/**
 * Reading and removing a child's worktree, on a person's behalf.
 *
 * The worker creates worktrees (packages/worker/src/agents/worktrees.ts) and a
 * parent agent owns the lifecycle of the ones it started (D-157): reviewing the
 * branch, merging it, and asking for it to be removed. This module is the
 * person's half of the same job — the escape hatch for a parent that crashed,
 * was cancelled, or simply stopped — and it runs in the host because a leftover
 * worktree outlives the worker that made it. Git alone, argument arrays only,
 * no engine and no shell string.
 *
 * Nothing here removes a worktree that still holds work unless the caller says
 * so explicitly. Losing a child's commits silently is the one failure the
 * whole lifecycle exists to prevent.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { WORKTREES_DIR_NAME, worktreeHoldsWork, type AgentRun, type AgentWorktreeStatus } from "@lasercode/protocol";

export interface WorktreeRemoval {
  removed: boolean;
  /** What the worktree held when the decision was made; `null` when the run had none. */
  worktree: AgentWorktreeStatus | null;
}

/** The parts of a run this module needs; a plain object in tests. */
export type WorktreeOwner = Pick<AgentRun, "projectCwd" | "worktree">;

const NOT_OURS = `not under the project's ${WORKTREES_DIR_NAME} directory`;

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
        done({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

/** Only a directory strictly under `<project>/.worktrees/` is ever removed. */
export function isOwnedWorktreePath(projectCwd: string, path: string): boolean {
  const root = resolve(projectCwd, WORKTREES_DIR_NAME) + sep;
  const target = resolve(path);
  return target.startsWith(root) && target.length > root.length;
}

/**
 * What the run's worktree holds right now. `undefined` when the run never had
 * one — a child started with `worktree: false` has nothing to read and nothing
 * to remove, and the caller must say nothing about a branch that does not exist.
 */
export async function worktreeStatus(run: WorktreeOwner): Promise<AgentWorktreeStatus | undefined> {
  const worktree = run.worktree;
  if (!worktree) return undefined;
  const base: AgentWorktreeStatus = {
    path: worktree.path,
    branch: worktree.branch,
    exists: existsSync(worktree.path),
    unmergedCommits: null,
    uncommittedFiles: null,
  };
  if (!isOwnedWorktreePath(run.projectCwd, worktree.path)) return { ...base, detail: NOT_OURS };
  if (!base.exists) return { ...base, unmergedCommits: 0, uncommittedFiles: 0 };

  // Commits on the branch the project's own checkout does not have. A branch
  // merged elsewhere still counts here: over-reporting costs one extra
  // confirmation, under-reporting costs the work.
  const ahead = await git(run.projectCwd, ["rev-list", "--count", `HEAD..${worktree.branch}`]);
  const changed = await git(worktree.path, ["status", "--porcelain", "--untracked-files=all"]);
  const unmergedCommits = ahead.code === 0 ? readCount(ahead.stdout) : null;
  const uncommittedFiles = changed.code === 0 ? changed.stdout.split("\n").filter((line) => line.trim() !== "").length : null;
  const detail =
    unmergedCommits === null
      ? ahead.stderr.trim() || "git could not compare this branch with the project."
      : uncommittedFiles === null
        ? changed.stderr.trim() || "git could not read this worktree's changes."
        : undefined;
  return { ...base, unmergedCommits, uncommittedFiles, ...(detail ? { detail } : {}) };
}

function readCount(text: string): number | null {
  const value = Number.parseInt(text.trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Remove the worktree and branch a run owned, if any.
 *
 * Refused, with what it holds, when the directory is not one the app created,
 * or when it still carries unmerged commits or uncommitted files — unless
 * `force` says the work is deliberately being thrown away.
 */
export async function removeRunWorktree(run: WorktreeOwner, options: { force?: boolean } = {}): Promise<WorktreeRemoval | undefined> {
  const status = await worktreeStatus(run);
  if (!status) return undefined;
  if (status.detail === NOT_OURS) return { removed: false, worktree: status };
  if (!options.force && worktreeHoldsWork(status)) return { removed: false, worktree: status };

  if (status.exists) {
    const removal = await git(run.projectCwd, ["worktree", "remove", "--force", status.path]);
    if (removal.code !== 0) {
      return { removed: false, worktree: { ...status, detail: removal.stderr.trim() || `git exited ${removal.code}` } };
    }
  } else {
    await git(run.projectCwd, ["worktree", "prune"]);
  }
  if (status.branch) await git(run.projectCwd, ["branch", "-D", status.branch]);
  return { removed: true, worktree: { ...status, exists: false, unmergedCommits: 0, uncommittedFiles: 0 } };
}
