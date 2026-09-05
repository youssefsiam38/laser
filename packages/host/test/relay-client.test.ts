/**
 * The relay client end to end: a "phone" drives @lasercode/crypto over a socket
 * that speaks the relay's control protocol, and the host answers real JSON-RPC.
 *
 * The relay itself is stubbed here (30 lines) rather than imported, so the host
 * never gains a dependency on the relay package — the deployed relay must stay a
 * package that links nothing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import {
  NoiseHandshake,
  NoiseSession,
  channelIdFor,
  nobleBackend,
  toBase64Url,
  utf8,
  fromUtf8,
  type KeyPair,
} from "@lasercode/crypto";
import type { JsonRpcNotification, JsonRpcResponse } from "@lasercode/protocol";
import { RelayClient } from "../src/relay-client.js";

/** Mirrors `CHANNEL_PROTOCOL_PREFIX` in @lasercode/relay; see the note above. */
const CHANNEL_PROTOCOL_PREFIX = "lasercode.channel.";

/** Just enough relay: two sockets per channel, `hello`/`peer`, binary passthrough. */
class StubRelay {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly channels = new Map<string, WebSocket[]>();
  port = 0;

  constructor() {
    this.http = createServer((_req, res) => res.writeHead(404).end());
    // Like the real relay: the channel is a subprotocol, never a path segment.
    this.wss = new WebSocketServer({
      server: this.http,
      perMessageDeflate: false,
      handleProtocols: (protocols) => {
        for (const protocol of protocols) if (protocol.startsWith(CHANNEL_PROTOCOL_PREFIX)) return protocol;
        return false;
      },
    });
    this.wss.on("connection", (ws, req) => {
      const offered = req.headers["sec-websocket-protocol"] ?? "";
      const channel = (Array.isArray(offered) ? offered.join(",") : offered)
        .split(",")
        .map((value) => value.trim())
        .find((value) => value.startsWith(CHANNEL_PROTOCOL_PREFIX))
        ?.slice(CHANNEL_PROTOCOL_PREFIX.length);
      if (channel === undefined) return ws.close(4400, "no channel subprotocol");
      const peers = this.channels.get(channel) ?? [];
      this.channels.set(channel, peers);
      if (peers.length >= 2) return ws.close(4409, "channel full");
      peers.push(ws);
      const other = (): WebSocket | undefined => peers.find((p) => p !== ws);
      ws.send(
        JSON.stringify({
          t: "hello",
          channel,
          slot: peers.length - 1,
          peer: peers.length === 2,
          maxFrameBytes: 65_536,
        }),
      );
      if (peers.length === 2) other()?.send(JSON.stringify({ t: "peer", present: true }));
      ws.on("message", (data, isBinary) => {
        const peer = other();
        if (isBinary && peer?.readyState === peer?.OPEN) peer?.send(data as Buffer, { binary: true });
      });
      ws.on("close", () => {
        const index = peers.indexOf(ws);
        if (index >= 0) peers.splice(index, 1);
        other()?.send(JSON.stringify({ t: "peer", present: false }));
      });
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.http.listen(0, "127.0.0.1", () => resolve()));
    this.port = (this.http.address() as AddressInfo).port;
    return `ws://127.0.0.1:${this.port}/ws`;
  }

  async close(): Promise<void> {
    for (const peers of this.channels.values()) for (const ws of peers) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

/** The phone half: Noise_KK initiator plus a frame queue. */
class Phone {
  session: NoiseSession | null = null;
  readonly messages: unknown[] = [];
  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  static async attach(url: string, channelId: Uint8Array, mine: KeyPair, theirs: Uint8Array): Promise<Phone> {
    // Build the handshake first and attach listeners before awaiting `open`:
    // the relay sends `hello` the instant the socket is accepted, and a listener
    // registered afterwards would miss it.
    const handshake = await NoiseHandshake.create({
      pattern: "KK",
      initiator: true,
      prologue: channelId,
      staticKeyPair: mine,
      remoteStaticPublicKey: theirs,
      backend: nobleBackend,
    });
    const ws = new WebSocket(url, [`${CHANNEL_PROTOCOL_PREFIX}${toBase64Url(channelId)}`], {
      perMessageDeflate: false,
    });
    const phone = new Phone(ws);

    let peerSeen = false;
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        const control = JSON.parse(data.toString()) as { t: string; peer?: boolean; present?: boolean; n?: number };
        if (control.t === "ping") ws.send(JSON.stringify({ t: "pong", n: control.n }));
        const present = control.t === "hello" ? control.peer : control.t === "peer" ? control.present : undefined;
        if (present === true && !peerSeen) {
          peerSeen = true;
          void handshake.writeMessage().then((m) => ws.send(m, { binary: true }));
        }
        return;
      }
      const frame = new Uint8Array(data as Buffer);
      if (!phone.session) {
        void handshake
          .readMessage(frame)
          .then(async () => {
            phone.session = new NoiseSession({ ...(await handshake.split()), channelId, initiator: true });
          })
          .catch(() => {});
        return;
      }
      void phone.session.decrypt(frame).then((payload) => {
        if (payload) phone.messages.push(JSON.parse(fromUtf8(payload)));
      });
    });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return phone;
  }

  async ready(timeoutMs = 2000): Promise<void> {
    await until(() => this.session !== null, timeoutMs, "the Noise handshake to finish");
  }

  async send(value: unknown): Promise<void> {
    this.ws.send(await this.session!.encrypt(utf8(JSON.stringify(value))), { binary: true });
  }

  /** Flip one byte of a real frame; the host must refuse it. */
  async sendTampered(value: unknown): Promise<void> {
    const frame = await this.session!.encrypt(utf8(JSON.stringify(value)));
    frame[frame.length - 1] ^= 0x40;
    this.ws.send(frame, { binary: true });
  }

  close(): void {
    this.ws.terminate();
  }
}

async function until(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function harness(options: { shapeTiming?: boolean } = {}) {
  const relay = new StubRelay();
  const url = await relay.listen();
  cleanup.push(() => relay.close());

  const desktop = await nobleBackend.generateKeyPair();
  const device = await nobleBackend.generateKeyPair();
  const channelId = await channelIdFor(desktop, device.publicKey, { backend: nobleBackend });

  const requests: unknown[] = [];
  let emit: (n: JsonRpcNotification) => void = () => {};
  const errors: Error[] = [];

  const client = new RelayClient({
    relayUrl: url,
    channelId,
    staticKeyPair: desktop,
    devicePublicKey: device.publicKey,
    deviceName: "test phone",
    backend: nobleBackend,
    minBackoffMs: 20,
    maxBackoffMs: 40,
    ...(options.shapeTiming ? { shapeTiming: true } : {}),
    handle: async (raw): Promise<JsonRpcResponse> => {
      requests.push(raw);
      const id = (raw as { id: string | number }).id;
      return { jsonrpc: "2.0", id, result: { ok: true, method: (raw as { method: string }).method } };
    },
    subscribe: (listener) => {
      emit = listener;
      return () => {
        emit = () => {};
      };
    },
    onError: (error) => errors.push(error),
  });
  cleanup.push(() => client.stop("test over"));
  client.start();

  return { url, channelId, desktop, device, client, requests, errors, notify: (n: JsonRpcNotification) => emit(n) };
}

describe("RelayClient", () => {
  it("answers a device's JSON-RPC request through the relay", async () => {
    const h = await harness();
    const phone = await Phone.attach(h.url, h.channelId, h.device, h.desktop.publicKey);
    cleanup.push(() => phone.close());
    await phone.ready();
    await until(() => h.client.state === "connected", 2000, "the client to report connected");

    await phone.send({ jsonrpc: "2.0", id: 1, method: "pi/session/list", params: {} });
    await until(() => phone.messages.length > 0, 2000, "a response");
    expect(phone.messages[0]).toMatchObject({ id: 1, result: { ok: true, method: "pi/session/list" } });
    expect(h.requests).toHaveLength(1);
  });

  it("forwards notifications only while a device is attached, and tracks each session's seq", async () => {
    const h = await harness();
    // Before anyone attaches: dropped, not queued — the device resumes with fromSeq.
    h.notify(update("/s/a.jsonl", 7));
    expect(h.client.statistics().notificationsDropped).toBe(1);
    expect(h.client.lastSeq.get("/s/a.jsonl")).toBe(7);

    const phone = await Phone.attach(h.url, h.channelId, h.device, h.desktop.publicKey);
    cleanup.push(() => phone.close());
    await phone.ready();
    await until(() => h.client.state === "connected", 2000, "connected");

    h.notify(update("/s/a.jsonl", 8));
    await until(() => phone.messages.length > 0, 2000, "the notification");
    expect(phone.messages[0]).toMatchObject({ method: "session/update", params: { seq: 8 } });
    expect(h.client.lastSeq.get("/s/a.jsonl")).toBe(8);
  });

  it("survives a tool result far larger than the relay's frame ceiling", async () => {
    // A single Read of a 200 kB file produces one of these. Sending it whole
    // made the relay close the socket, and the reconnect replayed the same
    // update into the same wall — the relay path died on the first real turn.
    const h = await harness();
    const phone = await Phone.attach(h.url, h.channelId, h.device, h.desktop.publicKey);
    cleanup.push(() => phone.close());
    await phone.ready();
    await until(() => h.client.state === "connected", 2000, "connected");

    h.notify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionPath: "/s/a.jsonl",
        seq: 1,
        at: new Date(0).toISOString(),
        update: { kind: "tool_execution_end", toolCallId: "t1", isError: false, result: "x".repeat(200_000) },
      },
    });
    await until(() => phone.messages.length > 0, 2000, "the reduced notification");
    expect(phone.messages[0]).toMatchObject({
      method: "session/update",
      params: { seq: 1, update: { kind: "tool_execution_end", oversized: true } },
    });

    // And the session is still usable afterwards.
    h.notify(update("/s/a.jsonl", 2));
    await until(() => phone.messages.length > 1, 2000, "a following notification");
    expect(h.client.state).toBe("connected");
  });

  it("rejects a tampered frame and does not act on it", async () => {
    const h = await harness();
    const phone = await Phone.attach(h.url, h.channelId, h.device, h.desktop.publicKey);
    cleanup.push(() => phone.close());
    await phone.ready();
    await until(() => h.client.state === "connected", 2000, "connected");

    await phone.sendTampered({ jsonrpc: "2.0", id: 9, method: "session/cancel", params: { path: "/s/a.jsonl" } });
    await until(() => h.errors.length > 0, 2000, "the authentication failure");
    expect(h.errors[0]!.message).toMatch(/authentication failed/);
    expect(h.requests).toHaveLength(0);
  });

  it("refuses a device whose static key is not the paired one", async () => {
    const h = await harness();
    const impostor = await nobleBackend.generateKeyPair();
    const phone = await Phone.attach(h.url, h.channelId, impostor, h.desktop.publicKey);
    cleanup.push(() => phone.close());
    await until(() => h.errors.length > 0, 2000, "the rejection");
    expect(h.errors.map((e) => e.message).join("\n")).toMatch(/failed authentication/);
    expect(phone.session).toBeNull();
  });

  it("re-handshakes when the device comes back, without restarting the host", async () => {
    const h = await harness();
    const first = await Phone.attach(h.url, h.channelId, h.device, h.desktop.publicKey);
    await first.ready();
    await until(() => h.client.state === "connected", 2000, "connected");
    expect(h.client.statistics().handshakes).toBe(1);

    first.close();
    await until(() => h.client.state === "waiting_for_peer", 2000, "the peer to be reported gone");

    const second = await Phone.attach(h.url, h.channelId, h.device, h.desktop.publicKey);
    cleanup.push(() => second.close());
    await second.ready();
    await until(() => h.client.state === "connected", 2000, "reconnection");
    expect(h.client.statistics().handshakes).toBe(2);

    await second.send({ jsonrpc: "2.0", id: 2, method: "session/cancel", params: { path: "/s/a.jsonl" } });
    await until(() => second.messages.length > 0, 2000, "a response after reconnecting");
    expect(second.messages[0]).toMatchObject({ id: 2 });
  });

  it("declines to connect a revoked device", async () => {
    const relay = new StubRelay();
    const url = await relay.listen();
    cleanup.push(() => relay.close());
    const desktop = await nobleBackend.generateKeyPair();
    const device = await nobleBackend.generateKeyPair();
    const errors: Error[] = [];
    const client = new RelayClient({
      relayUrl: url,
      channelId: await channelIdFor(desktop, device.publicKey, { backend: nobleBackend }),
      staticKeyPair: desktop,
      devicePublicKey: device.publicKey,
      backend: nobleBackend,
      isAuthorized: () => false,
      handle: async () => ({ jsonrpc: "2.0", id: 0, result: {} }),
      subscribe: () => () => {},
      onError: (error) => errors.push(error),
    });
    cleanup.push(() => client.stop());
    client.start();
    await until(() => client.state === "stopped", 2000, "the client to refuse");
    expect(errors[0]!.message).toMatch(/no longer a linked device/);
    expect(client.statistics().handshakes).toBe(0);
  });

  it("answers a cookie challenge and retries, instead of hanging", async () => {
    // `ws` hands an unexpected HTTP response to its listener and then emits
    // nothing further, so a client that forgets to consume it stalls forever.
    let challenges = 0;
    const http = createServer((_req, res) => res.writeHead(404).end());
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    const seen: string[] = [];
    http.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://relay.invalid");
      seen.push(url.search);
      if (url.searchParams.get("cookie") !== "the-cookie" && challenges++ === 0) {
        const payload = JSON.stringify({ error: "cookie_required", cookie: "the-cookie" });
        socket.end(
          `HTTP/1.1 429 Too Many Requests\r\ncontent-type: application/json\r\ncontent-length: ${payload.length}\r\nconnection: close\r\n\r\n${payload}`,
        );
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ t: "hello", channel: "x", slot: 0, peer: false }));
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", () => resolve()));
    const port = (http.address() as AddressInfo).port;
    cleanup.push(async () => {
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    });

    const desktop = await nobleBackend.generateKeyPair();
    const device = await nobleBackend.generateKeyPair();
    const client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${port}/ws`,
      channelId: await channelIdFor(desktop, device.publicKey, { backend: nobleBackend }),
      staticKeyPair: desktop,
      devicePublicKey: device.publicKey,
      backend: nobleBackend,
      minBackoffMs: 20,
      maxBackoffMs: 40,
      handle: async () => ({ jsonrpc: "2.0", id: 0, result: {} }),
      subscribe: () => () => {},
    });
    cleanup.push(() => client.stop());
    client.start();

    await until(() => client.state === "waiting_for_peer", 2000, "the retry to connect");
    expect(seen).toEqual(["", "?cookie=the-cookie"]);
    expect(client.statistics().connectAttempts).toBe(2);
  });

  it("backs off and retries when the relay refuses the upgrade outright", async () => {
    const http = createServer((_req, res) => res.writeHead(404).end());
    let attempts = 0;
    http.on("upgrade", (_req, socket) => {
      attempts++;
      // The client destroys its half as soon as it has read the 409, which
      // arrives here as ECONNRESET. Without a listener that is an unhandled
      // 'error' on the socket and takes the whole test run with it.
      socket.on("error", () => {});
      const payload = JSON.stringify({ error: "channel_full", message: "that channel already has two peers" });
      socket.end(
        `HTTP/1.1 409 Conflict\r\ncontent-type: application/json\r\ncontent-length: ${payload.length}\r\nconnection: close\r\n\r\n${payload}`,
      );
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", () => resolve()));
    const port = (http.address() as AddressInfo).port;
    cleanup.push(async () => {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    });

    const desktop = await nobleBackend.generateKeyPair();
    const device = await nobleBackend.generateKeyPair();
    const errors: Error[] = [];
    const client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${port}/ws`,
      channelId: await channelIdFor(desktop, device.publicKey, { backend: nobleBackend }),
      staticKeyPair: desktop,
      devicePublicKey: device.publicKey,
      backend: nobleBackend,
      minBackoffMs: 10,
      maxBackoffMs: 20,
      handle: async () => ({ jsonrpc: "2.0", id: 0, result: {} }),
      subscribe: () => () => {},
      onError: (error) => errors.push(error),
    });
    cleanup.push(() => client.stop());
    client.start();

    await until(() => attempts >= 2, 2000, "a second attempt after backoff");
    expect(errors[0]!.message).toMatch(/already has two peers.*revoke one from the desktop/s);
  });

  it("puts outbound frames on the timing grid when shaping is on", async () => {
    const h = await harness({ shapeTiming: true });
    const phone = await Phone.attach(h.url, h.channelId, h.device, h.desktop.publicKey);
    cleanup.push(() => phone.close());
    await phone.ready();
    await until(() => h.client.state === "connected", 2000, "connected");

    h.notify(update("/s/a.jsonl", 1));
    await until(() => phone.messages.length > 0, 2000, "the shaped notification");
    expect(phone.messages[0]).toMatchObject({ method: "session/update" });
    // Chaff keeps arriving after the last real frame and the phone drops it, so
    // the message count stays at one while frames keep moving.
    const framesAfterFirst = h.client.statistics().framesSent;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(h.client.statistics().framesSent).toBeGreaterThan(framesAfterFirst);
    expect(phone.messages).toHaveLength(1);
  });
});

function update(sessionPath: string, seq: number): JsonRpcNotification {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionPath, seq, at: new Date(0).toISOString(), update: { kind: "agent_start" } },
  };
}
