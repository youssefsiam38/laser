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
import { PRODUCT_VERSION } from "@lasercode/protocol";
import type {
  ClientMethod,
  ClientRequests,
  HostNotificationMethod,
  HostNotifications,
  JsonRpcMessage,
  SessionUpdateParams,
} from "@lasercode/protocol";

export type NotificationHandler = <M extends HostNotificationMethod>(method: M, params: HostNotifications[M]) => void;

export type ConnectionState = "connecting" | "open" | "closed";

export interface HostClientOptions {
  onVersionMismatch?: (hostVersion: string) => void;
  url?: string;
  onNotification: NotificationHandler;
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
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
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
    clearTimeout(this.handshakeTimer);
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
    ws.onopen = () => {
      this.handshakeTimer = setTimeout(() => ws.close(), 5000);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "pi/host/version", params: {} }));
    };
    ws.onmessage = (event) => this.onMessage(JSON.parse(String(event.data)) as JsonRpcMessage);
    ws.onclose = () => {
      clearTimeout(this.handshakeTimer);
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

  private acceptVersion(version: unknown): void {
      clearTimeout(this.handshakeTimer);
      const desktop = (globalThis as typeof globalThis & { desktop?: { version: string } }).desktop;
      if (version !== PRODUCT_VERSION || (desktop && desktop.version !== PRODUCT_VERSION)) {
        this.handshakeMessages.length = 0;
        this.versionBlocked = true;
        this.options.onVersionMismatch?.(typeof version === "string" ? version : "unknown");
        this.ws?.close();
        return;
      }
      this.backoffMs = 500;
      this.setState("open");
      for (const message of this.handshakeMessages.splice(0)) this.onMessage(message);
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
    for (const params of batch) this.deliver("session/update", params);
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

  private onMessage(message: JsonRpcMessage): void {
    if ("id" in message && !("method" in message)) {
      if (message.id === 0) {
        this.acceptVersion((message.result as { version?: string } | undefined)?.version);
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
