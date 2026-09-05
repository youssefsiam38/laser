/**
 * The relay's rules, exercised over a real socket. These are cheap to test and
 * every one of them is a security property, not a nicety.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { RelayServer } from "../src/server.js";
import { RelayClose, type RelayControl } from "../src/protocol.js";

const CHANNEL_A = "A".repeat(43);
const CHANNEL_B = "B".repeat(43);
/** 12-byte header + 64-byte bucket + 16-byte tag. */
const LEGAL_FRAME = 92;
/** A distinct, well-formed 43-character channel id. */
const channelId = (n: number): string => String(n).padStart(43, "C");

let relay: RelayServer;
let base: string;
const open: Peer[] = [];

/**
 * A client that records everything from the moment it connects. Attaching
 * listeners lazily loses the `hello` frame, which the relay sends immediately.
 */
class Peer {
  readonly controls: RelayControl[] = [];
  readonly binary: Buffer[] = [];
  private readonly waiters: (() => void)[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) this.binary.push(data as Buffer);
      else this.controls.push(JSON.parse(data.toString()) as RelayControl);
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  /** Wait for a control frame matching `predicate`, counting ones already seen. */
  async control(predicate: (m: RelayControl) => boolean = () => true, timeoutMs = 1500): Promise<RelayControl> {
    return this.await_(() => this.controls.find(predicate), "control frame", timeoutMs);
  }

  async firstBinary(timeoutMs = 1500): Promise<Buffer> {
    return this.await_(() => this.binary[0], "binary frame", timeoutMs);
  }

  close(): void {
    this.ws.close();
  }

  private async await_<T>(peek: () => T | undefined, what: string, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = peek();
      if (found !== undefined) return found;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for a ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 25);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

function connect(channel: string, query = "", origin = base): Promise<Peer> {
  const ws = new WebSocket(`${origin}/ws/${channel}${query}`);
  const peer = new Peer(ws);
  open.push(peer);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(peer));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        const error = Object.assign(new Error(`HTTP ${res.statusCode}: ${text}`), {
          status: res.statusCode,
          body: safeJson(text),
        });
        reject(error);
      });
    });
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function closed(peer: Peer): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => peer.ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
}

beforeEach(async () => {
  relay = new RelayServer({ host: "127.0.0.1", port: 0, pingIntervalMs: 60_000 });
  const { port } = await relay.listen();
  base = `ws://127.0.0.1:${port}`;
});

afterEach(async () => {
  for (const peer of open.splice(0)) peer.ws.terminate();
  await relay.close();
});

describe("relay", () => {
  it("serves /healthz with live counters", async () => {
    const response = await fetch(`${base.replace("ws://", "http://")}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; channels: number; cookiesRequired: boolean };
    expect(body.ok).toBe(true);
    expect(body.channels).toBe(0);
    expect(body.cookiesRequired).toBe(false);
  });

  it("forwards bytes verbatim once both peers are present", async () => {
    const a = await connect(CHANNEL_A);
    expect(await a.control()).toMatchObject({ t: "hello", slot: 0, peer: false });

    const b = await connect(CHANNEL_A);
    expect(await b.control()).toMatchObject({ t: "hello", slot: 1, peer: true });
    expect(await a.control((m) => m.t === "peer")).toMatchObject({ t: "peer", present: true });

    const frame = Buffer.alloc(LEGAL_FRAME);
    frame.write("piorbit", 12);
    a.ws.send(frame, { binary: true });
    expect(Buffer.compare(await b.firstBinary(), frame)).toBe(0);
    expect(relay.statistics().framesForwarded).toBe(1);
  });

  it("forwards zero bytes before the peer arrives, and buffers nothing", async () => {
    const a = await connect(CHANNEL_A);
    await a.control();
    a.ws.send(Buffer.alloc(LEGAL_FRAME), { binary: true });
    expect(await a.control((m) => m.t === "error")).toMatchObject({ t: "error", code: "no_peer" });

    const b = await connect(CHANNEL_A);
    await b.control((m) => m.t === "hello");
    // Nothing was queued: the dropped frame does not turn up late.
    await expect(b.firstBinary(200)).rejects.toThrow(/timed out/);
    expect(relay.statistics().framesForwarded).toBe(0);
  });

  it("refuses a third socket on a channel", async () => {
    await connect(CHANNEL_A);
    await connect(CHANNEL_A);
    await expect(connect(CHANNEL_A)).rejects.toMatchObject({ status: 409 });
    expect(relay.statistics().refused["channel_full"]).toBe(1);
  });

  it("tells a peer when the other side leaves, and keeps the channel usable", async () => {
    const a = await connect(CHANNEL_A);
    const b = await connect(CHANNEL_A);
    await a.control((m) => m.t === "peer");
    b.close();
    expect(await a.control((m) => m.t === "peer" && !m.present)).toMatchObject({ present: false });
    const c = await connect(CHANNEL_A);
    expect(await c.control()).toMatchObject({ t: "hello", peer: true });
  });

  it("forwards the Noise handshake, which is not a padded frame size", async () => {
    // A Noise_KK message is 32 bytes of ephemeral plus a 16-byte tag. It is not
    // a padded transport frame and never will be, so enforcing padded sizes on
    // it made every handshake — and therefore the whole relay path — impossible.
    const a = await connect(CHANNEL_A);
    const b = await connect(CHANNEL_A);
    await a.control((m) => m.t === "peer");
    const handshake = Buffer.alloc(48, 7);
    a.ws.send(handshake, { binary: true });
    expect(await b.firstBinary()).toEqual(handshake);
    b.ws.send(Buffer.alloc(48, 9), { binary: true });
    expect((await a.firstBinary()).length).toBe(48);
  });

  it("rejects a frame that is not a padded piorbit size, once the handshake is over", async () => {
    const a = await connect(CHANNEL_A);
    const b = await connect(CHANNEL_A);
    await a.control((m) => m.t === "peer");
    // Spend the two-frame handshake allowance.
    a.ws.send(Buffer.alloc(LEGAL_FRAME), { binary: true });
    a.ws.send(Buffer.alloc(LEGAL_FRAME), { binary: true });
    expect(await b.firstBinary()).toHaveLength(LEGAL_FRAME);

    a.ws.send(Buffer.alloc(100), { binary: true });
    expect(await a.control((m) => m.t === "error")).toMatchObject({ code: "bad_frame_size" });
    expect((await closed(a)).code).toBe(RelayClose.BadRequest);
  });

  it("ignores a forged x-forwarded-for when no proxy is trusted", async () => {
    // Every rate limit and the cookie challenge key off this address. Taking the
    // leftmost entry — or trusting the header at all when nothing sits in front
    // of the relay — made all of them bypassable with one header.
    const limited = new RelayServer({ host: "127.0.0.1", port: 0, channelCreationPerMinute: 2 });
    const { port } = await limited.listen();
    try {
      const open = (channel: string, forwarded: string): Promise<void> =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${channel}`, {
            headers: { "x-forwarded-for": forwarded },
          });
          ws.once("open", () => {
            ws.close();
            resolve();
          });
          ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
          ws.once("error", reject);
        });
      await open(channelId(1), "9.9.9.1");
      await open(channelId(2), "9.9.9.2");
      await expect(open(channelId(3), "9.9.9.3")).rejects.toThrow(/HTTP 429/);
    } finally {
      await limited.close();
    }
  });

  it("rejects a control frame it does not speak", async () => {
    const a = await connect(CHANNEL_A);
    await a.control();
    a.ws.send(JSON.stringify({ t: "subscribe", channel: CHANNEL_B }));
    expect(await a.control((m) => m.t === "error")).toMatchObject({ code: "bad_control" });
  });

  it("rejects a malformed channel id before any WebSocket state exists", async () => {
    await expect(connect("short")).rejects.toMatchObject({ status: 400 });
    expect(relay.statistics().channels).toBe(0);
  });

  it("limits channel creation separately from reconnections", async () => {
    const small = new RelayServer({
      host: "127.0.0.1",
      port: 0,
      channelCreationPerMinute: 2,
      connectionsPerMinute: 100,
      pingIntervalMs: 60_000,
    });
    const { port } = await small.listen();
    const origin = `ws://127.0.0.1:${port}`;
    try {
      await connect("C".repeat(43), "", origin);
      await connect("D".repeat(43), "", origin);
      // Creation budget spent: a brand new channel is refused...
      await expect(connect("E".repeat(43), "", origin)).rejects.toMatchObject({ status: 429 });
      // ...but joining an existing one still works. Reconnecting must never be throttled.
      const rejoin = await connect("D".repeat(43), "", origin);
      expect(await rejoin.control()).toMatchObject({ t: "hello", peer: true });
    } finally {
      await small.close();
    }
  });

  it("issues a cookie under load and accepts it back, holding no state", async () => {
    const loaded = new RelayServer({ host: "127.0.0.1", port: 0, cookieThreshold: 0, pingIntervalMs: 60_000 });
    const { port } = await loaded.listen();
    const origin = `ws://127.0.0.1:${port}`;
    try {
      const refusal = (await connect(CHANNEL_A, "", origin).catch((e: unknown) => e)) as {
        status?: number;
        body?: { cookie?: string };
      };
      expect(refusal.status).toBe(429);
      const cookie = refusal.body?.cookie;
      expect(typeof cookie).toBe("string");

      const peer = await connect(CHANNEL_A, `?cookie=${cookie}`, origin);
      expect(await peer.control()).toMatchObject({ t: "hello" });
      await expect(connect(CHANNEL_A, "?cookie=not-the-right-one", origin)).rejects.toMatchObject({ status: 429 });
    } finally {
      await loaded.close();
    }
  });
});
