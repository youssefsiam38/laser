/**
 * Checkpoints, scopes and restore (M18-T2). Real git fixtures; no browser.
 */
import {
  CHECKPOINT_REF_NAMESPACE,
  ErrorCodes,
  PRODUCT_NAME,
  WORKTREES_DIR_NAME,
  checkpointRef,
  type AgentRun,
} from "@lasercode/protocol";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishFailedCheckpoint } from "../src/source-control/capture.js";
import {
  SourceControlService,
  captureCheckpoint,
  checkpointSessionKey,
  sessionRepositories,
  writeCheckpointRetention,
} from "../src/source-control/index.js";
import type { SourceControlDeps } from "../src/source-control/index.js";
import { runGit } from "../src/source-control/git-run.js";

const haveGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-${prefix}-`));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@x",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@x",
  };
  delete env.GIT_INDEX_FILE;
  return execFileSync("git", args, { cwd, env }).toString();
}

function initRepo(dir: string, contents: Record<string, string> = { "a.txt": "one\n" }): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@x"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  for (const [name, body] of Object.entries(contents)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
}

function fingerprint(dir: string) {
  const gitDir = git(dir, ["rev-parse", "--absolute-git-dir"]).trim();
  const indexPath = join(gitDir, "index");
  return {
    index: existsSync(indexPath) ? readFileSync(indexPath) : Buffer.alloc(0),
    porcelain: git(dir, ["status", "--porcelain=v1", "-z"]),
    branch: git(dir, ["branch", "-a"]),
    log: git(dir, ["log", "--oneline"]),
    reflog: git(dir, ["reflog"]),
    worktree: readFileSync(join(dir, "a.txt")),
  };
}

function service(cwd: string, extra: Partial<SourceControlDeps> = {}): SourceControlService {
  return new SourceControlService({
    projectCwd: cwd,
    sessionWorkdir: () => cwd,
    sessionStreaming: () => false,
    agentRun: () => undefined,
    ...extra,
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function slowAddRunner(gate: { started: { resolve: () => void }; release: { promise: Promise<void> } }): SourceControlDeps["runGit"] {
  return async (options) => {
    if (options.args.includes("add") && options.args.includes("-A")) {
      gate.started.resolve();
      await gate.release.promise;
    }
    return runGit(options);
  };
}

const SESSION = "/sessions/demo.jsonl";

function agentRun(over: Partial<AgentRun> & Pick<AgentRun, "runId" | "worktree">): AgentRun {
  return {
    agentName: "worker",
    subagentName: "w",
    sessionId: "s",
    sessionPath: SESSION,
    projectCwd: over.projectCwd ?? "/p",
    rootSessionPath: SESSION,
    depth: 1,
    parent: { sessionPath: SESSION, sessionId: "s" },
    origin: "agent",
    status: "completed",
    task: "t",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe.skipIf(!haveGit)("sessionRepositories", () => {
  it("returns the containing repository, or immediate child repositories", async () => {
    const repo = temp("repo");
    initRepo(repo);
    expect((await sessionRepositories(repo)).map((row) => row.path)).toEqual([repo]);

    const workspace = temp("ws");
    const a = join(workspace, "a");
    const b = join(workspace, "b");
    mkdirSync(a);
    mkdirSync(b);
    mkdirSync(join(workspace, "node_modules"));
    initRepo(a);
    initRepo(b);
    initRepo(join(workspace, "node_modules"));
    const found = (await sessionRepositories(workspace)).map((row) => row.path).sort();
    expect(found).toEqual([a, b].sort());
    expect(await sessionRepositories(temp("plain"))).toEqual([]);
  });
});

describe.skipIf(!haveGit)("checkpoint capture", () => {
  it("leaves the person's index, working tree, branches, log and reflog byte-for-byte unchanged", async () => {
    const dir = temp("untouched");
    initRepo(dir);
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    writeFileSync(join(dir, "notes.md"), "scratch\n");
    git(dir, ["add", "a.txt"]);
    const before = fingerprint(dir);
    const envBefore = process.env.GIT_INDEX_FILE;

    const [repo] = await sessionRepositories(dir);
    const result = await captureCheckpoint({ repo: repo!, sessionPath: SESSION, turn: 0 });
    expect(result.ok).toBe(true);
    const after = fingerprint(dir);
    expect(after.index.equals(before.index)).toBe(true);
    expect(after.porcelain).toBe(before.porcelain);
    expect(after.branch).toBe(before.branch);
    expect(after.log).toBe(before.log);
    expect(after.reflog).toBe(before.reflog);
    expect(after.worktree.equals(before.worktree)).toBe(true);
    expect(process.env.GIT_INDEX_FILE).toBe(envBefore);
    expect(git(dir, ["status", "--porcelain=v1", "-z"])).toContain("notes.md");
  });

  it("captures tracked and new unignored files and excludes ignored secrets", async () => {
    const dir = temp("ignore");
    initRepo(dir, { "a.txt": "one\n", ".gitignore": "secret.env\n" });
    writeFileSync(join(dir, "secret.env"), "TOKEN=super-secret-value\n");
    writeFileSync(join(dir, "new.ts"), "export const n = 1;\n");
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");

    const ctl = service(dir);
    await ctl.captureBaseline(SESSION, dir);
    const listed = await ctl.list(SESSION, dir);
    expect(listed.retention).toBe("200");
    expect(listed.checkpoints).toHaveLength(1);
    const ref = listed.checkpoints[0]!.ref;
    const tree = git(dir, ["ls-tree", "-r", "--name-only", ref]);
    expect(tree).toContain("a.txt");
    expect(tree).toContain("new.ts");
    expect(tree).not.toContain("secret.env");
    expect(() => execFileSync("git", ["cat-file", "-e", `${ref}:secret.env`], { cwd: dir, stdio: "pipe" })).toThrow();
    expect(() => git(dir, ["grep", "-a", "-F", "super-secret-value", ref])).toThrow();
  });
});

describe.skipIf(!haveGit)("scopes", () => {
  it("returns numstat for session, turn and uncommitted, including new files", async () => {
    const dir = temp("scopes");
    initRepo(dir);
    writeFileSync(join(dir, "already.txt"), "before\n");
    const ctl = service(dir);
    await ctl.captureBaseline(SESSION, dir, "entry-0");
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    writeFileSync(join(dir, "created.ts"), "export const x = 1;\n");
    await ctl.captureAfterTurn(SESSION, dir, "entry-1");

    const session = await ctl.changes({ cwd: dir, path: SESSION, scope: "session" });
    expect(session.repos).toHaveLength(1);
    expect(session.repos[0]!.files.map((file) => file.path).sort()).toEqual(["a.txt", "created.ts"]);
    expect(session.repos[0]!.files.find((file) => file.path === "created.ts")).toMatchObject({ status: "added" });
    expect(session.repos[0]!.files.find((file) => file.path === "already.txt")).toBeUndefined();

    const turn = await ctl.changes({ cwd: dir, path: SESSION, scope: "turn", turn: 1 });
    expect(turn.repos[0]!.files.map((file) => file.path).sort()).toEqual(["a.txt", "created.ts"]);

    writeFileSync(join(dir, "extra.md"), "now\n");
    const uncommitted = await ctl.changes({ cwd: dir, path: SESSION, scope: "uncommitted" });
    const names = uncommitted.repos[0]!.files.map((file) => file.path).sort();
    expect(names).toContain("already.txt");
    expect(names).toContain("extra.md");
    expect(names).toContain("a.txt");
    expect(names).toContain("created.ts");
  });

  it("does not list a repository the session never touched", async () => {
    const workspace = temp("multi");
    const touched = join(workspace, "app");
    const other = join(workspace, "lib");
    mkdirSync(touched);
    mkdirSync(other);
    initRepo(touched);
    initRepo(other);
    const ctl = service(workspace, { sessionWorkdir: () => workspace, projectCwd: workspace });
    await ctl.captureBaseline(SESSION, workspace);
    writeFileSync(join(touched, "a.txt"), "changed\n");
    await ctl.captureAfterTurn(SESSION, workspace);
    const session = await ctl.changes({ cwd: workspace, path: SESSION, scope: "session", workdir: workspace });
    expect(session.repos.map((row) => row.repo)).toEqual([touched]);
  });

  it("answers range and agent scopes", async () => {
    const dir = temp("range");
    initRepo(dir);
    const head = git(dir, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(dir, "a.txt"), "two\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-q", "-m", "two"]);
    const ctl = service(dir, {
      agentRun: (runId) =>
        runId === "run_1"
          ? {
              agentName: "worker",
              subagentName: "w",
              sessionId: "s",
              runId: "run_1",
              sessionPath: SESSION,
              projectCwd: dir,
              rootSessionPath: SESSION,
              depth: 1,
              parent: { sessionPath: SESSION, sessionId: "s" },
              worktree: { path: dir, branch: "main", baseCommit: head },
              origin: "agent",
              status: "running",
              task: "t",
              startedAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            }
          : undefined,
    });
    const range = await ctl.changes({ cwd: dir, path: SESSION, scope: "range", fromRef: head, toRef: "HEAD" });
    expect(range.repos[0]!.files.some((file) => file.path === "a.txt" && file.status === "modified")).toBe(true);
    const agent = await ctl.changes({ cwd: dir, path: SESSION, scope: "agent", runId: "run_1" });
    expect(agent.repos[0]!.files.some((file) => file.path === "a.txt")).toBe(true);
  });
});

describe.skipIf(!haveGit)("retention", () => {
  it("defaults to 200, prunes oldest-first, packs refs, and off removes them", { timeout: 20_000 }, async () => {
    const dir = temp("keep");
    initRepo(dir);
    expect((await service(dir).list(SESSION, dir)).retention).toBe("200");
    writeCheckpointRetention(dir, "50");
    const ctl = service(dir);
    await ctl.captureBaseline(SESSION, dir);
    for (let i = 0; i < 52; i++) {
      writeFileSync(join(dir, "a.txt"), `turn ${i}\n`);
      await ctl.captureAfterTurn(SESSION, dir);
    }
    const listed = await ctl.list(SESSION, dir);
    expect(listed.retention).toBe("50");
    expect(listed.checkpoints).toHaveLength(50);
    expect(listed.checkpoints[0]!.turn).toBeGreaterThan(0);
    const packed = readFileSync(join(dir, ".git", "packed-refs"), "utf8");
    expect(packed).toContain(CHECKPOINT_REF_NAMESPACE);

    const session = await ctl.changes({ cwd: dir, path: SESSION, scope: "session" });
    expect(session.pruned?.detail).toMatch(/Older checkpoints were removed/);
    expect(session.pruned?.oldestTurn).toBeGreaterThan(0);
    expect(session.repos[0]!.files.some((file) => file.path === "a.txt")).toBe(true);

    writeCheckpointRetention(dir, "off");
    await ctl.applyRetention(SESSION, "off");
    expect((await ctl.list(SESSION, dir)).checkpoints).toEqual([]);
  });
});

describe.skipIf(!haveGit)("paged payloads", () => {
  it("pages file_diff and file_source rather than sending them whole", async () => {
    const dir = temp("page");
    initRepo(dir);
    const ctl = service(dir);
    await ctl.captureBaseline(SESSION, dir);
    writeFileSync(join(dir, "big.txt"), `${"x".repeat(200)}\n`.repeat(400));
    await ctl.captureAfterTurn(SESSION, dir);
    const diff = await ctl.fileDiff({
      cwd: dir,
      path: SESSION,
      scope: "turn",
      turn: 1,
      repo: dir,
      file: "big.txt",
      offset: 0,
      limit: 64,
    });
    expect(diff.truncated).toBe(true);
    expect(diff.next).toBe(64);
    expect(diff.bytes).toBeLessThanOrEqual(64);
    expect(diff.totalBytes).toBeGreaterThan(64);
    expect(diff.text?.length).toBeGreaterThan(0);

    const source = await ctl.fileSource({ cwd: dir, path: SESSION, repo: dir, file: "big.txt", ref: "worktree", offset: 0, limit: 64 });
    expect(source.truncated).toBe(true);
    expect(source.totalBytes).toBeGreaterThan(64);
  });
});

describe.skipIf(!haveGit)("restore", () => {
  it("names what would be restored and lost, then puts the working tree back without rewriting staging", async () => {
    const dir = temp("undo");
    initRepo(dir);
    writeFileSync(join(dir, "staged.txt"), "keep\n");
    git(dir, ["add", "staged.txt"]);
    writeFileSync(join(dir, "a.txt"), "captured\n");
    const ctl = service(dir);
    await ctl.captureBaseline(SESSION, dir, "leaf-0");
    writeFileSync(join(dir, "a.txt"), "lost\n");
    writeFileSync(join(dir, "danger.txt"), "uncommitted\n");
    const preview = await ctl.restore({ cwd: dir, path: SESSION, turn: 0, restore: "files" });
    expect(preview.restored).toBeUndefined();
    expect(preview.preview.repos[0]!.files.sort()).toEqual(["a.txt", "danger.txt"]);
    expect(preview.preview.repos[0]!.uncommittedLost.sort()).toEqual(["a.txt", "danger.txt"]);
    expect(preview.preview.hidden).not.toContain("files");
    expect(preview.preview.hidden).not.toContain("conversation");
    expect(preview.preview.staging).toBe("not_restored");
    expect(preview.preview.detail).toMatch(/staging is not/i);

    const done = await ctl.restore({ cwd: dir, path: SESSION, turn: 0, restore: "files", confirm: true });
    expect(done.restored?.files).toBe(true);
    expect(done.restored?.conversation).toBe(false);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("captured\n");
    expect(existsSync(join(dir, "danger.txt"))).toBe(false);
    expect(existsSync(join(dir, "staged.txt"))).toBe(true);
    const cached = git(dir, ["diff", "--cached", "--name-only"]);
    expect(cached).toContain("staged.txt");
    expect(cached).not.toContain("a.txt");
  });

  it("is refused with a sentence while a turn is running", async () => {
    const dir = temp("busy");
    initRepo(dir);
    const ctl = service(dir, { sessionStreaming: () => true });
    await expect(ctl.restore({ cwd: dir, path: SESSION, turn: 0, restore: "files", confirm: true })).rejects.toMatchObject({
      code: ErrorCodes.SessionBusy,
      message: expect.stringMatching(/turn is running/i),
    });
  });
});

describe.skipIf(!haveGit)("multi-repository restore", () => {
  it("restores each repository from its own commit and does not clean a repo whose checkpoint is missing", async () => {
    const workspace = temp("multi-restore");
    const repoA = join(workspace, "alpha");
    const repoB = join(workspace, "beta");
    mkdirSync(repoA);
    mkdirSync(repoB);
    initRepo(repoA, { "a.txt": "alpha-one\n" });
    initRepo(repoB, { "b.txt": "beta-one\n" });
    const ctl = service(workspace, { sessionWorkdir: () => workspace, projectCwd: workspace });
    await ctl.captureBaseline(SESSION, workspace);
    writeFileSync(join(repoA, "a.txt"), "alpha-two\n");
    writeFileSync(join(repoA, "keep-a.txt"), "keep-a\n");
    writeFileSync(join(repoB, "b.txt"), "beta-two\n");
    writeFileSync(join(repoB, "keep-b.txt"), "keep-b\n");
    await ctl.captureAfterTurn(SESSION, workspace);
    const first = await ctl.list(SESSION, workspace);
    const turn = first.checkpoints[first.checkpoints.length - 1]!.turn;
    const commitA = first.checkpoints.at(-1)?.repos?.find((row) => row.repo === repoA)?.commit;
    const commitB = first.checkpoints.at(-1)?.repos?.find((row) => row.repo === repoB)?.commit;
    expect(commitA).toBeTruthy();
    expect(commitB).toBeTruthy();
    expect(commitA).not.toBe(commitB);

    writeFileSync(join(repoA, "a.txt"), "alpha-lost\n");
    writeFileSync(join(repoA, "extra-a.txt"), "extra-a\n");
    writeFileSync(join(repoB, "b.txt"), "beta-lost\n");
    writeFileSync(join(repoB, "extra-b.txt"), "extra-b\n");

    const preview = await ctl.restore({ cwd: workspace, path: SESSION, turn, restore: "files" });
    expect(preview.preview.repos.find((row) => row.repo === repoB)?.files).toEqual(
      expect.arrayContaining(["b.txt", "extra-b.txt"]),
    );

    git(repoB, ["update-ref", "-d", first.checkpoints.at(-1)!.ref]);
    const done = await ctl.restore({ cwd: workspace, path: SESSION, turn, restore: "files", confirm: true });
    expect(done.restored?.files).toBe(true);
    expect(readFileSync(join(repoA, "a.txt"), "utf8")).toBe("alpha-two\n");
    expect(existsSync(join(repoA, "keep-a.txt"))).toBe(true);
    expect(existsSync(join(repoA, "extra-a.txt"))).toBe(false);
    expect(readFileSync(join(repoB, "b.txt"), "utf8")).toBe("beta-lost\n");
    expect(existsSync(join(repoB, "keep-b.txt"))).toBe(true);
    expect(existsSync(join(repoB, "extra-b.txt"))).toBe(true);
    expect(done.restored?.repos?.find((row) => row.repo === repoA)?.restored).toBe(true);
    expect(done.restored?.repos?.find((row) => row.repo === repoB)?.restored).toBe(false);
    expect(done.restored?.repos?.find((row) => row.repo === repoB)?.detail).toMatch(/not in this repository|left unchanged/i);
  });

  it("refuses a caller-controlled workdir on the write path", async () => {
    const dir = temp("restore-cwd");
    initRepo(dir);
    const ctl = service(dir);
    await ctl.captureBaseline(SESSION, dir);
    await expect(
      ctl.restore({ cwd: dir, path: SESSION, turn: 0, restore: "files", confirm: true, workdir: temp("foreign") }),
    ).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
      message: expect.stringMatching(/working files/i),
    });
  });
});

describe.skipIf(!haveGit)("agent-scope file_diff", () => {
  it("opens a diff in a child worktree that is a different path", async () => {
    const parent = temp("agent-parent");
    const child = temp("agent-child");
    initRepo(parent);
    initRepo(child, { "a.txt": "child-base\n" });
    const head = git(child, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(child, "only-child.ts"), "export const n = 1;\n");
    const ctl = service(parent, {
      agentRun: (runId) =>
        runId === "run_child"
          ? {
              agentName: "worker",
              subagentName: "w",
              sessionId: "s",
              runId: "run_child",
              sessionPath: SESSION,
              projectCwd: parent,
              rootSessionPath: SESSION,
              depth: 1,
              parent: { sessionPath: SESSION, sessionId: "s" },
              worktree: { path: child, branch: "main", baseCommit: head },
              origin: "agent",
              status: "running",
              task: "t",
              startedAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            }
          : undefined,
    });
    const changes = await ctl.changes({ cwd: parent, path: SESSION, scope: "agent", runId: "run_child" });
    expect(changes.repos.map((row) => row.repo)).toEqual([child]);
    expect(changes.repos[0]!.files.some((file) => file.path === "only-child.ts")).toBe(true);
    const diff = await ctl.fileDiff({
      cwd: parent,
      path: SESSION,
      scope: "agent",
      runId: "run_child",
      repo: child,
      file: "only-child.ts",
    });
    expect(diff.text).toMatch(/export const n/);
    const source = await ctl.fileSource({
      cwd: parent,
      path: SESSION,
      runId: "run_child",
      repo: child,
      file: "only-child.ts",
      ref: "worktree",
    });
    expect(source.text).toMatch(/export const n/);
  });
});

describe.skipIf(!haveGit)("capture numbering", () => {
  it("snapshots a prompt once by entry id and hides files when the tree matches", async () => {
    const dir = temp("prompt-id");
    initRepo(dir);
    const ctl = service(dir);
    await ctl.captureBaseline(SESSION, dir, "leaf-0");
    await ctl.captureForPrompt(SESSION, dir, "user-1");
    await ctl.captureForPrompt(SESSION, dir, "user-1");
    await ctl.captureForPrompt(SESSION, dir, "user-2");
    const listed = await ctl.list(SESSION, dir);
    expect(listed.checkpoints.filter((row) => !row.failed).map((row) => row.entryId)).toEqual([
      "leaf-0",
      "user-1",
      "user-2",
    ]);
    const preview = await ctl.restore({ cwd: dir, path: SESSION, turn: listed.checkpoints.find((row) => row.entryId === "user-2")!.turn, restore: "both" });
    expect(preview.preview.repos[0]!.files).toEqual([]);
    expect(preview.preview.repos[0]!.uncommittedLost).toEqual([]);
    expect(preview.preview.hidden).toContain("files");
  });

  it("keeps a whitespace-bearing entry id and does not reuse a failed turn number", async () => {
    const dir = temp("turns");
    initRepo(dir);
    const ctl = service(dir);
    await ctl.captureBaseline(SESSION, dir, "leaf with spaces");
    const [repo] = await sessionRepositories(dir);
    const baseline = (await ctl.list(SESSION, dir)).checkpoints[0];
    expect(baseline?.entryId).toBe("leaf with spaces");
    expect(await publishFailedCheckpoint({ repo: repo!, sessionPath: SESSION, turn: 1 }, baseline?.commit)).toBe(true);
    writeFileSync(join(dir, "a.txt"), "after-fail\n");
    await ctl.captureAfterTurn(SESSION, dir, "leaf-2");
    const listed = await ctl.list(SESSION, dir);
    expect(listed.checkpoints.map((row) => ({ turn: row.turn, failed: row.failed ?? false }))).toEqual([
      { turn: 0, failed: false },
      { turn: 1, failed: true },
      { turn: 2, failed: false },
    ]);
    await expect(ctl.changes({ cwd: dir, path: SESSION, scope: "turn", turn: 0 })).rejects.toMatchObject({
      code: ErrorCodes.InvalidParams,
      message: expect.stringMatching(/baseline/i),
    });
    const failedTurn = await ctl.changes({ cwd: dir, path: SESSION, scope: "turn", turn: 1 });
    expect(failedTurn.pruned?.detail).toMatch(/not captured/i);
    expect(failedTurn.repos).toEqual([]);
  });

  it("reuses one durable isolated index per repository", async () => {
    const dir = temp("index");
    initRepo(dir);
    const ctl = service(dir);
    await ctl.captureBaseline(SESSION, dir);
    writeFileSync(join(dir, "a.txt"), "now\n");
    await ctl.changes({ cwd: dir, path: SESSION, scope: "session" });
    const gitDir = git(dir, ["rev-parse", "--absolute-git-dir"]).trim();
    expect(existsSync(join(gitDir, `${PRODUCT_NAME}-checkpoint-index`))).toBe(true);
  });
});

it("derives checkpoint refs from the product name, never a literal", () => {
  const key = checkpointSessionKey(SESSION);
  expect(checkpointRef(key, 3)).toBe(`${CHECKPOINT_REF_NAMESPACE}/${key}/3`);
  expect(checkpointRef(key, 3).startsWith("refs/")).toBe(true);
});

describe.skipIf(!haveGit)("agent scope §8.5", () => {
  it("covers a live worktree, a shared checkout, a removed worktree whose branch survives, and a gone branch", async () => {
    const parent = temp("agent-scope-parent");
    initRepo(parent, { "root.txt": "root\n" });
    const base = git(parent, ["rev-parse", "HEAD"]).trim();
    const child = join(parent, WORKTREES_DIR_NAME, "review");
    mkdirSync(join(parent, WORKTREES_DIR_NAME), { recursive: true });
    git(parent, ["worktree", "add", "-b", "agents/review", child]);
    writeFileSync(join(child, "only-child.ts"), "export const n = 1;\n");
    git(child, ["add", "only-child.ts"]);
    git(child, ["commit", "-q", "-m", "child"]);

    const live = agentRun({
      runId: "run_live",
      projectCwd: parent,
      worktree: { path: child, branch: "agents/review", baseCommit: base },
    });
    const liveCtl = service(parent, { agentRun: (id) => (id === live.runId ? live : undefined) });
    const withTree = await liveCtl.changes({ cwd: parent, path: SESSION, scope: "agent", runId: live.runId });
    expect(withTree.agent).toEqual({ runId: live.runId });
    expect(withTree.repos.map((row) => row.repo)).toEqual([child]);
    expect(withTree.repos[0]!.files.some((file) => file.path === "only-child.ts")).toBe(true);

    const sharedDir = temp("agent-scope-shared");
    initRepo(sharedDir);
    const sharedCtl = service(sharedDir, {
      agentRun: (id) => (id === "run_shared" ? agentRun({ runId: "run_shared", projectCwd: sharedDir, worktree: null }) : undefined),
    });
    await sharedCtl.captureBaseline(SESSION, sharedDir);
    writeFileSync(join(sharedDir, "shared.ts"), "export const s = 1;\n");
    await sharedCtl.captureAfterTurn(SESSION, sharedDir);
    const shared = await sharedCtl.changes({ cwd: sharedDir, path: SESSION, scope: "agent", runId: "run_shared" });
    expect(shared.agent).toEqual({ runId: "run_shared" });
    expect(shared.agent?.worktreeRemoved).toBeUndefined();
    expect(shared.repos[0]!.files.some((file) => file.path === "shared.ts")).toBe(true);

    git(parent, ["worktree", "remove", child]);
    const removed = agentRun({
      runId: "run_removed",
      projectCwd: parent,
      worktree: {
        path: child,
        branch: "agents/review",
        baseCommit: base,
        removedAt: "2026-09-20T00:00:00.000Z",
      },
    });
    const removedCtl = service(parent, { agentRun: (id) => (id === removed.runId ? removed : undefined) });
    const surviving = await removedCtl.changes({
      cwd: parent,
      path: SESSION,
      scope: "agent",
      runId: removed.runId,
    });
    expect(surviving.agent).toEqual({ runId: removed.runId, worktreeRemoved: true });
    expect(surviving.agent?.branchGone).toBeUndefined();
    expect(surviving.repos[0]!.files.some((file) => file.path === "only-child.ts")).toBe(true);

    git(parent, ["branch", "-D", "agents/review"]);
    const goneCtl = service(parent, { agentRun: (id) => (id === removed.runId ? removed : undefined) });
    const gone = await goneCtl.changes({ cwd: parent, path: SESSION, scope: "agent", runId: removed.runId });
    expect(gone.agent).toEqual({ runId: removed.runId, worktreeRemoved: true, branchGone: true });
    expect(gone.repos).toEqual([]);
  });
});

describe.skipIf(!haveGit)("baseline race", () => {
  it("does not put the first turn's new file in the open-time baseline", async () => {
    const dir = temp("baseline-race");
    initRepo(dir, { "src/index.ts": "export {}\n" });
    const started = deferred();
    const release = deferred();
    const ctl = service(dir, { runGit: slowAddRunner({ started, release }) });

    void ctl.captureBaseline(SESSION, dir);
    await started.promise;

    const firstTurn = (async () => {
      await ctl.awaitBaseline(SESSION);
      writeFileSync(join(dir, "src/feature.ts"), "export const feature = 1;\n");
      writeFileSync(join(dir, "src/index.ts"), "export { feature } from \"./feature.ts\";\n");
      await ctl.captureAfterTurn(SESSION, dir);
    })();

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(existsSync(join(dir, "src/feature.ts"))).toBe(false);

    release.resolve();
    await firstTurn;

    const listed = await ctl.list(SESSION, dir);
    const baseline = listed.checkpoints.find((row) => row.turn === 0);
    expect(baseline?.failed).toBeFalsy();
    const tree = git(dir, ["ls-tree", "-r", "--name-only", baseline!.ref]);
    expect(tree).not.toMatch(/src\/feature\.ts/);
    expect(tree).toMatch(/src\/index\.ts/);

    const turn = await ctl.changes({ cwd: dir, path: SESSION, scope: "turn", turn: 1 });
    expect(turn.pruned).toBeUndefined();
    expect(turn.repos[0]!.files.some((file) => file.path === "src/feature.ts" && file.status === "added")).toBe(true);
  });

  it("does not recapture a timed-out baseline as the first turn's tree", async () => {
    const dir = temp("baseline-timeout");
    initRepo(dir, { "src/index.ts": "export {}\n" });
    const started = deferred();
    const release = deferred();
    const ctl = service(dir, { runGit: slowAddRunner({ started, release }) });

    void ctl.captureBaseline(SESSION, dir);
    await started.promise;
    await ctl.awaitBaseline(SESSION, 50);
    expect((await ctl.list(SESSION, dir)).lastError).toMatch(/too long/i);
    writeFileSync(join(dir, "src/feature.ts"), "export const feature = 1;\n");
    const after = ctl.captureAfterTurn(SESSION, dir);
    release.resolve();
    await after;
    await ctl.captureBaseline(SESSION, dir);

    const listed = await ctl.list(SESSION, dir);
    const baseline = listed.checkpoints.find((row) => row.turn === 0);
    expect(baseline?.failed).toBe(true);
    if (baseline) {
      const tree = git(dir, ["ls-tree", "-r", "--name-only", baseline.ref]);
      expect(tree).not.toMatch(/src\/feature\.ts/);
    }

    const session = await ctl.changes({ cwd: dir, path: SESSION, scope: "session" });
    expect(session.pruned?.detail).toMatch(/no longer starts at the beginning|No checkpoints are kept/i);
    const turn = await ctl.changes({ cwd: dir, path: SESSION, scope: "turn", turn: 1 });
    expect(turn.pruned?.detail).toMatch(/no longer kept|not captured/i);
    expect(turn.repos).toEqual([]);
  });
});
