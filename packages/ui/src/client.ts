/**
 * HostClient — JSON-RPC over WebSocket to the piorbit host.
 *
 * Reconnects with backoff and, on reconnect, re-issues `session/load` with
 * the last seen `seq` for every session the app is attached to, so a dropped
 * socket (laptop sleep, phone lock, host restart) loses no output. Also
 * reconnects proactively on `visibilitychange` because iOS closes sockets on
 * lock without always firing `close` (docs/research/findings.md).
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
}

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
  private state: ConnectionState = "closed";

  constructor(private readonly options: HostClientOptions) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && this.state !== "open") this.open();
      });
    }
  }

  close(): void {
    this.closedByUser = true;
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
      for (const [path, seq] of this.attached) {
        this.request("session/load", { path, fromSeq: seq }).catch(() => {});
      }
    };
    ws.onmessage = (event) => this.onMessage(JSON.parse(String(event.data)) as JsonRpcMessage);
    ws.onclose = () => {
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

  private onMessage(message: JsonRpcMessage): void {
    if ("id" in message && !("method" in message)) {
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
      }
      this.options.onNotification(method, message.params as never);
    }
  }
}
