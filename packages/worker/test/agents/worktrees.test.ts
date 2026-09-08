/**
 * M13-T3 · worktrees against real temporary repositories: create at the
 * parent's commit, refuse non-git and no-commit projects, refuse duplicates,
 * exclude `.worktrees/` through info/exclude, keep the path safe.
 */
import { PRODUCT_NAME, WORKTREES_DIR_NAME } from "@lasercode/protocol";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HarnessError } from "../../src/agents/errors.js";
import { WorktreeManager, assertSafeWorktreePath, worktreeSlug } from "../../src/agents/worktrees.js";

const haveGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env: ENV }).toString().trim();

describe("worktreeSlug", () => {
  it("lower-cases, strips everything but [a-z0-9-], and appends the run suffix within 60 characters", () => {
    expect(worktreeSlug("Review Auth Refresh!", "run_0a1b2c3d")).toBe("review-auth-refresh-0a1b2c3d");
    const long = worktreeSlug("x".repeat(100), "run_deadbeef");
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("-deadbeef")).toBe(true);
    expect(worktreeSlug("!!!", "run_1234abcd")).toBe("agent-1234abcd");
  });
});

describe("assertSafeWorktreePath", () => {
  it("accepts only a direct child of <root>/.worktrees", () => {
    expect(() => assertSafeWorktreePath("/repo", "/repo/.worktrees/a-1")).not.toThrow();
    expect(() => assertSafeWorktreePath("/repo", "/repo")).toThrow(HarnessError);
    expect(() => assertSafeWorktreePath("/repo", "/repo/.worktrees")).toThrow(HarnessError);
    expect(() => assertSafeWorktreePath("/repo", "/repo/.worktrees/a/b")).toThrow(HarnessError);
    expect(() => assertSafeWorktreePath("/repo", "/repo/.worktrees/../src")).toThrow(HarnessError);
    expect(() => assertSafeWorktreePath("/repo", "/elsewhere/.worktrees/a")).toThrow(HarnessError);
  });
});

describe.skipIf(!haveGit)("WorktreeManager against a repository", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-worktrees-`));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function repoWithCommit(): string {
    const dir = join(base, "repo");
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, "add", "a.txt");
    git(dir, "commit", "-q", "-m", "first");
    return dir;
  }

  it("creates the worktree at the parent's commit on its own branch and excludes the directory", async () => {
    const repo = repoWithCommit();
    const head = git(repo, "rev-parse", "HEAD");
    mkdirSync(join(repo, "node_modules"));
    const manager = new WorktreeManager();
    const worktree = await manager.create({ projectCwd: repo, baseCwd: repo, subagentName: "Fix Login", runId: "run_0a1b2c3d" });
    expect(worktree.path).toBe(join(repo, WORKTREES_DIR_NAME, "fix-login-0a1b2c3d"));
    expect(worktree.branch).toBe("agents/fix-login-0a1b2c3d");
    expect(worktree.baseCommit).toBe(head);
    expect(worktree.cwd).toBe(worktree.path);
    expect(git(worktree.path, "rev-parse", "HEAD")).toBe(head);
    expect(git(worktree.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agents/fix-login-0a1b2c3d");
    expect(existsSync(join(worktree.path, "a.txt"))).toBe(true);
    // node_modules is linked, the exclude file lists the directory, .gitignore is untouched.
    expect(existsSync(join(worktree.path, "node_modules"))).toBe(true);
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toContain(`/${WORKTREES_DIR_NAME}/`);
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(manager.ownedBy("run_0a1b2c3d")?.path).toBe(worktree.path);
    // Removal is best effort and complete.
    await manager.remove(worktree.root, worktree.path, worktree.branch);
    expect(existsSync(worktree.path)).toBe(false);
    expect(git(repo, "branch", "--list", "agents/fix-login-0a1b2c3d")).toBe("");
    expect(manager.ownedBy("run_0a1b2c3d")).toBeUndefined();
  });

  it("keeps the project's subdirectory as the child's cwd and branches from the parent worktree", async () => {
    const repo = repoWithCommit();
    mkdirSync(join(repo, "packages", "app"), { recursive: true });
    writeFileSync(join(repo, "packages", "app", "b.txt"), "two\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "second");
    const manager = new WorktreeManager();
    const first = await manager.create({ projectCwd: join(repo, "packages", "app"), baseCwd: join(repo, "packages", "app"), subagentName: "a", runId: "run_11111111" });
    expect(first.cwd).toBe(join(first.path, "packages", "app"));
    // A nested child branches from the parent worktree's commit.
    writeFileSync(join(first.path, "c.txt"), "three\n");
    git(first.path, "add", "c.txt");
    git(first.path, "commit", "-q", "-m", "child work");
    const childHead = git(first.path, "rev-parse", "HEAD");
    const second = await manager.create({ projectCwd: join(repo, "packages", "app"), baseCwd: first.cwd, subagentName: "b", runId: "run_22222222" });
    expect(second.baseCommit).toBe(childHead);
    expect(second.path).toBe(join(repo, WORKTREES_DIR_NAME, "b-22222222"));
    expect(existsSync(join(second.path, "c.txt"))).toBe(true);
  });

  it("refuses a project that is not a repository, one without commits, and a duplicate", async () => {
    const manager = new WorktreeManager();
    const plain = join(base, "plain");
    mkdirSync(plain);
    await expect(manager.create({ projectCwd: plain, baseCwd: plain, subagentName: "a", runId: "run_aaaaaaaa" })).rejects.toThrow(/not a git repository/);
    const empty = join(base, "empty");
    mkdirSync(empty);
    git(empty, "init", "-q", "-b", "main");
    await expect(manager.create({ projectCwd: empty, baseCwd: empty, subagentName: "a", runId: "run_aaaaaaaa" })).rejects.toThrow(/no commits yet/);
    const repo = repoWithCommit();
    await manager.create({ projectCwd: repo, baseCwd: repo, subagentName: "a", runId: "run_aaaaaaaa" });
    await expect(manager.create({ projectCwd: repo, baseCwd: repo, subagentName: "a", runId: "run_aaaaaaaa" })).rejects.toThrow(/already exists/);
    await expect(manager.remove(repo, repo)).rejects.toThrow(HarnessError);
  });
});
