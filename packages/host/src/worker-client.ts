/**
 * WorkerClient — spawns one `piorbit-worker` for one cwd and speaks JSON-RPC
 * to it over the fd-3 pipe. Correlates requests by id, forwards notifications,
 * and reports exit. The host never imports Pi; it only resolves the worker's
 * entry file path.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import {
  ErrorCodes,
  LineDecoder,
  isNotification,
  isResponse,
  type JsonRpcError,
  type JsonRpcMessage,
  type JsonRpcNotification,
} from "@piorbit/protocol";

export interface WorkerClientOptions {
  cwd: string;
  agentDir?: string;
  sessionDir?: string;
  subagentsTempRoot?: string;
  /**
   * Whether Pi may load this project's own `.pi` resources (M2-T4). The host
   * decides (see projects.ts / trust.ts) and passes the answer down as
   * `--project-trusted yes|no`; omitting it leaves the worker on Pi's own
   * default, which is "trusted".
   */
  projectTrusted?: boolean;
  /** Path to the worker entry; defaults to the workspace `@piorbit/worker` build. */
  workerMain?: string;
  /** Node binary to run the worker with; defaults to the current one. */
  nodeBinary?: string;
  /** Extra environment for the worker, on top of the host's own. */
  env?: Readonly<Record<string, string>>;
  onNotification: (notification: JsonRpcNotification) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onStderr?: (text: string) => void;
}

export class WorkerRpcError extends Error {
  override readonly name = "WorkerRpcError";
  constructor(public readonly rpc: JsonRpcError) {
    super(rpc.message);
  }
}

export function defaultWorkerMain(): string {
  return createRequire(import.meta.url).resolve("@piorbit/worker/main");
}

export class WorkerClient {
  private readonly child: ChildProcess;
  private readonly pipe: Duplex;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private exited = false;
  /** Set once, so a spawn `error` followed by an `exit` reports one incident. */
  private reported = false;
  /**
   * The spawn itself failed (bad node binary, missing worker entry, EACCES).
   * Node emits `error` and never `exit` for these, so the pool needs to be able
   * to tell "never started" from "exited", and to say which in the UI.
   */
  private startError: Error | undefined;
  readonly ready: Promise<void>;

  constructor(private readonly options: WorkerClientOptions) {
    const args = [options.workerMain ?? defaultWorkerMain(), "--cwd", options.cwd];
    if (options.agentDir) args.push("--agent-dir", options.agentDir);
    if (options.sessionDir) args.push("--session-dir", options.sessionDir);
    if (options.subagentsTempRoot) args.push("--subagents-temp-root", options.subagentsTempRoot);
    if (options.projectTrusted !== undefined) args.push("--project-trusted", options.projectTrusted ? "yes" : "no");

    this.child = spawn(options.nodeBinary ?? process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env, PIORBIT_WORKER_FD: "3" },
    });
    this.pipe = this.child.stdio[3] as Duplex;

    let resolveReady!: () => void;
    let rejectReady!: (e: Error) => void;
    this.ready = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });

    const decoder = new LineDecoder();
    this.pipe.setEncoding("utf8");
    this.pipe.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line) as JsonRpcMessage;
        } catch {
          continue;
        }
        if (isResponse(message)) {
          const entry = this.pending.get(Number(message.id));
          if (!entry) continue;
          this.pending.delete(Number(message.id));
          if (message.error) entry.reject(new WorkerRpcError(message.error));
          else entry.resolve(message.result);
        } else if (isNotification(message)) {
          if (message.method === "pi/worker/status" && (message.params as { status?: string }).status === "ready") {
            resolveReady();
          }
          options.onNotification(message);
        }
      }
    });
    this.child.stderr?.on("data", (c: Buffer) => options.onStderr?.(c.toString()));
    this.child.stdout?.on("data", () => {}); // drain; Pi/extension logs are not ours
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.settle(new Error(`worker for ${options.cwd} exited (${code ?? signal})`), rejectReady, code, signal);
    });
    this.child.on("error", (error) => {
      // No `exit` follows a failed spawn, so this is the only chance to unblock
      // `ready`, fail the pending calls, and tell the pool the worker is gone.
      this.exited = true;
      this.startError ??= error;
      this.settle(error, rejectReady, null, null);
    });
  }

  /** Fail everything in flight and report the exit, exactly once. */
  private settle(
    error: Error,
    rejectReady: (e: Error) => void,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.reported) return;
    this.reported = true;
    rejectReady(error);
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.options.onExit(code, signal);
  }

  /** Non-undefined when the child process could not be started at all. */
  get spawnError(): Error | undefined {
    return this.startError;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get alive(): boolean {
    return !this.exited;
  }

  request<R = unknown>(method: string, params: unknown): Promise<R> {
    if (this.exited) return Promise.reject(new WorkerRpcError({ code: ErrorCodes.DriverUnavailable, message: "worker exited" }));
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.pipe.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** Close the pipe (worker retires itself) and wait for exit. */
  async stop(graceMs = 5000): Promise<void> {
    if (this.exited) return;
    this.pipe.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, graceMs);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
