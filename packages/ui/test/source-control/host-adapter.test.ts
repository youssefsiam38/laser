import { expect, it } from "vitest";
import type { AgentRun, FileSlice, ProjectChanges } from "@lasercode/protocol";
import {
  checkpointCommitFor,
  createHostChangesAdapter,
  mapAgentRunContext,
  mapChangedFile,
  mapFileSlice,
  mapProjectChanges,
  projectChangesParams,
  resolveChangesSession,
  scopeSourceEnds,
} from "../../src/source-control/host-adapter.js";
import { CHANGES_NEED_SESSION, CHANGES_UNAVAILABLE } from "../../src/source-control/errors.js";
import { getChangesAdapter, resetChangesAdapter } from "../../src/source-control/data.js";
import { resetWorkspaceShapeReader, workspaceShapeRequestCount } from "../../src/source-control/workspace-shape.js";

it("maps a binary numstat file onto our binary status", () => {
  expect(mapChangedFile({ path: "logo.png", status: "modified", added: null, removed: null })).toMatchObject({
    path: "logo.png",
    status: "binary",
    added: 0,
    removed: 0,
  });
});

it("maps a paged slice, including truncated next offsets", () => {
  const slice: FileSlice = {
    repo: "/p",
    path: "a.ts",
    totalBytes: 90_000,
    offset: 0,
    bytes: 65536,
    next: 65536,
    truncated: true,
    text: "diff --git a/a.ts b/a.ts\n",
  };
  expect(mapFileSlice(slice, { path: "a.ts", status: "modified", added: 2, removed: 1 })).toMatchObject({
    patch: slice.text,
    nextOffset: 65536,
    truncated: true,
  });
});

it("maps project changes onto the overlay list", () => {
  const result: ProjectChanges = {
    scope: "session",
    repos: [{ repo: "/p", branch: "main", files: [{ path: "a.ts", status: "added", added: 3, removed: 0 }] }],
  };
  expect(mapProjectChanges(result, { kind: "session" }).repos[0]?.files[0]?.status).toBe("added");
});

it("maps an isolated run and a shared checkout", () => {
  const isolated = {
    runId: "run_1",
    worktree: { path: "/p/.worktrees/a", branch: "agents/a", baseCommit: "abc" },
  } as AgentRun;
  expect(mapAgentRunContext(isolated)).toMatchObject({ checkout: "worktree", worktreePath: "/p/.worktrees/a" });
  const shared = { runId: "run_2", worktree: null } as AgentRun;
  expect(mapAgentRunContext(shared).checkout).toBe("shared");
});

it("maps computed branchGone from the changes result, never from removedAt", () => {
  const result: ProjectChanges = {
    scope: "agent",
    repos: [],
    agent: { runId: "run_gone", worktreeRemoved: true, branchGone: true },
  };
  expect(mapProjectChanges(result, { kind: "agent", runId: "run_gone" }).agent).toEqual({
    runId: "run_gone",
    worktreeRemoved: true,
    branchGone: true,
  });
  const removed = {
    runId: "run_gone",
    worktree: { path: "/w", branch: "agents/a", baseCommit: "abc", removedAt: "2026-09-20T00:00:00.000Z" },
  } as AgentRun;
  expect(mapAgentRunContext(removed).branchGone).toBeUndefined();
  expect(mapAgentRunContext(removed, result.agent).branchGone).toBe(true);
});

it("maps a removed worktree as surviving-branch, never as branchGone", () => {
  const removed = {
    runId: "run_3",
    worktree: { path: "/w", branch: "agents/a", baseCommit: "abc", removedAt: "2026-09-20T00:00:00.000Z" },
  } as AgentRun;
  expect(mapAgentRunContext(removed)).toEqual({
    runId: "run_3",
    checkout: "worktree",
    worktreePath: "/w",
    branch: "agents/a",
    baseCommit: "abc",
    worktreeRemoved: true,
  });
});

it("getAgentContext from a faked run reaches the surviving-branch state and not the gone-branch state", async () => {
  const adapter = createHostChangesAdapter({
    request: async () => {
      throw new Error("should not run");
    },
    session: () => ({ cwd: "/p", path: "/s.jsonl" }),
    agentRun: (runId) => {
      if (runId !== "run_removed") return undefined;
      return {
        runId,
        worktree: {
          path: "/p/.worktrees/review",
          branch: "agents/review",
          baseCommit: "abc1234",
          removedAt: "2026-09-20T00:00:00.000Z",
        },
      } as AgentRun;
    },
  });
  const context = await adapter.getAgentContext?.("run_removed");
  expect(context).toMatchObject({
    runId: "run_removed",
    checkout: "worktree",
    worktreeRemoved: true,
    branch: "agents/review",
  });
  expect(context?.branchGone).toBeUndefined();
});

it("fills protocol params from a scope", () => {
  expect(projectChangesParams({ kind: "turn", turnId: "4" }, { cwd: "/p", path: "/s.jsonl" })).toMatchObject({
    scope: "turn",
    turn: 4,
  });
  expect(projectChangesParams({ kind: "range", from: "abc", to: "def" }, { cwd: "/p", path: "/s.jsonl" })).toMatchObject({
    fromRef: "abc",
    toRef: "def",
  });
});

/**
 * The mapping, per scope, against what the worker diffs. The old side used to
 * be `undefined` for every scope but `range`, and `pi/project/file_source`
 * reads a missing ref as the working tree — so both sides came back as the
 * file on disk and the renderer threw mid-render on the mismatch.
 */
it("names both ends of every scope, the way the worker's range does", () => {
  expect(scopeSourceEnds({ kind: "session" })).toEqual({
    old: { kind: "checkpoint", turn: "first" },
    new: { kind: "ref", ref: "worktree" },
  });
  expect(scopeSourceEnds({ kind: "turn", turnId: "4" })).toEqual({
    old: { kind: "checkpoint", turn: 3 },
    new: { kind: "checkpoint", turn: 4 },
  });
  // Turn 0 is the open-time baseline, which is not a range the worker serves.
  expect(scopeSourceEnds({ kind: "turn", turnId: "0" })).toEqual({ old: undefined, new: undefined });
  expect(scopeSourceEnds({ kind: "uncommitted" })).toEqual({
    old: { kind: "ref", ref: "HEAD" },
    new: { kind: "ref", ref: "worktree" },
  });
  expect(scopeSourceEnds({ kind: "range", from: "abc", to: "def" })).toEqual({
    old: { kind: "ref", ref: "abc" },
    new: { kind: "ref", ref: "def" },
  });
  expect(scopeSourceEnds({ kind: "agent", runId: "run_1" }, { isolated: true, baseCommit: "base1" })).toEqual({
    old: { kind: "ref", ref: "base1" },
    new: { kind: "ref", ref: "worktree" },
  });
  // A run with no worktree shares its parent's checkout, and the worker falls
  // back to the session range for it — so the overlay must too.
  expect(scopeSourceEnds({ kind: "agent", runId: "run_2" }, { isolated: false })).toEqual({
    old: { kind: "checkpoint", turn: "first" },
    new: { kind: "ref", ref: "worktree" },
  });
});

it("takes a checkpoint's commit for the repository that is being read", () => {
  const row = {
    turn: 0,
    ref: "refs/x/checkpoints/k/0",
    commit: "aaa",
    createdAt: "2026-01-01T00:00:00.000Z",
    repos: [
      { repo: "/p", ref: "refs/x/checkpoints/k/0", commit: "aaa" },
      { repo: "/p/nested", ref: "refs/x/checkpoints/k/0", commit: "bbb" },
    ],
  };
  expect(checkpointCommitFor(row, "/p/nested")).toBe("bbb");
  expect(checkpointCommitFor(row, "/elsewhere")).toBeUndefined();
  const { repos: _repos, ...flat } = row;
  expect(checkpointCommitFor(flat, "/p")).toBe("aaa");
});

it("resolves the overlay session from the open view", () => {
  expect(
    resolveChangesSession(
      {
        current: "/s.jsonl",
        sessions: [{ path: "/s.jsonl", cwd: "/p" } as never],
        open: { "/s.jsonl": { path: "/s.jsonl", state: { cwd: "/p" } } as never },
      },
      "default",
    ),
  ).toEqual({ cwd: "/p", path: "/s.jsonl" });
});

it("refuses when no adapter is registered, and the host adapter refuses without a session", async () => {
  resetChangesAdapter();
  await expect(getChangesAdapter().listChanges({ kind: "session" })).rejects.toThrow(CHANGES_UNAVAILABLE);
  const adapter = createHostChangesAdapter({
    request: async () => {
      throw new Error("should not run");
    },
    session: () => null,
  });
  await expect(adapter.listChanges({ kind: "session" })).rejects.toThrow(CHANGES_NEED_SESSION);
});

it("reads workspace shape through the shared reader once per cwd", async () => {
  resetWorkspaceShapeReader();
  const calls: Array<{ method: string; params: unknown }> = [];
  const adapter = createHostChangesAdapter({
    request: (async (method, params) => {
      calls.push({ method, params });
      if (method === "pi/project/workspace") {
        return {
          cwd: "/p",
          kind: "repo",
          repositories: [
            { root: "/p", name: "p", projectRoot: true, gitDir: "/p/.git", insideWorkTree: true },
          ],
          hasCommit: true,
          truncated: false,
        };
      }
      return {};
    }) as never,
    session: () => ({ cwd: "/p", path: "/s.jsonl" }),
  });
  const first = await adapter.getWorkspace?.();
  const second = await adapter.getWorkspace?.();
  expect(first?.kind).toBe("repo");
  expect(second?.kind).toBe("repo");
  expect(calls.map((call) => call.method)).toEqual(["pi/project/workspace"]);
  expect(workspaceShapeRequestCount()).toBe(1);
  resetWorkspaceShapeReader();
});

it("calls the protocol methods with the session context", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const adapter = createHostChangesAdapter({
    request: (async (method, params) => {
      calls.push({ method, params });
      if (method === "pi/project/changes") {
        return {
          scope: "session",
          repos: [{ repo: "/p", branch: "main", files: [{ path: "a.ts", status: "modified", added: 1, removed: 0 }] }],
        };
      }
      if (method === "pi/project/file_diff") {
        return {
          repo: "/p",
          path: "a.ts",
          totalBytes: 10,
          offset: 0,
          bytes: 10,
          truncated: false,
          text: "diff --git a/a.ts b/a.ts\n",
        };
      }
      return { repo: "/p", path: "a.ts", totalBytes: 1, offset: 0, bytes: 1, truncated: false, text: "x" };
    }) as never,
    session: () => ({ cwd: "/p", path: "/s.jsonl" }),
  });
  const list = await adapter.listChanges({ kind: "session" });
  expect(list.repos[0]?.files[0]?.path).toBe("a.ts");
  const page = await adapter.getFileDiff({ kind: "session" }, "/p", "a.ts");
  expect(page.truncated).toBe(false);
  expect(calls.map((call) => call.method)).toEqual(["pi/project/changes", "pi/project/file_diff"]);
});

/** The requests the overlay actually makes for the two sides of a file. */
function sourceHarness(checkpoints: unknown[], agentRun?: (runId: string) => AgentRun | undefined) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = createHostChangesAdapter({
    request: (async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "pi/project/checkpoint/list") {
        return { path: "/s.jsonl", retention: "200", checkpoints };
      }
      return { repo: "/p", path: "a.ts", totalBytes: 2, offset: 0, bytes: 2, truncated: false, text: "x\n" };
    }) as never,
    session: () => ({ cwd: "/p", path: "/s.jsonl" }),
    ...(agentRun ? { agentRun } : {}),
  });
  const sources = () => calls.filter((call) => call.method === "pi/project/file_source").map((call) => call.params);
  const listCount = () => calls.filter((call) => call.method === "pi/project/checkpoint/list").length;
  return { adapter, calls, sources, listCount };
}

const CHECKPOINTS = [
  { turn: 0, ref: "r/0", commit: "c0", createdAt: "2026-01-01T00:00:00.000Z", repos: [{ repo: "/p", ref: "r/0", commit: "c0" }] },
  { turn: 1, ref: "r/1", commit: "c1", createdAt: "2026-01-01T00:01:00.000Z", repos: [{ repo: "/p", ref: "r/1", commit: "c1" }] },
  { turn: 2, ref: "r/2", commit: "c2", createdAt: "2026-01-01T00:02:00.000Z", repos: [{ repo: "/p", ref: "r/2", commit: "c2" }] },
];

it("fetches the session scope's own two ends: the first checkpoint and the working tree", async () => {
  const harness = sourceHarness(CHECKPOINTS);
  const [old, next] = await Promise.all([
    harness.adapter.getFileSource?.({ kind: "session" }, "/p", "a.ts", "old"),
    harness.adapter.getFileSource?.({ kind: "session" }, "/p", "a.ts", "new"),
  ]);
  // The working-tree side needs no lookup, so it leaves first; what matters
  // is that each side asked for its own end.
  expect(harness.sources().map((params) => params.ref).sort()).toEqual(["c0", "worktree"]);
  expect(old?.ref).toBe("c0");
  expect(next?.ref).toBe("worktree");
  // Both sides of one file share one checkpoint list.
  expect(harness.listCount()).toBe(1);
});

it("walks turn N back to checkpoint N-1, and skips a checkpoint that failed", async () => {
  const harness = sourceHarness([
    ...CHECKPOINTS.slice(0, 1),
    { ...CHECKPOINTS[1]!, failed: true },
    CHECKPOINTS[2]!,
  ]);
  await harness.adapter.getFileSource?.({ kind: "turn", turnId: "2" }, "/p", "a.ts", "old");
  await harness.adapter.getFileSource?.({ kind: "turn", turnId: "2" }, "/p", "a.ts", "new");
  // Turn 1 failed, so it is not a side anything may be read from: the old end
  // is refused rather than silently becoming the working tree.
  expect(harness.sources().map((params) => params.ref)).toEqual(["c2"]);
});

it("reads the uncommitted scope from HEAD, not from the working tree twice", async () => {
  const harness = sourceHarness([]);
  await harness.adapter.getFileSource?.({ kind: "uncommitted" }, "/p", "a.ts", "old");
  await harness.adapter.getFileSource?.({ kind: "uncommitted" }, "/p", "a.ts", "new");
  expect(harness.sources().map((params) => params.ref)).toEqual(["HEAD", "worktree"]);
  expect(harness.listCount()).toBe(0);
});

it("reads an isolated agent run from its base commit, and names the run", async () => {
  const harness = sourceHarness([], (runId) =>
    runId === "run_1"
      ? ({ runId, cwd: "/p/.worktrees/a", worktree: { path: "/p/.worktrees/a", branch: "agents/a", baseCommit: "base1" } } as AgentRun)
      : undefined,
  );
  await harness.adapter.getFileSource?.({ kind: "agent", runId: "run_1" }, "/p/.worktrees/a", "a.ts", "old");
  await harness.adapter.getFileSource?.({ kind: "agent", runId: "run_1" }, "/p/.worktrees/a", "a.ts", "new");
  expect(harness.sources()).toMatchObject([
    { ref: "base1", runId: "run_1", workdir: "/p/.worktrees/a" },
    { ref: "worktree", runId: "run_1", workdir: "/p/.worktrees/a" },
  ]);
});

it("refuses a side it cannot name rather than letting the engine answer 'working tree'", async () => {
  // No checkpoints kept: the session scope has no left-hand end to read, so
  // the file opens at its hunks instead of being hydrated against itself.
  const empty = sourceHarness([]);
  expect(await empty.adapter.getFileSource?.({ kind: "session" }, "/p", "a.ts", "old")).toBeNull();
  expect(empty.sources()).toEqual([]);
  // A shared-checkout agent run has no base commit; it falls back to the
  // session's first checkpoint, which is absent here too.
  const shared = sourceHarness([], (runId) => ({ runId, worktree: null } as AgentRun));
  expect(await shared.adapter.getFileSource?.({ kind: "agent", runId: "run_2" }, "/p", "a.ts", "old")).toBeNull();
  expect(shared.sources()).toEqual([]);
});

it("sends runId on git actions when the overlay is an agent scope", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const adapter = createHostChangesAdapter({
    request: (async (method, params) => {
      calls.push({ method, params });
      if (method === "pi/project/git/commit") {
        return {
          outcome: "preview",
          confirmation: { repo: "/wt", branch: "agents/a", files: ["a.ts"], summary: "Commit a.ts." },
        };
      }
      return {};
    }) as never,
    session: () => ({ cwd: "/p", path: "/s.jsonl" }),
    scope: () => ({ kind: "agent", runId: "run_1" }),
  });
  await adapter.gitCommit?.({ paths: ["a.ts"], message: "Fix it.", repo: "/wt" });
  expect(calls[0]?.params).toMatchObject({ cwd: "/p", runId: "run_1", repo: "/wt" });
});

it("omits confirm on a git preview and round-trips expect on the write", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const adapter = createHostChangesAdapter({
    request: (async (method, params) => {
      calls.push({ method, params });
      if (method === "pi/project/git/commit") {
        return {
          outcome: (params as { confirm?: boolean }).confirm === true ? "done" : "preview",
          confirmation: { repo: "/p", branch: "main", files: ["a.ts"], summary: "Commit a.ts on main." },
          expect: { branch: "main", files: ["a.ts"], head: "abc" },
        };
      }
      if (method === "pi/project/git/hosts") {
        return { hosts: [{ repo: "/p", host: "github", usable: true }] };
      }
      if (method === "pi/project/git/prose") {
        return { kind: "commit", text: "Fix it." };
      }
      return {};
    }) as never,
    session: () => ({ cwd: "/p", path: "/s.jsonl" }),
  });
  await adapter.gitCommit?.({ paths: ["a.ts"], message: "Fix it.", repo: "/p" });
  await adapter.gitCommit?.({
    paths: ["a.ts"],
    message: "Fix it.",
    repo: "/p",
    confirm: true,
    expect: { branch: "main", files: ["a.ts"], head: "abc" },
  });
  const preview = calls[0]?.params as { confirm?: boolean; expect?: unknown; cwd: string };
  const confirm = calls[1]?.params as { confirm?: boolean; expect?: unknown };
  expect(calls.map((call) => call.method)).toEqual(["pi/project/git/commit", "pi/project/git/commit"]);
  expect(preview.cwd).toBe("/p");
  expect(preview.confirm).toBeUndefined();
  expect(preview.expect).toBeUndefined();
  expect(confirm.confirm).toBe(true);
  expect(confirm.expect).toEqual({ branch: "main", files: ["a.ts"], head: "abc" });
});
