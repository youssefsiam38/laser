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
import { ErrorCodes, PRODUCT_NAME } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
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
function harness(options: { catalogRows?: SessionSummary[]; open?: Record<string, string[]>; agents?: boolean; workspaces?: { beam: string; chat: string }; exclude?: string[]; workerRequest?: (method: string, params: unknown) => Promise<unknown> } = {}) {
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
        if (options.workerRequest) return options.workerRequest(method, params);
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
  const workspaces = options.workspaces ?? WORKSPACES;
  const projects = new ProjectRegistry({ catalog, agentDir: dir, exclude: [...(options.exclude ?? []), workspaces.beam, workspaces.chat] });
  const agents = options.agents ? new AgentStore({ agentDir: join(dir, "agent"), workspaces: options.workspaces ?? WORKSPACES }) : undefined;
  // Fixtures date from June; a fixed clock keeps retention from pruning them.
  const runs = options.agents ? new AgentRunRegistry({ now: () => new Date("2026-06-02T00:00:00.000Z") }) : undefined;
  const views = new ViewCache(2);
  const router = new Router(pool, catalog, { attention, projects, views, agents, runs });

  // The Router only records a stub from inside `dispatch`; reach the private
  // recorder the same way `session/new` does, without standing up a worker.
  const note = (s: SessionState) => (router as unknown as { noteUnwritten(s: SessionState): void }).noteUnwritten(s);

  return {
    router,
    note,
    bind: (path: string, cwd: string) => bound.set(path, cwd),
    catalogRows,
    open,
    workerRequests,
    views,
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

describe("Router · paged catalog", () => {
  it("returns seven summaries per project, then a cursor page, without opening workers", async () => {
    const rows: SessionSummary[] = Array.from({ length: 150 }, (_, index) => ({
      cwd: `/projects/${Math.floor(index / 15)}`, path: `/sessions/${String(index).padStart(3, "0")}.jsonl`, id: String(index),
      createdAt: "2026-06-01T00:00:00.000Z", modifiedAt: "2026-06-01T00:00:00.000Z", messageCount: 2,
    }));
    const h = harness({ catalogRows: rows });
    try {
      const first = await h.router.handle({ jsonrpc: "2.0", id: 1, method: "pi/session/list", params: { page: {} } });
      expect(first).toHaveProperty("result.sessions.length", 70);
      const result = (first as { result: { sessions: SessionSummary[]; groups: Array<{ cwd: string; cursor: string }> } }).result;
      expect(result.groups).toHaveLength(10);
      const group = result.groups[0]!;
      const next = await h.router.handle({ jsonrpc: "2.0", id: 2, method: "pi/session/list", params: { cwd: group.cwd, page: { cursor: group.cursor } } });
      expect(next).toHaveProperty("result.sessions.length", 7);
      const more = (next as { result: { sessions: SessionSummary[] } }).result.sessions;
      expect(more.every(row => !result.sessions.some(firstRow => firstRow.path === row.path))).toBe(true);
      const invalid = await h.router.handle({ jsonrpc: "2.0", id: 3, method: "pi/session/list", params: { cwd: "/another", page: { cursor: group.cursor } } });
      expect(invalid).toHaveProperty("error.code", ErrorCodes.InvalidParams);
      const full = await h.router.handle({ jsonrpc: "2.0", id: 4, method: "pi/session/list", params: {} });
      expect(full).toHaveProperty("result.sessions.length", 150);
      expect(h.workerRequests).toEqual([]);
    } finally { h.cleanup(); }
  });
});

describe("Router · history windows", () => {
  it("routes pages to the serving worker without reading or poisoning the full snapshot cache", async () => {
    const directory = mkdtempSync(join(tmpdir(), "history-window-"));
    const path = join(directory, "session.jsonl");
    writeFileSync(path, "session fixture");
    const full = { entries: [{ id: "old" }, { id: "tail" }], leafId: "tail" };
    const page = { entries: [{ id: "tail" }], leafId: "tail", window: { epoch: "one", seq: 12 } };
    const h = harness({ workerRequest: async (_method, params) => (params as { window?: unknown }).window ? page : full });
    h.bind(path, CWD_A);
    h.open[CWD_A]!.push(path);
    const call = (id: number, window?: { tail: number }) => h.router.handle({ jsonrpc: "2.0", id, method: "pi/session/entries", params: { path, ...(window ? { window } : {}) } });
    try {
      expect(await call(1, { tail: 40 })).toMatchObject({ result: page });
      expect(h.views.get(path)).toBeUndefined();
      expect(await call(2)).toMatchObject({ result: full });
      expect(await call(3, { tail: 40 })).toMatchObject({ result: page });
      expect(h.views.get(path)).toEqual(full);
      expect(await call(4)).toMatchObject({ result: full });
      expect(h.workerRequests).toHaveLength(3);
      expect(h.workerRequests[0]?.params).toEqual({ path, window: { tail: 40 } });
    } finally { h.cleanup(); rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("Router · dictation cancellation", () => {
  it("routes discard while end is still transcribing, then releases the upload route", async () => {
    let finish!: (value: unknown) => void;
    let began!: () => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    const entered = new Promise<void>((resolve) => { began = resolve; });
    const h = harness({ workerRequest: async (method) => {
      if (method === "pi/transcribe/begin") return { id: "recording" };
      if (method === "pi/transcribe/end") { began(); return pending; }
      return {};
    } });
    try {
      await h.router.handle({ jsonrpc: "2.0", id: 1, method: "pi/transcribe/begin", params: { cwd: CWD_A, mimeType: "audio/wav" } });
      const ending = h.router.handle({ jsonrpc: "2.0", id: 2, method: "pi/transcribe/end", params: { id: "recording" } });
      await entered;
      const discarded = await h.router.handle({ jsonrpc: "2.0", id: 3, method: "pi/transcribe/cancel", params: { id: "recording" } });
      expect(discarded).toMatchObject({ result: {} });
      expect(h.workerRequests.at(-1)).toEqual({ cwd: CWD_A, method: "pi/transcribe/cancel", params: { id: "recording" } });
      finish({ text: "" }); await ending;
      const gone = await h.router.handle({ jsonrpc: "2.0", id: 4, method: "pi/transcribe/chunk", params: { id: "recording", data: "AA==" } });
      expect(gone).toHaveProperty("error");
    } finally { finish({ text: "" }); h.cleanup(); }
  });
});

describe("Router · internal storage is never a project", () => {
  it("omits invalid internal sessions without relabelling them as Chat, and refuses load/create/add", async () => {
    const internal = WORKSPACE_ROOT;
    const summary = (cwd: string, path: string): SessionSummary => ({ cwd, path, id: path, createdAt: "2026-09-10T00:00:00.000Z", modifiedAt: "2026-09-10T00:00:00.000Z", messageCount: 1 });
    const invalid = summary(internal, "/sessions/invalid.jsonl");
    const beam = summary(join(WORKSPACES.beam, "session-private"), "/sessions/beam.jsonl");
    const chat = summary(join(WORKSPACES.chat, "session-private"), "/sessions/chat.jsonl");
    const project = summary(CWD_A, PATH_A);
    const h = harness({ agents: true, exclude: [internal], catalogRows: [invalid, beam, chat, project] });
    try {
      expect(h.router.sessions().map(s => s.path)).toEqual([beam.path, chat.path, project.path]);
      for (const [method, params] of [
        ["pi/project/add", { cwd: internal }],
        ["session/new", { cwd: internal }],
        ["session/load", { path: invalid.path }],
      ] as const) {
        const response = await h.router.handle({ jsonrpc: "2.0", id: 1, method, params });
        expect(response).toMatchObject({ error: { code: ErrorCodes.InvalidParams, message: expect.stringContaining("internal app storage") } });
      }
      expect(h.workerRequests).toEqual([]);
    } finally { h.cleanup(); }
  });
});

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

describe("Router · session recovery", () => {
  it("opens a saved session before forwarding an action after its worker retired", async () => {
    const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-router-recover-`));
    const path = join(dir, "saved.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "session", id: "saved", cwd: CWD_A })}\n`);
    const row: SessionSummary = {
      path,
      id: "saved",
      cwd: CWD_A,
      createdAt: "2026-01-01T00:00:00Z",
      modifiedAt: "2026-01-01T00:00:00Z",
      messageCount: 1,
    };
    const h = harness({ catalogRows: [row], open: { [CWD_A]: [] } });
    try {
      const params = {
        path,
        content: [{ type: "text", text: "continue" }],
        firstTurn: { agentName: "reviewer", thinkingLevel: "high" },
      };
      await rpc(h.router, "session/prompt", params);
      expect(h.workerRequests).toEqual([
        { cwd: CWD_A, method: "session/load", params: { path } },
        { cwd: CWD_A, method: "session/prompt", params },
      ]);
    } finally {
      h.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a retired unsaved session before a worker can recreate its stale path", async () => {
    const h = harness({ open: { [CWD_A]: [] } });
    h.bind(PATH_A, CWD_A);
    try {
      const response = await rpc(h.router, "session/load", { path: PATH_A });
      expect(response).toMatchObject({
        error: {
          code: -32000,
          message: "This session is no longer open and has no saved transcript. Start a new session.",
        },
      });
      expect(h.workerRequests).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});

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
      expect(await rpc(h.router, "agents/validate", { agent: { ...input, scopedSkills: true }, originalName: null })).toMatchObject({ result: { issues: [{ field: "skills" }] } });
      const saved = await rpc(h.router, "agents/save", { agent: input, originalName: null });
      expect(saved).toMatchObject({ result: { agent: { name: "reviewer", kind: "custom" }, snapshot: { revision: 1 } } });
      expect(await rpc(h.router, "agents/save", { agent: { ...input, name: "beam" }, originalName: null })).toMatchObject({ error: { data: { issues: [{ field: "name" }] } } });
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
      expect(await rpc(h.router, "agents/builtin/set-instructions", { name: "chat", instructions: "Answer as an editor." })).toMatchObject({
        result: { snapshot: { builtinInstructions: { chat: "Answer as an editor." }, agents: expect.arrayContaining([expect.objectContaining({ name: "chat", instructions: "Answer as an editor." })]) } },
      });
      expect(await rpc(h.router, "agents/builtin/set-instructions", { name: "chat", instructions: null })).toMatchObject({
        result: { snapshot: { builtinInstructions: { chat: null } } },
      });
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

  it("lists an unwritten session with the agent the worker already knows it runs (M13-T47)", async () => {
    // Pi writes the file on the first message; until then the catalog cannot
    // read a record, so the row the router synthesises must carry the agent
    // from the worker's state — or an empty Beam chat lists as "no agent" and
    // the launcher never recognises it as Beam's.
    const h = harness({ agents: true });
    const beamPath = "/sessions/beam-empty.jsonl";
    h.open[WORKSPACES.beam] = [beamPath];
    h.note({ ...state(beamPath, WORKSPACES.beam), agent: { agentName: "beam", kind: "beam" } });
    const row = h.router.sessions().find((s) => s.path === beamPath);
    expect(row?.agent).toEqual({ agentName: "beam", kind: "beam" });
    expect(row?.messageCount).toBe(0);
  });

  it("session/new: a project starts the default agent, a workspace its own, and never Namer", async () => {
    const h = harness({ agents: true });
    try {
      await rpc(h.router, "session/new", { cwd: CWD_A });
      expect(h.workerRequests.at(-1)).toEqual({ cwd: CWD_A, method: "session/new", params: { cwd: CWD_A, agentName: "default" } });
      expect(h.projects.list().map((p) => p.cwd)).toContain(CWD_A);

      await rpc(h.router, "session/new", { cwd: WORKSPACES.beam });
      const beamRequest = h.workerRequests.at(-1)!;
      expect(beamRequest.cwd.startsWith(`${WORKSPACES.beam}/session-`)).toBe(true);
      expect(beamRequest).toMatchObject({ params: { agentName: "beam" } });
      await rpc(h.router, "session/new", { cwd: WORKSPACES.beam });
      const secondBeamRequest = h.workerRequests.at(-1)!;
      expect(secondBeamRequest.cwd).not.toBe(beamRequest.cwd);
      expect(secondBeamRequest.cwd.startsWith(`${WORKSPACES.beam}/session-`)).toBe(true);
      await rpc(h.router, "session/new", { cwd: WORKSPACES.chat, agentName: "chat" });
      const chatRequest = h.workerRequests.at(-1)!;
      expect(chatRequest).toMatchObject({ params: { agentName: "chat" } });
      expect(chatRequest.cwd).not.toBe(WORKSPACES.chat);
      expect(chatRequest.cwd.startsWith(`${WORKSPACES.chat}/session-`)).toBe(true);
      expect((chatRequest.params as { cwd: string }).cwd).toBe(chatRequest.cwd);
      expect(existsSync(chatRequest.cwd)).toBe(true);
      await rpc(h.router, "session/new", { cwd: WORKSPACES.chat, agentName: "chat" });
      const secondChatRequest = h.workerRequests.at(-1)!;
      expect(secondChatRequest.cwd).not.toBe(chatRequest.cwd);
      expect(secondChatRequest.cwd.startsWith(`${WORKSPACES.chat}/session-`)).toBe(true);
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
      expect(h.workerRequests.at(-1)?.cwd.startsWith(`${join(root, "chat")}/session-`)).toBe(true);
      expect(h.workerRequests.at(-1)).toMatchObject({ params: { agentName: "chat" } });

      const before = h.workerRequests.length;
      const refused = await rpc(h.router, "session/new", { cwd: join(root, "blocked", "beam") });
      expect(refused).toMatchObject({ error: { message: expect.stringMatching(/Beam could not create a private workspace: a parent of that path is a file/) } });
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

  // M13-T42: the worktree is the parent's to merge and remove, and a person's
  // to clear when the parent never did. Neither is allowed to happen silently.
  describe("a child's worktree", () => {
    /** A real repository with a real child worktree, plus a router that knows the run. */
    function world(): { h: ReturnType<typeof harness>; child: string; project: string; worktree: string; branch: string; dir: string } {
      const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-router-worktree-`));
      const project = join(dir, "project");
      const author = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];
      execFileSync("git", ["init", "-q", "-b", "main", project]);
      writeFileSync(join(project, "a.txt"), "one\n");
      execFileSync("git", ["-C", project, ...author, "add", "-A"]);
      execFileSync("git", ["-C", project, ...author, "commit", "-q", "-m", "one"]);
      const worktree = join(project, ".worktrees", "explorer-1");
      const branch = "agents/explorer-1";
      execFileSync("git", ["-C", project, "worktree", "add", "-q", worktree, "-b", branch, "HEAD"]);

      const child = join(dir, "child.jsonl");
      writeFileSync(child, "");
      const row: SessionSummary = { path: child, id: "c", cwd: project, createdAt: "2026-01-01T00:00:00Z", modifiedAt: "2026-01-01T00:00:00Z", messageCount: 0 };
      const h = harness({ agents: true, catalogRows: [row], open: {} });
      h.runs!.upsert(run("w1", { sessionPath: child, projectCwd: project, worktree: { path: worktree, branch, baseCommit: "x" } }));
      return { h, child, project, worktree, branch, dir };
    }

    const commitIn = (cwd: string, name: string) => {
      const author = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];
      writeFileSync(join(cwd, name), "work\n");
      execFileSync("git", ["-C", cwd, ...author, "add", "-A"]);
      execFileSync("git", ["-C", cwd, ...author, "commit", "-q", "-m", name]);
    };

    it("answers what it holds, and says null for a session that never had one", async () => {
      const w = world();
      try {
        commitIn(w.worktree, "b.txt");
        const answered = (await rpc(w.h.router, "agents/worktree/status", { path: w.child })) as { result: { worktree: { unmergedCommits: number; branch: string } | null } };
        expect(answered.result.worktree).toMatchObject({ branch: w.branch, exists: true, unmergedCommits: 1 });

        const none = (await rpc(w.h.router, "agents/worktree/status", { path: "/sessions/nothing.jsonl" })) as { result: { worktree: null } };
        expect(none.result.worktree).toBeNull();
      } finally {
        w.h.cleanup();
        rmSync(w.dir, { recursive: true, force: true });
      }
    });

    it("lets a person clear a leftover worktree without deleting the session, and refuses one holding work", async () => {
      const w = world();
      try {
        commitIn(w.worktree, "b.txt");
        const refused = (await rpc(w.h.router, "agents/worktree/remove", { path: w.child })) as { result: { removed: boolean; worktree: { unmergedCommits: number } } };
        expect(refused.result.removed).toBe(false);
        expect(refused.result.worktree.unmergedCommits).toBe(1);
        expect(existsSync(w.worktree)).toBe(true);

        const forced = (await rpc(w.h.router, "agents/worktree/remove", { path: w.child, force: true })) as { result: { removed: boolean } };
        expect(forced.result.removed).toBe(true);
        expect(existsSync(w.worktree)).toBe(false);
        // The session is untouched: this is not a delete.
        expect(existsSync(w.child)).toBe(true);
        // The run knows: the fleet must not offer to remove it again, nor
        // keep showing a path that is gone.
        expect(w.h.runs!.get("w1")?.worktree?.removedAt).toBeDefined();
      } finally {
        w.h.cleanup();
        rmSync(w.dir, { recursive: true, force: true });
      }
    });

    it("keeps the worktree when a delete omits the instruction, and removes it only when asked", async () => {
      const kept = world();
      try {
        expect(await rpc(kept.h.router, "pi/session/delete", { path: kept.child })).toMatchObject({ result: {} });
        expect(existsSync(kept.child)).toBe(false);
        expect(existsSync(kept.worktree)).toBe(true);
      } finally {
        kept.h.cleanup();
        rmSync(kept.dir, { recursive: true, force: true });
      }

      const gone = world();
      try {
        commitIn(gone.worktree, "b.txt");
        const answer = (await rpc(gone.h.router, "pi/session/delete", { path: gone.child, worktree: "delete" })) as { result: { worktree?: { path: string } } };
        expect(answer.result.worktree?.path).toBe(gone.worktree);
        // A person who was shown what it held and chose "delete" is obeyed.
        expect(existsSync(gone.worktree)).toBe(false);
        expect(gone.h.runs!.get("w1")?.worktree?.removedAt).toBeDefined();
      } finally {
        gone.h.cleanup();
        rmSync(gone.dir, { recursive: true, force: true });
      }
    });
  });
});
