/**
 * The CLI's client for the host — the same WebSocket JSON-RPC the app speaks,
 * with none of the app's resume machinery: a CLI process is short-lived, so a
 * dropped socket is an error to report, not a state to recover from.
 */
import { WebSocket } from "ws";
import {
  ErrorCodes,
  type ClientMethod,
  type ClientRequests,
  type HostNotificationMethod,
  type HostNotifications,
  type JsonRpcMessage,
} from "@piorbit/protocol";
import { CliError, ExitCode } from "./errors.js";

export class HostRpcError extends Error {
  override readonly name = "HostRpcError";
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }

  /** The host does not know this method (or refuses it). */
  get isUnsupported(): boolean {
    return this.code === ErrorCodes.MethodNotFound || this.code === ErrorCodes.Unsupported;
  }
}

export type NotificationHandler = <M extends HostNotificationMethod>(method: M, params: HostNotifications[M]) => void;

export interface HostRpcOptions {
  url: string;
  /** How long to wait for the socket to open. */
  connectTimeoutMs?: number;
  onNotification?: NotificationHandler;
  /** Called when the socket closes without `close()` having been asked for. */
  onDropped?: (reason: string) => void;
}

export class HostRpc {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private closing = false;

  private constructor(
    socket: WebSocket,
    private readonly options: HostRpcOptions,
  ) {
    this.socket = socket;
    this.socket.on("message", (data) => this.onMessage(String(data)));
    this.socket.on("close", (code, reason) => this.onClose(`${code}${reason.length > 0 ? ` ${reason}` : ""}`));
    this.socket.on("error", (error) => this.onClose(error.message));
  }

  static async connect(options: HostRpcOptions): Promise<HostRpc> {
    const socket = new WebSocket(options.url);
    const timeoutMs = options.connectTimeoutMs ?? 5000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(
          new CliError(`timed out connecting to the piorbit host at ${options.url}`, {
            exitCode: ExitCode.NoHost,
            fix: "Check that it is running with `piorbit status`, or start it with `piorbit up`.",
          }),
        );
      }, timeoutMs);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          new CliError(`cannot reach the piorbit host at ${options.url}: ${error.message}`, {
            exitCode: ExitCode.NoHost,
            fix:
              error.code === "ECONNREFUSED"
                ? "Start it with `piorbit up`."
                : "Run `piorbit status` to see what the host is doing.",
          }),
        );
      });
    });
    return new HostRpc(socket, options);
  }

  request<M extends ClientMethod>(method: M, params: ClientRequests[M]["params"]): Promise<ClientRequests[M]["result"]> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new CliError("the connection to the piorbit host closed before the request was sent", {
          exitCode: ExitCode.NoHost,
          fix: "Run `piorbit status`; if the host died, `piorbit up` starts a new one.",
        }),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  close(): void {
    this.closing = true;
    for (const entry of this.pending.values()) {
      entry.reject(new CliError("the piorbit host connection was closed", { exitCode: ExitCode.NoHost }));
    }
    this.pending.clear();
    this.socket.close();
  }

  /**
   * Reject everything in flight with `error` and hang up.
   *
   * For the case where the host is waiting on an answer this client cannot
   * give. The host holds a worker start behind a question and keeps holding
   * it; without this the request simply never returns, which in a terminal is
   * indistinguishable from a hang.
   */
  failPending(error: Error): void {
    this.closing = true;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.socket.close();
  }

  private onMessage(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // The host never sends non-JSON; ignoring beats crashing a pipe.
    }
    if ("id" in message && !("method" in message)) {
      const entry = this.pending.get(Number(message.id));
      if (!entry) return;
      this.pending.delete(Number(message.id));
      if (message.error) entry.reject(new HostRpcError(message.error.code, message.error.message, message.error.data));
      else entry.resolve(message.result);
      return;
    }
    if ("method" in message && !("id" in message)) {
      const handler = this.options.onNotification;
      if (handler) handler(message.method as HostNotificationMethod, message.params as never);
    }
  }

  private onClose(reason: string): void {
    const error = new CliError(`the piorbit host connection closed (${reason})`, {
      exitCode: ExitCode.NoHost,
      fix: "Run `piorbit status`. The host log is at <agent-dir>/piorbit/host.log.",
    });
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    if (!this.closing) this.options.onDropped?.(reason);
  }
}

/** Turn a JSON-RPC error from the host into something with a fix line. */
export function describeRpcError(error: unknown, what: string): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof HostRpcError) {
    if (error.code === ErrorCodes.SessionNotFound) {
      return new CliError(`${what}: ${error.message}`, {
        exitCode: ExitCode.HostError,
        fix: "Run `piorbit sessions` to see the sessions the host knows about, and pass one of those paths or ids.",
      });
    }
    if (error.isUnsupported) {
      return new CliError(`${what}: ${error.message}`, {
        exitCode: ExitCode.HostError,
        fix: "This host build does not implement that call yet. Rebuild with `pnpm -r build` and restart it with `piorbit restart`.",
      });
    }
    return new CliError(`${what}: ${error.message}`, { exitCode: ExitCode.HostError });
  }
  return new CliError(`${what}: ${error instanceof Error ? error.message : String(error)}`, {
    exitCode: ExitCode.HostError,
  });
}
