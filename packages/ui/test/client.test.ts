/**
 * HostClient: the visibility listener's lifetime, delta coalescing, and the
 * reconnect resume loop (which sessions it resumes and what it does with
 * `replayFrom`). Uses hand-rolled `WebSocket` / `document` / rAF stubs so the
 * suite stays in the node environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostNotificationMethod } from "@lasercode/protocol";
import { PRODUCT_VERSION, type EnvironmentDescriptor } from "@lasercode/protocol";
import { HostClient } from "../src/client.js";
import { testDescriptor } from "./runtime/environment-fixture.js";
import { createStateStore } from "../src/runtime/LaserProvider.js";
import { initialState, reduce } from "../src/store.js";

// --- stubs -----------------------------------------------------------------

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | undefined;
  onmessage: ((event: { data: string }) => void) | undefined;
  onclose: (() => void) | undefined;
  onerror: (() => void) | undefined;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  /**
   * The whole handshake: the version, and then the environment the client now
   * waits for before it opens (RP-13). `null` answers nothing, for the tests
   * that drive a step by hand.
   */
  accept(version: string | null = PRODUCT_VERSION, environment: EnvironmentDescriptor | null = testDescriptor()): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
    if (version === null) return;
    this.deliver({ jsonrpc: "2.0", id: 0, result: { version } });
    if (environment !== null) this.describe(environment);
  }

  /** Answer `environment/describe` — or refuse it, with `null`. */
  describe(environment: EnvironmentDescriptor | null = testDescriptor()): void {
    this.deliver(environment === null
      ? { jsonrpc: "2.0", id: -1, error: { code: -32601, message: "no" } }
      : { jsonrpc: "2.0", id: -1, result: { environment } });
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  frames(): Array<{ id?: number; method: string; params: Record<string, unknown> }> {
    return this.sent.map((s) => JSON.parse(s) as { id?: number; method: string; params: Record<string, unknown> }).filter((s) => s.id !== 0 && s.id !== -1);
  }
}

interface FakeDocument {
  visibilityState: string;
  listeners: Map<string, Set<() => void>>;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  fire(type: string): void;
}

const fakeDocument = (): FakeDocument => ({
  visibilityState: "visible",
  listeners: new Map(),
  addEventListener(type, fn) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  },
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  },
  fire(type) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  },
});

let frames: Array<() => void> = [];
const runFrame = (): void => {
  const due = frames;
  frames = [];
  for (const fn of due) fn();
};

let doc: FakeDocument;

beforeEach(() => {
  FakeSocket.instances = [];
  frames = [];
  doc = fakeDocument();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
    frames.push(fn);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const build = (over: Partial<ConstructorParameters<typeof HostClient>[0]> = {}) => {
  const notifications: Array<{ method: HostNotificationMethod; params: unknown }> = [];
  const client = new HostClient({
    url: "ws://test/ws",
    onNotification: (method, params) => notifications.push({ method, params }),
    ...over,
  });
  return { client, notifications };
};

const updateMessage = (seq: number) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionPath: "/s.jsonl", seq, at: "", update: { kind: "text_delta", delta: String(seq), contentIndex: 0 } },
});

// --- tests -----------------------------------------------------------------

it("does not load or resume sessions until the host release matches", async () => {
  const { client } = build(); client.track("/s.jsonl", 4); client.connect();
  const socket = FakeSocket.instances[0]!; socket.accept(null);
  expect(client.connection).toBe("connecting"); expect(socket.frames()).toEqual([]);
  await expect(client.request("session/new", { cwd: "/work" })).rejects.toThrow();
  socket.deliver({ jsonrpc: "2.0", id: 0, result: { version: PRODUCT_VERSION } });
  // The version matched, and still nothing happens: the environment has not
  // been described yet, so there is nothing this view knows it may do.
  expect(client.connection).toBe("connecting"); expect(socket.frames()).toEqual([]);
  socket.describe();
  expect(client.connection).toBe("open"); expect(socket.frames()[0]?.method).toBe("session/load");
  client.close();
});

it("refuses descriptor-denied requests before allocating an id or sending a frame", async () => {
  const { client } = build();
  client.connect();
  const socket = FakeSocket.instances[0]!;
  socket.accept(PRODUCT_VERSION, testDescriptor({ scopes: ["handshake", "read"] }));

  const before = socket.sent.length;
  await expect(client.request("pi/settings/set", { scope: "global", changes: [] })).rejects.toThrow(/settings access/i);
  expect(socket.sent).toHaveLength(before);

  const allowed = client.request("pi/session/list", {});
  expect(socket.frames().at(-1)).toMatchObject({ id: 1, method: "pi/session/list" });
  socket.deliver({ jsonrpc: "2.0", id: 1, result: { sessions: [] } });
  await allowed;
  client.close();
});

it("refuses local-only and capability-denied requests without a WebSocket frame", async () => {
  for (const [descriptor, method, params] of [
    [testDescriptor({ localOnly: ["pi/settings/get"] }), "pi/settings/get", { cwd: "/work" }],
    [testDescriptor({ capabilities: { logs: false } }), "pi/logs/query", { limit: 1 }],
  ] as const) {
    const { client } = build();
    client.connect();
    const socket = FakeSocket.instances.at(-1)!;
    socket.accept(PRODUCT_VERSION, descriptor);
    const before = socket.sent.length;
    await expect(client.request(method, params as never)).rejects.toThrow();
    expect(socket.sent).toHaveLength(before);
    client.close();
  }
});

it("stops reconnect and resume on a new host version without sending a cancellation", async () => {
  vi.useFakeTimers(); const mismatch = vi.fn();
  const { client } = build({ onVersionMismatch: mismatch });
  client.track("/s.jsonl", 4); client.connect();
  const socket = FakeSocket.instances[0]!; socket.accept("99.0.0");
  expect(mismatch).toHaveBeenCalledExactlyOnceWith("99.0.0");
  expect(socket.frames()).toEqual([]);
  await expect(client.whenConnected()).rejects.toThrow(/Refresh/);
  client.reconnect("visible"); doc.fire("visibilitychange"); vi.advanceTimersByTime(60_000);
  expect(FakeSocket.instances).toHaveLength(1);
  client.close();
});

it("does not allow a matching web bundle to hide an older Electron main", () => {
  vi.stubGlobal("desktop", { version: "0.0.1" });
  const mismatch = vi.fn(), { client } = build({ onVersionMismatch: mismatch });
  client.connect(); FakeSocket.instances[0]!.accept();
  expect(mismatch).toHaveBeenCalledWith(PRODUCT_VERSION);
  expect(client.connection).toBe("closed"); client.close();
});

describe("visibility listener", () => {
  it("registers once per client and is removed on close", () => {
    const { client } = build();
    client.connect();
    client.connect();
    expect(doc.listeners.get("visibilitychange")?.size).toBe(1);

    client.close();
    expect(doc.listeners.get("visibilitychange")?.size).toBe(0);
  });

  it("does not resurrect a closed client when the tab is focused", () => {
    const { client } = build();
    client.connect();
    FakeSocket.instances[0]!.accept();
    client.close();
    expect(FakeSocket.instances).toHaveLength(1);

    doc.fire("visibilitychange");
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("reopens a dropped socket when the tab comes back", () => {
    const { client } = build();
    client.connect();
    const socket = FakeSocket.instances[0]!;
    socket.accept();
    socket.close();
    expect(client.connection).toBe("closed");

    doc.fire("visibilitychange");
    expect(FakeSocket.instances).toHaveLength(2);
  });
});

describe("delta coalescing", () => {
  it.each(["frame", "timer", "dialog", "reply", "disconnect"])("publishes once at the %s barrier without skipping accepted sequences", async (barrier) => {
    vi.useFakeTimers();
    const initial = reduce(initialState, { type: "opened", state: {
      path: "/s.jsonl", id: "s", cwd: "/p", model: null, thinkingLevel: "medium",
      isStreaming: true, isCompacting: false, steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0,
    } });
    const seeded = reduce(initial, { type: "notification", method: "session/update", params: {
      sessionPath: "/s.jsonl", seq: 1, at: "", update: { kind: "text_delta", delta: "start", contentIndex: 0 },
    } });
    const store = createStateStore(seeded);
    const unbatched = createStateStore(seeded);
    const published = vi.fn();
    const baseline = vi.fn();
    store.subscribe(published);
    unbatched.subscribe(baseline);
    const observed: number[] = [];
    const { client } = build({
      batchNotifications: store.batch,
      onNotification: (method, params) => {
        if (method !== "session/update") {
          expect(published).toHaveBeenCalledTimes(1);
          return;
        }
        store.dispatch({ type: "notification", method, params });
        unbatched.dispatch({ type: "notification", method, params });
      },
    });
    client.subscribe((method) => {
      if (method === "session/update") observed.push(store.getSnapshot().open["/s.jsonl"]!.lastSeq);
    });
    client.connect();
    const socket = FakeSocket.instances[0]!;
    socket.accept();
    for (let seq = 2; seq <= 33; seq++) socket.deliver(updateMessage(seq));
    expect(published).not.toHaveBeenCalled();
    if (barrier === "frame") runFrame();
    if (barrier === "timer") vi.advanceTimersByTime(33);
    if (barrier === "dialog") socket.deliver({ jsonrpc: "2.0", method: "pi/ui/request", params: {} });
    if (barrier === "reply") {
      const reply = client.request("pi/session/list", {});
      socket.deliver({ jsonrpc: "2.0", id: socket.frames().at(-1)!.id, result: { sessions: [] } });
      await reply;
    }
    if (barrier === "disconnect") socket.close();
    expect(published).toHaveBeenCalledTimes(1);
    expect(baseline).toHaveBeenCalledTimes(32);
    expect(observed).toEqual(Array.from({ length: 32 }, (_, i) => i + 2));
    expect(store.getSnapshot()).toEqual(unbatched.getSnapshot());
    runFrame();
    vi.advanceTimersByTime(33);
    expect(published).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("settles nested and throwing store transactions synchronously; no-op batches do not publish", () => {
    const store = createStateStore();
    const published = vi.fn();
    store.subscribe(published);
    store.batch(() => {});
    expect(published).not.toHaveBeenCalled();
    expect(() => store.batch(() => {
      store.batch(() => store.dispatch({ type: "connection", state: "open" }));
      expect(store.getSnapshot().connection).toBe("open");
      expect(published).not.toHaveBeenCalled();
      throw new Error("listener");
    })).toThrow("listener");
    expect(published).toHaveBeenCalledTimes(1);
    store.dispatch({ type: "connection", state: "closed" });
    expect(published).toHaveBeenCalledTimes(2);
  });
  it("holds session/update until the next frame, in seq order", () => {
    const { client, notifications } = build();
    client.connect();
    const socket = FakeSocket.instances[0]!;
    socket.accept();

    socket.deliver(updateMessage(1));
    socket.deliver(updateMessage(2));
    socket.deliver(updateMessage(3));
    expect(notifications).toHaveLength(0);

    runFrame();
    expect(notifications.map((n) => (n.params as { seq: number }).seq)).toEqual([1, 2, 3]);
  });

  it("still flushes on a timer when no frame ever paints (hidden tab)", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.useFakeTimers();
    const { client, notifications } = build();
    client.connect();
    const socket = FakeSocket.instances[0]!;
    socket.accept();

    socket.deliver(updateMessage(1));
    socket.deliver(updateMessage(2));
    expect(notifications).toHaveLength(0);

    vi.advanceTimersByTime(50);
    expect(notifications.map((n) => (n.params as { seq: number }).seq)).toEqual([1, 2]);
  });

  it("measures queued deltas in exact UTF-8 bytes, including multi-byte text (RP-7)", () => {
    // A CJK or emoji transcript weighs two to four bytes per code unit. Counting
    // UTF-16 length would let a byte bound hold three times what it says.
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.useFakeTimers();
    const { client, notifications } = build();
    client.connect();
    const socket = FakeSocket.instances[0]!;
    socket.accept();

    // 450,000 characters of three-byte text: under a megabyte of UTF-16 code
    // units, comfortably over it in the bytes that are actually queued.
    const cjk = "日本語".repeat(150_000);
    socket.deliver({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionPath: "/s.jsonl", seq: 1, at: "", update: { kind: "text_delta", delta: cjk, contentIndex: 0 } },
    });
    expect(notifications).toHaveLength(1);
    expect((notifications[0]!.params as { update: { delta: string } }).update.delta).toBe(cjk);

    // The same for a surrogate pair, whose UTF-8 form is twice its UTF-16 one.
    const emoji = "🚀".repeat(300_000);
    socket.deliver({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionPath: "/s.jsonl", seq: 2, at: "", update: { kind: "text_delta", delta: emoji, contentIndex: 0 } },
    });
    expect(notifications).toHaveLength(2);
    expect((notifications[1]!.params as { update: { delta: string } }).update.delta).toBe(emoji);
  });

  it("measures a structural update by what it really weighs, not by a guess", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.useFakeTimers();
    const { client, notifications } = build();
    client.connect();
    const socket = FakeSocket.instances[0]!;
    socket.accept();

    // No `delta`, no `text`: a tool result, which used to count as 256 bytes
    // however large it was.
    socket.deliver({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionPath: "/s.jsonl",
        seq: 1,
        at: "",
        update: { kind: "tool_execution_end", toolCallId: "t1", result: { output: "x".repeat(2 * 1024 * 1024) } },
      },
    });
    expect(notifications).toHaveLength(1);
  });

  it("never holds a batch over the threshold between callbacks", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.useFakeTimers();
    const { client, notifications } = build();
    client.connect();
    const socket = FakeSocket.instances[0]!;
    socket.accept();

    const piece = "y".repeat(200 * 1024);
    let delivered = 0;
    for (let seq = 1; seq <= 30; seq++) {
      socket.deliver({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionPath: "/s.jsonl", seq, at: "", update: { kind: "text_delta", delta: piece, contentIndex: 0 } },
      });
      const pending = (client as unknown as { pendingBytes: number }).pendingBytes;
      expect(pending).toBeLessThanOrEqual(1024 * 1024);
      delivered = notifications.length;
    }
    vi.advanceTimersByTime(50);
    expect(notifications.length).toBeGreaterThanOrEqual(delivered);
    expect(notifications.map((n) => (n.params as { seq: number }).seq)).toEqual(
      Array.from({ length: 30 }, (_value, index) => index + 1),
    );
    expect((client as unknown as { pendingBytes: number }).pendingBytes).toBe(0);
  });

  it("flushes a heavy burst by size, not only by clock, and drops nothing (RP-7)", () => {
    // A hidden or throttled view still receives deltas; without a byte bound
    // the buffer is whatever arrives before the next timer. It flushes early
    // instead — and everything that arrived is delivered, in order.
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.useFakeTimers();
    const { client, notifications } = build();
    client.connect();
    const socket = FakeSocket.instances[0]!;
    socket.accept();

    const wide = "x".repeat(64 * 1024);
    for (let seq = 1; seq <= 24; seq++) {
      socket.deliver({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionPath: "/s.jsonl", seq, at: "", update: { kind: "text_delta", delta: wide, contentIndex: 0 } },
      });
    }
    // 24 × 64 KiB is past the megabyte mark, so the buffer already went out.
    expect(notifications.length).toBeGreaterThan(0);
    vi.advanceTimersByTime(50);
    expect(notifications.map((n) => (n.params as { seq: number }).seq)).toEqual(
      Array.from({ length: 24 }, (_value, index) => index + 1),
    );
  });

  it("flushes buffered deltas before any other message, keeping order", () => {
    const { client, notifications } = build();
    client.connect();
    const socket = FakeSocket.instances[0]!;
    socket.accept();

    socket.deliver(updateMessage(1));
    socket.deliver({
      jsonrpc: "2.0",
      method: "pi/ui/request",
      params: { path: "/s.jsonl", method: "confirm", id: "ui-1", title: "Sure?" },
    });

    expect(notifications.map((n) => n.method)).toEqual(["session/update", "pi/ui/request"]);
  });
});

describe("reconnect resume", () => {
  const reconnect = (client: HostClient): FakeSocket => {
    vi.useFakeTimers();
    FakeSocket.instances[0]!.close();
    vi.advanceTimersByTime(1000);
    const next = FakeSocket.instances[1]!;
    next.accept();
    return next;
  };

  it("resumes tracked sessions and skips the ones the app dropped", () => {
    const { client } = build({ shouldResume: (path) => path === "/keep.jsonl" });
    client.connect();
    FakeSocket.instances[0]!.accept();
    client.track("/keep.jsonl", 4);
    client.track("/gone.jsonl", 9);

    const socket = reconnect(client);
    const loads = socket.frames().filter((f) => f.method === "session/load");
    expect(loads).toHaveLength(1);
    expect(loads[0]!.params).toEqual({ path: "/keep.jsonl", fromSeq: 4 });
  });

  it("reports replayFrom so a restarted worker's epoch can be adopted", () => {
    const onResume = vi.fn();
    const { client } = build({ onResume });
    client.connect();
    FakeSocket.instances[0]!.accept();
    client.track("/s.jsonl", 87);

    const socket = reconnect(client);
    const load = socket.frames().find((f) => f.method === "session/load")!;
    socket.deliver({ jsonrpc: "2.0", id: load.id, result: { state: {}, replayFrom: 0, seq: 0 } });

    return Promise.resolve().then(() => {
      // The third argument is the `fromSeq` this very request carried, which
      // is the only watermark the caller may compare against: the replayed
      // updates are flushed before the response resolves.
      expect(onResume).toHaveBeenCalledWith("/s.jsonl", 0, 87);
      client.resync("/s.jsonl", 0);
      // The next reconnect asks from the adopted epoch, not the stale one.
      FakeSocket.instances[1]!.close();
      vi.advanceTimersByTime(2000);
      const third = FakeSocket.instances[2]!;
      third.accept();
      expect(third.frames().find((f) => f.method === "session/load")!.params).toEqual({
        path: "/s.jsonl",
        fromSeq: 0,
      });
    });
  });
});
