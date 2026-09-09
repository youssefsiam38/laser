import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isOwnedWorktreePath, removeRunWorktree, worktreeStatus } from "../../src/agents/worktrees.js";

const AUTHOR = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString();

/** A project with one commit and a child worktree on `agents/explorer-1`. */
function repoWithChild(): { project: string; base: string; path: string; branch: string } {
  const base = mkdtempSync(join(tmpdir(), "host-worktrees-"));
  const project = join(base, "project");
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  writeFileSync(join(project, "a.txt"), "one\n");
  git(project, ...AUTHOR, "add", "-A");
  git(project, ...AUTHOR, "commit", "-q", "-m", "one");
  const path = join(project, ".worktrees", "explorer-1");
  const branch = "agents/explorer-1";
  git(project, "worktree", "add", "-q", path, "-b", branch, "HEAD");
  return { project, base, path, branch };
}

const owner = (project: string, path: string, branch: string) => ({ projectCwd: project, worktree: { path, branch, baseCommit: "x" } });

describe("worktreeStatus", () => {
  it("reports a clean worktree as holding nothing", async () => {
    const { project, path, branch } = repoWithChild();
    const status = await worktreeStatus(owner(project, path, branch));
    expect(status).toMatchObject({ path, branch, exists: true, unmergedCommits: 0, uncommittedFiles: 0 });
  });

  it("counts commits the project's checkout does not have, and uncommitted files", async () => {
    const { project, path, branch } = repoWithChild();
    writeFileSync(join(path, "b.txt"), "two\n");
    git(path, ...AUTHOR, "add", "-A");
    git(path, ...AUTHOR, "commit", "-q", "-m", "two");
    writeFileSync(join(path, "c.txt"), "three\n");
    const status = await worktreeStatus(owner(project, path, branch));
    expect(status?.unmergedCommits).toBe(1);
    expect(status?.uncommittedFiles).toBe(1);
  });

  it("says nothing at all about a run that never had a worktree", async () => {
    expect(await worktreeStatus({ projectCwd: "/p", worktree: null })).toBeUndefined();
  });

  it("refuses to read a path outside the project's worktrees directory", async () => {
    const { project } = repoWithChild();
    const status = await worktreeStatus(owner(project, project, "main"));
    expect(status?.detail).toContain(".worktrees");
    expect(status?.unmergedCommits).toBeNull();
  });
});

describe("removeRunWorktree", () => {
  it("removes a clean worktree and its branch, and refuses paths outside .worktrees", async () => {
    const { project, base, path, branch } = repoWithChild();
    expect(existsSync(path)).toBe(true);

    expect(isOwnedWorktreePath(project, path)).toBe(true);
    expect(isOwnedWorktreePath(project, project)).toBe(false);
    expect(isOwnedWorktreePath(project, join(project, ".worktrees"))).toBe(false);
    expect(isOwnedWorktreePath(project, join(base, "elsewhere"))).toBe(false);

    const outside = await removeRunWorktree(owner(project, project, "main"));
    expect(outside?.removed).toBe(false);
    expect(existsSync(join(project, "a.txt"))).toBe(true);

    const result = await removeRunWorktree(owner(project, path, branch));
    expect(result?.removed).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(git(project, "branch", "--list", branch).trim()).toBe("");
    expect(git(project, "worktree", "list")).not.toContain("explorer-1");

    // Already gone: still a clean answer.
    const again = await removeRunWorktree(owner(project, path, branch));
    expect(again?.removed).toBe(true);
    expect(await removeRunWorktree({ projectCwd: project, worktree: null })).toBeUndefined();
  });

  it("refuses a worktree holding unmerged commits, and says what it holds", async () => {
    const { project, path, branch } = repoWithChild();
    writeFileSync(join(path, "b.txt"), "two\n");
    git(path, ...AUTHOR, "add", "-A");
    git(path, ...AUTHOR, "commit", "-q", "-m", "two");

    const refused = await removeRunWorktree(owner(project, path, branch));
    expect(refused?.removed).toBe(false);
    expect(refused?.worktree?.unmergedCommits).toBe(1);
    expect(existsSync(path)).toBe(true);

    const forced = await removeRunWorktree(owner(project, path, branch), { force: true });
    expect(forced?.removed).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a worktree holding uncommitted files unless forced", async () => {
    const { project, path, branch } = repoWithChild();
    writeFileSync(join(path, "draft.txt"), "unsaved\n");

    const refused = await removeRunWorktree(owner(project, path, branch));
    expect(refused?.removed).toBe(false);
    expect(refused?.worktree?.uncommittedFiles).toBe(1);
    expect(existsSync(path)).toBe(true);

    expect((await removeRunWorktree(owner(project, path, branch), { force: true }))?.removed).toBe(true);
  });
});
