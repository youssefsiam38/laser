/**
 * M13-T3 · worktrees against real temporary repositories: create at the
 * parent's commit, refuse non-git and no-commit projects, refuse duplicates,
 * exclude `.worktrees/` through info/exclude, keep the path safe.
 */
import { PRODUCT_NAME, PROJECT_DIR_NAME, WORKTREES_DIR_NAME } from "@lasercode/protocol";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    vi.useRealTimers();
    rmSync(base, { recursive: true, force: true });
  });

  async function expectProcessEnded(pid: number): Promise<void> {
    expect(pid).toBeGreaterThan(0);
    await vi.waitFor(() => {
      if (process.platform === "linux") {
        // A killed orphan may remain a zombie until this runner's init reaps it.
        const path = `/proc/${pid}/stat`;
        if (existsSync(path)) expect(readFileSync(path, "utf8").split(") ")[1]?.[0]).toBe("Z");
      } else {
        expect(() => process.kill(pid, 0)).toThrow();
      }
    });
  }

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
    writeFileSync(join(repo, "node_modules", "parent-only"), "untouched");
    writeFileSync(join(repo, ".git", "info", "exclude"), "node_modules/\n");
    const manager = new WorktreeManager();
    const worktree = await manager.create({ projectCwd: repo, baseCwd: repo, subagentName: "Fix Login", runId: "run_0a1b2c3d" });
    expect(worktree.path).toBe(join(repo, WORKTREES_DIR_NAME, "fix-login-0a1b2c3d"));
    expect(worktree.branch).toBe("agents/fix-login-0a1b2c3d");
    expect(worktree.baseCommit).toBe(head);
    expect(worktree.cwd).toBe(worktree.path);
    expect(git(worktree.path, "rev-parse", "HEAD")).toBe(head);
    expect(git(worktree.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agents/fix-login-0a1b2c3d");
    expect(existsSync(join(worktree.path, "a.txt"))).toBe(true);
    // Parent dependencies stay entirely outside the clean checkout.
    expect(existsSync(join(worktree.path, "node_modules"))).toBe(false);
    expect(worktree.environment).toMatchObject({ path: worktree.path, branch: worktree.branch, baseCommit: head, parentCheckout: repo });
    expect(worktree.environment?.absentDirectories).toContain("node_modules/");
    expect(worktree.setup).toEqual({ status: "not-present" });
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

  it("caps verbatim top-level observations and does not report directories already checked out", async () => {
    const repo = repoWithCommit();
    mkdirSync(join(repo, "tracked-dir"));
    writeFileSync(join(repo, "tracked-dir", "source"), "tracked");
    git(repo, "add", "."); git(repo, "commit", "-qm", "directory");
    const names = Array.from({ length: 24 }, (_, i) => `cache ${String(i).padStart(2, "0")}`);
    writeFileSync(join(repo, ".git", "info", "exclude"), names.map((name) => `${name}/`).join("\n") + "\n");
    for (const name of names) { mkdirSync(join(repo, name)); writeFileSync(join(repo, name, "value"), "ignored"); }
    const tree = await new WorktreeManager().create({ projectCwd: repo, baseCwd: repo, subagentName: "facts", runId: "run_aabb" });
    const absent = tree.environment!.absentDirectories;
    expect(absent).toHaveLength(20);
    expect(absent).toContain("cache 00/");
    expect(absent).not.toContain("tracked-dir/");
    expect(absent.every((name) => name.endsWith("/") && !name.slice(0, -1).includes("/"))).toBe(true);
  });

  it.each([
    ["echo ready; pwd", "ok", undefined],
    ["echo broken >&2; exit 2", "failed", 2],
    ["sleep 30 & echo $!; wait", "timed-out", undefined],
  ] as const)("runs a project hook: %s", async (script, status, exitCode) => {
    const repo = repoWithCommit();
    mkdirSync(join(repo, PROJECT_DIR_NAME));
    const hook = join(repo, PROJECT_DIR_NAME, "worktree-setup");
    writeFileSync(hook, `#!/bin/sh\n${script}\n`);
    chmodSync(hook, 0o755);
    const tree = await new WorktreeManager().create({ projectCwd: repo, baseCwd: repo, subagentName: "setup", runId: "run_aabb" });
    expect(tree.setup?.status).toBe("pending");
    if (status === "timed-out") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const running = new WorktreeManager().runSetup(repo, tree, new AbortController().signal);
    if (status === "timed-out") {
      if (tree.setup?.status !== "pending") throw new Error("hook missing");
      const { logPath } = tree.setup;
      await vi.waitFor(() => expect(readFileSync(logPath, "utf8").trim()).toMatch(/^\d+$/));
      let settled = false;
      void running.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(599_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      vi.useRealTimers();
    }
    const result = await running;
    expect(result.status).toBe(status);
    if (result.status === "failed") expect(result.exitCode).toBe(exitCode);
    if (!("logPath" in result)) throw new Error("hook missing");
    const output = readFileSync(result.logPath, "utf8");
    if (status === "ok") expect(output).toContain(tree.cwd);
    if (status === "failed") expect(output).toContain("broken");
    if (status === "timed-out") await expectProcessEnded(Number(output.trim()));
    expect(git(tree.path, "status", "--porcelain")).toBe("");
    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
  });

  it("cancels a running hook and skips a non-executable hook", async () => {
    const repo = repoWithCommit();
    mkdirSync(join(repo, PROJECT_DIR_NAME));
    const hook = join(repo, PROJECT_DIR_NAME, "worktree-setup");
    writeFileSync(hook, "#!/bin/sh\nsleep 30 & echo $!; wait\n");
    chmodSync(hook, 0o755);
    const tree = await new WorktreeManager().create({ projectCwd: repo, baseCwd: repo, subagentName: "setup", runId: "run_aabb" });
    const controller = new AbortController();
    const running = new WorktreeManager().runSetup(repo, tree, controller.signal);
    if (tree.setup?.status !== "pending") throw new Error("hook missing");
    const logPath = tree.setup.logPath;
    await vi.waitFor(() => expect(readFileSync(logPath, "utf8").trim()).toMatch(/^\d+$/));
    const pid = Number(readFileSync(logPath, "utf8").trim());
    controller.abort();
    expect((await running).status).toBe("cancelled");
    await expectProcessEnded(pid);
    chmodSync(hook, 0o644);
    const absent = await new WorktreeManager().create({ projectCwd: repo, baseCwd: repo, subagentName: "absent", runId: "run_ccdd" });
    expect(absent.setup).toEqual({ status: "not-present" });
  });

  it("never executes an untrusted hook, even with a previously pending record", async () => {
    const repo = repoWithCommit();
    mkdirSync(join(repo, PROJECT_DIR_NAME));
    const hook = join(repo, PROJECT_DIR_NAME, "worktree-setup");
    writeFileSync(hook, "#!/bin/sh\necho unsafe > marker\n");
    chmodSync(hook, 0o755);
    const manager = new WorktreeManager();
    const tree = await manager.create({ projectCwd: repo, projectTrusted: false, baseCwd: repo, subagentName: "untrusted", runId: "run_aabb" });
    expect(tree.setup).toEqual({ status: "skipped-untrusted" });
    expect(await manager.runSetup(repo, tree, new AbortController().signal, false)).toEqual({ status: "skipped-untrusted" });
    tree.setup = { status: "pending", logPath: join(tree.path, "setup.log") };
    expect(await manager.runSetup(repo, tree, new AbortController().signal, false)).toEqual({ status: "skipped-untrusted" });
    expect(existsSync(join(tree.path, "marker"))).toBe(false);
    expect(existsSync(join(tree.path, "setup.log"))).toBe(false);
  });

  // M13-T42: the parent is refused a removal that would destroy work, so the
  // counting has to be right against a real repository.
  it("counts what a child's worktree still holds, and finds the repository a project belongs to", async () => {
    const repo = repoWithCommit();
    const manager = new WorktreeManager();
    const worktree = await manager.create({ projectCwd: repo, baseCwd: repo, subagentName: "iso", runId: "run_0a1b2c3d" });

    expect(await manager.rootOf(repo)).toBe(git(repo, "rev-parse", "--show-toplevel"));
    const plain = join(base, "not-a-repo");
    mkdirSync(plain);
    expect(await manager.rootOf(plain)).toBeUndefined();

    const clean = await manager.facts({ path: worktree.path, branch: worktree.branch, compareCwd: repo });
    expect(clean).toEqual({ exists: true, unmergedCommits: 0, uncommittedFiles: 0 });

    writeFileSync(join(worktree.path, "b.txt"), "two\n");
    git(worktree.path, "add", "b.txt");
    git(worktree.path, "commit", "-q", "-m", "child work");
    writeFileSync(join(worktree.path, "c.txt"), "draft\n");
    const dirty = await manager.facts({ path: worktree.path, branch: worktree.branch, compareCwd: repo });
    expect(dirty).toEqual({ exists: true, unmergedCommits: 1, uncommittedFiles: 1 });

    // Once the parent merges it, there is nothing left to lose.
    git(repo, "merge", "-q", "--no-edit", worktree.branch);
    expect((await manager.facts({ path: worktree.path, branch: worktree.branch, compareCwd: repo })).unmergedCommits).toBe(0);

    // A directory that is already gone holds nothing, and never throws.
    await manager.remove(worktree.root, worktree.path, worktree.branch);
    expect(await manager.facts({ path: worktree.path, branch: worktree.branch, compareCwd: repo })).toEqual({ exists: false, unmergedCommits: 0, uncommittedFiles: 0 });
  });

  it("says it cannot tell rather than reporting nothing when git refuses the question", async () => {
    const repo = repoWithCommit();
    const manager = new WorktreeManager();
    const worktree = await manager.create({ projectCwd: repo, baseCwd: repo, subagentName: "iso", runId: "run_0a1b2c3d" });
    const unknown = await manager.facts({ path: worktree.path, branch: "agents/never-existed", compareCwd: repo });
    expect(unknown.exists).toBe(true);
    expect(unknown.unmergedCommits).toBeNull();
    expect(unknown.detail).toBeTruthy();
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
