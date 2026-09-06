import { describe, expect, it } from "vitest";
import {
  ErrorCodes,
  ProtocolError,
  clientMethods,
  clientParamsSchemas,
  parseClientRequest,
  parseJsonLine,
  type ClientMethod,
} from "../src/index.js";

/** One valid params sample per method. The compiler-checked `satisfies` in schemas.ts
 *  guarantees the map is complete; this table guarantees each schema accepts a real shape. */
const samples: Record<ClientMethod, unknown> = {
  "session/new": { cwd: "/p" },
  "session/load": { path: "/s.jsonl", fromSeq: 12 },
  "session/search": { query: "Apple", cwd: "/p", after: "2026-01-01T00:00:00Z", before: "2026-07-01T00:00:00Z", cursor: 50 },
  "session/prompt": { path: "/s.jsonl", content: [{ type: "text", text: "hi" }], streamingBehavior: "steer" },
  "session/cancel": { path: "/s.jsonl" },
  "session/set_mode": { path: "/s.jsonl", mode: "plan" },
  "session/goal/get": { path: "/s.jsonl" },
  "session/goal/action": { path: "/s.jsonl", action: { action: "start", objective: "Ship the release", tokenBudget: 100_000 } },
  "pi/session/list": {},
  "pi/session/inbox": { cwd: "/p", limit: 20 },
  "pi/session/seen": { path: "/s.jsonl", seq: 12 },
  "pi/session/steer": { path: "/s.jsonl", content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] },
  "pi/session/follow_up": { path: "/s.jsonl", content: [{ type: "text", text: "later" }] },
  "pi/session/clear_queue": { path: "/s.jsonl" },
  "pi/session/fork": { path: "/s.jsonl", entryId: "abc" },
  "pi/session/navigate": { path: "/s.jsonl", entryId: "abc", summarize: true, label: "x" },
  "pi/session/rename": { path: "/s.jsonl", name: "feature" },
  "pi/session/delete": { path: "/s.jsonl" },
  "pi/session/entries": { path: "/s.jsonl" },
  "pi/session/detach": { path: "/s.jsonl" },
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

  // --- panels ---
  "pi/panel/action": { path: "/s.jsonl", id: "web-access:search:42", actionId: "open", value: "https://example.com" },
  "pi/account-usage/refresh": { path: "/s.jsonl" },
  "pi/panel/read": { path: "/tmp/session.jsonl", ref: "file:/tmp/run/events.jsonl", from: 0, to: 65536 },
  "pi/panel/list": { path: "/s.jsonl" },

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
};

describe("client request schemas", () => {
  it("every method has a sample and every sample round-trips through JSON", () => {
    expect(Object.keys(samples).sort()).toEqual([...clientMethods].sort());
    for (const method of clientMethods) {
      const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: samples[method] });
      const req = parseClientRequest(parseJsonLine(line));
      expect(req.method).toBe(method);
      expect(req.params).toEqual(samples[method]);
    }
  });

  it("rejects unknown keys, wrong enums, empty content", () => {
    expect(() => clientParamsSchemas["session/prompt"].parse({ path: "/s", content: [] })).toThrow();
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
