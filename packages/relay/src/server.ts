/**
 * The relay (M6-T4). A WebSocket byte forwarder and nothing else.
 *
 * What it does:
 *   - routes by a 43-character opaque channel id in the path
 *   - allows exactly two sockets per channel; a third is refused
 *   - forwards zero bytes until both sides are present
 *   - limits channel CREATION and connection ATTEMPTS per IP, separately
 *   - demands a WireGuard-style cookie once it is under load, holding no state
 *   - rejects frames that are not a legal padded size
 *   - pings at the application level every 20 s (Railway drops silent sockets)
 *
 * What it cannot do: read anything. It links no crypto library, holds no key
 * belonging to any channel, and never inspects a binary frame's contents. The
 * threat model is in docs/security.md.
 *
 * Railway notes: one replica (`numReplicas: 1` in railway.json) because there is
 * no sticky routing — two peers on the same channel must land on the same
 * process. Scaling out needs a shared bus, which is a separate task, not a knob.
 * `sleepApplication` stays false: a sleeping relay is a desktop nobody can reach.
 */
import { PRODUCT_NAME } from "@piorbit/protocol/identity";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { CookieJar, COOKIE_ROTATION_MS } from "./cookie.js";
import { LoadWindow, TokenBucket } from "./limits.js";
import {
  CHANNEL_PROTOCOL_PREFIX,
  RelayClose,
  channelIdFromProtocols,
  legalFrameSizes,
  type RelayControl,
  type RelayErrorCode,
} from "./protocol.js";

export interface RelayOptions {
  host?: string;
  port?: number;
  /** Ceiling on channels held at once. Beyond it, new channels are refused. */
  maxChannels?: number;
  /** Largest binary frame forwarded, in bytes. */
  maxFrameBytes?: number;
  /** Reject binary frames whose size is not a legal padded frame size. */
  enforceFrameSizes?: boolean;
  channelCreationPerMinute?: number;
  connectionsPerMinute?: number;
  /** Upgrade attempts in the last 10 s above which cookies are demanded. */
  cookieThreshold?: number;
  pingIntervalMs?: number;
  /** Close a socket that has been alone on its channel this long. 0 = never (the default: a desktop parks here waiting for its phone). */
  soloTimeoutMs?: number;
  /**
   * How many trusted proxies sit in front of this relay.
   *
   * `false`/`0` (the default) means none: the peer address of the socket is the
   * client. Behind Railway it is `1`. The count matters because the relay reads
   * `x-forwarded-for` from the **right**, skipping `hops - 1` entries: the
   * rightmost entry is the one the nearest trusted proxy wrote, and everything
   * to its left is attacker-supplied. Reading the leftmost entry instead made
   * every rate limit and the cookie challenge bypassable with one header.
   *
   * `true` is accepted as a synonym for one hop.
   */
  trustProxy?: boolean | number;
  log?: (line: string) => void;
  now?: () => number;
}

interface Peer {
  socket: WebSocket;
  ip: string;
  slot: 0 | 1;
  /** Sequence of the last ping sent; a pong with a lower number is stale, not an answer. */
  lastPing: number;
  missedPings: number;
  aloneSince: number | null;
  /**
   * Binary frames this peer may still send at any size (up to `maxFrameBytes`).
   *
   * Noise handshake messages are raw Noise messages, not padded transport
   * frames — a KK message is 48 bytes and an IK pairing message is whatever its
   * payload makes it — so size enforcement has to let the first frames of an
   * attachment through or no handshake can ever complete. The allowance is a
   * counter, not an inspection: the relay still never looks inside a frame.
   * It is refilled whenever the channel's membership changes, because the peers
   * re-handshake on every attachment.
   */
  handshakeFrames: number;
}

interface Channel {
  id: string;
  peers: Peer[];
  createdAt: number;
}

export interface RelayStats {
  channels: number;
  sockets: number;
  upgrades: number;
  framesForwarded: number;
  bytesForwarded: number;
  refused: Record<string, number>;
  cookiesRequired: boolean;
}

const DEFAULTS = {
  maxChannels: 10_000,
  maxFrameBytes: 65_536,
  channelCreationPerMinute: 30,
  connectionsPerMinute: 240,
  cookieThreshold: 600,
  pingIntervalMs: 20_000,
  soloTimeoutMs: 0,
  loadWindowMs: 10_000,
} as const;

/** Binary frames per attachment exempt from padded-size enforcement (two Noise messages). */
const HANDSHAKE_FRAMES = 2;

export class RelayServer {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly channels = new Map<string, Channel>();
  private readonly socketChannel = new WeakMap<WebSocket, string>();
  private readonly creation: TokenBucket;
  private readonly connections: TokenBucket;
  private readonly load: LoadWindow;
  private readonly cookies: CookieJar;
  private readonly legalSizes: Set<number>;
  private readonly options: Required<Omit<RelayOptions, "log" | "now" | "host" | "port" | "trustProxy">> & {
    host: string;
    port: number;
    /** Normalized to a hop count; 0 means "the socket's peer address is the client". */
    trustProxy: number;
  };
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pingSeq = 0;

  private stats = {
    upgrades: 0,
    framesForwarded: 0,
    bytesForwarded: 0,
    refused: {} as Record<string, number>,
  };

  constructor(options: RelayOptions = {}) {
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.options = {
      host: options.host ?? "0.0.0.0",
      port: options.port ?? 8080,
      maxChannels: options.maxChannels ?? DEFAULTS.maxChannels,
      maxFrameBytes: options.maxFrameBytes ?? DEFAULTS.maxFrameBytes,
      enforceFrameSizes: options.enforceFrameSizes ?? true,
      channelCreationPerMinute: options.channelCreationPerMinute ?? DEFAULTS.channelCreationPerMinute,
      connectionsPerMinute: options.connectionsPerMinute ?? DEFAULTS.connectionsPerMinute,
      cookieThreshold: options.cookieThreshold ?? DEFAULTS.cookieThreshold,
      pingIntervalMs: options.pingIntervalMs ?? DEFAULTS.pingIntervalMs,
      soloTimeoutMs: options.soloTimeoutMs ?? DEFAULTS.soloTimeoutMs,
      // Off unless a deployment says otherwise: a directly exposed relay must be
      // safe out of the box, and a wrong hop count is a silent bypass.
      trustProxy: normalizeHops(options.trustProxy),
    };
    this.creation = new TokenBucket({
      capacity: this.options.channelCreationPerMinute,
      refillPerMinute: this.options.channelCreationPerMinute,
      now: this.now,
    });
    this.connections = new TokenBucket({
      capacity: this.options.connectionsPerMinute,
      refillPerMinute: this.options.connectionsPerMinute,
      now: this.now,
    });
    this.load = new LoadWindow(DEFAULTS.loadWindowMs, this.now);
    this.cookies = new CookieJar(COOKIE_ROTATION_MS, this.now);
    this.legalSizes = legalFrameSizes(this.options.maxFrameBytes);

    this.http = createServer((req, res) => this.serveHttp(req, res));
    // `noServer` so the cookie challenge can answer with plain HTTP 429 before
    // any WebSocket state exists. permessage-deflate is off: it is a CRIME-class
    // compression oracle over payloads we deliberately pad, and Railway's proxy
    // handles it badly besides.
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: this.options.maxFrameBytes,
      // Echo the channel subprotocol back, or the client's handshake fails.
      // Anything else a client offers is ignored, never selected.
      handleProtocols: (protocols) => {
        for (const protocol of protocols) if (protocol.startsWith(CHANNEL_PROTOCOL_PREFIX)) return protocol;
        return false;
      },
    });
    this.http.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
  }

  async listen(): Promise<{ host: string; port: number; url: string }> {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.options.port, this.options.host, () => resolve());
    });
    const { port } = this.http.address() as AddressInfo;
    this.timer = setInterval(() => this.sweep(), this.options.pingIntervalMs);
    this.timer.unref?.();
    const url = `http://${this.options.host}:${port}`;
    this.log(`${PRODUCT_NAME} relay listening on ${url} (max ${this.options.maxChannels} channels)`);
    return { host: this.options.host, port, url };
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const channel of this.channels.values()) {
      for (const peer of channel.peers) peer.socket.close(RelayClose.GoingAway, "relay shutting down");
    }
    this.channels.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  statistics(): RelayStats {
    let sockets = 0;
    for (const channel of this.channels.values()) sockets += channel.peers.length;
    return {
      channels: this.channels.size,
      sockets,
      upgrades: this.stats.upgrades,
      framesForwarded: this.stats.framesForwarded,
      bytesForwarded: this.stats.bytesForwarded,
      refused: { ...this.stats.refused },
      cookiesRequired: this.underLoad(),
    };
  }

  // ------------------------------------------------------------- HTTP -----

  private serveHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://relay.invalid");
    if (url.pathname === "/healthz") {
      const body = JSON.stringify({ ok: true, uptimeSeconds: Math.round(process.uptime()), ...this.statistics() });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(body);
      return;
    }
    if (url.pathname === "/") {
      res
        .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
        .end(`${PRODUCT_NAME} relay. It forwards encrypted bytes between two peers and can read none of them.\n`);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found\n");
  }

  // ---------------------------------------------------------- upgrade -----

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const ip = this.clientIp(req);
    const url = new URL(req.url ?? "/", "http://relay.invalid");
    this.load.record();

    if (!/^\/ws\/?$/.test(url.pathname)) {
      return this.refuseUpgrade(socket, 404, "not_found", "expected /ws with the channel as a subprotocol");
    }
    // The channel id is a header, not a path segment: see CHANNEL_PROTOCOL_PREFIX.
    const channelId = channelIdFromProtocols(req.headers["sec-websocket-protocol"]);
    if (channelId === undefined) {
      return this.refuseUpgrade(
        socket,
        400,
        "bad_channel",
        `offer the channel as a Sec-WebSocket-Protocol value: ${CHANNEL_PROTOCOL_PREFIX}<43 base64url characters>`,
      );
    }
    if (!this.connections.take(ip)) {
      const retry = this.connections.retryAfterSeconds(ip);
      return this.refuseUpgrade(socket, 429, "rate_limited", `too many connection attempts; retry in ${retry}s`, {
        "retry-after": String(retry),
      });
    }
    // Cookies only once we are actually under load: a quiet relay never makes
    // anyone do a second round trip.
    if (this.underLoad() && !this.cookies.verify(ip, url.searchParams.get("cookie") ?? undefined)) {
      return this.refuseUpgrade(
        socket,
        429,
        "cookie_required",
        "the relay is under load; reconnect with ?cookie=<value>",
        { "retry-after": "1" },
        { cookie: this.cookies.issue(ip) },
      );
    }

    const existing = this.channels.get(channelId);
    if (!existing) {
      if (this.channels.size >= this.options.maxChannels) {
        return this.refuseUpgrade(socket, 503, "capacity", "the relay is at capacity; try again shortly");
      }
      if (!this.creation.take(ip)) {
        const retry = this.creation.retryAfterSeconds(ip);
        return this.refuseUpgrade(socket, 429, "creation_rate_limited", `too many new channels; retry in ${retry}s`, {
          "retry-after": String(retry),
        });
      }
    } else if (existing.peers.length >= 2) {
      return this.refuseUpgrade(socket, 409, "channel_full", "that channel already has two peers");
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.stats.upgrades++;
      this.onConnection(ws, channelId, ip);
    });
  }

  private refuseUpgrade(
    socket: Duplex,
    status: number,
    reason: string,
    message: string,
    headers: Record<string, string> = {},
    body: Record<string, unknown> = {},
  ): void {
    this.stats.refused[reason] = (this.stats.refused[reason] ?? 0) + 1;
    const payload = JSON.stringify({ error: reason, message, ...body });
    const lines = [
      `HTTP/1.1 ${status} ${statusText(status)}`,
      "content-type: application/json",
      `content-length: ${Buffer.byteLength(payload)}`,
      "connection: close",
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      "",
      payload,
    ];
    socket.end(lines.join("\r\n"));
  }

  private underLoad(): boolean {
    return this.load.count > this.options.cookieThreshold;
  }

  // ------------------------------------------------------- connection -----

  private onConnection(ws: WebSocket, channelId: string, ip: string): void {
    const channel = this.channels.get(channelId) ?? { id: channelId, peers: [], createdAt: this.now() };
    this.channels.set(channelId, channel);
    const slot: 0 | 1 = channel.peers.length === 0 ? 0 : 1;
    const peer: Peer = {
      socket: ws,
      ip,
      slot,
      lastPing: 0,
      missedPings: 0,
      aloneSince: this.now(),
      handshakeFrames: HANDSHAKE_FRAMES,
    };
    channel.peers.push(peer);
    this.socketChannel.set(ws, channelId);
    // Both sides re-handshake when the membership changes, so both get a fresh
    // allowance — including the desktop that has been parked here waiting.
    for (const member of channel.peers) member.handshakeFrames = HANDSHAKE_FRAMES;

    const other = this.other(channel, peer);
    this.send(ws, {
      t: "hello",
      channel: channelId,
      slot,
      peer: other !== undefined,
      pingIntervalMs: this.options.pingIntervalMs,
      maxFrameBytes: this.options.maxFrameBytes,
    });
    if (other) {
      peer.aloneSince = null;
      other.aloneSince = null;
      this.send(other.socket, { t: "peer", present: true });
      this.send(ws, { t: "peer", present: true });
    }

    ws.on("message", (data: RawData, isBinary: boolean) => this.onMessage(channel, peer, data, isBinary));
    ws.on("close", () => this.onClose(channel, peer));
    ws.on("error", () => this.onClose(channel, peer));
  }

  private onMessage(channel: Channel, peer: Peer, data: RawData, isBinary: boolean): void {
    if (!isBinary) return this.onControl(peer, data);

    const frame = toBuffer(data);
    if (frame.length > this.options.maxFrameBytes) {
      this.fail(peer, "frame_too_large", `frames are capped at ${this.options.maxFrameBytes} bytes`);
      return;
    }
    if (this.options.enforceFrameSizes && !this.legalSizes.has(frame.length)) {
      if (peer.handshakeFrames <= 0) {
        this.fail(peer, "bad_frame_size", `${frame.length} bytes is not a padded ${PRODUCT_NAME} frame size`);
        return;
      }
    }
    // Spent whether or not it was needed, so the exemption is a strict prefix of
    // the attachment rather than a standing licence.
    if (peer.handshakeFrames > 0) peer.handshakeFrames -= 1;
    const other = this.other(channel, peer);
    if (!other) {
      // Zero bytes move until both sides are present. Nothing is buffered:
      // buffering is state, and state is what a relay must not accumulate.
      this.send(peer.socket, { t: "error", code: "no_peer", message: "no peer on this channel yet" });
      return;
    }
    if (other.socket.readyState !== other.socket.OPEN) return;
    other.socket.send(frame, { binary: true });
    this.stats.framesForwarded++;
    this.stats.bytesForwarded += frame.length;
  }

  private onControl(peer: Peer, data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(toBuffer(data).toString("utf8"));
    } catch {
      this.fail(peer, "bad_control", "control frames must be JSON");
      return;
    }
    const message = parsed as { t?: unknown; n?: unknown };
    if (message?.t !== "pong" || typeof message.n !== "number") {
      this.fail(peer, "bad_control", 'the only control frame the relay accepts is {"t":"pong","n":<number>}');
      return;
    }
    if (message.n === peer.lastPing) peer.missedPings = 0;
  }

  private onClose(channel: Channel, peer: Peer): void {
    const index = channel.peers.indexOf(peer);
    if (index < 0) return;
    channel.peers.splice(index, 1);
    const other = channel.peers[0];
    if (other) {
      other.aloneSince = this.now();
      other.handshakeFrames = HANDSHAKE_FRAMES; // it will handshake again for the next peer
      this.send(other.socket, { t: "peer", present: false });
    }
    if (channel.peers.length === 0) this.channels.delete(channel.id);
  }

  private fail(peer: Peer, code: RelayErrorCode, message: string): void {
    this.stats.refused[code] = (this.stats.refused[code] ?? 0) + 1;
    this.send(peer.socket, { t: "error", code, message });
    peer.socket.close(RelayClose.BadRequest, message.slice(0, 120));
  }

  // ------------------------------------------------------------ upkeep ----

  /** Ping every socket, reap the unresponsive, and forget idle rate-limit rows. */
  private sweep(): void {
    const n = ++this.pingSeq;
    const now = this.now();
    for (const channel of [...this.channels.values()]) {
      for (const peer of [...channel.peers]) {
        if (peer.socket.readyState !== peer.socket.OPEN) continue;
        if (peer.missedPings >= 2) {
          peer.socket.close(RelayClose.Timeout, "no response to two pings");
          this.onClose(channel, peer);
          continue;
        }
        if (
          this.options.soloTimeoutMs > 0 &&
          peer.aloneSince !== null &&
          now - peer.aloneSince > this.options.soloTimeoutMs
        ) {
          peer.socket.close(RelayClose.Timeout, "no peer arrived");
          this.onClose(channel, peer);
          continue;
        }
        peer.lastPing = n;
        peer.missedPings++;
        this.send(peer.socket, { t: "ping", n });
      }
    }
    this.creation.sweep();
    this.connections.sweep();
  }

  private other(channel: Channel, peer: Peer): Peer | undefined {
    return channel.peers.find((candidate) => candidate !== peer);
  }

  private send(ws: WebSocket, message: RelayControl): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  /**
   * The address every rate limit and the cookie challenge key off.
   *
   * `x-forwarded-for` is append-only and client-controllable at the *left*, so
   * the trustworthy entry is `hops` from the right — the one the nearest proxy
   * we trust wrote. With no trusted proxy the header is ignored entirely.
   */
  private clientIp(req: IncomingMessage): string {
    const hops = this.options.trustProxy;
    if (hops > 0) {
      const header = req.headers["x-forwarded-for"];
      const raw = Array.isArray(header) ? header.join(",") : header;
      const parts = (raw ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      const chosen = parts[parts.length - hops];
      if (chosen) return normalizeIp(chosen);
    }
    return normalizeIp(req.socket.remoteAddress ?? "unknown");
  }
}

function normalizeHops(value: boolean | number | undefined): number {
  if (value === undefined || value === false) return 0;
  if (value === true) return 1;
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

function statusText(status: number): string {
  return (
    { 400: "Bad Request", 404: "Not Found", 409: "Conflict", 429: "Too Many Requests", 503: "Service Unavailable" }[
      status
    ] ?? "Error"
  );
}
