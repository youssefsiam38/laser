import { ErrorCodes, ProtocolError, type CheckpointInfo, type RestorePreview, type RestoreRepoPreview, type RestoreTarget } from "@lasercode/protocol";
import { runGit } from "./git-run.js";
import { currentBranch } from "./changes.js";
import { parseNameStatus } from "./parse.js";
import type { RepoRef } from "./repositories.js";

export async function restorePreview(
  repos: readonly RepoRef[],
  checkpoints: readonly CheckpointInfo[],
  turn: number,
  restore: RestoreTarget,
): Promise<RestorePreview> {
  const checkpoint = checkpoints.find((row) => row.turn === turn);
  if (!checkpoint) {
    throw new ProtocolError(ErrorCodes.InvalidParams, "That turn's checkpoint is no longer kept.");
  }
  const previews: RestoreRepoPreview[] = [];
  for (const repo of repos) {
    const branch = await currentBranch(repo);
    const files = await restorePaths(repo, checkpoint.commit);
    const uncommittedLost = await uncommittedPaths(repo);
    previews.push({ repo: repo.path, branch, files, uncommittedLost });
  }
  const hidden: RestoreTarget[] = [];
  if (!previews.some((row) => row.files.length > 0)) hidden.push("files");
  if (!checkpoint.entryId) hidden.push("conversation");
  return {
    turn,
    restore,
    hidden: hidden.filter((item) => restore === "both" || item === restore),
    repos: previews,
    ...(checkpoint.entryId ? { conversation: { entryId: checkpoint.entryId, turn } } : {}),
  };
}

export async function restoreFiles(repo: RepoRef, commit: string): Promise<void> {
  const tracked = await runGit({
    cwd: repo.path,
    args: ["ls-files", "--cached", `--with-tree=${commit}`, "-z", "--", "."],
    timeoutMs: 15_000,
  });
  if (tracked.stdout.length > 0) {
    const restored = await runGit({
      cwd: repo.path,
      args: ["restore", "--source", commit, "--worktree", "--staged", "--", "."],
      timeoutMs: 30_000,
    });
    if (restored.exitCode !== 0) {
      throw new ProtocolError(ErrorCodes.Internal, restored.stderr.trim() || "Could not restore those files.");
    }
  }
  const cleaned = await runGit({
    cwd: repo.path,
    args: ["clean", "-fd", "--", "."],
    timeoutMs: 30_000,
  });
  if (cleaned.exitCode !== 0 && !cleaned.stderr.includes("failed to remove ./")) {
    throw new ProtocolError(ErrorCodes.Internal, cleaned.stderr.trim() || "Could not clean files that were not in the checkpoint.");
  }
}

async function restorePaths(repo: RepoRef, commit: string): Promise<string[]> {
  const diff = await runGit({
    cwd: repo.path,
    args: ["diff", "--name-status", "--no-renames", "-z", "--no-ext-diff", commit, "--"],
    timeoutMs: 15_000,
  });
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
  if (listed.exitCode !== 0) return [];
  return listed.stdout.split("\0").filter(Boolean);
}

async function uncommittedPaths(repo: RepoRef): Promise<string[]> {
  const porcelain = await runGit({
    cwd: repo.path,
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    timeoutMs: 8000,
  });
  if (porcelain.exitCode !== 0) return [];
  const paths: string[] = [];
  const chunks = porcelain.stdout.split("\0");
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const code = chunk.slice(0, 2);
    const path = chunk.slice(3);
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") i += 1;
    if (path) paths.push(path);
  }
  return paths;
}
