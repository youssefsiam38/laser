/**
 * Removing a child's worktree when its session is deleted.
 *
 * The worker creates worktrees (packages/worker/src/agents/worktrees.ts) and
 * owns them while the child runs. Deleting a session is a host operation, and
 * a deleted child's worktree has no owner left, so the host removes it here
 * with git alone — no engine, no shell string. Best effort: a worktree that is
 * already gone, or a repository that refuses, is reported, never thrown.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { WORKTREES_DIR_NAME, type AgentRun } from "@lasercode/protocol";

export interface WorktreeRemoval {
  path: string;
  removed: boolean;
  detail?: string;
}

function git(cwd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((done) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: 30_000, windowsHide: true },
      (error, _stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : error ? 1 : 0;
        done({ code, stderr: String(stderr ?? "") });
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

/** Remove the worktree and branch a run owned, if any. */
export async function removeRunWorktree(run: Pick<AgentRun, "projectCwd" | "worktree">): Promise<WorktreeRemoval | undefined> {
  const worktree = run.worktree;
  if (!worktree) return undefined;
  if (!isOwnedWorktreePath(run.projectCwd, worktree.path)) {
    return { path: worktree.path, removed: false, detail: "not under the project's worktrees directory" };
  }
  if (existsSync(worktree.path)) {
    const removal = await git(run.projectCwd, ["worktree", "remove", "--force", worktree.path]);
    if (removal.code !== 0) return { path: worktree.path, removed: false, detail: removal.stderr.trim() || `git exited ${removal.code}` };
  } else {
    await git(run.projectCwd, ["worktree", "prune"]);
  }
  if (worktree.branch) await git(run.projectCwd, ["branch", "-D", worktree.branch]);
  return { path: worktree.path, removed: true };
}
