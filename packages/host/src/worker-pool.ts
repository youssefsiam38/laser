/**
 * WorkerPool — one WorkerClient per project directory, never two (AGENTS.md
 * invariant 5). Spawns lazily, tracks which session paths live in which cwd,
 * and reports crashes as `pi/worker/status` notifications.
 */
import { resolve as resolvePath } from "node:path";
import type { HostNotifications, JsonRpcNotification } from "@piorbit/protocol";
import { WorkerClient, type WorkerClientOptions } from "./worker-client.js";

export interface WorkerPoolOptions {
  agentDir?: string;
  sessionDir?: string;
  subagentsTempRoot?: string;
  workerMain?: string;
  nodeBinary?: string;
  onNotification: (cwd: string, notification: JsonRpcNotification) => void;
  onStderr?: (cwd: string, text: string) => void;
}

export class WorkerPool {
  private readonly workers = new Map<string, WorkerClient>();
  private readonly starting = new Map<string, Promise<WorkerClient>>();
  private readonly sessionCwd = new Map<string, string>();

  constructor(private readonly options: WorkerPoolOptions) {}

  cwds(): string[] {
    return [...this.workers.keys()];
  }

  /** Get the live worker for a cwd, spawning it if needed. Concurrent callers share one spawn. */
  async get(cwd: string): Promise<WorkerClient> {
    const key = resolvePath(cwd);
    const live = this.workers.get(key);
    if (live?.alive) return live;
    const inflight = this.starting.get(key);
    if (inflight) return inflight;

    const promise = this.spawn(key);
    this.starting.set(key, promise);
    try {
      return await promise;
    } finally {
      this.starting.delete(key);
    }
  }

  /** Remember which cwd owns a session path so later requests route without a lookup. */
  bindSession(path: string, cwd: string): void {
    this.sessionCwd.set(path, resolvePath(cwd));
  }

  cwdOfSession(path: string): string | undefined {
    return this.sessionCwd.get(path);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.workers.values()].map((w) => w.stop()));
    this.workers.clear();
    this.sessionCwd.clear();
  }

  private async spawn(cwd: string): Promise<WorkerClient> {
    const clientOptions: WorkerClientOptions = {
      cwd,
      ...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
      ...(this.options.sessionDir ? { sessionDir: this.options.sessionDir } : {}),
      ...(this.options.subagentsTempRoot ? { subagentsTempRoot: this.options.subagentsTempRoot } : {}),
      ...(this.options.workerMain ? { workerMain: this.options.workerMain } : {}),
      ...(this.options.nodeBinary ? { nodeBinary: this.options.nodeBinary } : {}),
      onNotification: (n) => this.options.onNotification(cwd, n),
      onExit: (code, signal) => {
        if (this.workers.get(cwd) === client) this.workers.delete(cwd);
        for (const [path, owner] of this.sessionCwd) if (owner === cwd) this.sessionCwd.delete(path);
        const params: HostNotifications["pi/worker/status"] = {
          cwd,
          status: "crashed",
          message: `exit ${code ?? signal}`,
        };
        this.options.onNotification(cwd, { jsonrpc: "2.0", method: "pi/worker/status", params });
      },
      ...(this.options.onStderr ? { onStderr: (t: string) => this.options.onStderr?.(cwd, t) } : {}),
    };
    const client = new WorkerClient(clientOptions);
    this.workers.set(cwd, client);
    await client.ready;
    return client;
  }
}
