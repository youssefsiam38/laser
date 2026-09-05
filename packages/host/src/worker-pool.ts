/**
 * WorkerPool (M0-T6, M2-T1) — one worker process per project directory, never
 * two (AGENTS.md invariant 5), with a lifecycle a person can see and act on.
 *
 * States, all reported as `pi/worker/status`:
 *   starting  a spawn is in flight (emitted by the pool, before the process is
 *             even up: a slow first Pi load is the most common "is it broken?"
 *             moment, and silence there is the worst answer)
 *   ready     the worker answered on fd 3
 *   crashed   it exited without being asked to. If sessions were open, the pool
 *             restarts it with exponential backoff up to `maxRestarts`, then
 *             stops and waits for `pi/worker/restart`
 *   retired   it was stopped on purpose: idle, or asked to stop
 *
 * Retirement is deliberately conservative. A worker is only retired when no
 * client is attached to any of its sessions, none of them is running, and no
 * pi-subagents background run refers to them (checked through the run's own
 * `status.json` and the recorded runner pid, never through `lastUpdate` — see
 * docs/research/findings.md on the session-reaping hazard).
 */
import type { HostNotifications, JsonRpcNotification, WorkerInfo, WorkerStatus } from "@lasercode/protocol";
import { ErrorCodes, ProtocolError } from "@lasercode/protocol";
import { activeRuns, type ActiveRun } from "./subagents/file-layer.js";
import { canonical } from "./trust.js";
import { WorkerClient, type WorkerClientOptions } from "./worker-client.js";

export interface WorkerPoolOptions {
  agentDir?: string;
  sessionDir?: string;
  subagentsTempRoot?: string;
  workerMain?: string;
  nodeBinary?: string;
  /** Extra environment for every worker (the bundled package manager, M10-T5). */
  env?: Readonly<Record<string, string>>;
  onNotification: (cwd: string, notification: JsonRpcNotification) => void;
  onStderr?: (cwd: string, text: string) => void;
  /** Called for every lifecycle change, after the notification is sent. */
  onStatus?: (info: WorkerInfo) => void;
  /**
   * Trust gate (M2-T4). Resolves to the `projectTrusted` flag the worker runs
   * with, prompting a client when nobody has decided. `undefined` means laser
   * has no opinion (nothing in the directory is trust-gated) and the worker
   * keeps Pi's own default. Rejecting refuses the spawn with the reason.
   */
  resolveTrust?: (cwd: string) => Promise<boolean | undefined>;
  /** True while a connected client is following a session in this directory. */
  isAttached?: (cwd: string) => boolean;
  /** Pi session ids of the sessions this worker holds; for the subagents guard. */
  sessionIds?: (cwd: string) => Set<string>;
  /** Idle time before a retirement is considered. 0 disables retirement. */
  idleMs?: number;
  /** How often idleness is checked. */
  sweepMs?: number;
  maxRestarts?: number;
  /**
   * Uptime after which a worker counts as healthy again, so its crash counter
   * resets. Without it a worker that dies every ten seconds restarts forever;
   * with it, a crash loop hits the cap and stops asking.
   */
  healthyMs?: number;
  /** First backoff step; doubles per attempt up to `backoffCapMs`. */
  backoffMs?: number;
  backoffCapMs?: number;
  now?: () => number;
  /** Injectable for tests, so a backoff does not mean a real wait. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

interface Entry {
  cwd: string;
  client: WorkerClient | undefined;
  starting: Promise<WorkerClient> | undefined;
  status: WorkerStatus;
  message: string | undefined;
  since: number;
  lastActivity: number;
  restarts: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  retryAt: number | undefined;
  /** When the current (or last) process reached `ready`. */
  readyAt: number | undefined;
  /** Session paths opened in this worker, for re-opening after a restart. */
  open: Set<string>;
  /** True while `stop()`/retirement is driving the exit, so it is not a crash. */
  stopping: boolean;
  /**
   * Set for the whole of a retirement, from the decision to stop until the
   * child has actually gone. `get()` awaits it before deciding anything: the
   * old code released `entry.client` first and a concurrent request then
   * spawned a second process for the same directory (AGENTS.md invariant 5),
   * which also re-opened session files the dying worker was still flushing
   * (invariant 8).
   */
  stopped: Promise<void> | undefined;
  /** Why the current retirement was asked for, so `onExit` reports that reason. */
  retireReason: string | undefined;
  /** Sessions with a running agent, from the update stream. */
  running: Set<string>;
  /** Paths re-opened by the restart that is about to report `ready`. */
  reopened: string[] | undefined;
}

const DEFAULTS = {
  idleMs: 10 * 60_000,
  sweepMs: 30_000,
  maxRestarts: 5,
  healthyMs: 60_000,
  backoffMs: 1_000,
  backoffCapMs: 30_000,
};

export class WorkerPool {
  private readonly entries = new Map<string, Entry>();
  private readonly sessionCwd = new Map<string, string>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(private readonly options: WorkerPoolOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const sweepMs = options.sweepMs ?? DEFAULTS.sweepMs;
    if ((options.idleMs ?? DEFAULTS.idleMs) > 0 && sweepMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
      this.sweepTimer.unref?.();
    }
  }

  /** Directories with a live or starting worker. */
  cwds(): string[] {
    return [...this.entries.values()].filter((e) => e.client?.alive || e.starting).map((e) => e.cwd);
  }

  /** Everything the pool knows, live or not, for `pi/worker/list`. */
  workers(): WorkerInfo[] {
    return [...this.entries.values()].map((entry) => this.infoOf(entry));
  }

  /** Workers that are up right now. Never spawns; used for broadcasts. */
  liveClients(): Array<{ cwd: string; client: WorkerClient }> {
    const out: Array<{ cwd: string; client: WorkerClient }> = [];
    for (const entry of this.entries.values()) {
      if (entry.client?.alive) out.push({ cwd: entry.cwd, client: entry.client });
    }
    return out;
  }

  workerInfo(cwd: string): WorkerInfo | undefined {
    const entry = this.entries.get(canonical(cwd));
    return entry ? this.infoOf(entry) : undefined;
  }

  /** Get the live worker for a cwd, spawning it if needed. Concurrent callers share one spawn. */
  async get(cwd: string): Promise<WorkerClient> {
    const key = canonical(cwd);
    let entry = this.ensure(key);
    // A retirement owns the directory until its child is actually gone. Deciding
    // anything before then is how two workers end up on one cwd.
    while (entry.stopped) {
      await entry.stopped.catch(() => {});
      entry = this.ensure(key);
    }
    entry.lastActivity = this.now();
    if (entry.client?.alive) return entry.client;
    if (entry.starting) return entry.starting;

    // An explicit request cancels a pending backoff: the user is asking now.
    this.clearRetry(entry);
    const promise = this.spawn(entry);
    entry.starting = promise;
    try {
      return await promise;
    } finally {
      if (entry.starting === promise) entry.starting = undefined;
    }
  }

  /** Remember which cwd owns a session path so later requests route without a lookup. */
  bindSession(path: string, cwd: string): void {
    const key = canonical(cwd);
    this.sessionCwd.set(path, key);
    const entry = this.entries.get(key);
    if (entry) {
      entry.open.add(path);
      entry.lastActivity = this.now();
    }
  }

  cwdOfSession(path: string): string | undefined {
    return this.sessionCwd.get(path);
  }

  /** Session paths currently open in a worker. */
  openSessions(cwd: string): string[] {
    return [...(this.entries.get(canonical(cwd))?.open ?? [])];
  }

  /** Note that something happened for this worker, so it is not idle. */
  noteActivity(cwd: string): void {
    const entry = this.entries.get(canonical(cwd));
    if (entry) entry.lastActivity = this.now();
  }

  /** Track running agents so a busy worker is never retired. */
  noteRunning(cwd: string, path: string, running: boolean): void {
    const entry = this.entries.get(canonical(cwd));
    if (!entry) return;
    entry.lastActivity = this.now();
    if (running) entry.running.add(path);
    else entry.running.delete(path);
  }

  /** Start (or restart) a worker on purpose: the retry affordance. */
  async restart(cwd: string): Promise<WorkerInfo> {
    const key = canonical(cwd);
    const entry = this.ensure(key);
    entry.restarts = 0;
    this.clearRetry(entry);
    // Retiring clears the open set, so remember it first: "Retry" is meant to
    // bring the sessions back, not just the process.
    const paths = [...entry.open];
    if (entry.client?.alive || entry.stopped) await this.stop(key, "restarting");
    entry.reopened = paths;
    const client = await this.get(key);
    for (const path of paths) {
      // Same as after a crash: the worker's `seq` restarts at 1 and clients
      // resync through `session/load`'s `replayFrom`.
      await client.request("session/load", { path }).then(
        () => this.bindSession(path, key),
        () => {},
      );
    }
    return this.infoOf(entry);
  }

  /** Retire a worker. Refused while one of its sessions is running. */
  async stop(cwd: string, message = "stopped"): Promise<void> {
    const key = canonical(cwd);
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.running.size > 0) {
      throw new ProtocolError(
        ErrorCodes.SessionBusy,
        `the worker for ${key} is running an agent; cancel the session before stopping it`,
      );
    }
    await this.retire(entry, message);
  }

  async stopAll(): Promise<void> {
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    const entries = [...this.entries.values()];
    for (const entry of entries) {
      entry.stopping = true;
      this.clearRetry(entry);
    }
    await Promise.all(entries.map((entry) => entry.client?.stop()));
    this.entries.clear();
    this.sessionCwd.clear();
  }

  // ------------------------------------------------------------- internals

  private ensure(cwd: string): Entry {
    const existing = this.entries.get(cwd);
    if (existing) return existing;
    const entry: Entry = {
      cwd,
      client: undefined,
      starting: undefined,
      status: "retired",
      message: undefined,
      since: this.now(),
      lastActivity: this.now(),
      restarts: 0,
      retryTimer: undefined,
      retryAt: undefined,
      readyAt: undefined,
      open: new Set(),
      stopping: false,
      stopped: undefined,
      retireReason: undefined,
      running: new Set(),
      reopened: undefined,
    };
    this.entries.set(cwd, entry);
    return entry;
  }

  private async spawn(entry: Entry): Promise<WorkerClient> {
    // The invariant, enforced rather than assumed: one process per directory.
    if (entry.client?.alive) {
      throw new ProtocolError(ErrorCodes.Internal, `a worker for ${entry.cwd} is already running (pid ${entry.client.pid})`);
    }
    if (this.closed) throw new ProtocolError(ErrorCodes.DriverUnavailable, "the host is shutting down");
    if (entry.stopped) throw retiringError(entry.cwd);

    this.setStatus(entry, "starting", entry.restarts > 0 ? `restarting (attempt ${entry.restarts})` : "starting the agent");

    let projectTrusted: boolean | undefined;
    if (this.options.resolveTrust) {
      try {
        const decision = this.options.resolveTrust(entry.cwd);
        // A decision that is already made settles within a tick. One that does
        // not is a question on someone's screen, and the chip should say so
        // rather than claim Pi is starting.
        let settled = false;
        void decision.then(
          () => (settled = true),
          () => (settled = true),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!settled) this.setStatus(entry, "starting", "waiting for your decision about this project");
        projectTrusted = await decision;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.setStatus(entry, "crashed", message);
        throw error;
      }
      if (this.closed) throw new ProtocolError(ErrorCodes.DriverUnavailable, "the host is shutting down");
      // A `pi/worker/stop` can land while the trust question is on screen.
      if (entry.stopped) throw retiringError(entry.cwd);
      if (entry.client?.alive) return entry.client;
    }

    const clientOptions: WorkerClientOptions = {
      cwd: entry.cwd,
      ...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
      ...(this.options.sessionDir ? { sessionDir: this.options.sessionDir } : {}),
      ...(this.options.subagentsTempRoot ? { subagentsTempRoot: this.options.subagentsTempRoot } : {}),
      ...(this.options.workerMain ? { workerMain: this.options.workerMain } : {}),
      ...(this.options.nodeBinary ? { nodeBinary: this.options.nodeBinary } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
      ...(projectTrusted !== undefined ? { projectTrusted } : {}),
      onNotification: (n) => this.onWorkerNotification(entry, n),
      onExit: (code, signal) => this.onExit(entry, client, code, signal),
      ...(this.options.onStderr ? { onStderr: (t: string) => this.options.onStderr?.(entry.cwd, t) } : {}),
    };
    const client = new WorkerClient(clientOptions);
    entry.client = client;
    entry.stopping = false;
    entry.lastActivity = this.now();
    try {
      await client.ready;
    } catch (error) {
      // A process that never started (a bad bundled Node, a missing worker
      // entry) reports `error` and no `exit`. Without this the chip sat on
      // "starting" forever with no Retry, which is the one failure that most
      // needs one.
      if (entry.client === client) {
        entry.client = undefined;
        const message = error instanceof Error ? error.message : String(error);
        this.setStatus(entry, "crashed", `Worker could not start: ${message}. Use "Retry" once the cause is fixed.`);
      }
      throw error;
    }
    // `ready` resolves on the worker's own `pi/worker/status: ready`, which the
    // handler below has already turned into an enriched notification.
    return client;
  }

  /**
   * The worker sends its own `ready`/`retired`; re-send them enriched (pid,
   * restarts) so a client sees one shape for every lifecycle event, and keep
   * the pool's bookkeeping in step with the update stream.
   */
  private onWorkerNotification(entry: Entry, notification: JsonRpcNotification): void {
    entry.lastActivity = this.now();
    if (notification.method === "pi/worker/status") {
      const status = (notification.params as { status?: WorkerStatus } | null)?.status;
      if (status === "ready") {
        const reopened = entry.reopened;
        entry.reopened = undefined;
        entry.readyAt = this.now();
        this.setStatus(entry, "ready", undefined, reopened);
        return;
      }
      if (status === "retired") {
        entry.stopping = true;
        this.setStatus(entry, "retired", "worker exited");
        return;
      }
    }
    if (notification.method === "session/update") {
      const params = notification.params as { sessionPath?: string; update?: { kind?: string } } | null;
      const path = params?.sessionPath;
      const kind = params?.update?.kind;
      if (path) {
        entry.open.add(path);
        this.sessionCwd.set(path, entry.cwd);
        if (kind === "agent_start") entry.running.add(path);
        if (kind === "agent_end" || kind === "agent_settled") entry.running.delete(path);
      }
    }
    this.options.onNotification(entry.cwd, notification);
  }

  private onExit(entry: Entry, client: WorkerClient, code: number | null, signal: NodeJS.Signals | null): void {
    if (entry.client !== client) return; // a superseded process; ignore
    entry.client = undefined;
    entry.running.clear();
    if (entry.stopping || this.closed) {
      if (entry.status !== "retired") this.setStatus(entry, "retired", entry.retireReason ?? "worker exited");
      return;
    }
    // The process never existed: retrying on a timer cannot help (a bad node
    // binary or worker path does not fix itself), so say what happened and
    // offer the explicit Retry instead of a silent "starting" forever.
    if (client.spawnError) {
      entry.readyAt = undefined;
      this.setStatus(
        entry,
        "crashed",
        `Worker could not start: ${client.spawnError.message}. Fix that, then use "Retry".`,
      );
      return;
    }
    // A worker that ran healthily for a while and then died is a fresh
    // incident, not the continuation of a crash loop.
    const uptime = entry.readyAt === undefined ? 0 : this.now() - entry.readyAt;
    if (uptime >= (this.options.healthyMs ?? DEFAULTS.healthyMs)) entry.restarts = 0;
    entry.readyAt = undefined;
    const reason = signal ? `killed by ${signal}` : `exited with code ${code ?? "unknown"}`;
    const canRetry = entry.open.size > 0 && entry.restarts < (this.options.maxRestarts ?? DEFAULTS.maxRestarts);
    if (!canRetry) {
      this.setStatus(
        entry,
        "crashed",
        entry.open.size === 0
          ? `Worker ${reason}. It will start again on the next request.`
          : `Worker ${reason} and did not recover after ${entry.restarts} restarts. Use "Retry" to start it again.`,
      );
      return;
    }
    const attempt = entry.restarts + 1;
    const delay = Math.min(
      (this.options.backoffMs ?? DEFAULTS.backoffMs) * 2 ** entry.restarts,
      this.options.backoffCapMs ?? DEFAULTS.backoffCapMs,
    );
    entry.restarts = attempt;
    entry.retryAt = this.now() + delay;
    this.setStatus(entry, "crashed", `Worker ${reason}. Restarting in ${Math.round(delay / 1000)}s (attempt ${attempt}).`);
    entry.retryTimer = this.setTimer(() => {
      entry.retryTimer = undefined;
      entry.retryAt = undefined;
      void this.reopen(entry);
    }, delay);
    entry.retryTimer.unref?.();
  }

  /** Bring a crashed worker back and re-open the sessions it was holding. */
  private async reopen(entry: Entry): Promise<void> {
    if (this.closed || entry.client?.alive) return;
    const paths = [...entry.open];
    entry.reopened = paths;
    let client: WorkerClient;
    try {
      client = await this.get(entry.cwd);
    } catch {
      return; // `onExit`/`spawn` already reported why
    }
    for (const path of paths) {
      // The worker restarts its `seq` counter at 1; clients notice through
      // `session/load`'s `replayFrom` and resync (see the UI's `onResume`).
      await client.request("session/load", { path }).catch(() => entry.open.delete(path));
    }
  }

  /**
   * Stop a worker and keep the directory reserved until its child has actually
   * exited. `entry.client` is released by `onExit` (or here, if the child had
   * to be killed), never before the process is gone: releasing it early let a
   * concurrent `get()` spawn a second worker on the same session files.
   */
  private async retire(entry: Entry, message: string): Promise<void> {
    const inFlight = entry.stopped;
    if (inFlight) {
      await inFlight.catch(() => {});
      return;
    }
    entry.stopping = true;
    entry.retireReason = message;
    this.clearRetry(entry);
    entry.running.clear();
    // A retired worker holds nothing open. `Router.sessions()` uses exactly this
    // to drop the stub for a session Pi never wrote.
    entry.open.clear();
    const client = entry.client;
    if (!client) {
      entry.retireReason = undefined;
      if (entry.status !== "retired") this.setStatus(entry, "retired", message);
      return;
    }
    const done = client.stop();
    entry.stopped = done;
    try {
      await done;
    } finally {
      if (entry.stopped === done) entry.stopped = undefined;
      entry.retireReason = undefined;
    }
    if (entry.client === client) entry.client = undefined;
    // `onExit` normally publishes this first, with the same reason.
    if (entry.status !== "retired") this.setStatus(entry, "retired", message);
  }

  /** Retire workers nobody is using. Never throws; it runs on a timer. */
  private sweep(): void {
    const idleMs = this.options.idleMs ?? DEFAULTS.idleMs;
    if (idleMs <= 0) return;
    const now = this.now();
    const candidates = [...this.entries.values()].filter(
      (entry) =>
        entry.client?.alive &&
        entry.status === "ready" &&
        entry.running.size === 0 &&
        now - entry.lastActivity >= idleMs &&
        !(this.options.isAttached?.(entry.cwd) ?? false),
    );
    if (candidates.length === 0) return;
    // One filesystem pass for all candidates (`activeRuns` reads every root),
    // but the answer stays per candidate: a background run in project A is no
    // reason to keep idle workers for B and C alive.
    let runs: ActiveRun[];
    try {
      runs = activeRuns();
    } catch {
      return; // unreadable temp roots: assume work is in flight, retire nothing
    }
    for (const entry of candidates) {
      const ids = this.options.sessionIds?.(entry.cwd) ?? new Set<string>();
      const busy = runs.some(
        (run) => (run.sessionId !== undefined && ids.has(run.sessionId)) || run.cwd === entry.cwd,
      );
      if (busy) continue;
      void this.retire(entry, "retired after being idle").catch(() => {});
    }
  }

  private clearRetry(entry: Entry): void {
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
    entry.retryAt = undefined;
  }

  private infoOf(entry: Entry, reopened?: readonly string[]): WorkerInfo {
    return {
      cwd: entry.cwd,
      status: entry.status,
      ...(entry.message !== undefined ? { message: entry.message } : {}),
      ...(entry.client?.pid !== undefined ? { pid: entry.client.pid } : {}),
      restarts: entry.restarts,
      since: new Date(entry.since).toISOString(),
      ...(entry.retryAt !== undefined ? { retryAt: new Date(entry.retryAt).toISOString() } : {}),
      canRestart: entry.status === "crashed" || entry.status === "retired",
      ...(reopened && reopened.length > 0 ? { reopened: [...reopened] } : {}),
    };
  }

  private setStatus(entry: Entry, status: WorkerStatus, message?: string, reopened?: readonly string[]): void {
    entry.status = status;
    entry.message = message;
    entry.since = this.now();
    const info = this.infoOf(entry, reopened);
    const params: HostNotifications["pi/worker/status"] = info;
    this.options.onNotification(entry.cwd, { jsonrpc: "2.0", method: "pi/worker/status", params });
    this.options.onStatus?.(info);
  }
}

function retiringError(cwd: string): ProtocolError {
  return new ProtocolError(
    ErrorCodes.DriverUnavailable,
    `the worker for ${cwd} is still shutting down; try that again in a moment`,
  );
}
