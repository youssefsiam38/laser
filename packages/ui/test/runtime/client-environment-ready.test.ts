/**
 * The connection waits for this device to be ready, bounded (RP-10, M18-T10).
 *
 * The reason this exists: `acceptEnvironment` used to call the app's
 * synchronous acceptance and publish `open` in the same turn, while opening a
 * database, asking the operating system for a key and decrypting a record are
 * all asynchronous. Local-first re-entry would then have been a race — winning
 * on a warm page and losing on the cold start where it matters.
 *
 * So the acceptance may carry a `ready` promise, and these tests pin the four
 * things that make it safe: nothing is open or resumed while it is pending, it
 * is bounded, a failure opens the connection anyway, and a replaced socket's
 * late answer opens nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_VERSION, type EnvironmentDescriptor } from "@lasercode/protocol";

import { HostClient, MAX_READY_BUDGET_MS, READY_BUDGET_MS, type EnvironmentAcceptance } from "../../src/client.js";
import { testDescriptor } from "./environment-fixture.js";

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | undefined;
  onmessage: ((event: { data: string }) => void) | undefined;
  onclose: (() => void) | undefined;
  onerror: (() => void) | undefined;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  handshake(): void {
    this.deliver({ jsonrpc: "2.0", id: 0, result: { version: PRODUCT_VERSION } });
    this.deliver({ jsonrpc: "2.0", id: -1, result: { environment: testDescriptor() } });
  }

  work(): Array<{ method: string }> {
    return this.sent
      .map((line) => JSON.parse(line) as { id?: number; method: string })
      .filter((frame) => frame.id !== 0 && frame.id !== -1);
  }
}

const documentStub = { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} };

interface Harness {
  client: HostClient;
  notifications: Array<{ method: string }>;
  failures: string[];
  socket(): FakeSocket;
}

function build(accept: (environment: EnvironmentDescriptor) => EnvironmentAcceptance): Harness {
  const notifications: Array<{ method: string }> = [];
  const failures: string[] = [];
  const client = new HostClient({
    url: "ws://test/ws",
    onNotification: (method) => notifications.push({ method }),
    onEnvironment: accept,
    onEnvironmentFailure: (reason) => failures.push(reason),
  });
  return { client, notifications, failures, socket: () => FakeSocket.instances.at(-1)! };
}

/** A promise plus the handles to settle it exactly when a test wants to. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: () => void } {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((settle, fail) => {
    resolve = () => settle();
    reject = () => fail(new Error("this device could not be prepared"));
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    cb();
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("an acceptance with no preparation behaves exactly as before", () => {
  it("opens in the same turn the environment lands", () => {
    const h = build(() => ({ ok: true }));
    h.client.track("/p/s.jsonl", 3);
    h.client.connect();
    h.socket().open();
    h.socket().handshake();
    expect(h.client.connection).toBe("open");
    expect(h.socket().work().map((frame) => frame.method)).toEqual(["session/load"]);
  });
});

describe("a pending preparation holds the connection, and nothing else moves", () => {
  it("does not open, resume or deliver while this device is being prepared", async () => {
    const ready = deferred();
    const h = build(() => ({ ok: true, ready: ready.promise }));
    h.client.track("/p/s.jsonl", 3);
    h.client.connect();
    h.socket().open();
    h.socket().handshake();

    expect(h.client.connection).toBe("connecting");
    expect(h.socket().work()).toEqual([]);
    // A notification that arrives in the meantime waits for the open, exactly
    // as it does for the environment itself.
    h.socket().deliver({ jsonrpc: "2.0", method: "pi/session/attention", params: { path: "/p/s.jsonl" } });
    expect(h.notifications).toEqual([]);

    ready.resolve();
    await ready.promise;
    await Promise.resolve();
    expect(h.client.connection).toBe("open");
    expect(h.notifications.map((each) => each.method)).toEqual(["pi/session/attention"]);
    expect(h.socket().work().map((frame) => frame.method)).toEqual(["session/load"]);
    expect(h.failures).toEqual([]);
  });

  it("opens authoritatively when preparing this device fails", async () => {
    const ready = deferred();
    const h = build(() => ({ ok: true, ready: ready.promise }));
    h.client.connect();
    h.socket().open();
    h.socket().handshake();
    expect(h.client.connection).toBe("connecting");

    ready.reject();
    await ready.promise.catch(() => {});
    await Promise.resolve();
    // The cache is the app's problem; the host is not.
    expect(h.client.connection).toBe("open");
    expect(h.failures).toEqual([]);
  });

  it("opens at the budget when preparation never settles, and a late settle changes nothing", async () => {
    vi.useFakeTimers();
    const ready = deferred();
    const h = build(() => ({ ok: true, ready: ready.promise, readyBudgetMs: 50 }));
    h.client.connect();
    h.socket().open();
    h.socket().handshake();
    expect(h.client.connection).toBe("connecting");

    await vi.advanceTimersByTimeAsync(49);
    expect(h.client.connection).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1);
    expect(h.client.connection).toBe("open");

    const framesBefore = h.socket().sent.length;
    ready.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.client.connection).toBe("open");
    expect(h.socket().sent.length).toBe(framesBefore);
  });

  it("clamps an unreasonable budget rather than waiting on it", async () => {
    vi.useFakeTimers();
    const ready = deferred();
    const h = build(() => ({ ok: true, ready: ready.promise, readyBudgetMs: 60_000 }));
    h.client.connect();
    h.socket().open();
    h.socket().handshake();
    await vi.advanceTimersByTimeAsync(MAX_READY_BUDGET_MS);
    expect(h.client.connection).toBe("open");
    expect(READY_BUDGET_MS).toBeLessThan(MAX_READY_BUDGET_MS);
  });
});

describe("a preparation belongs to the socket it started on", () => {
  it("opens nothing when its socket has been replaced", async () => {
    const first = deferred();
    const second = deferred();
    const answers = [first, second];
    let index = 0;
    const h = build(() => ({ ok: true, ready: answers[index++]!.promise }));
    h.client.connect();
    const original = h.socket();
    original.open();
    original.handshake();
    expect(h.client.connection).toBe("connecting");

    // The socket drops while this device is still being prepared.
    original.close();
    expect(h.client.connection).toBe("closed");

    first.resolve();
    await first.promise;
    await Promise.resolve();
    // The late answer belongs to a socket nobody is using.
    expect(h.client.connection).toBe("closed");
    expect(original.sent.filter((line) => !line.includes("\"id\":0") && !line.includes("\"id\":-1"))).toEqual([]);
  });

  it("still refuses an environment the app cannot make this device safe for", () => {
    const h = build(() => ({ ok: false, reason: "This browser will not let go of data from an earlier session." }));
    h.client.connect();
    h.socket().open();
    h.socket().handshake();
    expect(h.client.connection).toBe("closed");
    expect(h.failures).toEqual(["This browser will not let go of data from an earlier session."]);
    expect(h.socket().closed).toBe(true);
  });
});

describe("the wait has a cancel half, and it is always called", () => {
  /** What the app is told when the connection stops waiting for this device. */
  const withCancel = () => {
    const expired: string[] = [];
    const ready = deferred();
    const h = build(() => ({
      ok: true,
      ready: ready.promise,
      readyBudgetMs: 40,
      onReadyExpired: () => expired.push("expired"),
    }));
    return { h, ready, expired };
  };

  it("tells the app when the budget runs out, before it opens", async () => {
    vi.useFakeTimers();
    const { h, ready, expired } = withCancel();
    h.client.connect();
    h.socket().open();
    h.socket().handshake();
    expect(expired).toEqual([]);

    await vi.advanceTimersByTimeAsync(40);
    expect(expired).toEqual(["expired"]);
    expect(h.client.connection).toBe("open");

    // The original preparation finishes a moment later and changes nothing.
    ready.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(expired).toEqual(["expired"]);
    expect(h.client.connection).toBe("open");
  });

  it("tells the app when its socket is replaced while it is still preparing", async () => {
    const { h, ready, expired } = withCancel();
    h.client.connect();
    const original = h.socket();
    original.open();
    original.handshake();
    original.close();

    ready.resolve();
    await ready.promise;
    await Promise.resolve();
    expect(expired).toEqual(["expired"]);
    expect(h.client.connection).toBe("closed");
  });

  it("tells the app when preparing this device failed", async () => {
    const { h, ready, expired } = withCancel();
    h.client.connect();
    h.socket().open();
    h.socket().handshake();
    ready.reject();
    await ready.promise.catch(() => {});
    await Promise.resolve();
    expect(expired).toEqual(["expired"]);
    expect(h.client.connection).toBe("open");
  });

  it("does not tell the app anything when preparation simply succeeded", async () => {
    const { h, ready, expired } = withCancel();
    h.client.connect();
    h.socket().open();
    h.socket().handshake();
    ready.resolve();
    await ready.promise;
    await Promise.resolve();
    expect(expired).toEqual([]);
    expect(h.client.connection).toBe("open");
  });

  it("survives a cancellation callback that throws", async () => {
    vi.useFakeTimers();
    const ready = deferred();
    const h = build(() => ({
      ok: true,
      ready: ready.promise,
      readyBudgetMs: 20,
      onReadyExpired: () => {
        throw new Error("the app's own cleanup broke");
      },
    }));
    h.client.connect();
    h.socket().open();
    h.socket().handshake();
    await vi.advanceTimersByTimeAsync(20);
    expect(h.client.connection).toBe("open");
  });
});
