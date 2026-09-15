/**
 * RP-7: what a connection that stops reading costs this host, and what it may
 * never cost anybody: a lost question, a lost terminal event, or a command.
 *
 * The unit tests below pin the state machine; the socket tests drive a real
 * host with a client that never reads a byte.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { HostServer } from "../src/server.js";
import { OutboundPressure } from "../src/transport-pressure.js";

describe("the account and the state machine", () => {
  it("flows while the socket keeps up", () => {
    const pressure = new OutboundPressure({ softBytes: 1000, hardBytes: 4000 });
    for (let i = 0; i < 10; i++) {
      expect(pressure.admit("session/update")).toBe("send");
      pressure.charge(100);
      pressure.settle(100);
    }
    expect(pressure.snapshot()).toMatchObject({ state: "flowing", queuedBytes: 0, inFlight: 0 });
    expect(pressure.snapshot().highWaterBytes).toBe(100);
  });

  it("releases only the three re-readable diagnostics past the soft mark", () => {
    const shed: string[] = [];
    const pressure = new OutboundPressure({ softBytes: 100, hardBytes: 10_000, onShed: ({ method }) => shed.push(method) });
    pressure.charge(200);
    expect(pressure.admit("pi/logs/append")).toBe("shed");
    expect(pressure.admit("pi/packages/progress")).toBe("shed");
    expect(pressure.admit("resource/refresh_request")).toBe("shed");
    // Everything that carries state, a question or a terminal event still goes.
    for (const method of ["session/update", "pi/ui/request", "tasks/update", "agents/run", "pi/providers/login/event"]) {
      expect(pressure.admit(method), method).toBe("send");
    }
    // A response was asked for by somebody who is waiting: never sheddable.
    expect(pressure.admit(undefined)).toBe("send");
    expect(shed).toEqual(["pi/logs/append", "pi/packages/progress", "resource/refresh_request"]);
    expect(pressure.snapshot().shed).toEqual({
      total: 3,
      byMethod: { "pi/logs/append": 1, "pi/packages/progress": 1, "resource/refresh_request": 1 },
    });
  });

  it("returns to flowing with hysteresis, not at the mark itself", () => {
    const pressure = new OutboundPressure({ softBytes: 100, hardBytes: 10_000 });
    pressure.charge(200);
    expect(pressure.snapshot().state).toBe("shedding");
    pressure.settle(100); // 100 queued: at the mark, still shedding
    expect(pressure.snapshot().state).toBe("shedding");
    pressure.settle(60); // 40 queued: below half
    expect(pressure.snapshot().state).toBe("flowing");
  });

  it("refuses a frame that would cross the hard mark rather than writing it first", () => {
    const fences: Array<{ reason: string; queuedBytes: number }> = [];
    const pressure = new OutboundPressure({ softBytes: 100, hardBytes: 1000, onFence: (info) => fences.push(info) });
    // One frame, larger than the whole allowance: it is never accounted and
    // never handed to the socket, and the connection is fenced instead. This
    // is not shedding — a response and a state frame are treated alike, and
    // what the peer missed it re-reads when it reconnects.
    expect(pressure.admit("session/update", 1500)).toBe("fenced");
    expect(pressure.charge(1500)).toBe(false);
    expect(fences[0]).toEqual({ reason: "hard-limit", queuedBytes: 1500 });
    expect(pressure.fenced).toBe(true);
    const snapshot = pressure.snapshot();
    // The high-water is what was really held, never a frame nobody wrote.
    expect(snapshot.highWaterBytes).toBeLessThanOrEqual(1000);
    expect(snapshot.queuedBytes).toBe(0);
    expect(snapshot.inFlight).toBe(0);
    expect(snapshot.shed.total).toBe(0);
    // Nothing more is written for a fenced peer — including its own state.
    expect(pressure.admit("session/update")).toBe("fenced");
    expect(pressure.admit(undefined)).toBe("fenced");
  });

  it("never lets the account cross the hard mark, frame by frame", () => {
    const pressure = new OutboundPressure({ softBytes: 400, hardBytes: 1000 });
    let accepted = 0;
    for (let i = 0; i < 20; i++) {
      if (pressure.admit("session/update", 300) !== "send") break;
      expect(pressure.charge(300)).toBe(true);
      accepted += 1;
      expect(pressure.snapshot().queuedBytes).toBeLessThanOrEqual(1000);
    }
    expect(accepted).toBe(3);
    expect(pressure.fenced).toBe(true);
    expect(pressure.snapshot().highWaterBytes).toBe(900);
  });

  it("settles a frame that was already in flight when the fence came, and retains nothing", () => {
    const pressure = new OutboundPressure({ softBytes: 100, hardBytes: 1000 });
    expect(pressure.charge(600)).toBe(true);
    // A second frame does not fit: refused, fenced, not accounted.
    expect(pressure.charge(600)).toBe(false);
    expect(pressure.fenced).toBe(true);
    expect(pressure.snapshot().queuedBytes).toBe(600);
    // The callback for the frame that *was* written still arrives afterwards.
    pressure.settle(600);
    expect(pressure.snapshot()).toMatchObject({ queuedBytes: 0, inFlight: 0, state: "fenced" });
    // And a late settle for a frame that was never charged cannot go negative.
    pressure.settle(600);
    expect(pressure.snapshot().queuedBytes).toBe(0);
  });

  it("fences a peer that sits above the soft mark without draining", () => {
    let now = 0;
    const fences: string[] = [];
    const pressure = new OutboundPressure({
      softBytes: 100,
      hardBytes: 1_000_000,
      stuckMs: 1000,
      now: () => now,
      onFence: ({ reason }) => fences.push(reason),
    });
    pressure.charge(200);
    expect(pressure.snapshot().state).toBe("shedding");
    now = 999;
    pressure.charge(1);
    expect(fences).toEqual([]);
    now = 1500;
    pressure.charge(1);
    expect(fences).toEqual(["stuck"]);
  });

  it("owes nothing for a connection that has gone", () => {
    const pressure = new OutboundPressure({ softBytes: 100, hardBytes: 1000 });
    pressure.charge(50);
    pressure.reset();
    expect(pressure.snapshot()).toMatchObject({ queuedBytes: 0, inFlight: 0 });
  });
});

describe("a direct client that stops reading", () => {
  let host: HostServer | undefined;
  let root: string | undefined;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await host?.close();
    host = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  const connect = async (url: string): Promise<WebSocket> => {
    const socket = new WebSocket(`${url.replace("http", "ws")}/ws`);
    sockets.push(socket);
    await new Promise<void>((resolve) => socket.once("open", resolve));
    return socket;
  };

  it("is disconnected rather than queued for, and other work is untouched", async () => {
    root = mkdtempSync(join(tmpdir(), "transport-pressure-"));
    host = new HostServer({ agentDir: join(root, "agent"), sessionDir: join(root, "sessions"), stateDir: join(root, "state"), logFile: false });
    const { url } = await host.listen();
    const socket = await connect(url);
    const seen: string[] = [];
    let closeCode: number | undefined;
    socket.on("message", (data) => seen.push(JSON.parse(data.toString()).method));
    socket.on("close", (code) => {
      closeCode = code;
    });

    // While the socket is healthy, host state reaches it.
    host.notify("pi/project/updated", { projects: [] });
    await expect.poll(() => seen.includes("pi/project/updated")).toBe(true);

    // Now it stops reading. The kernel buffer fills, `ws` starts queueing, and
    // the host's own account of this one connection grows until it fences it.
    const raw = (socket as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    raw.pause();
    const fenced = () =>
      [...(host as unknown as { pressure: Map<unknown, { snapshot(): { state: string } }> }).pressure.values()]
        .some((pressure) => pressure.snapshot().state === "fenced");
    const wide = "x".repeat(64 * 1024);
    const deadline = Date.now() + 15_000;
    while (!fenced() && Date.now() < deadline) {
      for (let i = 0; i < 64; i++) {
        host.notify("pi/project/updated", { projects: [{ path: `/p-${i}`, name: wide, trust: "trusted" } as never] });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(fenced()).toBe(true);
    // A peer that starts reading again finds itself disconnected, with the
    // code that says "reconnect and catch up" rather than a protocol error.
    raw.resume();
    await expect.poll(() => closeCode, { timeout: 10_000 }).toBe(1013);
    // Nothing of its state was quietly dropped into a queue on the way: what
    // it missed it re-reads on reconnect, which is the one resume path.
    expect(seen).not.toContain("pi/logs/append");

    // The host is untouched: a fence is one connection's, and nothing else.
    const other = await connect(url);
    const reply = await new Promise<{ error?: unknown }>((resolve) => {
      other.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number; error?: unknown };
        if (message.id === 1) resolve(message);
      });
      other.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "pi/project/list", params: {} }));
    });
    expect(reply.error).toBeUndefined();
  }, 40_000);
});
