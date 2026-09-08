import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isOwnedWorktreePath, removeRunWorktree } from "../../src/agents/worktrees.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString();

describe("removeRunWorktree", () => {
  it("removes a child's worktree and branch, and refuses paths outside .worktrees", async () => {
    const base = mkdtempSync(join(tmpdir(), "host-worktrees-"));
    const project = join(base, "project");
    execFileSync("git", ["init", "-q", "-b", "main", project]);
    writeFileSync(join(project, "a.txt"), "one\n");
    git(project, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "add", "-A");
    git(project, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "one");
    const path = join(project, ".worktrees", "explorer-1");
    git(project, "worktree", "add", "-q", path, "-b", "agents/explorer-1", "HEAD");
    expect(existsSync(path)).toBe(true);

    expect(isOwnedWorktreePath(project, path)).toBe(true);
    expect(isOwnedWorktreePath(project, project)).toBe(false);
    expect(isOwnedWorktreePath(project, join(project, ".worktrees"))).toBe(false);
    expect(isOwnedWorktreePath(project, join(base, "elsewhere"))).toBe(false);

    const outside = await removeRunWorktree({ projectCwd: project, worktree: { path: project, branch: "main", baseCommit: "x" } });
    expect(outside?.removed).toBe(false);
    expect(existsSync(join(project, "a.txt"))).toBe(true);

    const result = await removeRunWorktree({ projectCwd: project, worktree: { path, branch: "agents/explorer-1", baseCommit: "x" } });
    expect(result?.removed).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(git(project, "branch", "--list", "agents/explorer-1").trim()).toBe("");
    expect(git(project, "worktree", "list")).not.toContain("explorer-1");

    // Already gone: still a clean answer.
    const again = await removeRunWorktree({ projectCwd: project, worktree: { path, branch: "agents/explorer-1", baseCommit: "x" } });
    expect(again?.removed).toBe(true);
    expect(await removeRunWorktree({ projectCwd: project, worktree: null })).toBeUndefined();
  });
});
