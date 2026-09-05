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
  "session/prompt": { path: "/s.jsonl", content: [{ type: "text", text: "hi" }], streamingBehavior: "steer" },
  "session/cancel": { path: "/s.jsonl" },
  "session/set_mode": { path: "/s.jsonl", mode: "plan" },
  "pi/session/list": {},
  "pi/session/steer": { path: "/s.jsonl", content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] },
  "pi/session/follow_up": { path: "/s.jsonl", content: [{ type: "text", text: "later" }] },
  "pi/session/clear_queue": { path: "/s.jsonl" },
  "pi/session/fork": { path: "/s.jsonl", entryId: "abc" },
  "pi/session/navigate": { path: "/s.jsonl", entryId: "abc", summarize: true, label: "x" },
  "pi/session/rename": { path: "/s.jsonl", name: "feature" },
  "pi/session/entries": { path: "/s.jsonl" },
  "pi/session/compact": { path: "/s.jsonl" },
  "pi/model/list": { path: "/s.jsonl" },
  "pi/model/set": { path: "/s.jsonl", model: { provider: "stub", id: "stub-1" } },
  "pi/thinking/set": { path: "/s.jsonl", level: "high" },
  "pi/ui/response": { id: "ui-1", value: "Allow" },
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
