/**
 * Just enough relay, and a phone that speaks to it.
 *
 * The relay itself is stubbed rather than imported, for the same reason
 * `relay-client.test.ts` stubs it: the host must never gain a dependency on
 * the relay package, which is a byte forwarder that links nothing. This copy
 * also records every frame it forwarded, so a test can prove the relay saw
 * ciphertext and nothing else.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { NoiseHandshake, NoiseSession, nobleBackend, toBase64Url, utf8, fromUtf8, type KeyPair } from "@lasercode/crypto";

/** Mirrors `CHANNEL_PROTOCOL_PREFIX` in the relay package; see the note above. */
const CHANNEL_PROTOCOL_PREFIX = "lasercode.channel.";

export class StubRelay {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly channels = new Map<string, WebSocket[]>();
  /** Every binary frame this relay forwarded, in order. */
  readonly forwarded: Uint8Array[] = [];
  port = 0;

  constructor() {
    this.http = createServer((_req, res) => res.writeHead(404).end());
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
      const other = (): WebSocket | undefined => peers.find((peer) => peer !== ws);
      ws.send(JSON.stringify({ t: "hello", channel, slot: peers.length - 1, peer: peers.length === 2, maxFrameBytes: 65_536 }));
      if (peers.length === 2) other()?.send(JSON.stringify({ t: "peer", present: true }));
      ws.on("message", (data, isBinary) => {
        const peer = other();
        if (!isBinary) return;
        this.forwarded.push(new Uint8Array(data as Buffer));
        if (peer?.readyState === peer?.OPEN) peer?.send(data as Buffer, { binary: true });
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
export class Phone {
  session: NoiseSession | null = null;
  readonly messages: unknown[] = [];
  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  static async attach(url: string, channelId: Uint8Array, mine: KeyPair, theirs: Uint8Array): Promise<Phone> {
    const handshake = await NoiseHandshake.create({
      pattern: "KK",
      initiator: true,
      prologue: channelId,
      staticKeyPair: mine,
      remoteStaticPublicKey: theirs,
      backend: nobleBackend,
    });
    const ws = new WebSocket(url, [`${CHANNEL_PROTOCOL_PREFIX}${toBase64Url(channelId)}`], { perMessageDeflate: false });
    const phone = new Phone(ws);

    let peerSeen = false;
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        const control = JSON.parse(data.toString()) as { t: string; peer?: boolean; present?: boolean; n?: number };
        if (control.t === "ping") ws.send(JSON.stringify({ t: "pong", n: control.n }));
        const present = control.t === "hello" ? control.peer : control.t === "peer" ? control.present : undefined;
        if (present === true && !peerSeen) {
          peerSeen = true;
          void handshake.writeMessage().then((message) => ws.send(message, { binary: true }));
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

  async ready(timeoutMs = 4000): Promise<void> {
    await until(() => this.session !== null, timeoutMs, "the Noise handshake to finish");
  }

  async send(value: unknown): Promise<void> {
    this.ws.send(await this.session!.encrypt(utf8(JSON.stringify(value))), { binary: true });
  }

  /** The next response for this request id, decrypted by the phone itself. */
  async request(value: { id: number | string; method: string; params?: unknown }, timeoutMs = 4000): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    await this.send({ jsonrpc: "2.0", ...value, params: value.params ?? {} });
    await until(
      () => this.messages.some((message) => (message as { id?: unknown }).id === value.id),
      timeoutMs,
      `a response to ${value.method}`,
    );
    return this.messages.find((message) => (message as { id?: unknown }).id === value.id) as { result?: unknown; error?: { code: number; message: string } };
  }

  close(): void {
    this.ws.terminate();
  }
}

export async function until(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
