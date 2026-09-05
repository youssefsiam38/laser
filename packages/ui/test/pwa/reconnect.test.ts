/**
 * The reconnect guard never trusts an OPEN socket: a probe that does not
 * answer forces a fresh socket; a probe that answers leaves it alone; a socket
 * the client already knows is closed is reopened without waiting out the
 * backoff. Fake timers, fake client, no DOM listeners (the guard only wires
 * those when `document` exists).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReconnectGuard, type GuardConnectionState, type ReconnectGuardEvent, type ReconnectableClient } from "../../src/pwa/reconnect.js";

class FakeClient implements ReconnectableClient {
  connection: GuardConnectionState = "open";
  probes: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  reconnects: string[] = [];
  closes = 0;
  connects = 0;
  withReconnect = true;

  probe(): Promise<unknown> {
    return new Promise<void>((resolve, reject) => this.probes.push({ resolve, reject }));
  }
  reconnect(reason: string): void {
    this.reconnects.push(reason);
    this.connection = "connecting";
  }
  close(): void {
    this.closes++;
  }
  connect(): void {
    this.connects++;
  }
}

/** A client without `reconnect()`, as HostClient is before the requested change. */
class LegacyClient extends FakeClient {
  override reconnect = undefined as unknown as FakeClient["reconnect"];
}

describe("createReconnectGuard", () => {
  const events: ReconnectGuardEvent[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    events.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("forces a reconnect when an open socket does not answer the probe in time", async () => {
    const client = new FakeClient();
    const guard = createReconnectGuard(client, { probeTimeoutMs: 1000, heartbeatMs: 0, onEvent: (e) => events.push(e) });
    const p = guard.probe("visible");
    await vi.advanceTimersByTimeAsync(999);
    expect(client.reconnects).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(client.reconnects).toEqual(["visible: no answer in 1000ms"]);
    expect(events.map((e) => e.type)).toEqual(["probe", "reconnect"]);
    guard.dispose();
  });

  it("leaves a socket alone when the probe answers", async () => {
    const client = new FakeClient();
    const guard = createReconnectGuard(client, { probeTimeoutMs: 1000, heartbeatMs: 0, onEvent: (e) => events.push(e) });
    const p = guard.probe("pageshow");
    await vi.advanceTimersByTimeAsync(10);
    client.probes[0]!.resolve();
    await p;
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.reconnects).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(["probe", "probe-ok"]);
    guard.dispose();
  });

  it("a rejected probe means the client already knows: nothing is forced", async () => {
    const client = new FakeClient();
    const guard = createReconnectGuard(client, { probeTimeoutMs: 1000, heartbeatMs: 0 });
    const p = guard.probe("online");
    await vi.advanceTimersByTimeAsync(1);
    client.probes[0]!.reject(new Error("connection closed"));
    await p;
    expect(client.reconnects).toEqual([]);
    guard.dispose();
  });

  it("skips the client's backoff when the socket is already closed", async () => {
    const client = new FakeClient();
    client.connection = "closed";
    const guard = createReconnectGuard(client, { heartbeatMs: 0 });
    await guard.probe("visible");
    expect(client.reconnects).toEqual(["visible: socket closed"]);
    expect(client.probes).toHaveLength(0);
    guard.dispose();
  });

  it("waits while connecting, and forces only when it is stuck", async () => {
    const client = new FakeClient();
    client.connection = "connecting";
    const guard = createReconnectGuard(client, { heartbeatMs: 0, connectingTimeoutMs: 5000 });
    const started = Date.now();
    await guard.probe("visible");
    expect(client.reconnects).toEqual([]);
    vi.setSystemTime(started + 6000);
    await guard.probe("focus");
    expect(client.reconnects).toEqual(["focus: stuck connecting"]);
    guard.dispose();
  });

  it("collapses overlapping probes into one", async () => {
    const client = new FakeClient();
    const guard = createReconnectGuard(client, { probeTimeoutMs: 1000, heartbeatMs: 0 });
    const a = guard.probe("visible");
    const b = guard.probe("focus");
    expect(client.probes).toHaveLength(1);
    client.probes[0]!.resolve();
    await Promise.all([a, b]);
    guard.dispose();
  });

  it("falls back to close()+connect() for a client without reconnect()", async () => {
    const client = new LegacyClient();
    const guard = createReconnectGuard(client, { probeTimeoutMs: 500, heartbeatMs: 0 });
    const p = guard.probe("visible");
    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(client.closes).toBe(1);
    expect(client.connects).toBe(1);
    guard.dispose();
  });
});
