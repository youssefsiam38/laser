import { expect, it } from "vitest";
import type { JsonRpcNotification } from "@lasercode/protocol";
import { MEMBERSHIP_OWNERS_PER_PATH_MAX, MEMBERSHIP_PATHS_MAX, TranscriptDelivery } from "../src/transcript-delivery.js";

const update = (path: string): JsonRpcNotification => ({ jsonrpc: "2.0", method: "session/update", params: { sessionPath: path, seq: 1, at: new Date(0).toISOString(), update: { kind: "text_delta", text: "x".repeat(1000) } } });
const load = (d: TranscriptDelivery, path: string, options: { selective?: boolean; owner?: string } = {}) =>
  d.begin({
    jsonrpc: "2.0",
    id: 1,
    method: "session/load",
    params: { path, fromSeq: 0, ...(options.selective === false ? {} : { transcript: "loaded" }), ...(options.owner ? { owner: options.owner } : {}) },
  });
const detach = (d: TranscriptDelivery, path: string, owner?: string) =>
  d.begin({ jsonrpc: "2.0", id: 2, method: "pi/session/detach", params: { path, ...(owner ? { owner } : {}) } })(success);
const success = { jsonrpc: "2.0" as const, id: 1, result: {} };

it("admits replay before the load reply, keeps a newly created session, and leaves lifecycle/questions global", () => {
  const d = new TranscriptDelivery();
  expect(d.accepts(update("/other"))).toBe(true);
  load(d, "/prior", { selective: false })(success);
  const finish = load(d, "/a");
  expect(d.accepts(update("/a"))).toBe(true);
  expect(d.accepts(update("/other"))).toBe(false);
  expect(d.accepts(update("/prior"))).toBe(true);
  load(d, "/beam")(success);
  finish(success);
  for (const method of ["pi/ui/request", "pi/session/attention", "agents/run", "tasks/update", "pi/worker/status"]) {
    expect(d.accepts({ jsonrpc: "2.0", method, params: { path: "/other" } })).toBe(true);
  }
  const failed = load(d, "/failed");
  failed({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "gone" } });
  expect(d.accepts(update("/failed"))).toBe(false);
});

it("stops delivering a session when its last owner detaches, and again on reopen", () => {
  const d = new TranscriptDelivery();
  load(d, "/a")(success);
  expect(d.holders("/a")).toBe(1);
  detach(d, "/a");
  expect(d.holders("/a")).toBe(0);
  // The update it misses here is not lost: the client reopens with `fromSeq`
  // and the worker replays it (or `replayFrom` forces a resync).
  expect(d.accepts(update("/a"))).toBe(false);
  load(d, "/a")(success);
  expect(d.accepts(update("/a"))).toBe(true);
});

it("counts owners per connection: one scope leaving does not unsubscribe the other", () => {
  const d = new TranscriptDelivery();
  load(d, "/a")(success);
  load(d, "/a", { owner: "scope:1" })(success);
  expect(d.holders("/a")).toBe(2);
  detach(d, "/a");
  expect(d.holders("/a")).toBe(1);
  expect(d.accepts(update("/a"))).toBe(true);
  detach(d, "/a", "scope:1");
  expect(d.holders("/a")).toBe(0);
  expect(d.accepts(update("/a"))).toBe(false);
  expect(d.counts()).toEqual({ paths: 0, owners: 0 });
});

it("a detach during a load releases that load, and only a later load re-admits", () => {
  // Detach after the load began, before it answered: its success must not
  // bring the released owner back.
  const first = new TranscriptDelivery();
  load(first, "/x", { owner: "scope:1" })(success);
  const inFlight = load(first, "/a");
  detach(first, "/a");
  inFlight(success);
  expect(first.holders("/a")).toBe(0);
  expect(first.accepts(update("/a"))).toBe(false);

  // A load begun *after* the detach is a newer generation, and the older
  // detach cannot cancel it.
  const later = load(first, "/a");
  later(success);
  expect(first.holders("/a")).toBe(1);

  // The other ordering: detach first, then a load that overlaps it.
  const second = new TranscriptDelivery();
  load(second, "/a")(success);
  detach(second, "/a");
  const reopened = load(second, "/a");
  expect(second.accepts(update("/a"))).toBe(true);
  reopened(success);
  expect(second.holders("/a")).toBe(1);
});

it("treats duplicate concurrent loads by one owner as one hold", () => {
  const d = new TranscriptDelivery();
  const first = load(d, "/b");
  const second = load(d, "/b");
  first();
  expect(d.accepts(update("/b"))).toBe(true);
  second(success);
  expect(d.holders("/b")).toBe(1);
  detach(d, "/b");
  expect(d.holders("/b")).toBe(0);
});

it("does not lose first events of new or forked sessions", () => {
  const d = new TranscriptDelivery();
  load(d, "/a")(success);
  for (const method of ["session/new", "pi/session/fork"]) {
    const finish = d.begin({ jsonrpc: "2.0", id: 2, method, params: method === "session/new" ? { cwd: "/project" } : { path: "/a", entryId: "e" } });
    expect(d.accepts(update("/new"))).toBe(true);
    finish({ jsonrpc: "2.0", id: 2, result: { state: { path: "/new" } } });
    expect(d.accepts(update("/new"))).toBe(true);
    expect(d.accepts(update("/other"))).toBe(false);
    detach(d, "/new");
  }
});

it("bounds what one connection can hold, whatever labels it invents", () => {
  const d = new TranscriptDelivery();
  for (let index = 0; index < MEMBERSHIP_OWNERS_PER_PATH_MAX + 5; index++) load(d, "/a", { owner: `scope:${index}` })(success);
  expect(d.holders("/a")).toBe(MEMBERSHIP_OWNERS_PER_PATH_MAX);
  for (let index = 0; index < MEMBERSHIP_PATHS_MAX + 5; index++) load(d, `/p${index}`)(success);
  expect(d.counts().paths).toBeLessThanOrEqual(MEMBERSHIP_PATHS_MAX);
});

it("bounds aggregate transcript wire bytes by loaded sessions at 1/8/32 active sessions", () => {
  for (const count of [1, 8, 32]) {
    const clients = [new TranscriptDelivery(), new TranscriptDelivery()];
    load(clients[0]!, "/0")(success);
    load(clients[1]!, `/${count - 1}`)(success);
    const notifications = Array.from({ length: count }, (_, i) => update(`/${i}`));
    const beforeBytes = notifications.reduce((sum, n) => sum + Buffer.byteLength(JSON.stringify(n)) * clients.length, 0);
    const afterBytes = clients.reduce((sum, d) => sum + notifications.filter(n => d.accepts(n)).reduce((s, n) => s + Buffer.byteLength(JSON.stringify(n)), 0), 0);
    expect(afterBytes).toBeLessThanOrEqual(beforeBytes / count + 2);
    console.log(JSON.stringify({ finding: "F22", sessions: count, beforeBytes, afterBytes }));
  }
});
