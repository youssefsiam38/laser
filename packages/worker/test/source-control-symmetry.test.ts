/**
 * The rail and the body must agree, in every scope and for every change kind
 * (M20-T5).
 *
 * The defect this pins: the uncommitted scope lists a new, unignored file as
 * an addition with the lines it has on disk (`untrackedAsAdded`), while
 * `pi/project/file_diff` ran `git diff HEAD -- <path>`, and git says nothing
 * about a path it does not track. Every added file in that scope was listed
 * `+N` and opened with nothing in it. Before the fix, `uncommitted · added`
 * below reports `+9` from `changes` and `0` added lines from `file_diff`.
 *
 * The invariant asserted here is the person's own sentence: **if the list says
 * `+N`, the patch carries N added lines** (and the same for deletions), and a
 * file the body cannot show as text is listed without a line count at all.
 */
import { PRODUCT_NAME, type AgentRun } from "@lasercode/protocol";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SourceControlService } from "../src/source-control/index.js";
import type { ProjectChangesParams } from "@lasercode/protocol";

const haveGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const SESSION = "/sessions/demo.jsonl";
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
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
  delete env.GIT_INDEX_FILE;
  return execFileSync("git", args, { cwd, env }).toString();
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@x"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "index.ts"), "one\ntwo\nthree\n");
  writeFileSync(join(dir, "legacy.ts"), "gone\n");
  writeFileSync(join(dir, "moved.ts"), "moved\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
}

/** Every change kind at once: added, modified, deleted, renamed and binary. */
function makeEveryKind(dir: string): void {
  writeFileSync(join(dir, "feature.ts"), Array.from({ length: 9 }, (_, i) => `export const n${i} = ${i};`).join("\n") + "\n");
  writeFileSync(join(dir, "added.ts"), "a\nb\nc\nd\n");
  writeFileSync(join(dir, "index.ts"), "one\nTWO\nthree\nfour\nfive\nsix\nseven\n");
  unlinkSync(join(dir, "legacy.ts"));
  unlinkSync(join(dir, "moved.ts"));
  writeFileSync(join(dir, "renamed.ts"), "moved\n");
  writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 4]));
}

function service(cwd: string, agentRun?: (runId: string) => AgentRun | undefined): SourceControlService {
  return new SourceControlService({
    projectCwd: cwd,
    sessionWorkdir: () => cwd,
    sessionStreaming: () => false,
    agentRun: agentRun ?? (() => undefined),
  });
}

/** What the body would actually draw: the patch's own `+`/`-` lines. */
function patchLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/**
 * Walks every file the list reports for a scope and holds the body to it.
 * Returns the rows it checked so a test can prove the fixture really covered
 * the kinds it claims to.
 */
async function assertScopeAgrees(
  ctl: SourceControlService,
  params: ProjectChangesParams,
): Promise<Array<{ path: string; added: number | null; removed: number | null }>> {
  const changes = await ctl.changes(params);
  const rows: Array<{ path: string; added: number | null; removed: number | null }> = [];
  for (const repo of changes.repos) {
    for (const file of repo.files) {
      rows.push({ path: file.path, added: file.added, removed: file.removed });
      const slice = await ctl.fileDiff({ ...params, repo: repo.repo, file: file.path });
      const patch = slice.text ?? "";
      if (file.added === null || file.removed === null) {
        // No line count promised, so nothing to keep: the body says what it is.
        expect(patch === "" || /Binary files .* differ|GIT binary patch/.test(patch)).toBe(true);
        continue;
      }
      const drawn = patchLines(patch);
      expect({ path: `${params.scope}:${file.path}`, ...drawn }).toEqual({
        path: `${params.scope}:${file.path}`,
        added: file.added,
        removed: file.removed,
      });
    }
  }
  return rows;
}

describe.skipIf(!haveGit)("the rail and the body agree", () => {
  it("uncommitted: an added file renders the lines its row promised", async () => {
    const dir = temp("sym-uncommitted");
    initRepo(dir);
    makeEveryKind(dir);
    const ctl = service(dir);

    const rows = await assertScopeAgrees(ctl, { cwd: dir, path: SESSION, scope: "uncommitted" });
    const byPath = new Map(rows.map((row) => [row.path, row]));
    // The fixture really does cover the kinds this is about.
    expect(byPath.get("feature.ts")).toEqual({ path: "feature.ts", added: 9, removed: 0 });
    expect(byPath.get("added.ts")).toEqual({ path: "added.ts", added: 4, removed: 0 });
    expect(byPath.get("renamed.ts")).toEqual({ path: "renamed.ts", added: 1, removed: 0 });
    expect(byPath.get("legacy.ts")).toEqual({ path: "legacy.ts", added: 0, removed: 1 });
    expect(byPath.get("index.ts")?.added).toBeGreaterThan(0);
    expect(byPath.get("logo.png")).toEqual({ path: "logo.png", added: null, removed: 0 });
  });

  it("uncommitted: a new file with no trailing newline, in a subdirectory, and a symlink", async () => {
    const dir = temp("sym-edges");
    initRepo(dir);
    writeFileSync(join(dir, "no-newline.ts"), "just one line");
    execFileSync("mkdir", ["-p", join(dir, "sub", "deep")]);
    writeFileSync(join(dir, "sub", "deep", "nested.ts"), "x\ny\n");
    execFileSync("ln", ["-s", "index.ts", join(dir, "link.ts")]);
    const ctl = service(dir);

    const rows = await assertScopeAgrees(ctl, { cwd: dir, path: SESSION, scope: "uncommitted" });
    const byPath = new Map(rows.map((row) => [row.path, row]));
    expect(byPath.get("no-newline.ts")?.added).toBe(1);
    expect(byPath.get("sub/deep/nested.ts")?.added).toBe(2);
    // A symlink is one line to git — the path it points at — and the row says so.
    expect(byPath.get("link.ts")?.added).toBe(1);
  });

  it("session and turn: a file new since the checkpoint renders its added lines", async () => {
    const dir = temp("sym-session");
    initRepo(dir);
    const ctl = service(dir);
    await ctl.captureBaseline(SESSION, dir);
    makeEveryKind(dir);
    await ctl.captureAfterTurn(SESSION, dir);

    const session = await assertScopeAgrees(ctl, { cwd: dir, path: SESSION, scope: "session" });
    expect(new Map(session.map((row) => [row.path, row])).get("feature.ts")).toEqual({ path: "feature.ts", added: 9, removed: 0 });

    const turn = await assertScopeAgrees(ctl, { cwd: dir, path: SESSION, scope: "turn", turn: 1 });
    expect(new Map(turn.map((row) => [row.path, row])).get("added.ts")).toEqual({ path: "added.ts", added: 4, removed: 0 });
  });

  it("range: both ends are commits and every kind agrees", async () => {
    const dir = temp("sym-range");
    initRepo(dir);
    const from = git(dir, ["rev-parse", "HEAD"]).trim();
    makeEveryKind(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "everything"]);
    const to = git(dir, ["rev-parse", "HEAD"]).trim();
    const ctl = service(dir);

    const rows = await assertScopeAgrees(ctl, { cwd: dir, path: SESSION, scope: "range", fromRef: from, toRef: to });
    expect(new Map(rows.map((row) => [row.path, row])).get("feature.ts")).toEqual({ path: "feature.ts", added: 9, removed: 0 });
  });

  it("agent: a child's new file in its own worktree renders its added lines", async () => {
    const parent = temp("sym-agent-parent");
    const child = temp("sym-agent-child");
    initRepo(parent);
    initRepo(child);
    const base = git(child, ["rev-parse", "HEAD"]).trim();
    makeEveryKind(child);
    const run: AgentRun = {
      agentName: "worker",
      subagentName: "w",
      sessionId: "s",
      runId: "run_child",
      sessionPath: SESSION,
      projectCwd: parent,
      rootSessionPath: SESSION,
      depth: 1,
      parent: { sessionPath: SESSION, sessionId: "s" },
      worktree: { path: child, branch: "main", baseCommit: base },
      origin: "agent",
      status: "running",
      task: "t",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as AgentRun;
    const ctl = service(parent, (runId) => (runId === "run_child" ? run : undefined));

    const rows = await assertScopeAgrees(ctl, { cwd: parent, path: SESSION, scope: "agent", runId: "run_child", workdir: child });
    expect(new Map(rows.map((row) => [row.path, row])).get("feature.ts")).toEqual({ path: "feature.ts", added: 9, removed: 0 });
  });
});
