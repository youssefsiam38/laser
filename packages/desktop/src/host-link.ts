/**
 * The shell's own connection to the host.
 *
 * The renderer has one too, and that is on purpose: the tray, the dock badge
 * and notifications have to be right when every window is closed, and on macOS
 * the app is expected to keep running with no window at all. Sharing the
 * renderer's socket would mean the tray goes blank the moment someone closes
 * the last window.
 *
 * It is a read-only listener — it lists sessions and projects and follows
 * attention. It never prompts, never cancels, never writes. Anything that
 * changes state goes through the UI, where a person can see what they did.
 *
 * Unlike the CLI's `HostRpc`, this one reconnects: the host restarts (a crash,
 * an update, `laser restart`) and the tray has to come back on its own.
 */
import { WebSocket } from "ws";
import type { HostNotificationMethod, HostNotifications, JsonRpcMessage, ProjectInfo, SessionSummary } from "@lasercode/protocol";
import type { AttentionChange, FleetSnapshot } from "./fleet.js";
import { FleetModel } from "./fleet.js";
import type { DesktopLog } from "./log.js";

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;
/** Coalesce bursts of attention events into one re-list. */
const REFRESH_DEBOUNCE_MS = 400;
const REQUEST_TIMEOUT_MS = 10_000;

export interface HostLinkOptions {
  log: DesktopLog;
  onSnapshot: (snapshot: FleetSnapshot) => void;
  onAttention: (change: AttentionChange) => void;
  onSeen?: (path: string) => void;
  onSessions?: (sessions: readonly SessionSummary[]) => void;
}

export class HostLink {
  private readonly model = new FleetModel();
  private socket: WebSocket | undefined;
  private url: string | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private reconnectTimer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private backoff = RECONNECT_MIN_MS;
  private closed = false;

  constructor(private readonly options: HostLinkOptions) {}

  snapshot(): FleetSnapshot {
    return this.model.snapshot();
  }

  /** Point at a host. Safe to call repeatedly; a new URL reconnects. */
  connect(url: string): void {
    if (this.url === url && this.socket) return;
    this.url = url;
    this.backoff = RECONNECT_MIN_MS;
    // A retry may already be pending from the socket that just went away.
    // Without this, a host that comes back gets two connections.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.dropSocket();
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.dropSocket();
  }

  private open(): void {
    const url = this.url;
    if (!url || this.closed) return;
    // No Origin header: the host's allowlist exists to keep *browsers* out, and
    // a Node client that sends none is the CLI's case too.
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.on("open", () => {
      this.backoff = RECONNECT_MIN_MS;
      this.model.setConnected(true);
      void this.refresh();
    });
    socket.on("message", (data) => this.onMessage(String(data)));
    socket.on("error", () => {
      // `close` always follows; reporting both would double every log line.
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.failPending(new Error("the host connection closed"));
      this.model.setConnected(false);
      this.options.onSnapshot(this.model.snapshot());
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, delay);
  }

  private dropSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.failPending(new Error("the host connection was replaced"));
    if (!socket) return;
    socket.removeAllListeners();
    socket.terminate();
  }

  private failPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("not connected to the host"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** Re-read the whole picture. Cheap: it is a catalog the host already holds. */
  private async refresh(): Promise<void> {
    try {
      const [projects, sessions] = await Promise.all([
        this.request<{ projects: ProjectInfo[] }>("pi/project/list", {}),
        this.request<{ sessions: SessionSummary[] }>("pi/session/list", {}),
      ]);
      this.model.setProjects(projects.projects);
      this.options.onSessions?.(sessions.sessions);
      const changes = this.model.setSessions(sessions.sessions);
      for (const change of changes) this.options.onAttention(change);
      this.options.onSnapshot(this.model.snapshot());
    } catch (error) {
      // A refresh that loses a race with a reconnect is normal; only say
      // something when we are still connected and it still failed.
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.options.log.error("could not read the session list from the host", error);
      }
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  private onMessage(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // The host never sends non-JSON; ignoring beats crashing the tray.
    }
    if ("id" in message && !("method" in message)) {
      const entry = this.pending.get(Number(message.id));
      if (!entry) return;
      this.pending.delete(Number(message.id));
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
      return;
    }
    if (!("method" in message) || "id" in message) return;
    this.onNotification(message.method as HostNotificationMethod, message.params);
  }

  private onNotification(method: HostNotificationMethod, params: unknown): void {
    switch (method) {
      case "pi/session/seen": {
        const event = params as HostNotifications["pi/session/seen"];
        this.options.onSeen?.(event.path);
        return;
      }
      case "pi/session/attention": {
        const event = params as HostNotifications["pi/session/attention"];
        const change = this.model.applyAttention(event);
        if (change) this.options.onAttention(change);
        this.options.onSnapshot(this.model.snapshot());
        // The event carries no session name, so a session we are meeting for
        // the first time needs one listing before the tray can label it.
        if (change?.initial) this.scheduleRefresh();
        return;
      }
      case "pi/project/updated": {
        const event = params as HostNotifications["pi/project/updated"];
        this.model.setProjects(event.projects);
        this.options.onSnapshot(this.model.snapshot());
        this.scheduleRefresh();
        return;
      }
      default:
        // `session/update` is deliberately ignored. It fires on every token of
        // every turn, and nothing the tray shows changes with it: a session
        // that starts working, finishes, or blocks on a person announces that
        // through `pi/session/attention`.
        return;
    }
  }
}
