/**
 * The environment handshake (RP-13, M18-T13 B).
 *
 * The order is the contract: version, then environment, then — and only then —
 * an open connection, queued notifications, resumes and requests. These tests
 * drive the real `HostClient` against a hand-rolled socket so the order is
 * observable frame by frame, and they check the two things a person would
 * notice if it were wrong: work happening before this view knows where it is,
 * and one environment's sessions surviving into another.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_VERSION, type EnvironmentDescriptor } from "@lasercode/protocol";

import { HostClient, type EnvironmentAcceptance } from "../../src/client.js";
import { OTHER_ENVIRONMENT_KEY, TEST_ENVIRONMENT_KEY, testDescriptor } from "./environment-fixture.js";

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

  answerVersion(version: string = PRODUCT_VERSION): void {
    this.deliver({ jsonrpc: "2.0", id: 0, result: { version } });
  }

  answerEnvironment(environment: unknown = testDescriptor()): void {
    this.deliver({ jsonrpc: "2.0", id: -1, result: { environment } });
  }

  /** A result with no `environment` in it at all. */
  omitEnvironment(): void {
    this.deliver({ jsonrpc: "2.0", id: -1, result: {} });
  }

  refuseEnvironment(): void {
    this.deliver({ jsonrpc: "2.0", id: -1, error: { code: -32601, message: "unknown method environment/describe" } });
  }

  /** Every frame that is not part of the handshake. */
  work(): Array<{ method: string; params: unknown }> {
    return this.sent
      .map((line) => JSON.parse(line) as { id?: number; method: string; params: unknown })
      .filter((frame) => frame.id !== 0 && frame.id !== -1);
  }

  handshake(): string[] {
    return this.sent.map((line) => (JSON.parse(line) as { method: string }).method);
  }
}

const documentStub = {
  visibilityState: "visible",
  addEventListener: () => {},
  removeEventListener: () => {},
};

interface Harness {
  client: HostClient;
  environments: EnvironmentDescriptor[];
  failures: string[];
  socket(): FakeSocket;
}

function build(accept: (environment: EnvironmentDescriptor) => EnvironmentAcceptance = () => ({ ok: true })): Harness {
  const environments: EnvironmentDescriptor[] = [];
  const failures: string[] = [];
  const client = new HostClient({
    url: "ws://test/ws",
    onNotification: () => {},
    onEnvironment: (environment) => {
      environments.push(environment);
      return accept(environment);
    },
    onEnvironmentFailure: (reason) => failures.push(reason),
  });
  return { client, environments, failures, socket: () => FakeSocket.instances.at(-1)! };
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

describe("the order of the handshake", () => {
  it("asks for the environment only after the version matches, and opens only after it lands", async () => {
    const h = build();
    h.client.track("/p/s.jsonl", 7);
    h.client.connect();
    const socket = h.socket();
    socket.open();
    expect(socket.handshake()).toEqual(["pi/host/version"]);
    expect(h.client.connection).toBe("connecting");

    socket.answerVersion();
    expect(socket.handshake()).toEqual(["pi/host/version", "environment/describe"]);
    // The version matched and still nothing has been asked of the host and
    // nothing has been resumed: this view does not yet know where it is.
    expect(socket.work()).toEqual([]);
    expect(h.client.connection).toBe("connecting");
    await expect(h.client.request("pi/session/list", {})).rejects.toThrow(/Not connected/);

    socket.answerEnvironment();
    expect(h.environments[0]?.environmentKey).toBe(TEST_ENVIRONMENT_KEY);
    expect(h.client.connection).toBe("open");
    expect(socket.work().map((frame) => frame.method)).toEqual(["session/load"]);
  });

  it("holds notifications that arrive during the handshake until it is done", () => {
    const seen: string[] = [];
    const client = new HostClient({
      url: "ws://test/ws",
      onNotification: (method) => seen.push(method),
      onEnvironment: () => ({ ok: true }),
    });
    client.connect();
    const socket = FakeSocket.instances.at(-1)!;
    socket.open();
    socket.answerVersion();
    socket.deliver({ jsonrpc: "2.0", method: "pi/project/updated", params: { projects: [] } });
    expect(seen).toEqual([]);
    socket.answerEnvironment();
    expect(seen).toEqual(["pi/project/updated"]);
    client.close();
  });

  it("describes the environment again on every reconnect", () => {
    vi.useFakeTimers();
    const h = build();
    h.client.connect();
    h.socket().open();
    h.socket().answerVersion();
    h.socket().answerEnvironment();
    expect(h.client.connection).toBe("open");

    h.socket().close();
    vi.advanceTimersByTime(1000);
    const next = h.socket();
    next.open();
    next.answerVersion();
    expect(next.handshake()).toEqual(["pi/host/version", "environment/describe"]);
    next.answerEnvironment();
    expect(h.environments).toHaveLength(2);
    h.client.close();
  });
});

describe("an environment this view cannot establish", () => {
  const cases: Array<[string, (socket: FakeSocket) => void]> = [
    ["the host refuses the method", (socket) => socket.refuseEnvironment()],
    ["the descriptor is malformed", (socket) => socket.answerEnvironment({ contract: "ep1" })],
    ["the descriptor is missing", (socket) => socket.omitEnvironment()],
    ["the contract is another generation", (socket) => socket.answerEnvironment({ ...testDescriptor(), contract: "ep2" })],
    ["the descriptor names another build", (socket) => socket.answerEnvironment({ ...testDescriptor(), version: "0.0.1" })],
  ];

  for (const [name, answer] of cases) {
    it(`stays closed when ${name}`, () => {
      const h = build();
      h.client.track("/p/s.jsonl", 7);
      h.client.connect();
      const socket = h.socket();
      socket.open();
      socket.answerVersion();
      answer(socket);

      expect(h.client.connection).not.toBe("open");
      expect(h.failures).toHaveLength(1);
      expect(h.failures[0]).toMatch(/environment|Refresh/i);
      expect(socket.work()).toEqual([]);
      expect(socket.closed).toBe(true);
      h.client.close();
    });
  }

  it("keeps one stable sentence across a retry loop rather than repeating itself", () => {
    vi.useFakeTimers();
    const h = build();
    h.client.connect();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const socket = h.socket();
      socket.open();
      socket.answerVersion();
      socket.refuseEnvironment();
      vi.advanceTimersByTime(20_000);
    }
    // Four attempts, one sentence: the banner says the same true thing until
    // it stops being true.
    expect(h.failures).toHaveLength(1);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
    h.client.close();
  });

  it("recovers the moment the host can describe itself, without a reload", () => {
    vi.useFakeTimers();
    const h = build();
    h.client.connect();
    h.socket().open();
    h.socket().answerVersion();
    h.socket().refuseEnvironment();
    expect(h.client.connection).not.toBe("open");

    vi.advanceTimersByTime(20_000);
    const next = h.socket();
    next.open();
    next.answerVersion();
    next.answerEnvironment();
    expect(h.client.connection).toBe("open");
    h.client.close();
  });

  it("is refused when the app cannot make this device safe for it", () => {
    const h = build(() => ({ ok: false, reason: "This browser's stored data could not be cleared of other environments." }));
    h.client.connect();
    h.socket().open();
    h.socket().answerVersion();
    h.socket().answerEnvironment();
    expect(h.client.connection).not.toBe("open");
    expect(h.failures).toEqual(["This browser's stored data could not be cleared of other environments."]);
    h.client.close();
  });

  it("is not a version mismatch: the build is fine, the environment is not", () => {
    const mismatch = vi.fn();
    const client = new HostClient({
      url: "ws://test/ws",
      onNotification: () => {},
      onVersionMismatch: mismatch,
      onEnvironment: () => ({ ok: true }),
      onEnvironmentFailure: () => {},
    });
    client.connect();
    const socket = FakeSocket.instances.at(-1)!;
    socket.open();
    socket.answerVersion();
    socket.refuseEnvironment();
    expect(mismatch).not.toHaveBeenCalled();
    client.close();
  });
});

describe("what a connection carries across environments", () => {
  it("drops every attachment when the app says the environment changed", () => {
    const h = build((environment) => {
      // Exactly what the provider does: a move between environments forgets
      // the sessions this connection was following, before it opens.
      if (environment.environmentKey !== TEST_ENVIRONMENT_KEY) h.client.forgetAttachments();
      return { ok: true };
    });
    h.client.track("/p/s.jsonl", 7);
    h.client.connect();
    const socket = h.socket();
    socket.open();
    socket.answerVersion();
    socket.answerEnvironment(testDescriptor({ environmentKey: OTHER_ENVIRONMENT_KEY }));
    expect(h.client.connection).toBe("open");
    // No resume: the path belonged to the environment this view just left.
    expect(socket.work()).toEqual([]);
  });

  it("keeps them when the same environment comes back", () => {
    const h = build();
    h.client.track("/p/s.jsonl", 7);
    h.client.connect();
    const socket = h.socket();
    socket.open();
    socket.answerVersion();
    socket.answerEnvironment();
    expect(socket.work().map((frame) => frame.method)).toEqual(["session/load"]);
  });
});
