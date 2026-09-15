/**
 * HostClient — JSON-RPC over WebSocket to the laser host.
 *
 * Reconnects with backoff and, on reconnect, re-issues `session/load` with
 * the last seen `seq` for every session the app is attached to, so a dropped
 * socket (laptop sleep, phone lock, host restart) loses no output. Also
 * reconnects proactively on `visibilitychange` because iOS closes sockets on
 * lock without always firing `close` (docs/research/findings.md).
 *
 * `session/update` notifications are coalesced to one flush per animation
 * frame; every other message flushes the buffer first, so order is preserved.
 */
import { ENVIRONMENT_CONTRACT_VERSION, ENVIRONMENT_DESCRIBE_METHOD, PRODUCT_VERSION, environmentDescriptorSchema } from "@lasercode/protocol";
import type {
  ClientMethod,
  ClientRequests,
  EnvironmentDescriptor,
  HostNotificationMethod,
  HostNotifications,
  JsonRpcMessage,
  SessionUpdateParams,
} from "@lasercode/protocol";

export type NotificationHandler = <M extends HostNotificationMethod>(method: M, params: HostNotifications[M]) => void;

export type ConnectionState = "connecting" | "open" | "closed";

/**
 * What the app does with the environment it was just told about, before the
 * connection opens. Returning a refusal keeps the client closed: the app could
 * not make this device safe for this environment, so nothing may be read,
 * written, resumed or requested in it.
 */
export type EnvironmentAcceptance = { ok: true } | { ok: false; reason: string };

/** Handshake ids. Negative and zero, so they can never be a request id. */
const VERSION_ID = 0;
const ENVIRONMENT_ID = -1;

/** How long each handshake step may take before the socket is replaced. */
const HANDSHAKE_TIMEOUT_MS = 5000;

export interface HostClientOptions {
  onVersionMismatch?: (hostVersion: string) => void;
  /**
   * The environment this connection is in (RP-13), delivered after the version
   * matches and **before** the connection opens, every time it opens. The app
   * scopes this device's storage to it here; a refusal stops the handshake.
   */
  onEnvironment?: (environment: EnvironmentDescriptor) => EnvironmentAcceptance;
  /**
   * The environment could not be established: no descriptor, one this view
   * cannot understand, or an app that refused it. One stable sentence — the
   * same reason repeats without saying it twice.
   */
  onEnvironmentFailure?: (reason: string) => void;
  url?: string;
  onNotification: NotificationHandler;
  /** Synchronous publication transaction; event handlers still run in order. */
  batchNotifications?: (deliver: () => void) => void;
  onConnection?: (state: ConnectionState) => void;
  /**
   * Result of a resume `session/load`. `replayFrom` is the earliest seq the
   * worker can actually replay; `sentFromSeq` is the watermark we asked from.
   * Anything other than equality means the transcript has to be re-read: below
   * is a restarted worker's fresh epoch, above is a replay buffer that no
   * longer reaches back to us. The caller must compare against `sentFromSeq`
   * and not against live state — the replayed notifications are flushed before
   * this response resolves, so live state has already moved on.
   */
  onResume?: (path: string, replayFrom: number, sentFromSeq: number) => void;
  /**
   * Asked before a resume. Returning false drops the path instead of re-opening
   * a Pi session the app no longer shows.
   */
  shouldResume?: (path: string) => boolean;
}

/** Backstop flush cadence when `requestAnimationFrame` is absent or paused. */
const FLUSH_INTERVAL_MS = 33;

export function defaultHostUrl(): string {
  const loc = globalThis.location;
  if (!loc || loc.protocol === "file:") return "ws://127.0.0.1:41441/ws";
  const proto = loc.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${loc.host}/ws`;
}

export class HostClient {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly attached = new Map<string, number>(); // session path → last seq seen
  private backoffMs = 500;
  private closedByUser = false;
  private listening = false;
  private state: ConnectionState = "closed";
  private versionBlocked = false;
  /** The last environment failure, kept so retries do not repeat themselves. */
  private environmentReason: string | undefined;
  /**
   * The handshake of **one** socket.
   *
   * Everything time-sensitive is bound to the socket generation it belongs to:
   * a reply or a timeout from a socket that has since been replaced has no
   * business closing the replacement, cancelling its deadline or opening a
   * connection on its behalf. `reconnect()` and `close()` retire this, so a
   * late arrival finds nothing to act on.
   */
  private handshake: { socket: WebSocket; timer?: ReturnType<typeof setTimeout>; acceptedVersion?: string } | undefined;
  private readonly handshakeMessages: JsonRpcMessage[] = [];
  private frameHandle: number | undefined;
  private timerHandle: ReturnType<typeof setTimeout> | undefined;
  /** Transcript deltas waiting for the next frame, in arrival (seq) order. */
  private readonly pendingUpdates: SessionUpdateParams[] = [];
  /** Extra notification listeners registered with `subscribe()`. */
  private readonly listeners = new Set<NotificationHandler>();

  constructor(private readonly options: HostClientOptions) {}

  /**
   * One handler, registered once and removed in `close()`. A per-`connect()`
   * closure would outlive the client and resurrect it on the next tab focus.
   */
  private readonly onVisible = (): void => {
    if (this.closedByUser || this.versionBlocked) return;
    if (document.visibilityState === "visible" && this.state !== "open") this.open();
  };

  connect(): void {
    this.closedByUser = false;
    this.open();
    if (typeof document !== "undefined" && !this.listening) {
      this.listening = true;
      document.addEventListener("visibilitychange", this.onVisible);
    }
  }

  /**
   * Replace the socket now, without waiting for the dead one to admit it.
   *
   * A phone that was locked comes back with a socket still in `OPEN` that will
   * never deliver anything; the guard in `pwa/reconnect.ts` detects that with a
   * probe and calls this. The old socket's handlers are detached first, so its
   * late `close` cannot reject the *new* socket's in-flight requests — they
   * share one `pending` map, and that was the bug this method exists to avoid.
   */
  reconnect(reason: string): void {
    if (this.versionBlocked) return;
    const dead = this.ws;
    this.ws = undefined;
    // The dead socket's handshake dies with it: its deadline must not close
    // the replacement, and its late answer must not open one.
    this.retireHandshake();
    if (dead) {
      dead.onopen = dead.onmessage = dead.onclose = dead.onerror = null;
      try {
        dead.close(4000, reason.slice(0, 120));
      } catch {
        /* already gone */
      }
    }
    this.flushUpdates();
    for (const p of this.pending.values()) p.reject(new Error(`reconnecting: ${reason}`));
    this.pending.clear();
    this.backoffMs = 500;
    this.setState("closed");
    if (!this.closedByUser) this.open();
  }

  close(): void {
    this.retireHandshake();
    this.closedByUser = true;
    if (this.listening) {
      this.listening = false;
      document.removeEventListener("visibilitychange", this.onVisible);
    }
    this.pendingUpdates.length = 0;
    this.flushUpdates(); // clears the scheduled frame; the buffer is already empty
    this.ws?.close();
  }

  get connection(): ConnectionState {
    return this.state;
  }

  /** Record that the app is following this session so reconnects resume it. */
  track(path: string, seq = 0): void {
    if (!this.attached.has(path) || (this.attached.get(path) ?? 0) < seq) this.attached.set(path, seq);
  }

  untrack(path: string): void {
    this.attached.delete(path);
  }

  /**
   * Forget every attachment and its resume watermark, now.
   *
   * Called synchronously while the environment changes, before the connection
   * opens: a session path from the environment this device was in a moment ago
   * must never be resumed in the one it is in now.
   */
  forgetAttachments(): void {
    this.attached.clear();
  }

  /** Adopt a worker's fresh `seq` epoch (see `HostClientOptions.onResume`). */
  resync(path: string, seq: number): void {
    if (this.attached.has(path)) this.attached.set(path, seq);
  }

  /**
   * Resolve once the socket is open, or reject after `timeoutMs` saying so.
   *
   * The page and the socket come up together, so the first thing a person
   * clicks can easily land in the gap. Rejecting instantly made that click do
   * nothing at all; waiting a moment makes it work, and the timeout keeps the
   * failure a sentence rather than a hang.
   */
  whenConnected(timeoutMs = 5000): Promise<void> {
    if (this.versionBlocked) return Promise.reject(new Error("Refresh this view to match the host before continuing."));
    if (this.environmentReason && this.state !== "open") return Promise.reject(new Error(this.environmentReason));
    if (this.state === "open") return Promise.resolve();
    if (this.closedByUser) return Promise.reject(new Error("Not connected to the host."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error("The desktop is not answering yet. It may still be starting."));
      }, timeoutMs);
      const poll = setInterval(() => {
        if (this.state !== "open") return;
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      }, 50);
    });
  }

  request<M extends ClientMethod>(method: M, params: ClientRequests[M]["params"]): Promise<ClientRequests[M]["result"]> {
    if (this.versionBlocked || this.state !== "open" || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Not connected to the host."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params, clientVersion: PRODUCT_VERSION }));
    });
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.options.onConnection?.(state);
  }

  private open(): void {
    if (this.closedByUser || this.versionBlocked) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.setState("connecting");
    this.handshakeMessages.length = 0;
    const ws = new WebSocket(this.options.url ?? defaultHostUrl());
    this.ws = ws;
    this.retireHandshake();
    const handshake: { socket: WebSocket; timer?: ReturnType<typeof setTimeout>; acceptedVersion?: string } = { socket: ws };
    this.handshake = handshake;
    ws.onopen = () => {
      if (this.handshake !== handshake) return;
      handshake.timer = setTimeout(() => this.timeOutHandshake(handshake), HANDSHAKE_TIMEOUT_MS);
      // The version frame carries the client version like every other request:
      // a host that has moved on answers the mismatch rather than the version.
      this.send(ws, { jsonrpc: "2.0", id: VERSION_ID, method: "pi/host/version", params: {}, clientVersion: PRODUCT_VERSION });
    };
    ws.onmessage = (event) => {
      // A frame from a socket this client has already replaced is not this
      // connection's business, and neither is one that is not JSON at all.
      if (this.ws !== ws) return;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(String(event.data)) as JsonRpcMessage;
      } catch {
        return;
      }
      this.onMessage(message, ws);
    };
    ws.onclose = () => {
      if (this.handshake?.socket === ws) this.retireHandshake();
      if (this.ws !== ws) return;
      this.flushUpdates();
      this.setState("closed");
      for (const p of this.pending.values()) p.reject(new Error("connection closed"));
      this.pending.clear();
      if (!this.closedByUser && !this.versionBlocked) {
        setTimeout(() => this.open(), this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 10_000);
      }
    };
    ws.onerror = () => ws.close();
  }

  /** Drop the current handshake and its deadline, whatever state it is in. */
  private retireHandshake(): void {
    if (this.handshake?.timer) clearTimeout(this.handshake.timer);
    this.handshake = undefined;
  }

  /** The handshake took too long. Replace that socket, and only that socket. */
  private timeOutHandshake(handshake: { socket: WebSocket }): void {
    if (this.handshake?.socket !== handshake.socket) return;
    this.retireHandshake();
    handshake.socket.close();
  }

  /** Send on one specific socket, never on whatever replaced it. */
  private send(socket: WebSocket, frame: unknown): void {
    if (this.ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(frame));
  }

  /**
   * Step one: the versions must be the same build, exactly.
   *
   * A match no longer opens the connection. It asks the host which environment
   * this is, because until that answer lands this view does not know what it
   * may keep on this device, and must therefore keep nothing.
   */
  private acceptVersion(version: unknown, socket: WebSocket): void {
    const handshake = this.handshake;
    if (!handshake || handshake.socket !== socket) return;
    if (handshake.timer) clearTimeout(handshake.timer);
    delete handshake.timer;
    const desktop = (globalThis as typeof globalThis & { desktop?: { version: string } }).desktop;
    if (version !== PRODUCT_VERSION || (desktop && desktop.version !== PRODUCT_VERSION)) {
      this.handshakeMessages.length = 0;
      this.versionBlocked = true;
      this.retireHandshake();
      this.options.onVersionMismatch?.(typeof version === "string" ? version : "unknown");
      socket.close();
      return;
    }
    handshake.acceptedVersion = version;
    handshake.timer = setTimeout(
      () => this.failEnvironment("The host did not describe this environment in time.", socket),
      HANDSHAKE_TIMEOUT_MS,
    );
    this.send(socket, { jsonrpc: "2.0", id: ENVIRONMENT_ID, method: ENVIRONMENT_DESCRIBE_METHOD, params: {}, clientVersion: PRODUCT_VERSION });
  }

  /**
   * Step two: the environment, validated against the protocol's own schema,
   * its contract generation, and the version this socket already accepted.
   *
   * Only after the app has scoped itself to it does the connection open — so
   * no queued notification, no resume and no request can precede it.
   */
  private acceptEnvironment(message: { result?: unknown; error?: { message?: string } }, socket: WebSocket): void {
    const handshake = this.handshake;
    if (!handshake || handshake.socket !== socket) return;
    if (handshake.timer) clearTimeout(handshake.timer);
    delete handshake.timer;
    if (message.error) {
      this.failEnvironment("This host cannot say what environment this is, so nothing is being kept on this device.", socket);
      return;
    }
    const parsed = environmentDescriptorSchema.safeParse((message.result as { environment?: unknown } | undefined)?.environment);
    if (!parsed.success || parsed.data.contract !== ENVIRONMENT_CONTRACT_VERSION || parsed.data.version !== handshake.acceptedVersion) {
      this.failEnvironment("This view does not understand how this host describes its environment. Refresh this view.", socket);
      return;
    }
    let acceptance: EnvironmentAcceptance;
    try {
      acceptance = this.options.onEnvironment?.(parsed.data as EnvironmentDescriptor) ?? { ok: true };
    } catch {
      // The app could not prepare this device and said so by throwing. That is
      // still a closed connection with a sentence, never an unhandled error
      // inside a socket callback.
      this.failEnvironment("This view could not prepare this device for this environment.", socket);
      return;
    }
    if (!acceptance.ok) {
      this.failEnvironment(acceptance.reason, socket);
      return;
    }
    this.retireHandshake();
    this.environmentReason = undefined;
    this.backoffMs = 500;
    this.setState("open");
    for (const message of this.handshakeMessages.splice(0)) this.onMessage(message, socket);
    for (const [path, seq] of [...this.attached]) {
      // A session the app has dropped must not be re-opened in a worker.
      if (this.options.shouldResume && !this.options.shouldResume(path)) {
        this.attached.delete(path);
        continue;
      }
      this.request("session/load", { path, fromSeq: seq })
        .then((result) => {
          this.options.onResume?.(path, result.replayFrom, seq);
        })
        .catch(() => {});
    }
  }

  /**
   * The environment is not established, so this connection stays shut.
   *
   * Deliberately *not* a version mismatch: the build is fine, the environment
   * is not. The socket closes and the ordinary backoff keeps trying, which is
   * visible in the connection line rather than a silent permanent stop — and
   * the reason is reported once per distinct sentence, so a retry loop cannot
   * become a stream of toasts.
   */
  private failEnvironment(reason: string, socket: WebSocket): void {
    if (this.handshake?.socket !== socket) return;
    this.retireHandshake();
    this.handshakeMessages.length = 0;
    const repeated = this.environmentReason === reason;
    this.environmentReason = reason;
    if (!repeated) {
      try {
        this.options.onEnvironmentFailure?.(reason);
      } catch {
        // The app's own handler is not allowed to take the socket with it.
      }
    }
    socket.close();
  }

  /**
   * Transcript deltas arrive one WebSocket message per token, each its own
   * macrotask, so React cannot batch them: one render + one forced reflow per
   * character. Buffer them and hand the whole burst over once per frame.
   * Everything else (dialogs, worker status, RPC replies) flushes the buffer
   * first and then passes straight through, so relative order never changes.
   */
  private queueUpdate(params: SessionUpdateParams): void {
    this.pendingUpdates.push(params);
    // A hidden tab never paints, so rAF alone would buffer forever: the timer
    // is the backstop, and whichever fires first cancels the other.
    if (this.frameHandle === undefined && typeof globalThis.requestAnimationFrame === "function") {
      this.frameHandle = globalThis.requestAnimationFrame(() => {
        this.frameHandle = undefined;
        this.flushUpdates();
      });
    }
    if (this.timerHandle === undefined) {
      this.timerHandle = setTimeout(() => {
        this.timerHandle = undefined;
        this.flushUpdates();
      }, FLUSH_INTERVAL_MS);
    }
  }

  private flushUpdates(): void {
    if (this.frameHandle !== undefined) {
      globalThis.cancelAnimationFrame?.(this.frameHandle);
      this.frameHandle = undefined;
    }
    if (this.timerHandle !== undefined) {
      clearTimeout(this.timerHandle);
      this.timerHandle = undefined;
    }
    if (this.pendingUpdates.length === 0) return;
    const batch = this.pendingUpdates.splice(0, this.pendingUpdates.length);
    const deliver = () => {
      for (const params of batch) this.deliver("session/update", params);
    };
    if (this.options.batchNotifications) this.options.batchNotifications(deliver);
    else deliver();
  }

  /**
   * Extra notification listeners, alongside `options.onNotification`.
   *
   * The provider owns the one handler that feeds the reducer; screens that
   * live outside app state — the logs page tailing `pi/logs/append`, the
   * packages screen following `pi/packages/progress` — subscribe here instead
   * of widening the reducer with rows nothing else reads. Returns an
   * unsubscribe function.
   */
  subscribe(handler: NotificationHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  private deliver<M extends HostNotificationMethod>(method: M, params: HostNotifications[M]): void {
    this.options.onNotification(method, params);
    // A throwing listener must not stop the others, or the app's own handler.
    for (const listener of this.listeners) {
      try {
        listener(method, params);
      } catch {
        /* a screen's listener is never allowed to break the socket */
      }
    }
  }

  private onMessage(message: JsonRpcMessage, socket: WebSocket): void {
    if ("id" in message && !("method" in message)) {
      if (message.id === VERSION_ID) {
        this.acceptVersion((message.result as { version?: string } | undefined)?.version, socket);
        return;
      }
      if (message.id === ENVIRONMENT_ID) {
        this.acceptEnvironment(message as { result?: unknown; error?: { message?: string } }, socket);
        return;
      }
      this.flushUpdates();
      const entry = this.pending.get(Number(message.id));
      if (!entry) return;
      this.pending.delete(Number(message.id));
      // Keep the code and structured data: a refused agent save carries
      // `data.issues` so the form can land each refusal on its field.
      if (message.error) entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code, data: message.error.data }));
      else entry.resolve(message.result);
      return;
    }
    if ("method" in message) {
      if (this.versionBlocked) return;
      if (this.state !== "open") {
        if (this.handshakeMessages.length < 1000) this.handshakeMessages.push(message);
        return;
      }
      const method = message.method as HostNotificationMethod;
      if (method === "session/update") {
        const params = message.params as SessionUpdateParams;
        if (this.attached.has(params.sessionPath)) this.attached.set(params.sessionPath, params.seq);
        this.queueUpdate(params);
        return;
      }
      this.flushUpdates();
      this.deliver(method, message.params as never);
    }
  }
}
