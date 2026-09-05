/**
 * HostClient — JSON-RPC over WebSocket to the piorbit host.
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
import type {
  ClientMethod,
  ClientRequests,
  HostNotificationMethod,
  HostNotifications,
  JsonRpcMessage,
  SessionUpdateParams,
} from "@piorbit/protocol";

export type NotificationHandler = <M extends HostNotificationMethod>(method: M, params: HostNotifications[M]) => void;

export type ConnectionState = "connecting" | "open" | "closed";

export interface HostClientOptions {
  url?: string;
  onNotification: NotificationHandler;
  onConnection?: (state: ConnectionState) => void;
  /**
   * Result of a resume `session/load`. `replayFrom` below the seq we hold means
   * the worker restarted its counter and the app must adopt the new epoch.
   */
  onResume?: (path: string, replayFrom: number) => void;
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
    if (this.closedByUser) return;
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

  close(): void {
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

  request<M extends ClientMethod>(method: M, params: ClientRequests[M]["params"]): Promise<ClientRequests[M]["result"]> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("not connected"));
    }
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.options.onConnection?.(state);
  }

  private open(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.setState("connecting");
    const ws = new WebSocket(this.options.url ?? defaultHostUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.backoffMs = 500;
      this.setState("open");
      for (const [path, seq] of [...this.attached]) {
        // A session the app has dropped must not be re-opened in a worker.
        if (this.options.shouldResume && !this.options.shouldResume(path)) {
          this.attached.delete(path);
          continue;
        }
        this.request("session/load", { path, fromSeq: seq })
          .then((result) => {
            this.options.onResume?.(path, result.replayFrom);
          })
          .catch(() => {});
      }
    };
    ws.onmessage = (event) => this.onMessage(JSON.parse(String(event.data)) as JsonRpcMessage);
    ws.onclose = () => {
      this.flushUpdates();
      this.setState("closed");
      for (const p of this.pending.values()) p.reject(new Error("connection closed"));
      this.pending.clear();
      if (!this.closedByUser) {
        setTimeout(() => this.open(), this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 10_000);
      }
    };
    ws.onerror = () => ws.close();
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
      this.flushUpdates();
      const entry = this.pending.get(Number(message.id));
      if (!entry) return;
      this.pending.delete(Number(message.id));
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
      return;
    }
    if ("method" in message) {
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
