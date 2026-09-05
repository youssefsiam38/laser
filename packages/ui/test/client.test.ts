/**
 * HostClient: the visibility listener's lifetime, delta coalescing, and the
 * reconnect resume loop (which sessions it resumes and what it does with
 * `replayFrom`). Uses hand-rolled `WebSocket` / `document` / rAF stubs so the
 * suite stays in the node environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostNotificationMethod } from "@lasercode/protocol";
import { HostClient } from "../src/client.js";

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

  accept(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  frames(): Array<{ id?: number; method: string; params: Record<string, unknown> }> {
    return this.sent.map((s) => JSON.parse(s) as { id?: number; method: string; params: Record<string, unknown> });
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
    socket.deliver({ jsonrpc: "2.0", id: load.id, result: { state: {}, replayFrom: 0 } });

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
