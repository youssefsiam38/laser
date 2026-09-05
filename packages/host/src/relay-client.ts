/**
 * Host relay client (M6-T5). One instance per paired device.
 *
 * The connection is **outbound only**: the host never listens on a public port,
 * so nothing about piorbit is reachable from the internet except through a relay
 * channel whose id only the two peers can compute. The relay forwards bytes it
 * cannot read; this file is where those bytes become the same JSON-RPC the local
 * WebSocket server speaks.
 *
 * Shape of a connection:
 *
 *   connect ──▶ relay `hello` ──▶ wait for `peer: present`
 *                                   │
 *                                   ▼
 *                            Noise_KK as responder (the device initiates)
 *                                   │
 *                                   ▼
 *                            frames ⇄ JSON-RPC, until the peer leaves
 *
 * Resume uses what the protocol already carries and invents nothing: every
 * `session/update` has a per-session `seq`, and a reattaching client replays with
 * `session/load { fromSeq }`. So notifications produced while the device is away
 * are dropped here, not queued — a queue would be a second, weaker resume
 * mechanism that could disagree with the first.
 */
import {
  KeystrokeShaper,
  NoiseHandshake,
  NoiseSession,
  frameSizeFor,
  toBase64Url,
  utf8,
  fromUtf8,
  type CryptoBackend,
  type KeyPair,
} from "@piorbit/crypto";
import { ErrorCodes, type JsonRpcNotification, type JsonRpcResponse, type SessionUpdateParams } from "@piorbit/protocol";
import WebSocket from "ws";

export type RelayClientState =
  | "stopped"
  | "connecting"
  | "waiting_for_peer"
  | "handshaking"
  | "connected"
  | "backoff";

export interface RelayClientOptions {
  /** Relay base URL ending in the WebSocket path, e.g. `wss://relay.example/ws`. */
  relayUrl: string;
  /** 32 bytes. `channelIdFor(desktopStatic, devicePublicKey)` from @piorbit/crypto. */
  channelId: Uint8Array;
  /** This desktop's durable X25519 static key. */
  staticKeyPair: KeyPair;
  /** The paired device's static public key, from the signed device list. */
  devicePublicKey: Uint8Array;
  /** Human label for logs and errors: "Youssef's iPhone". */
  deviceName?: string;
  /** Answer one client request. Wire this to the host `Router.handle`. */
  handle(raw: unknown): Promise<JsonRpcResponse>;
  /** Subscribe to host notifications. Returns an unsubscribe function. */
  subscribe(listener: (notification: JsonRpcNotification) => void): () => void;
  /**
   * Re-checked every time the device reconnects, so revoking it takes effect on
   * its next attempt without restarting the host. Returning false stops the
   * client for good.
   */
  isAuthorized?(devicePublicKey: Uint8Array): boolean;
  /**
   * Put outbound frames on the 20 ms grid with a chaff tail. Off by default on
   * the host: agent output is bulk, not keystrokes, and permanent chaff would
   * cost a phone real bandwidth. The phone client turns this on for its own
   * side, which is where typing actually happens.
   */
  shapeTiming?: boolean;
  backend?: CryptoBackend;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  log?: (line: string) => void;
  onStateChange?: (state: RelayClientState, detail?: string) => void;
  onError?: (error: Error) => void;
  now?: () => number;
  random?: () => number;
  /** Test seam. */
  webSocketImpl?: typeof WebSocket;
}

export interface RelayClientStats {
  state: RelayClientState;
  connectAttempts: number;
  handshakes: number;
  framesSent: number;
  framesReceived: number;
  /** Notifications discarded because the device was not attached. Expected, not an error. */
  notificationsDropped: number;
  /**
   * Messages the relay's frame ceiling could not carry. A big tool result is
   * sent with the result replaced by a marker; only a message that is still too
   * large after that is dropped, and the count says so rather than the session
   * dying and reconnecting into the same wall.
   */
  oversizedMessages: number;
  lastError?: string;
}

const DEFAULT_MIN_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
/** Beyond this a frame is not a JSON-RPC message; refuse rather than parse it. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** What the relay advertises today; replaced by the real value from `hello`. */
const DEFAULT_RELAY_MAX_FRAME_BYTES = 65_536;

export class RelayClient {
  private readonly options: RelayClientOptions;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly WS: typeof WebSocket;

  private ws: WebSocket | null = null;
  private handshake: NoiseHandshake | null = null;
  private session: NoiseSession | null = null;
  private shaper: KeystrokeShaper | null = null;
  private unsubscribe: (() => void) | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private cookie: string | undefined;
  private stopped = true;
  private currentState: RelayClientState = "stopped";

  private readonly seqBySession = new Map<string, number>();
  private counters = {
    connectAttempts: 0,
    handshakes: 0,
    framesSent: 0,
    framesReceived: 0,
    notificationsDropped: 0,
    oversizedMessages: 0,
  };
  /**
   * The relay's own ceiling, from its `hello`. Frames above it are refused by
   * the relay with a socket close, so anything that would exceed it is reduced
   * here instead of being sent and killing the session.
   */
  private maxFrameBytes = DEFAULT_RELAY_MAX_FRAME_BYTES;
  private lastError: string | undefined;

  constructor(options: RelayClientOptions) {
    this.options = options;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.WS = options.webSocketImpl ?? WebSocket;
    if (options.channelId.length !== 32) {
      throw new RangeError(`relay channel id must be 32 bytes, got ${options.channelId.length}`);
    }
  }

  get state(): RelayClientState {
    return this.currentState;
  }

  /** Highest `session/update` seq seen per session, for diagnostics and logs. */
  get lastSeq(): ReadonlyMap<string, number> {
    return this.seqBySession;
  }

  get channelIdText(): string {
    return toBase64Url(this.options.channelId);
  }

  statistics(): RelayClientStats {
    return {
      state: this.currentState,
      ...this.counters,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.unsubscribe = this.options.subscribe((notification) => this.onNotification(notification));
    this.connect();
  }

  async stop(reason = "host stopping"): Promise<void> {
    this.stopped = true;
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
    this.backoffTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.teardown(reason);
    const ws = this.ws;
    this.ws = null;
    if (!ws) {
      this.setState("stopped", reason);
      return;
    }
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      ws.once("close", done);
      ws.close(1000, reason.slice(0, 120));
      setTimeout(() => {
        ws.terminate();
        done();
      }, 1000).unref?.();
    });
    this.setState("stopped", reason);
  }

  // --------------------------------------------------------- connection ---

  private connect(): void {
    if (this.stopped) return;
    if (this.options.isAuthorized && !this.options.isAuthorized(this.options.devicePublicKey)) {
      this.fail(new Error(`${this.deviceLabel()} is no longer a linked device; not connecting`));
      void this.stop("device revoked");
      return;
    }
    this.counters.connectAttempts++;
    this.setState("connecting");

    const url = this.socketUrl();
    const ws = new this.WS(url, { perMessageDeflate: false, maxPayload: MAX_MESSAGE_BYTES });
    this.ws = ws;

    ws.on("open", () => {
      this.log(`relay: connected for ${this.deviceLabel()} on channel ${this.channelIdText.slice(0, 8)}…`);
      this.cookie = undefined;
      this.setState("waiting_for_peer");
    });
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      void this.onMessage(data, isBinary).catch((error: unknown) => this.fail(asError(error)));
    });
    // The relay answers a cookie challenge, and every other refusal, with plain
    // HTTP before the upgrade. `ws` hands the response over untouched when a
    // listener exists and then does nothing else — no `close`, no `error` — so
    // this path owns consuming the body, destroying the request, and deciding
    // what happens next. Forgetting any of the three hangs the client forever.
    ws.on("unexpected-response", (request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        request.destroy();
        if (this.ws !== ws) return;
        this.ws = null;
        this.onUpgradeRefused(response.statusCode ?? 0, Buffer.concat(chunks).toString());
      });
    });
    ws.on("error", (error: Error) => {
      this.lastError = error.message;
      this.options.onError?.(error);
    });
    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.teardown(`relay closed the connection (${code})`);
      if (this.stopped) return;
      this.scheduleReconnect(`${code}${reason.length > 0 ? ` ${reason.toString()}` : ""}`);
    });
  }

  private socketUrl(): string {
    const base = this.options.relayUrl.replace(/\/+$/, "");
    const query = this.cookie ? `?cookie=${encodeURIComponent(this.cookie)}` : "";
    return `${base}/${this.channelIdText}${query}`;
  }

  private onUpgradeRefused(status: number, body: string): void {
    let parsed: { error?: string; message?: string; cookie?: string } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      /* the relay always sends JSON, but a proxy in front of it might not */
    }
    if (status === 429 && parsed.cookie) {
      // A cookie challenge is not a failure: answer it and retry at once. The
      // attempt does not count against the backoff, or a busy relay would push
      // every desktop into ever longer waits for doing exactly what it asked.
      this.cookie = parsed.cookie;
      this.log("relay: answering the load cookie and retrying");
      if (!this.stopped) this.connect();
      return;
    }
    this.cookie = undefined;
    const detail = parsed.message ?? body.slice(0, 200);
    this.lastError = `relay refused the connection (HTTP ${status})${detail ? `: ${detail}` : ""}`;
    if (status === 409) {
      this.lastError += ". Two devices are already on this channel; revoke one from the desktop.";
    }
    this.options.onError?.(new Error(this.lastError));
    if (!this.stopped) this.scheduleReconnect(`HTTP ${status}`);
  }

  private scheduleReconnect(detail: string): void {
    const min = this.options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
    const max = this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    const base = Math.min(max, min * 2 ** this.attempt);
    // ±20 % jitter so a relay restart does not bring every desktop back at once.
    const delay = Math.round(base * (0.8 + this.random() * 0.4));
    this.attempt++;
    this.setState("backoff", `${detail}; retrying in ${Math.round(delay / 1000)}s`);
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      this.connect();
    }, delay);
    this.backoffTimer.unref?.();
  }

  // ------------------------------------------------------------ traffic ---

  private async onMessage(data: WebSocket.RawData, isBinary: boolean): Promise<void> {
    if (!isBinary) return this.onControl(data);
    this.counters.framesReceived++;
    const frame = new Uint8Array(toBuffer(data));

    if (!this.session) {
      await this.advanceHandshake(frame);
      return;
    }
    const payload = await this.session.decrypt(frame);
    if (payload === null) return; // chaff from the peer's timing defence
    await this.dispatch(payload);
  }

  private onControl(data: WebSocket.RawData): void {
    let message: {
      t?: string;
      peer?: boolean;
      present?: boolean;
      n?: number;
      code?: string;
      message?: string;
      maxFrameBytes?: number;
    };
    try {
      message = JSON.parse(toBuffer(data).toString("utf8")) as typeof message;
    } catch {
      this.fail(new Error("the relay sent a control frame that was not JSON"));
      return;
    }
    switch (message.t) {
      // `hello.peer` says whether the device is already parked on the channel;
      // `peer.present` reports every arrival and departure after that.
      case "hello":
        if (typeof message.maxFrameBytes === "number" && message.maxFrameBytes > 0) {
          this.maxFrameBytes = message.maxFrameBytes;
        }
        if (message.peer === true) void this.onPeerChange(true);
        return;
      case "peer":
        void this.onPeerChange(message.present === true);
        return;
      case "ping":
        if (this.ws?.readyState === this.ws?.OPEN) this.ws?.send(JSON.stringify({ t: "pong", n: message.n }));
        return;
      case "error":
        this.lastError = `relay: ${message.code ?? "error"} — ${message.message ?? ""}`;
        this.options.onError?.(new Error(this.lastError));
        return;
      default:
        return;
    }
  }

  private async onPeerChange(present: boolean): Promise<void> {
    if (!present) {
      this.teardown("the device disconnected");
      this.setState("waiting_for_peer");
      return;
    }
    // A fresh handshake per attachment: forward secrecy across reconnects, and
    // no chance of reusing a counter from a previous connection.
    this.teardown("re-handshaking");
    this.setState("handshaking");
    try {
      this.handshake = await NoiseHandshake.create({
        pattern: "KK",
        initiator: false,
        prologue: this.options.channelId,
        staticKeyPair: this.options.staticKeyPair,
        remoteStaticPublicKey: this.options.devicePublicKey,
        ...(this.options.backend ? { backend: this.options.backend } : {}),
      });
    } catch (error) {
      this.fail(asError(error));
    }
  }

  private async advanceHandshake(frame: Uint8Array): Promise<void> {
    const handshake = this.handshake;
    if (!handshake) {
      this.fail(new Error("received a frame before the device announced itself"));
      return;
    }
    try {
      await handshake.readMessage(frame);
      const reply = await handshake.writeMessage();
      this.ws?.send(reply, { binary: true });
      this.counters.framesSent++;
      this.session = new NoiseSession({
        ...(await handshake.split()),
        channelId: this.options.channelId,
        initiator: false,
      });
      this.handshake = null;
      this.attempt = 0;
      this.counters.handshakes++;
      if (this.options.shapeTiming) this.startShaper();
      this.setState("connected", `SAS ${this.session.sas.emoji.join(" ")}`);
      this.log(`relay: ${this.deviceLabel()} attached (SAS ${this.session.sas.code})`);
    } catch (error) {
      // A failed KK handshake means the peer is not who the device list says.
      this.fail(
        new Error(
          `the device on this channel failed authentication: ${asError(error).message}. ` +
            "If you did not expect this, revoke the device from the desktop.",
        ),
      );
      this.ws?.close(4401, "handshake failed");
    }
  }

  private async dispatch(payload: Uint8Array): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(fromUtf8(payload));
    } catch {
      this.fail(new Error("the device sent a frame that was not JSON-RPC"));
      return;
    }
    // Only requests travel device → host. Notifications and responses from a
    // remote client are not part of the protocol and are ignored rather than
    // guessed at.
    const message = raw as { id?: unknown; method?: unknown };
    if (typeof message?.method !== "string" || message.id === undefined) return;
    const response = await this.options.handle(raw);
    const encoded = this.encode(response);
    if (encoded) {
      await this.send(encoded);
      return;
    }
    this.counters.oversizedMessages++;
    // Better an error the device can show than a frame that closes the socket.
    await this.send(
      utf8(
        JSON.stringify({
          jsonrpc: "2.0",
          id: (message as { id: string | number }).id,
          error: {
            code: ErrorCodes.Internal,
            message:
              "that answer is too large to send over the relay. Open this session on the desktop, " +
              "or ask for less of it at a time.",
          },
        }),
      ),
    );
  }

  private onNotification(notification: JsonRpcNotification): void {
    if (notification.method === "session/update") {
      const params = notification.params as SessionUpdateParams;
      if (params?.sessionPath && typeof params.seq === "number") {
        this.seqBySession.set(params.sessionPath, params.seq);
      }
    }
    if (!this.session) {
      // Dropped on purpose: the device resumes with session/load { fromSeq }.
      this.counters.notificationsDropped++;
      return;
    }
    const payload = this.encode(notification) ?? this.encode(reduce(notification));
    if (!payload) {
      // Nothing sensible left to shrink. Losing one update is bad; tearing the
      // session down and reconnecting into the same frame is worse.
      this.counters.oversizedMessages++;
      this.log(`relay: dropped a ${notification.method} notification that does not fit the relay's frame size`);
      return;
    }
    void this.send(payload).catch((error: unknown) => this.fail(asError(error)));
  }

  /**
   * Serialize a message if — and only if — the frame it produces is one the
   * relay will forward. `null` means "too big"; the caller decides what to do.
   */
  private encode(message: unknown): Uint8Array | null {
    if (message === null) return null;
    const payload = utf8(JSON.stringify(message));
    try {
      if (frameSizeFor(payload.length) > this.maxFrameBytes) return null;
    } catch {
      return null; // past the framing layer's own ceiling
    }
    return payload;
  }

  private async send(payload: Uint8Array): Promise<void> {
    if (this.shaper) {
      this.shaper.enqueue(payload);
      return;
    }
    await this.writeFrame(payload);
  }

  private async writeFrame(payload: Uint8Array | null): Promise<void> {
    const session = this.session;
    const ws = this.ws;
    if (!session || !ws || ws.readyState !== ws.OPEN) return;
    const frame = payload === null ? await session.encryptChaff() : await session.encrypt(payload);
    ws.send(frame, { binary: true });
    this.counters.framesSent++;
  }

  private startShaper(): void {
    this.shaper = new KeystrokeShaper({
      sendFrame: (frame) => this.writeFrame(frame),
      random: this.random,
      onError: (error) => this.options.onError?.(asError(error)),
    });
  }

  // ------------------------------------------------------------ lifecycle --

  private teardown(reason: string): void {
    this.shaper?.stop();
    this.shaper = null;
    this.session?.close();
    this.session = null;
    this.handshake = null;
    if (reason) this.log(`relay: ${reason}`);
  }

  private fail(error: Error): void {
    this.lastError = error.message;
    this.options.onError?.(error);
    this.teardown(error.message);
    // Any transport error is fatal to the Noise session; drop the socket and let
    // backoff bring it back rather than continuing on a desynchronised stream.
    this.ws?.close(4400, error.message.slice(0, 120));
  }

  private setState(state: RelayClientState, detail?: string): void {
    if (this.currentState === state && detail === undefined) return;
    this.currentState = state;
    this.options.onStateChange?.(state, detail);
  }

  private deviceLabel(): string {
    return this.options.deviceName ?? `device ${toBase64Url(this.options.devicePublicKey).slice(0, 8)}…`;
  }
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * A smaller version of a notification whose bulk is one field, or `null` when
 * there is nothing to shave. Today that is a tool result: a single Read of a
 * large file produces an update past any relay frame ceiling. The marker is
 * explicit, and `pi/session/entries` still has the real thing.
 */
function reduce(notification: JsonRpcNotification): JsonRpcNotification | null {
  if (notification.method !== "session/update") return null;
  const params = notification.params as SessionUpdateParams | undefined;
  const update = params?.update;
  if (!update) return null;
  if (update.kind === "tool_execution_end") {
    return {
      ...notification,
      params: {
        ...params,
        update: {
          ...update,
          result: { piorbit: "this result was too large to send over the relay; open the row to load it" },
          oversized: true,
        },
      },
    } as JsonRpcNotification;
  }
  if (update.kind === "tool_execution_update") {
    // A partial is a progress hint; dropping its body costs nothing lasting.
    return {
      ...notification,
      params: { ...params, update: { ...update, partial: undefined } },
    } as JsonRpcNotification;
  }
  return null;
}
