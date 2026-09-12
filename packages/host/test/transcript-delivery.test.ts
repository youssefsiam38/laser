import { expect, it } from "vitest";
import type { JsonRpcNotification } from "@lasercode/protocol";
import { TranscriptDelivery } from "../src/transcript-delivery.js";
const update = (path: string): JsonRpcNotification => ({ jsonrpc: "2.0", method: "session/update", params: { sessionPath: path, seq: 1, at: new Date(0).toISOString(), update: { kind: "text_delta", text: "x".repeat(1000) } } });
const load = (d: TranscriptDelivery, path: string, selective = true) => d.begin({ jsonrpc: "2.0", id: 1, method: "session/load", params: { path, fromSeq: 0, ...(selective ? { transcript: "loaded" } : {}) } });
const success = { jsonrpc: "2.0" as const, id: 1, result: {} };
it("admits replay before the load reply, keeps caches and Beam current, and leaves lifecycle/questions global", () => {
  const d = new TranscriptDelivery();
  expect(d.accepts(update("/other"))).toBe(true);
  load(d, "/prior", false)(success);
  const finish = load(d, "/a");
  expect(d.accepts(update("/a"))).toBe(true);
  expect(d.accepts(update("/other"))).toBe(false);
  expect(d.accepts(update("/prior"))).toBe(true);
  load(d, "/beam")(success); finish(success);
  d.begin({ jsonrpc: "2.0", id: 2, method: "pi/session/detach", params: { path: "/a" } })(success);
  expect(d.accepts(update("/a"))).toBe(true); // cache still needs every seq
  expect(d.accepts(update("/beam"))).toBe(true);
  for (const method of ["pi/ui/request", "pi/session/attention", "agents/run", "tasks/update", "pi/worker/status"]) {
    expect(d.accepts({ jsonrpc: "2.0", method, params: { path: "/other" } })).toBe(true);
  }
  const failed = load(d, "/failed");
  failed({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "gone" } });
  expect(d.accepts(update("/failed"))).toBe(false);
});
it("does not lose first events of new/forked sessions or concurrent loads", () => {
  const d = new TranscriptDelivery(); load(d, "/a")(success);
  for (const method of ["session/new", "pi/session/fork"]) {
    const finish = d.begin({ jsonrpc: "2.0", id: 2, method, params: method === "session/new" ? { cwd: "/project" } : { path: "/a", entryId: "e" } });
    expect(d.accepts(update("/new"))).toBe(true);
    finish({ jsonrpc: "2.0", id: 2, result: { state: { path: "/new" } } });
    expect(d.accepts(update("/new"))).toBe(true);
    expect(d.accepts(update("/other"))).toBe(false);
  }
  const first = load(d, "/b"), second = load(d, "/b");
  first(); expect(d.accepts(update("/b"))).toBe(true); second(success);
  expect(d.accepts(update("/b"))).toBe(true);
});
it("bounds aggregate transcript wire bytes by loaded sessions at 1/8/32 active sessions", () => {
  for (const count of [1, 8, 32]) {
    const clients = [new TranscriptDelivery(), new TranscriptDelivery()];
    load(clients[0]!, "/0")(success); load(clients[1]!, `/${count - 1}`)(success);
    const notifications = Array.from({ length: count }, (_, i) => update(`/${i}`));
    const beforeBytes = notifications.reduce((sum, n) => sum + Buffer.byteLength(JSON.stringify(n)) * clients.length, 0);
    const afterBytes = clients.reduce((sum, d) => sum + notifications.filter(n => d.accepts(n)).reduce((s, n) => s + Buffer.byteLength(JSON.stringify(n)), 0), 0);
    expect(afterBytes).toBeLessThanOrEqual(beforeBytes / count + 2);
    console.log(JSON.stringify({ finding: "F22", sessions: count, beforeBytes, afterBytes }));
  }
});
