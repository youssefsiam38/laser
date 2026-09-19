/**
 * Workspace shapes over real temporary layouts, plus isolation precedence.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "../src/identity.js";
import {
  AGENT_ISOLATION_DEFAULT,
  WorkspaceResolver,
  decideIsolation,
  describeIsolation,
  isolationDemandsWorktree,
  resolveWorkspaceShape,
  sharedCheckoutReason,
  strictIsolationRefusal,
  workspaceCanIsolate,
  type WorkspaceIO,
} from "../src/workspace.js";

const haveGit = (() => {
  try {
    execFile("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const GIT_ENV = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@x",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@x",
};

function nodeIo(): WorkspaceIO {
  return {
    run(args, cwd) {
      return new Promise((done) => {
        execFile(
          "git",
          [...args],
          { cwd, timeout: 8000, maxBuffer: 4 * 1024 * 1024, env: GIT_ENV },
          (error, stdout, stderr) => {
            done({ ok: !error, stdout: String(stdout), stderr: String(stderr) });
          },
        );
      });
    },
    async list(path) {
      const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
      return entries.map((entry) => ({
        name: entry.name,
        path: join(path, entry.name),
        isDirectory: entry.isDirectory(),
      }));
    },
    async exists(path) {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    join,
    resolve,
    dirname,
    basename,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", env: GIT_ENV }).toString().trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README"), "ok\n");
  git(dir, "add", "README");
  git(dir, "commit", "-q", "-m", "init");
}

describe.skipIf(!haveGit)("resolveWorkspaceShape", () => {
  let base: string;
  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  function scratch(): string {
    base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-workspace-`));
    return base;
  }

  it("resolves a plain repository and a monorepo with one .git as repo", async () => {
    const root = scratch();
    const repo = join(root, "app");
    initRepo(repo);
    mkdirSync(join(repo, "packages", "ui"), { recursive: true });
    const io = nodeIo();
    const shape = await resolveWorkspaceShape(repo, io);
    expect(shape.kind).toBe("repo");
    expect(shape.repositories).toEqual([{ root: resolve(repo), name: "app", projectRoot: true }]);
    const nestedDir = await resolveWorkspaceShape(join(repo, "packages", "ui"), io);
    expect(nestedDir.kind).toBe("repo");
    expect(nestedDir.repositories[0]?.root).toBe(resolve(repo));
    expect(nestedDir.repositories[0]?.projectRoot).toBe(false);
  });

  it("resolves a workspace of many repositories with no git at the root", async () => {
    const root = scratch();
    const workspace = join(root, "ws");
    mkdirSync(workspace);
    for (const name of ["alpha", "beta", "gamma"]) initRepo(join(workspace, name));
    mkdirSync(join(workspace, "node_modules", "left-pad"), { recursive: true });
    initRepo(join(workspace, "node_modules", "left-pad"));
    writeFileSync(join(workspace, "notes.txt"), "not a repo\n");
    const shape = await resolveWorkspaceShape(workspace, nodeIo());
    expect(shape.kind).toBe("workspace-of-repos");
    expect(shape.repositories.map((row) => row.name).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(shape.repositories.every((row) => row.projectRoot === false)).toBe(true);
    expect(workspaceCanIsolate(shape)).toBe(false);
  });

  it("resolves a directory with no git at all", async () => {
    const root = scratch();
    const plain = join(root, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "file.txt"), "x\n");
    const shape = await resolveWorkspaceShape(plain, nodeIo());
    expect(shape).toEqual({ cwd: resolve(plain), kind: "no-git", repositories: [] });
    expect(workspaceCanIsolate(shape)).toBe(false);
  });

  it("resolves a repository nested inside another repository", async () => {
    const root = scratch();
    const outer = join(root, "outer");
    initRepo(outer);
    const inner = join(outer, "temp");
    initRepo(inner);
    const io = nodeIo();
    const fromOuter = await resolveWorkspaceShape(outer, io);
    expect(fromOuter.kind).toBe("nested-repo");
    expect(fromOuter.repositories.map((row) => row.name).sort()).toEqual(["outer", "temp"]);
    const fromInner = await resolveWorkspaceShape(inner, io);
    expect(fromInner.kind).toBe("nested-repo");
    expect(fromInner.repositories[0]?.root).toBe(resolve(inner));
    expect(fromInner.repositories[0]?.projectRoot).toBe(true);
    expect(workspaceCanIsolate(fromInner)).toBe(true);
  });

  it("resolves a repository with .gitmodules as bare-or-submodule", async () => {
    const root = scratch();
    const repo = join(root, "with-modules");
    initRepo(repo);
    writeFileSync(join(repo, ".gitmodules"), "[submodule \"vendor\"]\n\tpath = vendor\n\turl = ./vendor\n");
    const shape = await resolveWorkspaceShape(repo, nodeIo());
    expect(shape.kind).toBe("bare-or-submodule");
    expect(shape.repositories[0]?.projectRoot).toBe(true);
    expect(workspaceCanIsolate(shape)).toBe(true);
  });

  it("resolves a bare repository as bare-or-submodule", async () => {
    const root = scratch();
    const bare = join(root, "bare.git");
    mkdirSync(bare);
    git(bare, "init", "-q", "--bare");
    const shape = await resolveWorkspaceShape(bare, nodeIo());
    expect(shape.kind).toBe("bare-or-submodule");
    expect(workspaceCanIsolate(shape)).toBe(false);
  });

  it("caches per cwd and refreshes only on rescan", async () => {
    const root = scratch();
    const workspace = join(root, "ws");
    mkdirSync(workspace);
    initRepo(join(workspace, "one"));
    const resolver = new WorkspaceResolver(nodeIo());
    const first = await resolver.resolve(workspace);
    expect(first.kind).toBe("workspace-of-repos");
    expect(first.repositories).toHaveLength(1);
    initRepo(join(workspace, "two"));
    const cached = await resolver.resolve(workspace);
    expect(cached.repositories).toHaveLength(1);
    const fresh = await resolver.resolve(workspace, { rescan: true });
    expect(fresh.repositories.map((row) => row.name).sort()).toEqual(["one", "two"]);
  });

  it("does not walk skipped directories even when they contain a .git", async () => {
    const root = scratch();
    const workspace = join(root, "ws");
    mkdirSync(workspace);
    initRepo(join(workspace, "keep"));
    mkdirSync(join(workspace, ".hidden"), { recursive: true });
    initRepo(join(workspace, ".hidden"));
    mkdirSync(join(workspace, "dist"), { recursive: true });
    initRepo(join(workspace, "dist"));
    const shape = await resolveWorkspaceShape(workspace, nodeIo());
    expect(shape.repositories.map((row) => row.name)).toEqual(["keep"]);
  });
});

describe("isolation precedence", () => {
  const noGit = { cwd: "/p", kind: "no-git" as const, repositories: [] };
  const repo = {
    cwd: "/p",
    kind: "repo" as const,
    repositories: [{ root: "/p", name: "p", projectRoot: true }],
  };
  const many = {
    cwd: "/p",
    kind: "workspace-of-repos" as const,
    repositories: Array.from({ length: 41 }, (_, i) => ({
      root: `/p/r${i}`,
      name: `r${i}`,
      projectRoot: false,
    })),
  };

  it("defaults the project setting to decide", () => {
    expect(AGENT_ISOLATION_DEFAULT).toBe("decide");
  });

  it("false always shares, even when the project prefers isolation", () => {
    expect(decideIsolation({ worktree: false, projectDefault: "isolate", shape: repo })).toEqual({
      isolate: false,
      demand: false,
    });
  });

  it("strict always demands isolation", () => {
    expect(isolationDemandsWorktree("strict", "share")).toBe(true);
    expect(decideIsolation({ worktree: "strict", projectDefault: "share", shape: noGit })).toEqual({
      isolate: true,
      demand: true,
    });
  });

  it("decide + true isolates a repo and shares a workspace of repos", () => {
    expect(decideIsolation({ worktree: true, projectDefault: "decide", shape: repo })).toEqual({
      isolate: true,
      demand: false,
    });
    expect(decideIsolation({ worktree: true, projectDefault: "decide", shape: many })).toEqual({
      isolate: false,
      demand: false,
    });
  });

  it("isolate makes true behave like strict", () => {
    expect(decideIsolation({ worktree: true, projectDefault: "isolate", shape: many })).toEqual({
      isolate: true,
      demand: true,
    });
  });

  it("share makes true share the checkout", () => {
    expect(decideIsolation({ worktree: true, projectDefault: "share", shape: repo })).toEqual({
      isolate: false,
      demand: false,
    });
  });

  it("writes the person-facing sentences the harness reports", () => {
    expect(sharedCheckoutReason({ worktree: true, projectDefault: "decide", shape: noGit })).toBe(
      "No repository here, so this agent shares your checkout.",
    );
    expect(sharedCheckoutReason({ worktree: true, projectDefault: "decide", shape: many })).toBe(
      "This workspace holds 41 repositories, so an agent cannot be isolated from all of them; sharing your checkout.",
    );
    expect(strictIsolationRefusal(noGit)).toMatch(/initialise git/i);
    expect(strictIsolationRefusal(noGit)).toMatch(/worktree false/);
    expect(strictIsolationRefusal(many)).toMatch(/41 repositories/);
    expect(strictIsolationRefusal(many)).toMatch(/worktree false/);
    expect(describeIsolation({ isolate: true, worktree: true, projectDefault: "decide", shape: repo })).toEqual({
      mode: "worktree",
      shape: "repo",
      reason: "This agent works in its own worktree, isolated from your checkout.",
    });
  });
});

describe("WorkspaceIO listing", () => {
  it("treats a missing directory as empty rather than throwing", async () => {
    const io = nodeIo();
    expect(await io.list("/no/such/path/for-workspace-shape")).toEqual([]);
    expect(await io.exists("/no/such/path/for-workspace-shape")).toBe(false);
  });
});
