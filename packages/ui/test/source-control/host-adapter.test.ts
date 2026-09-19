import { expect, it } from "vitest";
import type { AgentRun, FileSlice, ProjectChanges } from "@lasercode/protocol";
import {
  createHostChangesAdapter,
  mapAgentRunContext,
  mapChangedFile,
  mapFileSlice,
  mapProjectChanges,
  projectChangesParams,
  resolveChangesSession,
  sourceRef,
} from "../../src/source-control/host-adapter.js";
import { CHANGES_NEED_SESSION, CHANGES_UNAVAILABLE } from "../../src/source-control/errors.js";
import { getChangesAdapter, resetChangesAdapter } from "../../src/source-control/data.js";

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
  expect(sourceRef({ kind: "range", from: "abc", to: "def" }, "old")).toBe("abc");
  expect(sourceRef({ kind: "session" }, "new")).toBe("worktree");
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
