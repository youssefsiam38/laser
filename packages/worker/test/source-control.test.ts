/**
 * Checkpoints, scopes and restore (M18-T2). Real git fixtures; no browser.
 */
import { CHECKPOINT_REF_NAMESPACE, ErrorCodes, PRODUCT_NAME, checkpointRef } from "@lasercode/protocol";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SourceControlService,
  captureCheckpoint,
  checkpointSessionKey,
  sessionRepositories,
  writeCheckpointRetention,
} from "../src/source-control/index.js";
import type { SourceControlDeps } from "../src/source-control/index.js";

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

const SESSION = "/sessions/demo.jsonl";

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
    expect(session.repos).toEqual([]);

    writeCheckpointRetention(dir, "off");
    await ctl.captureAfterTurn(SESSION, dir);
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
  it("names what would be restored and lost, then puts files and staging back", async () => {
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
    expect(preview.preview.repos[0]!.uncommittedLost).toEqual(expect.arrayContaining(["a.txt", "danger.txt", "staged.txt"]));
    expect(preview.preview.hidden).not.toContain("files");

    const done = await ctl.restore({ cwd: dir, path: SESSION, turn: 0, restore: "files", confirm: true });
    expect(done.restored).toEqual({ files: true, conversation: false });
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("captured\n");
    expect(existsSync(join(dir, "danger.txt"))).toBe(false);
    expect(existsSync(join(dir, "staged.txt"))).toBe(true);
    const cached = git(dir, ["diff", "--cached", "--name-only"]);
    expect(cached).toContain("staged.txt");
    expect(cached).toContain("a.txt");
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

it("derives checkpoint refs from the product name, never a literal", () => {
  const key = checkpointSessionKey(SESSION);
  expect(checkpointRef(key, 3)).toBe(`${CHECKPOINT_REF_NAMESPACE}/${key}/3`);
  expect(checkpointRef(key, 3).startsWith("refs/")).toBe(true);
});
