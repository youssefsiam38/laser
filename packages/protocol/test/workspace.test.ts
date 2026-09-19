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
  WORKSPACE_SCAN_MAX_DEPTH,
  WORKSPACE_SCAN_MAX_REPOS,
  WorkspaceResolver,
  listCheckpointRepositories,
  resolveIsolation,
  resolveWorkspaceShape,
  workspaceCanIsolate,
  worktreesHome,
  type WorkspaceIO,
  type WorkspaceShape,
} from "../src/workspace.js";

const haveGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
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

function repoFields(root: string, cwd: string, extras?: { projectRoot?: boolean }): {
  root: string;
  name: string;
  projectRoot: boolean;
} {
  return {
    root: resolve(root),
    name: basename(root),
    projectRoot: extras?.projectRoot ?? resolve(root) === resolve(cwd),
  };
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
    expect(shape.hasCommit).toBe(true);
    expect(shape.truncated).toBe(false);
    expect(shape.repositories).toHaveLength(1);
    expect(shape.repositories[0]).toMatchObject(repoFields(repo, repo, { projectRoot: true }));
    expect(shape.repositories[0]?.insideWorkTree).toBe(true);
    expect(shape.repositories[0]?.gitDir).toBe(resolve(repo, ".git"));
    const nestedDir = await resolveWorkspaceShape(join(repo, "packages", "ui"), io);
    expect(nestedDir.kind).toBe("repo");
    expect(nestedDir.repositories[0]?.root).toBe(resolve(repo));
    expect(nestedDir.repositories[0]?.projectRoot).toBe(false);
    expect(nestedDir.repositories[0]?.insideWorkTree).toBe(true);
    expect(listCheckpointRepositories(shape)).toEqual([{ path: resolve(repo), gitDir: resolve(repo, ".git") }]);
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
    expect(shape.hasCommit).toBe(false);
    expect(shape.truncated).toBe(false);
    expect(shape.repositories.map((row) => row.name).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(shape.repositories.every((row) => row.projectRoot === false)).toBe(true);
    expect(shape.repositories.every((row) => row.insideWorkTree)).toBe(true);
    expect(workspaceCanIsolate(shape)).toBe(false);
    expect(listCheckpointRepositories(shape).map((row) => basename(row.path)).sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("resolves a directory with no git at all", async () => {
    const root = scratch();
    const plain = join(root, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "file.txt"), "x\n");
    const shape = await resolveWorkspaceShape(plain, nodeIo());
    expect(shape).toEqual({
      cwd: resolve(plain),
      kind: "no-git",
      repositories: [],
      hasCommit: false,
      truncated: false,
    });
    expect(workspaceCanIsolate(shape)).toBe(false);
    expect(listCheckpointRepositories(shape)).toEqual([]);
  });

  it("resolves a repository nested inside another repository from the outer cwd", async () => {
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
    // Parent directories are not walked: an inner project is its own repo.
    expect(fromInner.kind).toBe("repo");
    expect(fromInner.repositories[0]?.root).toBe(resolve(inner));
    expect(fromInner.repositories[0]?.projectRoot).toBe(true);
    expect(workspaceCanIsolate(fromInner)).toBe(true);
  });

  it("does not relabel a project because an ancestor directory is a repository", async () => {
    const root = scratch();
    const home = join(root, "home");
    initRepo(home);
    const project = join(home, "projects", "app");
    initRepo(project);
    const shape = await resolveWorkspaceShape(project, nodeIo());
    expect(shape.kind).toBe("repo");
    expect(shape.repositories[0]?.root).toBe(resolve(project));
    expect(workspaceCanIsolate(shape)).toBe(true);
  });

  it("resolves a repository that lists submodules as an ordinary repo", async () => {
    const root = scratch();
    const repo = join(root, "with-modules");
    initRepo(repo);
    writeFileSync(join(repo, ".gitmodules"), "[submodule \"vendor\"]\n\tpath = vendor\n\turl = ./vendor\n");
    const shape = await resolveWorkspaceShape(repo, nodeIo());
    expect(shape.kind).toBe("repo");
    expect(shape.repositories[0]?.projectRoot).toBe(true);
    expect(workspaceCanIsolate(shape)).toBe(true);
  });

  it("resolves a bare repository as bare-or-submodule and never checkpoints it", async () => {
    const root = scratch();
    const bare = join(root, "bare.git");
    mkdirSync(bare);
    git(bare, "init", "-q", "--bare");
    const shape = await resolveWorkspaceShape(bare, nodeIo());
    expect(shape.kind).toBe("bare-or-submodule");
    expect(shape.repositories[0]?.insideWorkTree).toBe(false);
    expect(workspaceCanIsolate(shape)).toBe(false);
    expect(listCheckpointRepositories(shape)).toEqual([]);
  });

  it("degrades an empty repository to shared and refuses only under strict", async () => {
    const root = scratch();
    const empty = join(root, "empty");
    mkdirSync(empty);
    git(empty, "init", "-q", "-b", "main");
    const shape = await resolveWorkspaceShape(empty, nodeIo());
    expect(shape.kind).toBe("repo");
    expect(shape.hasCommit).toBe(false);
    expect(workspaceCanIsolate(shape)).toBe(false);
    expect(resolveIsolation({ worktree: true, projectDefault: "decide", shape })).toEqual({
      kind: "shared",
      isolation: {
        mode: "shared",
        shape: "repo",
        reason: "This repository has no commits yet, so this agent shares your checkout.",
      },
    });
    const refused = resolveIsolation({ worktree: "strict", projectDefault: "decide", shape });
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") {
      expect(refused.message).toMatch(/no commits yet/);
      expect(refused.message).toMatch(/worktree false/);
    }
  });

  it("resolves a linked worktree as repo against the common dir", async () => {
    const root = scratch();
    const main = join(root, "main");
    initRepo(main);
    const linked = join(root, "linked");
    git(main, "worktree", "add", "-q", linked);
    const shape = await resolveWorkspaceShape(linked, nodeIo());
    expect(shape.kind).toBe("repo");
    expect(shape.hasCommit).toBe(true);
    expect(shape.repositories[0]?.projectRoot).toBe(true);
    expect(shape.repositories[0]?.root).toBe(resolve(linked));
    expect(shape.repositories[0]?.insideWorkTree).toBe(true);
    expect(shape.repositories[0]?.gitDir).toBe(resolve(main, ".git"));
    expect(worktreesHome(shape.repositories[0]!.gitDir, resolve(linked), { basename, dirname })).toBe(resolve(main));
    expect(workspaceCanIsolate(shape)).toBe(true);
  });

  it("does not find a repository past WORKSPACE_SCAN_MAX_DEPTH", async () => {
    expect(WORKSPACE_SCAN_MAX_DEPTH).toBe(3);
    const root = scratch();
    const workspace = join(root, "ws");
    mkdirSync(workspace);
    const edge = join(workspace, "a", "b", "edge");
    initRepo(edge);
    const tooDeep = join(workspace, "a", "b", "c", "miss");
    initRepo(tooDeep);
    const shape = await resolveWorkspaceShape(workspace, nodeIo());
    expect(shape.kind).toBe("workspace-of-repos");
    expect(shape.repositories.map((row) => row.root).sort()).toEqual([resolve(edge)]);
  });

  it("stops at WORKSPACE_SCAN_MAX_REPOS and reports truncated", async () => {
    expect(WORKSPACE_SCAN_MAX_REPOS).toBe(64);
    const root = scratch();
    const workspace = join(root, "ws");
    mkdirSync(workspace);
    for (let i = 0; i < WORKSPACE_SCAN_MAX_REPOS + 1; i++) {
      initRepo(join(workspace, `r${String(i).padStart(2, "0")}`));
    }
    const shape = await resolveWorkspaceShape(workspace, nodeIo());
    expect(shape.kind).toBe("workspace-of-repos");
    expect(shape.repositories).toHaveLength(WORKSPACE_SCAN_MAX_REPOS);
    expect(shape.truncated).toBe(true);
    const shared = resolveIsolation({ worktree: true, projectDefault: "decide", shape });
    expect(shared.kind).toBe("shared");
    if (shared.kind === "shared") {
      expect(shared.isolation.reason).toContain(`more than ${WORKSPACE_SCAN_MAX_REPOS}`);
    }
  });

  it("does not descend into a found repository, so vendored copies do not inflate the count", async () => {
    const root = scratch();
    const workspace = join(root, "ws");
    mkdirSync(workspace);
    const keep = join(workspace, "keep");
    initRepo(keep);
    initRepo(join(keep, "vendor-copy"));
    const shape = await resolveWorkspaceShape(workspace, nodeIo());
    expect(shape.repositories.map((row) => row.name)).toEqual(["keep"]);
    expect(shape.truncated).toBe(false);
  });

  it("caches the in-flight promise so concurrent resolves walk once", async () => {
    const root = scratch();
    const repo = join(root, "app");
    initRepo(repo);
    const inner = nodeIo();
    let runs = 0;
    const counting: WorkspaceIO = {
      ...inner,
      run(args, cwd) {
        runs += 1;
        return inner.run(args, cwd);
      },
    };
    const resolver = new WorkspaceResolver(counting);
    const [a, b] = await Promise.all([resolver.resolve(repo), resolver.resolve(repo)]);
    expect(a).toBe(b);
    const firstRuns = runs;
    expect(firstRuns).toBeGreaterThan(0);
    await resolver.resolve(repo);
    expect(runs).toBe(firstRuns);
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

function fixture(partial: Pick<WorkspaceShape, "kind"> & Partial<WorkspaceShape>): WorkspaceShape {
  return {
    cwd: "/p",
    repositories: [],
    hasCommit: false,
    truncated: false,
    ...partial,
  };
}

describe("isolation precedence", () => {
  const noGit = fixture({ kind: "no-git" });
  const repo = fixture({
    kind: "repo",
    hasCommit: true,
    repositories: [{ root: "/p", name: "p", projectRoot: true, gitDir: "/p/.git", insideWorkTree: true }],
  });
  const many = fixture({
    kind: "workspace-of-repos",
    repositories: Array.from({ length: 41 }, (_, i) => ({
      root: `/p/r${i}`,
      name: `r${i}`,
      projectRoot: false,
      gitDir: `/p/r${i}/.git`,
      insideWorkTree: true,
    })),
  });

  it("defaults the project setting to decide", () => {
    expect(AGENT_ISOLATION_DEFAULT).toBe("decide");
  });

  it("false always shares, even when the project prefers isolation", () => {
    expect(resolveIsolation({ worktree: false, projectDefault: "isolate", shape: repo })).toEqual({
      kind: "shared",
      isolation: {
        mode: "shared",
        shape: "repo",
        reason: "This agent shares your checkout because it was started with worktree false.",
      },
    });
  });

  it("strict always demands isolation", () => {
    const refused = resolveIsolation({ worktree: "strict", projectDefault: "share", shape: noGit });
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") {
      expect(refused.message).toMatch(/initialise git/i);
      expect(refused.message).toMatch(/worktree false/);
    }
  });

  it("decide + true isolates a repo and shares a workspace of repos", () => {
    expect(resolveIsolation({ worktree: true, projectDefault: "decide", shape: repo })).toEqual({
      kind: "worktree",
      isolation: {
        mode: "worktree",
        shape: "repo",
        reason: "This agent works in its own worktree, isolated from your checkout.",
      },
    });
    expect(resolveIsolation({ worktree: true, projectDefault: "decide", shape: many })).toMatchObject({
      kind: "shared",
      isolation: {
        mode: "shared",
        shape: "workspace-of-repos",
        reason: "This workspace holds 41 repositories, so an agent cannot be isolated from all of them; sharing your checkout.",
      },
    });
  });

  it("isolate makes true behave like strict", () => {
    const refused = resolveIsolation({ worktree: true, projectDefault: "isolate", shape: many });
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") {
      expect(refused.message).toMatch(/41 repositories/);
      expect(refused.message).toMatch(/worktree false/);
    }
  });

  it("share makes true share the checkout", () => {
    expect(resolveIsolation({ worktree: true, projectDefault: "share", shape: repo })).toEqual({
      kind: "shared",
      isolation: {
        mode: "shared",
        shape: "repo",
        reason: "This project is set to share your checkout, so this agent is not isolated.",
      },
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
