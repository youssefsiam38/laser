import { describe, expect, it } from "vitest";
import {
  AGENT_FLEET_ROWS_MAX,
  AGENT_RUN_STATUSES,
  AGENT_RUN_TERMINAL,
  BACKGROUND_TOOL_NAMES,
  ErrorCodes,
  HARNESS_TOOL_NAMES,
  ProtocolError,
  agentRunStatusSchema,
  backgroundTaskUpdateSchema,
  isTerminalRunStatus,
  clientMethods,
  clientParamsSchemas,
  parseClientRequest,
  parseJsonLine,
  sessionLoadResultSchema,
  type ClientMethod,
  type ClientRequests,
} from "../src/index.js";

/** One valid params sample per method. The compiler-checked `satisfies` in schemas.ts
 *  guarantees the map is complete; this table guarantees each schema accepts a real shape. */
const agentSample = {
  name: "reviewer",
  description: "Independent verification of a change",
  instructions: "You are an independent reviewer. Verify claims and report evidence.",
  engineInstructions: false,
  model: { provider: "anthropic", id: "claude-sonnet-5" },
  thinkingLevel: "medium",
  supportsSubagents: false,
  allowedAgents: [],
  scopedSkills: true,
  skills: [{ name: "code-review", path: "/home/me/.agents/skills/code-review/SKILL.md", scope: "global" }],
};

const samples: Record<ClientMethod, unknown> = {
  "pi/host/version": {},
  "session/new": { cwd: "/p" },
  "session/load": { path: "/s.jsonl", fromSeq: 12 },
  "session/search": { query: "Apple", cwd: "/p", after: "2026-01-01T00:00:00Z", before: "2026-07-01T00:00:00Z", cursor: 50 },
  "session/prompt": {
    path: "/s.jsonl",
    content: [{ type: "text", text: "hi" }],
    streamingBehavior: "steer",
    firstTurn: { agentName: "reviewer", thinkingLevel: "high" },
  },
  "session/cancel": { path: "/s.jsonl" },
  "session/set_mode": { path: "/s.jsonl", mode: "plan" },
  "session/goal/get": { path: "/s.jsonl" },
  "session/goal/action": { path: "/s.jsonl", action: { action: "start", objective: "Ship the release" } },
  "pi/session/list": {},
  "pi/session/inbox": { cwd: "/p", limit: 20 },
  "pi/session/seen": { path: "/s.jsonl", seq: 12 },
  "pi/session/steer": { path: "/s.jsonl", content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] },
  "pi/session/follow_up": { path: "/s.jsonl", content: [{ type: "text", text: "later" }] },
  "pi/session/clear_queue": { path: "/s.jsonl" },
  "session/pending/list": { path: "/s.jsonl" },
  "session/pending/add": { path: "/s.jsonl", content: [{ type: "text", text: "check the migration too" }] },
  "session/pending/edit": { path: "/s.jsonl", id: "p-9f2c1a04", content: [{ type: "text", text: "check the migration first" }] },
  "session/pending/remove": { path: "/s.jsonl", id: "p-9f2c1a04" },
  "session/pending/steer": { path: "/s.jsonl", id: "p-9f2c1a04" },
  "session/pending/clear": { path: "/s.jsonl" },
  "pi/session/fork": { path: "/s.jsonl", entryId: "abc", stopFirst: true },
  "pi/session/navigate": { path: "/s.jsonl", entryId: "abc", summarize: true, label: "x", stopFirst: true },
  "pi/session/rename": { path: "/s.jsonl", name: "feature" },
  "pi/session/delete": { path: "/s.jsonl", worktree: "delete" },
  "pi/session/entries": { path: "/s.jsonl" },
  "pi/session/detach": { path: "/s.jsonl" },
  "pi/session/move": { path: "/s.jsonl", cwd: "/p" },
  "pi/session/close": { path: "/s.jsonl" },
  "pi/session/compact": { path: "/s.jsonl" },
  "pi/model/list": { path: "/s.jsonl" },
  "pi/model/set": { path: "/s.jsonl", model: { provider: "stub", id: "stub-1" } },
  "pi/thinking/set": { path: "/s.jsonl", level: "high" },
  "pi/ui/response": { id: "ui-1", value: "Allow" },
  "pi/project/list": {},
  "pi/project/add": { cwd: "/p" },
  "pi/project/reorder": { cwds: ["/p/important", "/p/later"] },
  "pi/project/remove": { cwd: "/p" },
  "pi/project/trust": { cwd: "/p", trusted: true, remember: true },
  "pi/project/git": { cwd: "/p", path: "/s.jsonl" },
  "pi/project/browse": { path: "/home/me/code" },
  "pi/worker/list": {},
  "pi/worker/restart": { cwd: "/p" },
  "pi/worker/stop": { cwd: "/p" },

  // --- M4 ---
  "pi/settings/list": { cwd: "/p" },
  "pi/settings/get": { cwd: "/p" },
  "pi/settings/set": { cwd: "/p", scope: "global", changes: [{ path: "compaction.reserveTokens", op: "set", value: 8192 }] },
  "feature/list": { cwd: "/p" },
  "feature/set": { id: "subagents", enabled: true, scope: "project", cwd: "/p" },
  "web-search/status": { cwd: "/p" },
  "web-search/configure": { cwd: "/p", change: { action: "configure", provider: "openai", connection: { source: "shared", sharedProvider: "openai" }, activate: true } },
  "pi/packages/list": { cwd: "/p" },
  "pi/packages/install": { cwd: "/p", source: "pi-web-access", scope: "user", version: "1.4.2" },
  "pi/packages/catalog": { cwd: "/p", query: "web", limit: 40 },
  "pi/packages/runtime": {},
  "pi/packages/records": { cwd: "/p" },
  "pi/providers/login/start": { cwd: "/p", provider: "anthropic", method: "oauth" },
  "pi/providers/login/answer": { cwd: "/p", id: "login-1", promptId: "p-1", value: "sk-…" },
  "pi/providers/login/cancel": { cwd: "/p", id: "login-1" },
  "pi/providers/logout": { cwd: "/p", provider: "anthropic" },
  "pi/setup/state": {},
  "pi/setup/complete": { completed: true },
  "pi/packages/remove": { cwd: "/p", source: "pi-web-access", scope: "project" },
  "pi/packages/update": { cwd: "/p", source: "pi-web-access" },
  "pi/packages/check_updates": { cwd: "/p" },
  "pi/providers/list": { cwd: "/p" },
  "pi/models/catalog": { cwd: "/p", refresh: true },
  "pi/logs/query": { sections: ["provider"], search: "claude", limit: 100, beforeId: 900 },
  "pi/logs/content": { ref: "a".repeat(64), maxBytes: 4096 },
  "pi/logs/stats": {},
  "pi/logs/clear": { sections: ["tools", "provider"] },

  "pi/account-usage/refresh": { path: "/s.jsonl" },

  // --- background tasks ---
  "tasks/list": { path: "/s.jsonl" },
  "tasks/output": { path: "/s.jsonl", id: "t-9f2c1a04", fromByte: 0 },
  "tasks/stop": { path: "/s.jsonl", id: "t-9f2c1a04" },
  "pi/task/stop": { path: "/s.jsonl", id: "t-9f2c1a04" },

  // --- M11 prefs ---
  "pi/prefs/get": { namespace: "theme" },
  "pi/prefs/set": { namespace: "theme", value: { followSystem: false, theme: { id: "graphite", base: "dark" } } },

  // --- M4-T7 keybindings ---
  "pi/keybindings/get": { cwd: "/p" },
  "pi/keybindings/set": { cwd: "/p", changes: [{ id: "app.interrupt", op: "set", keys: ["ctrl+c"] }, { id: "tui.editor.undo", op: "reset" }] },

  // --- composer sources ---
  "pi/commands/list": { path: "/s.jsonl" },
  "pi/prompts/list": { path: "/s.jsonl" },
  "pi/project/files": { cwd: "/p", query: "srcidx", limit: 50 },

  // --- M7 push ---
  "pi/push/config": {},
  "pi/push/subscribe": {
    subscription: { endpoint: "https://push.example.com/abc", keys: { p256dh: "BJ...", auth: "sO..." } },
    device: { label: "iPhone · Safari", platform: "ios", standalone: true },
  },
  "pi/push/unsubscribe": { endpoint: "https://push.example.com/abc" },
  "pi/push/test": { endpoint: "https://push.example.com/abc" },

  // --- M8 dictation ---
  "pi/transcribe/status": { cwd: "/tmp/p" },
  "pi/transcribe/begin": { cwd: "/tmp/p", mimeType: "audio/webm;codecs=opus", path: "/s.jsonl" },
  "pi/transcribe/chunk": { id: "upload-1", data: "AAAA" },
  "pi/transcribe/end": { id: "upload-1" },
  "pi/transcribe/cancel": { id: "upload-1" },

  // --- M13 agents ---
  "agents/list": {},
  "agents/validate": { agent: agentSample, originalName: null },
  "agents/save": { agent: agentSample, originalName: null },
  "agents/delete": { name: "reviewer" },
  "agents/set-default": { name: "reviewer" },
  "agents/set-policy": { policy: { maxDepth: 2, foregroundCommandSeconds: 90 } },
  "agents/skills": { cwd: "/p" },
  "agents/engine-instructions": { cwd: "/p" },
  "agents/runs/list": { path: "/s.jsonl" },
  "agents/runs/stop": { runId: "run_7", reason: "Wrong direction" },
  "agents/worktree/status": { path: "/s.jsonl" },
  "agents/worktree/remove": { path: "/s.jsonl", force: true },
  "agents/builtin/set-model": { name: "chat", model: { provider: "openai", id: "gpt-5.6-luna" } },
  "agents/builtin/set-instructions": { name: "chat", instructions: "Answer like an exacting editor." },
  "agents/namer/qualify": { cwd: "/p" },
  "agents/sync": { snapshot: { revision: 3, agents: [], defaultAgent: "default" } },
};

describe("client request schemas", () => {
  it("round-trips the search connection probe without a provider override", () => {
    const request = { jsonrpc: "2.0", id: 1, method: "web-search/configure", params: { cwd: "/p", change: { action: "test" } } };
    expect(parseClientRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
    expect(clientParamsSchemas["web-search/configure"].safeParse({ cwd: "/p", change: { action: "test", provider: "duckduckgo" } }).success).toBe(false);
  });

  it("a built-in's model is set by name, for each of the three, and nulls back to the default", () => {
    const schema = clientParamsSchemas["agents/builtin/set-model"];
    for (const name of ["beam", "chat", "namer"]) {
      expect(schema.safeParse({ name, model: null }).success).toBe(true);
      expect(schema.safeParse({ name, model: { provider: "openai", id: "gpt-5-mini" } }).success).toBe(true);
    }
    // Only the built-ins: a custom agent's model is part of its definition.
    expect(schema.safeParse({ name: "reviewer", model: null }).success).toBe(false);
    expect(schema.safeParse({ model: null }).success).toBe(false);
    expect(schema.safeParse({ name: "chat" }).success).toBe(false);
    expect(schema.safeParse({ name: "chat", model: { provider: "openai", id: "x" }, extra: 1 }).success).toBe(false);
  });

  it("a built-in's instructions are set by name, or restored with null", () => {
    const schema = clientParamsSchemas["agents/builtin/set-instructions"];
    for (const name of ["beam", "chat", "namer"]) {
      expect(schema.safeParse({ name, instructions: "Be exact." }).success).toBe(true);
      expect(schema.safeParse({ name, instructions: null }).success).toBe(true);
    }
    expect(schema.safeParse({ name: "default", instructions: "x" }).success).toBe(false);
    expect(schema.safeParse({ name: "chat" }).success).toBe(false);
    expect(schema.safeParse({ name: "chat", instructions: "x", extra: true }).success).toBe(false);
  });

  it("every method has a sample and every sample round-trips through JSON", () => {
    expect(Object.keys(samples).sort()).toEqual([...clientMethods].sort());
    for (const method of clientMethods) {
      const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: samples[method] });
      const req = parseClientRequest(parseJsonLine(line));
      expect(req.method).toBe(method);
      expect(req.params).toEqual(samples[method]);
    }
  });

  it("refuses agent names that are not lower-case identifiers and unknown policy keys", () => {
    expect(clientParamsSchemas["agents/delete"].safeParse({ name: "Reviewer" }).success).toBe(false);
    expect(clientParamsSchemas["agents/delete"].safeParse({ name: "-review" }).success).toBe(false);
    expect(clientParamsSchemas["agents/save"].safeParse({ agent: { ...agentSample, name: "a".repeat(41) }, originalName: null }).success).toBe(false);
    expect(clientParamsSchemas["agents/set-policy"].safeParse({ policy: { maxDepth: 0 } }).success).toBe(false);
    expect(clientParamsSchemas["agents/set-policy"].safeParse({ policy: { budget: 3 } }).success).toBe(false);
    expect(clientParamsSchemas["session/new"].safeParse({ cwd: "/p", agentName: "beam" }).success).toBe(true);
  });

  it("accepts only user and project skill scopes", () => {
    const save = clientParamsSchemas["agents/save"];
    expect(save.safeParse({ agent: { ...agentSample, scopedSkills: true, skills: [{ name: "review", path: "/skills/review/SKILL.md", scope: "global" }] }, originalName: null }).success).toBe(true);
    expect(save.safeParse({ agent: { ...agentSample, scopedSkills: true, skills: [{ name: "review", path: "/skills/review/SKILL.md", scope: "project" }] }, originalName: null }).success).toBe(true);
    expect(save.safeParse({ agent: { ...agentSample, scopedSkills: true, skills: [{ name: "review", path: "/skills/review/SKILL.md", scope: "bundled" }] }, originalName: null }).success).toBe(false);
  });

  it("lets a delete omit the worktree instruction, and refuses anything but keep or delete", () => {
    const del = clientParamsSchemas["pi/session/delete"];
    expect(del.safeParse({ path: "/s.jsonl" }).success).toBe(true);
    expect(del.safeParse({ path: "/s.jsonl", worktree: "keep" }).success).toBe(true);
    expect(del.safeParse({ path: "/s.jsonl", worktree: "delete" }).success).toBe(true);
    expect(del.safeParse({ path: "/s.jsonl", worktree: true }).success).toBe(false);
    expect(del.safeParse({ path: "/s.jsonl", worktree: "remove" }).success).toBe(false);
  });

  it("moves a session by its path and a project directory, and nothing else", () => {
    const move = clientParamsSchemas["pi/session/move"];
    expect(move.safeParse({ path: "/s.jsonl", cwd: "/p" }).success).toBe(true);
    expect(move.safeParse({ path: "/s.jsonl" }).success).toBe(false);
    expect(move.safeParse({ path: "/s.jsonl", cwd: "" }).success).toBe(false);
    // The destination file is the host's decision: a caller cannot name one.
    expect(move.safeParse({ path: "/s.jsonl", cwd: "/p", to: "/p/x.jsonl" }).success).toBe(false);
    expect(clientParamsSchemas["pi/session/close"].safeParse({ path: "/s.jsonl", force: true }).success).toBe(false);
  });

  it("addresses a worktree by its child session's path, never by a fifth identity", () => {
    expect(clientParamsSchemas["agents/worktree/status"].safeParse({ path: "/s.jsonl" }).success).toBe(true);
    expect(clientParamsSchemas["agents/worktree/status"].safeParse({ runId: "run_7" }).success).toBe(false);
    expect(clientParamsSchemas["agents/worktree/remove"].safeParse({ path: "/s.jsonl" }).success).toBe(true);
    expect(clientParamsSchemas["agents/worktree/remove"].safeParse({ path: "/s.jsonl", force: "yes" }).success).toBe(false);
  });

  it("names one pending message by the id the worker minted, never by index or text", () => {
    const steer = clientParamsSchemas["session/pending/steer"];
    expect(steer.safeParse({ path: "/s.jsonl", id: "p-9f2c1a04" }).success).toBe(true);
    for (const id of ["", "0", "steer:0", "p-", "p-XYZ", "p-9f2c1a04!", "../p-9f2c1a04"]) {
      expect(steer.safeParse({ path: "/s.jsonl", id }).success).toBe(false);
    }
    // An edit with nothing in it would empty the row rather than change it.
    expect(clientParamsSchemas["session/pending/edit"].safeParse({ path: "/s.jsonl", id: "p-9f2c1a04", content: [] }).success).toBe(false);
    expect(clientParamsSchemas["session/pending/add"].safeParse({ path: "/s.jsonl", content: [{ type: "text", text: "x" }], lane: "steer" }).success).toBe(false);
  });

  it("rejects unknown keys, wrong enums, empty content", () => {
    expect(() => clientParamsSchemas["session/goal/action"].parse({ path: "/s", action: { action: "start", objective: "Inspect", tokenBudget: 1000 } })).toThrow();
    expect(() => clientParamsSchemas["session/prompt"].parse({ path: "/s", content: [] })).toThrow();
    expect(() => clientParamsSchemas["session/prompt"].parse({ path: "/s", content: [{ type: "text", text: "hi" }], firstTurn: { agentName: "Reviewer" } })).toThrow();
    expect(() => clientParamsSchemas["session/prompt"].parse({ path: "/s", content: [{ type: "text", text: "hi" }], firstTurn: { agentName: "reviewer", model: "hidden" } })).toThrow();
    expect(() => clientParamsSchemas["pi/thinking/set"].parse({ path: "/s", level: "ultra" })).toThrow();
    expect(() => clientParamsSchemas["session/new"].parse({ cwd: "/p", extra: 1 })).toThrow();
    expect(() => clientParamsSchemas["pi/ui/response"].parse({ id: "x", cancelled: false })).toThrow();
  });

  it("bounds literal history searches and validates date ranges and cursors", () => {
    const schema = clientParamsSchemas["session/search"];
    expect(schema.parse({ query: "  Apple  " })).toEqual({ query: "Apple" });
    for (const params of [{ query: " " }, { query: "x".repeat(201) }, { query: "x", after: "yesterday" }, { query: "x", cursor: -1 }, { query: "x", cursor: 0.5 }, { query: "x", path: "/arbitrary-file" }]) expect(() => schema.parse(params)).toThrow();
  });

  it("refuses a settings path that could reach an object's prototype", () => {
    for (const path of ["__proto__", "compaction.__proto__.x", "constructor", "a.prototype.b", "a..b", "a b"]) {
      expect(() =>
        clientParamsSchemas["pi/settings/set"].parse({ cwd: "/p", scope: "global", changes: [{ path, op: "unset" }] }),
      ).toThrow();
    }
    expect(() =>
      clientParamsSchemas["pi/settings/set"].parse({ cwd: "/p", scope: "user", changes: [{ path: "theme", op: "unset" }] }),
    ).toThrow();
  });

  it("refuses a preference namespace that is not a flat lower-case id, and an oversized value", () => {
    for (const namespace of ["Theme", "a/b", "a.b", "", "-x", "théme"]) {
      expect(() => clientParamsSchemas["pi/prefs/set"].parse({ namespace, value: 1 })).toThrow();
    }
    expect(() => clientParamsSchemas["pi/prefs/set"].parse({ namespace: "theme" })).toThrow();
    expect(() =>
      clientParamsSchemas["pi/prefs/set"].parse({ namespace: "theme", value: { big: "x".repeat(300_000) } }),
    ).toThrow();
    // Clearing a namespace is a real edit, not a missing value.
    expect(clientParamsSchemas["pi/prefs/set"].parse({ namespace: "theme", value: null })).toEqual({
      namespace: "theme",
      value: null,
    });
  });

  it("refuses a keybinding id or key the agent could not parse", () => {
    const set = (change: unknown) => () => clientParamsSchemas["pi/keybindings/set"].parse({ cwd: "/p", changes: [change] });
    expect(set({ id: "app.interrupt", op: "set", keys: [] })).toThrow();
    expect(set({ id: "app.interrupt", op: "set", keys: ["ctrl + c"] })).toThrow();
    expect(set({ id: "app/interrupt", op: "set", keys: ["ctrl+c"] })).toThrow();
    expect(set({ id: "__proto__", op: "reset" })).toThrow();
    expect(set({ id: "app.interrupt", op: "reset", keys: ["ctrl+c"] })).toThrow();
  });

  it("refuses an install version that is a range rather than a release", () => {
    for (const version of ["^1.2.3", "latest", "1.2", "1.2.x", ">=1"]) {
      expect(() =>
        clientParamsSchemas["pi/packages/install"].parse({ cwd: "/p", source: "x", scope: "user", version }),
      ).toThrow();
    }
    expect(() =>
      clientParamsSchemas["pi/packages/install"].parse({ cwd: "/p", source: "x", scope: "user", version: "1.2.3-rc.1" }),
    ).not.toThrow();
  });

  it("round-trips a background task and refuses a widened one", () => {
    const task = {
      id: "t-9f2c1a04",
      command: "pnpm -r test",
      title: "pnpm -r test",
      status: "running",
      origin: "promoted",
      startedAt: "2026-09-08T10:00:00.000Z",
      outputBytes: 4096,
      activity: "PASS packages/protocol",
      logPath: "/tmp/lasercode-tasks/s/t-9f2c1a04.log",
    };
    expect(backgroundTaskUpdateSchema.parse(task)).toEqual(task);
    // A terminal task keeps the reason it ended, and the exit code may be null.
    expect(() =>
      backgroundTaskUpdateSchema.parse({
        ...task,
        status: "stopped",
        endedAt: "2026-09-08T10:04:00.000Z",
        exitCode: null,
        terminalReason: "you stopped it",
      }),
    ).not.toThrow();
    expect(() => backgroundTaskUpdateSchema.parse({ ...task, status: "flying" })).toThrow();
    expect(() => backgroundTaskUpdateSchema.parse({ ...task, className: "danger" })).toThrow();
    expect(() => backgroundTaskUpdateSchema.parse({ ...task, outputBytes: -1 })).toThrow();
  });

  it("refuses a task output read for a task without a session", () => {
    expect(() => clientParamsSchemas["tasks/output"].parse({ id: "t-1", fromByte: 0 })).toThrow();
    expect(() => clientParamsSchemas["tasks/output"].parse({ path: "/s.jsonl", id: "t-1", fromByte: -1 })).toThrow();
  });

  it("round-trips a session/load result and keeps both sequence numbers", () => {
    // The shape a client reads to decide whether it missed anything: `seq` is
    // the watermark it stamps on a freshly hydrated view, `replayFrom` the
    // earliest seq the reply covers. Dropping `seq` is what made a re-opened
    // session ask from 0 and receive its whole transcript twice.
    const result: ClientRequests["session/load"]["result"] = {
      state: {
        path: "/s.jsonl",
        id: "s",
        cwd: "/p",
        model: null,
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        autoCompactionEnabled: true,
        messageCount: 2,
        pendingMessageCount: 0,
      },
      replayFrom: 12,
      seq: 41,
    };
    expect(sessionLoadResultSchema.parse(result)).toEqual(result);
    // A fresh open answers it too, so "no live update yet" is 0, never absent.
    expect(() => sessionLoadResultSchema.parse({ state: result.state, replayFrom: 0, seq: 0 })).not.toThrow();
    expect(() => sessionLoadResultSchema.parse({ state: result.state, replayFrom: 0 })).toThrow();
    expect(() => sessionLoadResultSchema.parse({ state: result.state, replayFrom: 0, seq: -1 })).toThrow();
    expect(() => sessionLoadResultSchema.parse({ state: result.state, replayFrom: 0, seq: 1.5 })).toThrow();
    // Strict: another counter cannot arrive without saying what it means.
    expect(() => sessionLoadResultSchema.parse({ ...result, tail: 9 })).toThrow();
  });

  it("refuses a log content ref that is not a sha256", () => {
    expect(() => clientParamsSchemas["pi/logs/content"].parse({ ref: "../../etc/passwd" })).toThrow();
    expect(() => clientParamsSchemas["pi/logs/content"].parse({ ref: "A".repeat(64) })).toThrow();
  });

  it("maps failures to JSON-RPC error codes", () => {
    const code = (raw: unknown) => {
      try {
        parseClientRequest(raw);
        return null;
      } catch (e) {
        return e instanceof ProtocolError ? e.code : "not-protocol-error";
      }
    };
    expect(code({ jsonrpc: "1.0", id: 1, method: "session/new", params: {} })).toBe(ErrorCodes.InvalidRequest);
    expect(code({ jsonrpc: "2.0", id: 1, method: "nope/x", params: {} })).toBe(ErrorCodes.MethodNotFound);
    expect(code({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "" } })).toBe(ErrorCodes.InvalidParams);
    expect(() => parseJsonLine("{not json")).toThrow(ProtocolError);
    try {
      parseJsonLine("{not json");
    } catch (e) {
      expect((e as ProtocolError).code).toBe(ErrorCodes.ParseError);
    }
  });

  it("treats missing params as an empty object for methods that allow it", () => {
    const req = parseClientRequest({ jsonrpc: "2.0", id: "a", method: "pi/session/list" });
    expect(req.params).toEqual({});
  });
});

describe("run status vocabulary", () => {
  it("carries needs_input as a live status, distinct from blocked, and no waiting tool", () => {
    // M13-T45: a child paused on a question is `needs_input` — live, not
    // ended — and `blocked` stays the ended shape. The wire schema follows the
    // list, so a status the list does not know is refused.
    expect([...AGENT_RUN_STATUSES]).toEqual(["queued", "running", "needs_input", "completed", "blocked", "failed", "cancelled"]);
    expect([...AGENT_RUN_TERMINAL]).toEqual(["completed", "blocked", "failed", "cancelled"]);
    expect(isTerminalRunStatus("needs_input")).toBe(false);
    expect(isTerminalRunStatus("blocked")).toBe(true);
    for (const status of AGENT_RUN_STATUSES) expect(agentRunStatusSchema.safeParse(status).success).toBe(true);
    expect(agentRunStatusSchema.safeParse("waiting").success).toBe(false);
    expect(agentRunStatusSchema.safeParse("timed_out").success).toBe(false);
    expect([...HARNESS_TOOL_NAMES]).toContain("inspect_agent");
    expect([...HARNESS_TOOL_NAMES]).not.toContain("wait_for_agents");
    // D-162: the same rule for background commands — no `task_wait`; every
    // exit reaches the model as a message.
    expect([...BACKGROUND_TOOL_NAMES]).not.toContain("task_wait");
  });

  it("names one fleet tool and no list of either kind (D-163)", () => {
    // The agent reads running work the way the person does: one tree, both
    // kinds of work, scoped to its session. `list_agents` and `task_list`
    // were two half-views of the same thing and are gone.
    expect([...HARNESS_TOOL_NAMES]).toEqual(["start_agent", "send_agent_message", "inspect_fleet", "inspect_agent", "stop_agent", "remove_agent_worktree", "complete_agent_run"]);
    expect([...HARNESS_TOOL_NAMES]).not.toContain("list_agents");
    expect([...BACKGROUND_TOOL_NAMES]).toEqual(["task_output", "task_stop"]);
    expect([...BACKGROUND_TOOL_NAMES]).not.toContain("task_list");
    expect(AGENT_FLEET_ROWS_MAX).toBe(50);
  });
});
