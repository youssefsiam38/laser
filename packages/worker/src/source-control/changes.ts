import {
  ErrorCodes,
  GIT_EMPTY_TREE,
  ProtocolError,
  gitLooksBinary,
  type ChangedFile,
  type ChangeScope,
  type CheckpointInfo,
  type PrunedScope,
  type ProjectChanges,
  type RepoChanges,
} from "@lasercode/protocol";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { writeIsolatedTree } from "./capture.js";
import { runGit } from "./git-run.js";
import { mergeChangeLists, parseNameStatus, parseNumstatFiles } from "./parse.js";
import { listSessionCheckpoints } from "./refs.js";
import type { RepoRef } from "./repositories.js";

export interface ScopeQuery {
  scope: ChangeScope;
  sessionPath: string;
  turn?: number;
  fromRef?: string;
  toRef?: string;
  baseCommit?: string;
}

export interface ResolvedRange {
  from: string;
  /** Absent means the live working tree. */
  to?: string;
  pruned?: PrunedScope;
  /** Uncommitted: porcelain + `git diff HEAD`, never a write-tree snapshot. */
  porcelain?: true;
}

export async function resolveScopeRange(repo: RepoRef, query: ScopeQuery, checkpoints: CheckpointInfo[]): Promise<ResolvedRange> {
  const range = await resolveScopeRangeInner(repo, query, checkpoints);
  if (range.pruned && !range.pruned.oldestTurn) return range;
  if (range.porcelain || range.to !== undefined) return range;
  const snap = await writeIsolatedTree(repo);
  if (!snap.ok) throw new ProtocolError(ErrorCodes.Internal, snap.error);
  return { ...range, to: snap.tree };
}

async function resolveScopeRangeInner(repo: RepoRef, query: ScopeQuery, checkpoints: CheckpointInfo[]): Promise<ResolvedRange> {
  const usable = checkpoints.filter((row) => !row.failed);
  switch (query.scope) {
    case "session": {
      const first = usable[0];
      if (!first) {
        return {
          from: GIT_EMPTY_TREE,
          pruned: { detail: "No checkpoints are kept for this session yet." },
        };
      }
      if (first.turn > 0) {
        return {
          from: first.commit,
          pruned: {
            oldestTurn: first.turn,
            detail: "Older checkpoints were removed. This range no longer starts at the beginning of the session.",
          },
        };
      }
      return { from: first.commit };
    }
    case "turn": {
      const turn = query.turn;
      if (turn === undefined) throw new ProtocolError(ErrorCodes.InvalidParams, "A turn number is required for this scope.");
      if (turn === 0) {
        throw new ProtocolError(ErrorCodes.InvalidParams, "The open-time baseline is not a conversation turn.");
      }
      const current = usable.find((row) => row.turn === turn);
      const previous = usable.find((row) => row.turn === turn - 1);
      const failed = checkpoints.find((row) => row.turn === turn && row.failed);
      if (!current) {
        return {
          from: GIT_EMPTY_TREE,
          pruned: {
            detail: failed
              ? "That turn was not captured, so this range cannot be shown."
              : "That turn's checkpoint is no longer kept, so this range cannot be shown.",
          },
        };
      }
      if (!previous) {
        return {
          from: current.commit,
          to: current.commit,
          pruned: {
            oldestTurn: current.turn,
            detail: "The previous turn's checkpoint is no longer kept, so this range cannot be shown.",
          },
        };
      }
      return { from: previous.commit, to: current.commit };
    }
    case "uncommitted": {
      const head = await runGit({ cwd: repo.path, args: ["rev-parse", "--verify", "--quiet", "HEAD"], timeoutMs: 4000 });
      if (head.timedOut || head.overflow) {
        throw new ProtocolError(ErrorCodes.Internal, "Reading HEAD took too long or the result was too large.");
      }
      return { from: head.exitCode === 0 && head.stdout.trim() ? head.stdout.trim() : GIT_EMPTY_TREE, porcelain: true };
    }
    case "range": {
      if (!query.fromRef || !query.toRef) {
        throw new ProtocolError(ErrorCodes.InvalidParams, "A commit range needs both ends.");
      }
      const from = await resolveRevision(repo, query.fromRef);
      const to = await resolveRevision(repo, query.toRef);
      return { from, to };
    }
    case "agent": {
      if (!query.baseCommit) throw new ProtocolError(ErrorCodes.InvalidParams, "This agent has no recorded starting commit.");
      const from = await resolveRevision(repo, query.baseCommit);
      return { from };
    }
  }
}

export async function repoChanges(repo: RepoRef, range: ResolvedRange): Promise<RepoChanges> {
  const branch = await currentBranch(repo);
  if (range.pruned && range.pruned.oldestTurn === undefined) {
    return { repo: repo.path, branch, files: [] };
  }
  const files = range.porcelain ? await uncommittedFiles(repo, range.from) : await diffFiles(repo, range.from, range.to);
  return { repo: repo.path, branch, files };
}

export function filterTouched(changes: ProjectChanges): ProjectChanges {
  return { ...changes, repos: changes.repos.filter((repo) => repo.files.length > 0) };
}

export async function loadCheckpoints(repos: readonly RepoRef[], sessionPath: string): Promise<CheckpointInfo[]> {
  const byTurn = new Map<number, CheckpointInfo>();
  const listed = await Promise.all(repos.map(async (repo) => ({ repo, rows: await listSessionCheckpoints(repo, sessionPath) })));
  for (const { repo, rows } of listed) {
    for (const row of rows) {
      const repoRow = { repo: repo.path, ref: row.ref, commit: row.commit };
      const existing = byTurn.get(row.turn);
      if (!existing) {
        byTurn.set(row.turn, { ...row, repos: [repoRow] });
        continue;
      }
      existing.repos = [...(existing.repos ?? []), repoRow];
      if (row.failed) existing.failed = true;
      if (row.entryId && !existing.entryId) existing.entryId = row.entryId;
    }
  }
  return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
}

async function diffFiles(repo: RepoRef, from: string, to: string | undefined): Promise<ChangedFile[]> {
  const ends = to ? [from, to] : [from];
  const [nameStatus, numstat] = await Promise.all([
    runGit({ cwd: repo.path, args: ["diff", "--name-status", "--no-renames", "-z", "--no-ext-diff", ...ends, "--"], timeoutMs: 15_000 }),
    runGit({ cwd: repo.path, args: ["diff", "--numstat", "--no-renames", "-z", "--no-ext-diff", ...ends, "--"], timeoutMs: 15_000 }),
  ]);
  if (nameStatus.timedOut || nameStatus.overflow || numstat.timedOut || numstat.overflow) {
    throw new ProtocolError(ErrorCodes.Internal, "Reading those changes took too long or the result was too large.");
  }
  if (nameStatus.exitCode > 1 || numstat.exitCode > 1) return [];
  return mergeChangeLists(parseNameStatus(nameStatus.stdout), parseNumstatFiles(numstat.stdout));
}

async function uncommittedFiles(repo: RepoRef, from: string): Promise<ChangedFile[]> {
  const [nameStatus, numstat, porcelain] = await Promise.all([
    runGit({ cwd: repo.path, args: ["diff", "--name-status", "--no-renames", "-z", "--no-ext-diff", from, "--"], timeoutMs: 15_000 }),
    runGit({ cwd: repo.path, args: ["diff", "--numstat", "--no-renames", "-z", "--no-ext-diff", from, "--"], timeoutMs: 15_000 }),
    runGit({ cwd: repo.path, args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"], timeoutMs: 8000 }),
  ]);
  if (nameStatus.timedOut || nameStatus.overflow || numstat.timedOut || numstat.overflow || porcelain.timedOut || porcelain.overflow) {
    throw new ProtocolError(ErrorCodes.Internal, "Reading those changes took too long or the result was too large.");
  }
  if (nameStatus.exitCode > 1 || numstat.exitCode > 1) return [];
  const files = mergeChangeLists(parseNameStatus(nameStatus.stdout), parseNumstatFiles(numstat.stdout));
  const known = new Set(files.map((file) => file.path));
  for (const path of untrackedFromPorcelain(porcelain.exitCode === 0 ? porcelain.stdout : "")) {
    if (known.has(path)) continue;
    files.push(untrackedAsAdded(repo, path));
    known.add(path);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function untrackedFromPorcelain(text: string): string[] {
  const paths: string[] = [];
  const chunks = text.split("\0");
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const code = chunk.slice(0, 2);
    const path = chunk.slice(3);
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") i += 1;
    if (code === "??" && path) paths.push(path);
  }
  return paths;
}

function untrackedAsAdded(repo: RepoRef, path: string): ChangedFile {
  try {
    const target = resolve(repo.path, path);
    const info = statSync(target);
    if (!info.isFile()) return { path, status: "added", added: 0, removed: 0 };
    if (info.size > 8 * 1024 * 1024) return { path, status: "added", added: null, removed: 0 };
    const buffer = readFileSync(target);
    if (gitLooksBinary(buffer)) return { path, status: "added", added: null, removed: 0 };
    return { path, status: "added", added: countLines(buffer), removed: 0 };
  } catch {
    return { path, status: "added", added: 0, removed: 0 };
  }
}

function countLines(buffer: Uint8Array): number {
  if (buffer.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < buffer.length; i++) if (buffer[i] === 0x0a) lines++;
  if (buffer[buffer.length - 1] !== 0x0a) lines++;
  return lines;
}

export async function currentBranch(repo: RepoRef): Promise<string> {
  const named = await runGit({ cwd: repo.path, args: ["symbolic-ref", "--quiet", "--short", "HEAD"], timeoutMs: 4000 });
  if (named.exitCode === 0 && named.stdout.trim()) return named.stdout.trim();
  const detached = await runGit({ cwd: repo.path, args: ["rev-parse", "--short", "HEAD"], timeoutMs: 4000 });
  return detached.stdout.trim() || "(no commits)";
}

export async function resolveRevision(repo: RepoRef, value: string): Promise<string> {
  if (value.startsWith("-") || value.includes("..") || value.includes("@{") || /[\s:~^?*\\\[]/.test(value)) {
    throw new ProtocolError(ErrorCodes.InvalidParams, "That revision is not a usable git ref.");
  }
  const resolved = await runGit({
    cwd: repo.path,
    args: ["rev-parse", "--verify", "--quiet", `${value}^{commit}`],
    timeoutMs: 4000,
  });
  if (resolved.timedOut || resolved.overflow) {
    throw new ProtocolError(ErrorCodes.Internal, "Resolving that revision took too long or the result was too large.");
  }
  if (resolved.exitCode !== 0 || !resolved.stdout.trim()) {
    throw new ProtocolError(ErrorCodes.InvalidParams, "That revision is not in this repository.");
  }
  return resolved.stdout.trim();
}

export { GIT_EMPTY_TREE };
