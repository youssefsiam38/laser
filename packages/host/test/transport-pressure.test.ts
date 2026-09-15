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

  it("fences past the hard mark and says why", () => {
    const fences: Array<{ reason: string; queuedBytes: number }> = [];
    const pressure = new OutboundPressure({ softBytes: 100, hardBytes: 1000, onFence: (info) => fences.push(info) });
    pressure.charge(1500);
    expect(fences).toEqual([{ reason: "hard-limit", queuedBytes: 1500 }]);
    expect(pressure.fenced).toBe(true);
    // Nothing more is written for a fenced peer — including its own state.
    expect(pressure.admit("session/update")).toBe("fenced");
    expect(pressure.admit(undefined)).toBe("fenced");
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
