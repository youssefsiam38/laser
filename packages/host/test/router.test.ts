/**
 * The Router's "unwritten session" bookkeeping (integration seam for M9).
 *
 * Pi writes a session file lazily, so a session created by `session/new` is
 * invisible to the catalog until its first persisted message. The Router keeps
 * a stub so the sidebar and `laser sessions` show it immediately. The stub is
 * a small state machine with three exits — catalog catches up, worker lets go,
 * or the filter excludes it — and getting any of them wrong leaves a ghost
 * session in the list forever, which is exactly the kind of bug a test is the
 * cheapest way to rule out.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRun, SessionState, SessionSummary } from "@lasercode/protocol";
import { AgentRunRegistry } from "../src/agents/runs.js";
import { AgentStore } from "../src/agents/store.js";
import { AttentionTracker } from "../src/attention.js";
import { SessionCatalog } from "../src/catalog.js";
import { ProjectRegistry } from "../src/projects.js";
import { Router } from "../src/router.js";
import { ViewCache } from "../src/views.js";
import type { WorkerPool } from "../src/worker-pool.js";

const CWD_A = "/projects/a";
const CWD_B = "/projects/b";
const PATH_A = "/sessions/new-a.jsonl";

function run(runId: string, patch: Partial<AgentRun> = {}): AgentRun {
  return {
    agentName: "reviewer",
    subagentName: "review",
    sessionId: `s-${runId}`,
    runId,
    sessionPath: `/sessions/child-${runId}.jsonl`,
    projectCwd: CWD_A,
    rootSessionPath: PATH_A,
    depth: 1,
    parent: { sessionPath: PATH_A, sessionId: "id-of-a" },
    worktree: null,
    origin: "agent",
    status: "running",
    task: "Review",
    startedAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...patch,
  };
}

function state(path: string, cwd: string): SessionState {
  return {
    path,
    id: "id-of-a",
    cwd,
    model: null,
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "all",
    followUpMode: "all",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  };
}

// Real directories: `session/new` creates a workspace before spawning its
// worker, and refuses the session when it cannot.
const WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-router-workspaces-`));
const WORKSPACES = { beam: join(WORKSPACE_ROOT, "beam"), chat: join(WORKSPACE_ROOT, "chat") };

/** A Router with fakes for everything but the piece under test. */
function harness(options: { catalogRows?: SessionSummary[]; open?: Record<string, string[]>; agents?: boolean; workspaces?: { beam: string; chat: string } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-router-`));
  const catalogRows = options.catalogRows ?? [];
  const open = options.open ?? { [CWD_A]: [PATH_A] };
  const bound = new Map<string, string>();

  const catalog = {
    list: (cwd?: string) =>
      (cwd === undefined ? catalogRows : catalogRows.filter((row) => row.cwd === cwd)).map((row) => ({ ...row, size: 1 })),
    get: (path: string) => catalogRows.find((row) => row.path === path),
    cwdOf: (path: string) => catalogRows.find((row) => row.path === path)?.cwd,
    cwdCounts: () => new Map<string, number>(),
    invalidate: () => {},
  } as unknown as SessionCatalog;

  const workerRequests: Array<{ cwd: string; method: string; params: unknown }> = [];
  const pool = {
    openSessions: (cwd: string) => open[cwd] ?? [],
    cwdOfSession: (path: string) => bound.get(path),
    bindSession: (path: string, cwd: string) => bound.set(path, cwd),
    get: async (cwd: string) => ({
      request: async (method: string, params: unknown) => {
        workerRequests.push({ cwd, method, params });
        if (method === "session/new") return { state: state(`/sessions/new-${workerRequests.length}.jsonl`, cwd) };
        if (method === "agents/runs/stop") {
          const { runId, reason } = params as { runId: string; reason?: string };
          return { run: { ...run(runId), status: "cancelled", endedBy: { initiator: "user", ...(reason ? { reason } : {}) } } };
        }
        if (method === "agents/namer/qualify") return { status: "ready", model: { provider: "openai", id: "gpt-5-nano" }, candidates: [] };
        return { commands: [{ name: "skill:test", source: "skill" }] };
      },
    }),
  } as unknown as WorkerPool;

  const attention = new AttentionTracker({});
  const projects = new ProjectRegistry({ catalog, agentDir: dir, exclude: [WORKSPACES.beam, WORKSPACES.chat] });
  const agents = options.agents ? new AgentStore({ agentDir: join(dir, "agent"), workspaces: options.workspaces ?? WORKSPACES }) : undefined;
  // Fixtures date from June; a fixed clock keeps retention from pruning them.
  const runs = options.agents ? new AgentRunRegistry({ now: () => new Date("2026-06-02T00:00:00.000Z") }) : undefined;
  const router = new Router(pool, catalog, { attention, projects, views: new ViewCache(2), agents, runs });

  // The Router only records a stub from inside `dispatch`; reach the private
  // recorder the same way `session/new` does, without standing up a worker.
  const note = (s: SessionState) => (router as unknown as { noteUnwritten(s: SessionState): void }).noteUnwritten(s);

  return {
    router,
    note,
    catalogRows,
    open,
    workerRequests,
    agents,
    runs,
    projects,
    cleanup: () => {
      projects.close();
      attention.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("Router · sessions not yet on disk", () => {
  it("searches only the selected project and date range without opening workers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "search-router-"));
    const path = join(dir, "visible.jsonl");
    writeFileSync(path, JSON.stringify({ type: "message", message: { role: "user", content: "Apple" } }));
    const row: SessionSummary = { path, id: "visible", cwd: CWD_A, createdAt: "2026-01-01T00:00:00Z", modifiedAt: "2026-06-01T00:00:00Z", messageCount: 1 };
    const h = harness({ catalogRows: [row, { ...row, path: "/missing-old.jsonl", modifiedAt: "2026-01-01T00:00:00Z" }, { ...row, path: "/missing-other.jsonl", cwd: CWD_B }] });
    try {
      const response = await h.router.handle({ jsonrpc: "2.0", id: 1, method: "session/search", params: { query: "Apple", cwd: CWD_A, after: "2026-05-01T00:00:00Z", before: "2026-07-01T00:00:00Z" } });
      expect(response).toMatchObject({ result: { hits: [{ path, source: "user", count: 1, excerpt: "Apple" }], unreadable: 0 } });
      expect(h.workerRequests).toEqual([]);
      const invalid = await h.router.handle({ jsonrpc: "2.0", id: 2, method: "session/search", params: { query: "Apple", after: "yesterday" } });
      expect(invalid).toHaveProperty("error");
    } finally { h.cleanup(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("routes a new-chat command catalogue by project before a session path exists", async () => {
    const h = harness();
    const response = await h.router.handle({ jsonrpc: "2.0", id: 1, method: "pi/commands/list", params: { cwd: CWD_A } });

    expect(response).toMatchObject({ result: { commands: [{ name: "skill:test", source: "skill" }] } });
    expect(h.workerRequests).toEqual([{ cwd: CWD_A, method: "pi/commands/list", params: { cwd: CWD_A } }]);
    h.cleanup();
  });

  it("lists a session the worker holds but Pi has not written", () => {
    const h = harness();
    h.note(state(PATH_A, CWD_A));
    expect(h.router.sessions().map((s) => s.path)).toEqual([PATH_A]);
    expect(h.router.sessions(CWD_A).map((s) => s.path)).toEqual([PATH_A]);
    h.cleanup();
  });

  it("honours the cwd filter", () => {
    const h = harness();
    h.note(state(PATH_A, CWD_A));
    expect(h.router.sessions(CWD_B)).toEqual([]);
    // Filtering it out must not drop it: it is still open in its own project.
    expect(h.router.sessions(CWD_A).map((s) => s.path)).toEqual([PATH_A]);
    h.cleanup();
  });

  it("drops the stub once the catalog sees the real file, without duplicating it", () => {
    const h = harness();
    h.note(state(PATH_A, CWD_A));
    h.catalogRows.push({
      path: PATH_A,
      id: "id-of-a",
      cwd: CWD_A,
      createdAt: "2026-01-01T00:00:00Z",
      modifiedAt: "2026-01-01T00:00:01Z",
      messageCount: 2,
      firstMessage: "hello",
    });
    const rows = h.router.sessions();
    expect(rows).toHaveLength(1);
    // The catalog's row wins: it has the real message count and first message.
    expect(rows[0]).toMatchObject({ messageCount: 2, firstMessage: "hello" });
    h.catalogRows.length = 0;
    // Forgotten for good, so a later catalog eviction cannot resurrect a ghost.
    expect(h.router.sessions()).toEqual([]);
    h.cleanup();
  });

  it("drops the stub when the worker closes the session without ever writing it", () => {
    const h = harness();
    h.note(state(PATH_A, CWD_A));
    expect(h.router.sessions()).toHaveLength(1);
    h.open[CWD_A] = [];
    expect(h.router.sessions()).toEqual([]);
    h.cleanup();
  });

  it("never shadows a session the catalog already knows", () => {
    const h = harness({
      catalogRows: [
        {
          path: PATH_A,
          id: "id-of-a",
          cwd: CWD_A,
          createdAt: "2026-01-01T00:00:00Z",
          modifiedAt: "2026-01-01T00:00:01Z",
          messageCount: 5,
        },
      ],
    });
    h.note(state(PATH_A, CWD_A));
    const rows = h.router.sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.messageCount).toBe(5);
    h.cleanup();
  });
});

const rpc = (router: Router, method: string, params: unknown = {}) => router.handle({ jsonrpc: "2.0", id: 1, method, params });

describe("Router · the pending tray", () => {
  it("routes every tray operation to the worker holding that session, and answers nothing itself", async () => {
    const h = harness({ catalogRows: [{ path: PATH_A, cwd: CWD_A } as SessionSummary] });
    // The tray is per session and lives in the worker; the host has no copy to
    // serve from and must not grow one, or two clients would see two trays.
    const calls = [
      ["session/pending/add", { path: PATH_A, content: [{ type: "text", text: "then commit" }] }],
      ["session/pending/edit", { path: PATH_A, id: "p-9f2c1a04", content: [{ type: "text", text: "then push" }] }],
      ["session/pending/remove", { path: PATH_A, id: "p-9f2c1a04" }],
      ["session/pending/steer", { path: PATH_A, id: "p-9f2c1a04" }],
      ["session/pending/clear", { path: PATH_A }],
    ] as const;
    for (const [method, params] of calls) await rpc(h.router, method, params);
    expect(h.workerRequests.map((request) => [request.cwd, request.method])).toEqual(calls.map(([method]) => [CWD_A, method]));
    h.cleanup();
  });
});

describe("Router · agents (docs/agents-leap)", () => {
  it("answers the definition methods from the store, never from a worker", async () => {
    const h = harness({ agents: true });
    try {
      const listed = (await rpc(h.router, "agents/list")) as { result: { agents: Array<{ name: string }>; defaultAgent: string } };
      expect(listed.result.agents.map((a) => a.name)).toEqual(["default", "beam", "chat", "namer"]);
      const input = { name: "reviewer", description: "", instructions: "Review.", engineInstructions: false, model: null, thinkingLevel: null, supportsSubagents: false, allowedAgents: [], scopedSkills: false, skills: [] };
      expect(await rpc(h.router, "agents/validate", { agent: { ...input, scopedSkills: true } })).toMatchObject({ result: { issues: [{ field: "skills" }] } });
      const saved = await rpc(h.router, "agents/save", { agent: input });
      expect(saved).toMatchObject({ result: { agent: { name: "reviewer", kind: "custom" }, snapshot: { revision: 1 } } });
      expect(await rpc(h.router, "agents/save", { agent: { ...input, name: "beam" } })).toMatchObject({ error: { data: { issues: [{ field: "name" }] } } });
      expect(await rpc(h.router, "agents/set-default", { name: "reviewer" })).toMatchObject({ result: { snapshot: { defaultAgent: "reviewer" } } });
      expect(await rpc(h.router, "agents/delete", { name: "reviewer" })).toMatchObject({ error: { message: "This agent starts new sessions. Choose another default first." } });
      expect(await rpc(h.router, "agents/set-policy", { policy: { maxDepth: 2 } })).toMatchObject({ result: { snapshot: { policy: { maxDepth: 2 } } } });
      // One method, three built-ins: each carries its choice to the agent of that name.
      expect(await rpc(h.router, "agents/builtin/set-model", { name: "beam", model: { provider: "openai", id: "gpt-5-mini" } })).toMatchObject({
        result: { snapshot: { beam: { model: { provider: "openai", id: "gpt-5-mini" }, needsChoice: false } } },
      });
      const chatSet = (await rpc(h.router, "agents/builtin/set-model", { name: "chat", model: { provider: "openai", id: "gpt-5-nano" } })) as {
        result: { snapshot: { chat: { model: unknown }; agents: Array<{ name: string; model: unknown }> } };
      };
      expect(chatSet.result.snapshot.chat).toEqual({ model: { provider: "openai", id: "gpt-5-nano" } });
      expect(chatSet.result.snapshot.agents.find((a) => a.name === "chat")?.model).toEqual({ provider: "openai", id: "gpt-5-nano" });
      expect(await rpc(h.router, "agents/builtin/set-model", { name: "chat", model: null })).toMatchObject({ result: { snapshot: { chat: { model: null } } } });
      expect(await rpc(h.router, "agents/builtin/set-model", { name: "namer", model: null })).toMatchObject({ result: { snapshot: { namer: { status: "unqualified" } } } });
      expect(await rpc(h.router, "agents/runs/list", {})).toMatchObject({ result: { runs: [] } });
      expect(await rpc(h.router, "agents/sync", { snapshot: { revision: 1 } })).toMatchObject({ error: { message: "The app sends this to its own workers." } });
      expect(h.workerRequests).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it("refuses every agents method with a reason when the host has no store", async () => {
    const h = harness();
    try {
      expect(await rpc(h.router, "agents/list")).toMatchObject({ error: { message: expect.stringContaining("without agent definitions") } });
      expect(await rpc(h.router, "agents/runs/list", {})).toMatchObject({ error: { message: expect.stringContaining("without a run registry") } });
    } finally {
      h.cleanup();
    }
  });

  it("routes the engine-owned methods by cwd and keeps the Namer verdict", async () => {
    const h = harness({ agents: true });
    try {
      await rpc(h.router, "agents/skills", { cwd: CWD_A });
      await rpc(h.router, "agents/engine-instructions", { cwd: CWD_B });
      const qualified = await rpc(h.router, "agents/namer/qualify", { cwd: CWD_A });
      expect(qualified).toMatchObject({ result: { status: "ready" } });
      expect(h.workerRequests.map((r) => `${r.method}@${r.cwd}`)).toEqual(["agents/skills@/projects/a", "agents/engine-instructions@/projects/b", "agents/namer/qualify@/projects/a"]);
      expect(h.agents!.snapshot().namer).toMatchObject({ status: "ready", model: { provider: "openai", id: "gpt-5-nano" } });
    } finally {
      h.cleanup();
    }
  });

  it("stops a run through the worker of the run's project and records the answer", async () => {
    const h = harness({ agents: true });
    try {
      h.runs!.upsert(run("r7", { projectCwd: CWD_B }));
      const stopped = await rpc(h.router, "agents/runs/stop", { runId: "r7", reason: "Wrong direction" });
      expect(stopped).toMatchObject({ result: { run: { runId: "r7", status: "cancelled", endedBy: { initiator: "user", reason: "Wrong direction" } } } });
      expect(h.workerRequests).toEqual([{ cwd: CWD_B, method: "agents/runs/stop", params: { runId: "r7", reason: "Wrong direction" } }]);
      expect(h.runs!.get("r7")?.status).toBe("cancelled");
      // Ended already: answered from the record, no worker asked.
      await rpc(h.router, "agents/runs/stop", { runId: "r7" });
      expect(h.workerRequests).toHaveLength(1);
      expect(await rpc(h.router, "agents/runs/stop", { runId: "nope" })).toMatchObject({ error: { message: "That run is no longer known to the app." } });
    } finally {
      h.cleanup();
    }
  });

  it("session/new: a project starts the default agent, a workspace its own, and never Namer", async () => {
    const h = harness({ agents: true });
    try {
      await rpc(h.router, "session/new", { cwd: CWD_A });
      expect(h.workerRequests.at(-1)).toEqual({ cwd: CWD_A, method: "session/new", params: { cwd: CWD_A, agentName: "default" } });
      expect(h.projects.list().map((p) => p.cwd)).toContain(CWD_A);

      await rpc(h.router, "session/new", { cwd: WORKSPACES.beam });
      expect(h.workerRequests.at(-1)).toMatchObject({ cwd: WORKSPACES.beam, params: { agentName: "beam" } });
      await rpc(h.router, "session/new", { cwd: WORKSPACES.chat, agentName: "chat" });
      expect(h.workerRequests.at(-1)).toMatchObject({ cwd: WORKSPACES.chat, params: { agentName: "chat" } });
      expect(h.projects.list().map((p) => p.cwd)).not.toContain(WORKSPACES.beam);
      expect(h.projects.list().map((p) => p.cwd)).not.toContain(WORKSPACES.chat);

      const before = h.workerRequests.length;
      expect(await rpc(h.router, "session/new", { cwd: CWD_A, agentName: "beam" })).toMatchObject({ error: { message: expect.stringContaining("Beam sessions start in") } });
      expect(await rpc(h.router, "session/new", { cwd: WORKSPACES.beam, agentName: "default" })).toMatchObject({ error: { message: "Only Beam sessions start in the Beam workspace." } });
      expect(await rpc(h.router, "session/new", { cwd: CWD_A, agentName: "namer" })).toMatchObject({ error: { message: expect.stringContaining("does not run a session") } });
      expect(await rpc(h.router, "session/new", { cwd: CWD_A, agentName: "ghost" })).toMatchObject({ error: { data: { issues: [{ field: "agentName" }] } } });
      expect(h.workerRequests).toHaveLength(before);
    } finally {
      h.cleanup();
    }
  });

  it("creates a workspace before starting its worker, and refuses the session with the reason when it cannot", async () => {
    const root = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-router-blocked-`));
    // A regular file where the workspaces root should be: nothing can be created beneath it.
    writeFileSync(join(root, "blocked"), "not a directory\n");
    const h = harness({ agents: true, workspaces: { beam: join(root, "blocked", "beam"), chat: join(root, "chat") } });
    try {
      expect(existsSync(join(root, "chat"))).toBe(false);
      await rpc(h.router, "session/new", { cwd: join(root, "chat"), agentName: "chat" });
      expect(existsSync(join(root, "chat"))).toBe(true);
      expect(h.workerRequests.at(-1)).toMatchObject({ cwd: join(root, "chat"), params: { agentName: "chat" } });

      const before = h.workerRequests.length;
      const refused = await rpc(h.router, "session/new", { cwd: join(root, "blocked", "beam") });
      expect(refused).toMatchObject({ error: { message: expect.stringMatching(/Beam's workspace folder could not be created at .*blocked\/beam: a parent of that path is a file/) } });
      // No worker was started for a directory that does not exist.
      expect(h.workerRequests).toHaveLength(before);
    } finally {
      h.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes a child session to its project's worker through the registry, else through the .worktrees rule", async () => {
    const child = "/sessions/child-r1.jsonl";
    const orphan = "/sessions/orphan.jsonl";
    const row = (path: string, cwd: string): SessionSummary => ({ path, id: path, cwd, createdAt: "2026-01-01T00:00:00Z", modifiedAt: "2026-01-01T00:00:00Z", messageCount: 0 });
    const h = harness({ agents: true, catalogRows: [row(child, `${CWD_B}/.worktrees/r1`), row(orphan, `${CWD_A}/.worktrees/lost`)] });
    try {
      h.runs!.upsert(run("r1", { sessionPath: child, projectCwd: CWD_A }));
      await rpc(h.router, "session/load", { path: child });
      expect(h.workerRequests.at(-1)).toMatchObject({ cwd: CWD_A, method: "session/load" });
      await rpc(h.router, "session/load", { path: orphan });
      expect(h.workerRequests.at(-1)).toMatchObject({ cwd: CWD_A, method: "session/load" });
      expect(h.workerRequests.map((r) => r.cwd)).not.toContain(`${CWD_A}/.worktrees/lost`);
    } finally {
      h.cleanup();
    }
  });

  it("decorates an agent's session row with its latest run, and cancels its runs on delete", async () => {
    const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-router-child-`));
    const child = join(dir, "child.jsonl");
    writeFileSync(child, "");
    const row: SessionSummary = { path: child, id: "c", cwd: CWD_A, createdAt: "2026-01-01T00:00:00Z", modifiedAt: "2026-01-01T00:00:00Z", messageCount: 0, agent: { agentName: "reviewer", kind: "child", subagentName: "review", parentPath: PATH_A, rootPath: PATH_A } };
    const h = harness({ agents: true, catalogRows: [row], open: {} });
    try {
      h.runs!.upsert(run("r1", { sessionPath: child, startedAt: "2026-06-01T00:00:01.000Z", status: "completed" }));
      h.runs!.upsert(run("r2", { sessionPath: child, startedAt: "2026-06-01T00:00:02.000Z" }));
      const listed = (await rpc(h.router, "pi/session/list", {})) as { result: { sessions: SessionSummary[] } };
      expect(listed.result.sessions[0]?.agent).toEqual({ agentName: "reviewer", kind: "child", subagentName: "review", parentPath: PATH_A, rootPath: PATH_A, runId: "r2", runStatus: "running" });
      expect(await rpc(h.router, "pi/session/delete", { path: child })).toMatchObject({ result: {} });
      expect(h.runs!.get("r2")?.status).toBe("cancelled");
      expect(h.runs!.get("r1")?.status).toBe("completed");
    } finally {
      h.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
