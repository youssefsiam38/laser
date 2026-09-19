import {
  ErrorCodes,
  ProtocolError,
  type ChangedFile,
  type ChangeScope,
  type CheckpointInfo,
  type PrunedScope,
  type ProjectChanges,
  type RepoChanges,
} from "@lasercode/protocol";
import { writeIsolatedTree } from "./capture.js";
import { runGit } from "./git-run.js";
import { mergeChangeLists, parseNameStatus, parseNumstatFiles } from "./parse.js";
import { listSessionCheckpoints } from "./refs.js";
import type { RepoRef } from "./repositories.js";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
}

export async function resolveScopeRange(repo: RepoRef, query: ScopeQuery, checkpoints: CheckpointInfo[]): Promise<ResolvedRange> {
  const range = await resolveScopeRangeInner(repo, query, checkpoints);
  if (range.pruned || range.to !== undefined) return range;
  const snap = await writeIsolatedTree(repo);
  if (!snap.ok) throw new ProtocolError(ErrorCodes.Internal, snap.error);
  return { ...range, to: snap.tree };
}

async function resolveScopeRangeInner(repo: RepoRef, query: ScopeQuery, checkpoints: CheckpointInfo[]): Promise<ResolvedRange> {
  switch (query.scope) {
    case "session": {
      const first = checkpoints[0];
      if (!first) {
        return {
          from: EMPTY_TREE,
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
      const current = checkpoints.find((row) => row.turn === turn);
      const previous = checkpoints.find((row) => row.turn === turn - 1);
      if (!current) {
        return {
          from: EMPTY_TREE,
          pruned: { detail: "That turn's checkpoint is no longer kept, so this range cannot be shown." },
        };
      }
      if (turn > 0 && !previous) {
        return {
          from: current.commit,
          to: current.commit,
          pruned: {
            oldestTurn: current.turn,
            detail: "The previous turn's checkpoint is no longer kept, so this range cannot be shown.",
          },
        };
      }
      return { from: previous?.commit ?? EMPTY_TREE, to: current.commit };
    }
    case "uncommitted": {
      const head = await runGit({ cwd: repo.path, args: ["rev-parse", "--verify", "--quiet", "HEAD"], timeoutMs: 4000 });
      return { from: head.exitCode === 0 && head.stdout.trim() ? head.stdout.trim() : EMPTY_TREE };
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
  if (range.pruned) {
    return { repo: repo.path, branch, files: [] };
  }
  const files = await diffFiles(repo, range.from, range.to);
  return { repo: repo.path, branch, files };
}

export function filterTouched(changes: ProjectChanges): ProjectChanges {
  return { ...changes, repos: changes.repos.filter((repo) => repo.files.length > 0) };
}

export async function loadCheckpoints(repos: readonly RepoRef[], sessionPath: string): Promise<CheckpointInfo[]> {
  const byTurn = new Map<number, CheckpointInfo>();
  for (const repo of repos) {
    for (const row of await listSessionCheckpoints(repo, sessionPath)) {
      if (!byTurn.has(row.turn)) byTurn.set(row.turn, row);
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
  if (nameStatus.exitCode > 1 || numstat.exitCode > 1) return [];
  return mergeChangeLists(parseNameStatus(nameStatus.stdout), parseNumstatFiles(numstat.stdout));
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
  if (resolved.exitCode !== 0 || !resolved.stdout.trim()) {
    throw new ProtocolError(ErrorCodes.InvalidParams, "That revision is not in this repository.");
  }
  return resolved.stdout.trim();
}

export { EMPTY_TREE };
