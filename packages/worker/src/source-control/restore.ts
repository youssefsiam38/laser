import { ErrorCodes, ProtocolError, type CheckpointInfo, type RestorePreview, type RestoreRepoPreview, type RestoreTarget } from "@lasercode/protocol";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "./git-run.js";
import { currentBranch } from "./changes.js";
import { parseNameStatus } from "./parse.js";
import { listSessionCheckpoints } from "./refs.js";
import type { RepoRef } from "./repositories.js";

const STAGING_DETAIL = "The working tree is restored. Staging is not: a checkpoint cannot record what was staged versus unstaged.";

export async function restorePreview(
  repos: readonly RepoRef[],
  sessionPath: string,
  turn: number,
  restore: RestoreTarget,
): Promise<RestorePreview> {
  const previews: RestoreRepoPreview[] = [];
  let anyCheckpoint = false;
  let entryId: string | undefined;
  for (const repo of repos) {
    const rows = await listSessionCheckpoints(repo, sessionPath);
    const checkpoint = rows.find((row) => row.turn === turn && !row.failed);
    const branch = await currentBranch(repo);
    const uncommittedLost = await uncommittedPaths(repo);
    if (!checkpoint) {
      previews.push({ repo: repo.path, branch, files: [], uncommittedLost });
      continue;
    }
    anyCheckpoint = true;
    if (checkpoint.entryId) entryId = checkpoint.entryId;
    const files = await restorePaths(repo, checkpoint.commit);
    // Lost work is only what this restore would overwrite, not everything dirty vs HEAD.
    const lost = uncommittedLost.filter((path) => files.includes(path));
    previews.push({ repo: repo.path, branch, files, uncommittedLost: lost });
  }
  if (!anyCheckpoint) {
    throw new ProtocolError(ErrorCodes.InvalidParams, "That turn's checkpoint is no longer kept.");
  }
  const hidden: RestoreTarget[] = [];
  if (!previews.some((row) => row.files.length > 0)) hidden.push("files");
  if (!entryId) hidden.push("conversation");
  return {
    turn,
    restore,
    hidden,
    repos: previews,
    staging: "not_restored",
    detail: STAGING_DETAIL,
    ...(entryId ? { conversation: { entryId, turn } } : {}),
  };
}

export async function verifyRestoreSource(repo: RepoRef, commit: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const verified = await runGit({
    cwd: repo.path,
    args: ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`],
    timeoutMs: 4000,
  });
  if (verified.timedOut || verified.overflow) {
    return { ok: false, error: "Checking that checkpoint took too long or the result was too large." };
  }
  if (verified.exitCode !== 0 || !verified.stdout.trim()) {
    return { ok: false, error: "That checkpoint is not in this repository, so its files were left unchanged." };
  }
  const listed = await runGit({
    cwd: repo.path,
    args: ["ls-files", "--cached", `--with-tree=${commit}`, "-z", "--", "."],
    timeoutMs: 15_000,
  });
  if (listed.timedOut || listed.overflow) {
    return { ok: false, error: "Reading that checkpoint took too long or the result was too large." };
  }
  if (listed.exitCode !== 0) {
    return { ok: false, error: listed.stderr.trim() || "That checkpoint could not be read, so its files were left unchanged." };
  }
  return { ok: true };
}

export async function restoreFiles(repo: RepoRef, commit: string): Promise<void> {
  const source = await verifyRestoreSource(repo, commit);
  if (!source.ok) throw new ProtocolError(ErrorCodes.Internal, source.error);
  const restored = await runGit({
    cwd: repo.path,
    args: ["restore", "--source", commit, "--worktree", "--", "."],
    timeoutMs: 30_000,
  });
  if (restored.timedOut || restored.overflow) {
    throw new ProtocolError(ErrorCodes.Internal, "Restoring those files took too long or the result was too large.");
  }
  if (restored.exitCode !== 0) {
    throw new ProtocolError(ErrorCodes.Internal, restored.stderr.trim() || "Could not restore those files.");
  }
  const extra = await pathsNotInCheckpoint(repo, commit);
  for (const path of extra) {
    rmSync(join(repo.path, path), { force: true, recursive: true });
  }
}

export async function checkpointForRepo(repo: RepoRef, sessionPath: string, turn: number): Promise<CheckpointInfo | undefined> {
  const rows = await listSessionCheckpoints(repo, sessionPath);
  return rows.find((row) => row.turn === turn && !row.failed);
}

async function restorePaths(repo: RepoRef, commit: string): Promise<string[]> {
  const source = await verifyRestoreSource(repo, commit);
  if (!source.ok) return [];
  const diff = await runGit({
    cwd: repo.path,
    args: ["diff", "--name-status", "--no-renames", "-z", "--no-ext-diff", commit, "--"],
    timeoutMs: 15_000,
  });
  if (diff.timedOut || diff.overflow) return [];
  const changed = [...parseNameStatus(diff.exitCode > 1 ? "" : diff.stdout).keys()];
  const untracked = await uncommittedPaths(repo);
  const inCheckpoint = new Set(await pathsAt(repo, commit));
  const extra = untracked.filter((path) => !inCheckpoint.has(path) && !changed.includes(path));
  return [...changed, ...extra].sort();
}

async function pathsAt(repo: RepoRef, commit: string): Promise<string[]> {
  const listed = await runGit({
    cwd: repo.path,
    args: ["ls-tree", "-r", "--name-only", "-z", commit],
    timeoutMs: 15_000,
  });
  if (listed.exitCode !== 0 || listed.timedOut || listed.overflow) return [];
  return listed.stdout.split("\0").filter(Boolean);
}

async function pathsNotInCheckpoint(repo: RepoRef, commit: string): Promise<string[]> {
  const inCheckpoint = new Set(await pathsAt(repo, commit));
  const tracked = await runGit({
    cwd: repo.path,
    args: ["ls-files", "-z", "--", "."],
    timeoutMs: 8000,
  });
  const onDisk: string[] = [];
  if (tracked.exitCode === 0 && !tracked.timedOut && !tracked.overflow) {
    onDisk.push(...tracked.stdout.split("\0").filter(Boolean));
  }
  onDisk.push(...(await uncommittedPaths(repo, true)));
  return [...new Set(onDisk)].filter((path) => !inCheckpoint.has(path));
}

async function uncommittedPaths(repo: RepoRef, untrackedOnly = false): Promise<string[]> {
  const porcelain = await runGit({
    cwd: repo.path,
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    timeoutMs: 8000,
  });
  if (porcelain.exitCode !== 0 || porcelain.timedOut || porcelain.overflow) return [];
  const paths: string[] = [];
  const chunks = porcelain.stdout.split("\0");
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const code = chunk.slice(0, 2);
    const path = chunk.slice(3);
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") i += 1;
    if (!path) continue;
    if (untrackedOnly && code !== "??") continue;
    paths.push(path);
  }
  return paths;
}
