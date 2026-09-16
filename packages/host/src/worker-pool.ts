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
 * client is attached to any of its sessions, none of them is running, and the
 * project has no live agent run (`hasLiveRun`, answered from the host's run
 * registry — see docs/agents.md). Nothing ends a run for taking too long, so a
 * project with an agent still working is never idle however long it takes.
 * That promise is not the sweep's alone: `stop()` and `restart()` refuse the
 * same work, so a `pi/worker/stop` or a Feature toggle (which restarts every
 * open project) cannot end a run either.
 *
 * Retiring a whole worker is the *last* thing that happens to it (RP-4). Long
 * before this sweep fires, `SessionLifetime` releases the individual runtimes
 * nobody is following, because coming back to one conversation costs a reload
 * while coming back to a retired worker costs every conversation in the project
 * a cold start. Both paths ask the worker the same question — `pi/worker/safety`
 * — so automatic retirement can never destroy what a release would refuse to
 * touch: an unanswered question, a message waiting in the tray, a command still
 * running.
 */
import type { ClientRequests, HostNotifications, JsonRpcNotification, SessionPin, SessionUnloadReason, WorkerInfo, WorkerRetireMode, WorkerStatus } from "@lasercode/protocol";
import { ErrorCodes, ProtocolError, environmentOverlay } from "@lasercode/protocol";
import { canonical } from "./trust.js";
import { SessionRouteLeases } from "./session-route-lease.js";
import { retirementRefused, retireWorker, type RetirementOutcome } from "./worker-retirement.js";
import { WorkerClient, nextWorkerGeneration, type WorkerClientOptions } from "./worker-client.js";

export interface WorkerPoolOptions {
  agentDir?: string;
  sessionDir?: string;
  /** Passed to every worker as `--state-dir` (see WorkerClientOptions). */
  stateDir?: string;
  /** Passed to every worker as `--environment-id`, so revisions agree (RP-9). */
  environmentId?: string;
  /**
   * Whether the log store keeps provider request bodies at all. `"summary"`
   * reaches the worker as `--provider-payloads summary`, so a capture is never
   * serialized or sent for a store that would discard it (RP-7).
   */
  providerPayloads?: "full" | "summary";
  workerMain?: string;
  nodeBinary?: string;
  /** Extra environment for every worker (the bundled package manager, M10-T5). */
  env?: Readonly<Record<string, string>>;
  /** Environment resolved at spawn time, so project feature overrides apply. */
  envForCwd?: (cwd: string) => Readonly<Record<string, string>>;
  /**
   * `source.generation` names the exact worker process the notification came
   * from, so a late message from a process that has been replaced cannot be
   * mistaken for its successor's (RP-7). Opaque and host-internal.
   */
  onNotification: (cwd: string, notification: JsonRpcNotification, source: { generation: string }) => void;
  /** That process is gone: nothing it started can still be completed. */
  onWorkerGone?: (source: { cwd: string; generation: string }) => void;
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
  /** Synchronous, nonprompting admission. Undefined refuses speculation. */
  prepareTrust?: (cwd: string) => { projectTrusted?: boolean } | undefined;
  /** Unused speculation expires independently of ordinary ten-minute idleness. */
  warmIdleMs?: number;
  /** Deferred user-facing background initialization, once speculation is used. */
  onPreparedUse?: (client: WorkerClient, cwd: string) => void;
  /** True while a connected client is following a session in this directory. */
  isAttached?: (cwd: string) => boolean;
  /** Pi session ids of the sessions this worker holds; for the subagents guard. */
  /** True while `cwd` has an agent run that has not ended; such a project is never idle. */
  hasLiveRun?: (cwd: string) => boolean;
  /**
   * Process inventory (RP-1). The pool is the only party that knows a worker's
   * pid at the moment it is spawned. Registering is bookkeeping only — no file
   * is read and nothing blocks — and the identity is proved later against a
   * collected process table. `noteWorker` hands back a generation that the
   * matching exit quotes, so a late exit from a dead worker cannot delete the
   * record of the worker that replaced it. Optional: a host without
   * diagnostics behaves exactly as before.
   */
  resources?: {
    noteWorker(cwd: string, pid: number | undefined): number | undefined;
    noteExit(pid: number | undefined, generation?: number): void;
  };
  /**
   * Runs after a worker reports `ready` and before `get()` resolves, so the
   * first request a worker answers already sees what the host knows (the
   * agent definitions, through `agents/sync`). A failure is reported through
   * `onStderr` and never fails the spawn: an older worker that does not know
   * the method is still a working worker.
   */
  prime?: (client: WorkerClient, cwd: string, speculative: boolean) => Promise<void>;
  /**
   * Work that must be finished before **any** worker process exists.
   *
   * Awaited inside `spawn`, not merely started beside it: the host's crash
   * cleanup of the command-log root is only safe while nothing is writing
   * there, and a cooperative cleanup that yields while a worker starts would
   * delete a directory that worker had just created (RP-6). Awaited on every
   * spawn, so a restart after a failure is gated too; its own result is
   * remembered by the caller, so this costs one await afterwards.
   */
  beforeSpawn?: () => Promise<unknown>;
  /**
   * How long a worker may take to answer the retirement question (RP-4) before
   * the host treats the silence as a refusal. A stop must not hang on a wedged
   * worker, and a worker that will not answer keeps running.
   */
  retireTimeoutMs?: number;
  /**
   * How long a silent worker keeps its admission closed after a timeout (RP-4):
   * the worker's own retirement lease, which the host waits out before writing
   * to it again. A test seam; the default matches the worker's.
   */
  retireLeaseMs?: number;
  /**
   * The host's per-session route leases (RP-4c). Shared with the router, so a
   * release and a path-routed request cannot straddle each other. Absent, the
   * pool owns a private one: correct on its own, but only the shared instance
   * makes routing and releasing one decision.
   */
  routeLeases?: SessionRouteLeases;
  /** Ordinary idle retirement. 0 disables it, but not unused warm expiry. */
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
  /** No session has claimed this process; invisible to lifecycle consumers. */
  warm: boolean;
  wantedAt: number;
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
  /** Session paths kept for re-opening after a crash. */
  open: Set<string>;
  /** Session paths confirmed open in the current worker process. */
  active: Set<string>;
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
  /** Set while a retirement decision is in flight (RP-4); `get()` waits on it. */
  retiring: Promise<void> | undefined;
  /** Sessions with a running agent, from the update stream. */
  running: Set<string>;
  /** Paths re-opened by the restart that is about to report `ready`. */
  reopened: string[] | undefined;
  /** Generation of this process's process-inventory record (RP-1), if any. */
  resourceRegistration?: number | undefined;
  /**
   * This spawn's memory-pressure generation (RP-8), minted before the process
   * exists so the worker can prove which spawn it is. Separate from
   * {@link Entry.resourceRegistration}, which is an RP-1 record's generation.
   */
  workerGeneration?: number | undefined;
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
  private readonly baseEnv: NodeJS.ProcessEnv = { ...process.env };
  private readonly entries = new Map<string, Entry>();
  private readonly sessionCwd = new Map<string, string>();
  /** When each open session last produced or received something (RP-4's LRU). */
  private readonly sessionActivity = new Map<string, number>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private preparing = false;
  /** RP-4c: the writer half of the route lease lives on `unloadSession`. */
  private readonly leases: SessionRouteLeases;

  constructor(private readonly options: WorkerPoolOptions) {
    this.leases = options.routeLeases ?? new SessionRouteLeases();
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const sweepMs = options.sweepMs ?? DEFAULTS.sweepMs;
    if (sweepMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
      this.sweepTimer.unref?.();
    }
  }

  /** Additive, memory-only. Includes starting workers: their pipe preserves order. */
  applyEnvironment(variables: Record<string, string>): number {
    const overlay = environmentOverlay(variables);
    Object.assign(this.baseEnv, overlay);
    // Deliberately not gated by retirement admission (RP-4): this is a
    // notification, not work, and the overlay is kept in `baseEnv`, so a worker
    // that is stopping either applies it harmlessly or is replaced by one that
    // is spawned with it. Nothing critical rides this path.
    for (const { client } of this.liveClients()) client.notify("pi/host/environment", { variables: overlay });
    return Object.keys(overlay).length;
  }

  /** User-requested directories with a live or starting worker. */
  cwds(): string[] {
    return [...this.entries.values()].filter((e) => !e.warm && (e.client?.alive || e.starting)).map((e) => e.cwd);
  }

  /** User-requested workers, live or not, for `pi/worker/list`. */
  workers(): WorkerInfo[] {
    return [...this.entries.values()].filter((entry) => !entry.warm).map((entry) => this.infoOf(entry));
  }

  /** Workers that are up right now. Never spawns; used for broadcasts. */
  liveClients(): Array<{ cwd: string; client: WorkerClient }> {
    const out: Array<{ cwd: string; client: WorkerClient }> = [];
    for (const entry of this.entries.values()) {
      if (entry.client?.alive) out.push({ cwd: entry.cwd, client: entry.client });
    }
    return out;
  }

  /**
   * Send one request to every ready worker. Never spawns, never throws: a
   * worker that refuses (an older one without the method) is reported in the
   * result and the others still hear it.
   */
  async broadcastRequest(method: string, params: unknown): Promise<Array<{ cwd: string; error?: string }>> {
    // A worker whose admission is closed for a retirement decision (RP-4) is
    // reported like any other refusal: the request was never written, and a
    // worker that is stopping has no state left for a broadcast to change.
    const targets = [...this.entries.values()].filter((entry) => entry.client?.alive && entry.status === "ready");
    return Promise.all(
      targets.map(async (entry) => {
        try {
          await entry.client!.request(method, params);
          return { cwd: entry.cwd };
        } catch (error) {
          return { cwd: entry.cwd, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
  }

  workerInfo(cwd: string): WorkerInfo | undefined {
    const entry = this.entries.get(canonical(cwd));
    return entry && !entry.warm ? this.infoOf(entry) : undefined;
  }

  /**
   * One unused warm worker at most, shared across all frontends. No queue of
   * speculative work: intent arriving during ANY spawn is dropped. A newer
   * intent replaces the least-recently-wanted (sole) idle speculative worker.
   */
  async prepare(cwd: string): Promise<void> {
    if (this.closed || this.preparing) return;
    this.preparing = true;
    try {
      const key = canonical(cwd);
      if (!this.options.prepareTrust?.(key)) return;
      const existing = this.entries.get(key);
      // Recovery and attached/session-owned entries are never speculation.
      if (existing && (!this.unused(existing) || existing.retryTimer || existing.status === "crashed")) return;
      if (existing?.warm) existing.wantedAt = this.now();
      if (existing?.client?.alive || existing?.starting || existing?.stopped) return;
      if ([...this.entries.values()].some((entry) => entry.starting)) return;
      const warm = [...this.entries.values()].filter((entry) => entry.warm && (entry.client || entry.starting || entry.stopped));
      for (const entry of warm.sort((a, b) => a.wantedAt - b.wantedAt)) {
        if (!this.unused(entry)) return;
        await this.retire(entry, "unused readiness replaced");
      }
      // A real open may have arrived while an eviction was finishing.
      if (this.closed || [...this.entries.values()].some((entry) => entry.starting)) return;
      const entry = this.ensure(key);
      if (entry.client?.alive || entry.stopped || !this.unused(entry) || entry.retryTimer || entry.status === "crashed") return;
      entry.warm = true;
      entry.wantedAt = this.now();
      const promise = this.spawn(entry);
      entry.starting = promise;
      try { await promise; }
      finally { if (entry.starting === promise) entry.starting = undefined; }
    } catch {
      // A hint never fails a user operation. get() can retry a failed spawn.
    } finally {
      this.preparing = false;
    }
  }

  /** Feature changes invalidate speculative startup configuration, never promote it. */
  async discardPrepared(): Promise<boolean> {
    let complete = true;
    for (const entry of this.entries.values()) {
      if (!entry.warm) continue;
      await entry.starting?.catch(() => {});
      // A real open may have adopted it meanwhile; the caller's normal worker
      // inventory owns that process now.
      if (!entry.warm) continue;
      if (!this.unused(entry)) { complete = false; continue; }
      try { await this.retire(entry, "readiness configuration changed"); }
      catch { complete = false; }
    }
    return complete;
  }

  private unused(entry: Entry): boolean {
    return entry.running.size === 0 && entry.open.size === 0
      && !(this.options.isAttached?.(entry.cwd) ?? false)
      && !(this.options.hasLiveRun?.(entry.cwd) ?? false);
  }

  /** Get the live worker for a cwd, spawning it if needed. Concurrent callers share one spawn. */
  async get(cwd: string): Promise<WorkerClient> {
    const key = canonical(cwd);
    let entry = this.ensure(key);
    // A retirement owns the directory until its child is actually gone. Deciding
    // anything before then is how two workers end up on one cwd.
    while (entry.stopped || entry.retiring) {
      await (entry.stopped ?? entry.retiring)?.catch(() => {});
      entry = this.ensure(key);
    }
    entry.lastActivity = this.now();
    // Readiness includes priming, not merely a live PID. A click racing a
    // failed hint retries through normal admission without exposing that failure.
    if (entry.starting) {
      const speculative = entry.warm;
      try {
        const client = await entry.starting;
        // Re-enter admission after the shared promise's owner clears it. This
        // also rechecks a trust decision changed while readiness was in flight.
        return entry.warm ? this.get(key) : client;
      } catch (error) {
        if (!speculative) throw error;
        if (entry.starting) await entry.starting.catch(() => {});
        return this.get(key);
      }
    }
    if (entry.warm) {
      if (entry.client?.alive && !this.options.prepareTrust?.(key)) {
        if (!this.unused(entry)) throw new ProtocolError(ErrorCodes.ProjectUntrusted, "Project trust changed. Finish its current work before reopening it.");
        await this.retire(entry, "readiness admission withdrawn");
        return this.get(key);
      }
      entry.warm = false;
      if (entry.client?.alive) {
        this.setStatus(entry, "ready");
        this.options.onPreparedUse?.(entry.client, key);
      }
    }
    if (entry.client?.alive) return entry.client;

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
    this.sessionActivity.set(path, this.now());
    const entry = this.entries.get(key);
    if (entry) {
      entry.open.add(path);
      entry.active.add(path);
      entry.lastActivity = this.now();
    }
  }

  /**
   * Every session a live, ready worker currently holds, with its directory
   * (RP-4). The session-lifetime policy walks this; it never spawns anything.
   */
  loadedSessions(): Array<{ cwd: string; path: string }> {
    const out: Array<{ cwd: string; path: string }> = [];
    for (const entry of this.entries.values()) {
      if (!entry.client?.alive || entry.status !== "ready") continue;
      for (const path of entry.active) out.push({ cwd: entry.cwd, path });
    }
    return out;
  }

  /** When this session last produced or received something; `undefined` if unknown. */
  lastSessionActivity(path: string): number | undefined {
    return this.sessionActivity.get(path);
  }

  /**
   * Ask a live worker to release one session's runtime (RP-4).
   *
   * The worker decides: it is the only party that can see a turn, a question, a
   * queued message, a run or a running command, and it answers with the pins
   * when it refuses. A release that succeeds is bookkeeping here too — nothing
   * routes to that session in this worker until it is loaded again — and a
   * refusal changes nothing at all.
   *
   * The whole of it runs under the session's route lease (RP-4c), bookkeeping
   * included: a path a routed request is holding is declined here, before any
   * worker is asked, and a routed request that arrives while this is in flight
   * waits for the outcome instead of writing to a worker that has already let
   * the runtime go. A decline is `{ unloaded: false, pins: [] }` — the shape the
   * sweep already reads as "left alone", with no backoff and no escalation.
   */
  async unloadSession(cwd: string, path: string, reason: SessionUnloadReason = "idle"): Promise<{ unloaded: boolean; pins: SessionPin[] }> {
    const answer = await this.leases.release(path, async () => {
      const key = canonical(cwd);
      const entry = this.entries.get(key);
      if (!entry?.client?.alive || entry.status !== "ready" || entry.stopping || entry.stopped) return { unloaded: false, pins: [] as SessionPin[] };
      const reply = await entry.client.request<ClientRequests["pi/session/unload"]["result"]>("pi/session/unload", { path, reason });
      // A worker that does not answer in this shape did not release anything: an
      // older generation replies to an unknown method rather than refusing it,
      // and forgetting the session on that would lose the route to a live runtime.
      if (typeof reply?.unloaded !== "boolean") return { unloaded: false, pins: [] as SessionPin[] };
      if (reply.unloaded) this.forgetSession(path);
      return { unloaded: reply.unloaded, pins: Array.isArray(reply.pins) ? reply.pins : [] };
    });
    return answer ?? { unloaded: false, pins: [] };
  }

  /** The route leases this pool releases under (RP-4c); shared with the router. */
  get routeLeases(): SessionRouteLeases {
    return this.leases;
  }

  cwdOfSession(path: string): string | undefined {
    return this.sessionCwd.get(path);
  }

  /** Session paths currently open in a live, ready worker. */
  openSessions(cwd: string): string[] {
    const entry = this.entries.get(canonical(cwd));
    if (!entry?.client?.alive || entry.status !== "ready") return [];
    return [...entry.active];
  }

  /**
   * The ready worker that already owns this session, or nothing. Never spawns
   * and never starts a session: a read that must not cost a process start asks
   * this first (RP-9).
   */
  ownerOfSession(path: string): WorkerClient | undefined {
    const cwd = this.sessionCwd.get(path);
    const entry = cwd === undefined ? undefined : this.entries.get(cwd);
    if (!entry?.client?.alive || entry.status !== "ready" || !entry.active.has(path)) return undefined;
    return entry.client;
  }

  /**
   * The worker let go of a session (`pi/session/close`) and its file is about
   * to move: nothing here may reopen it after a restart or route to it again.
   */
  forgetSession(path: string): void {
    const cwd = this.sessionCwd.get(path);
    this.sessionCwd.delete(path);
    this.sessionActivity.delete(path);
    const entry = cwd !== undefined ? this.entries.get(cwd) : undefined;
    if (!entry) return;
    entry.open.delete(path);
    entry.active.delete(path);
    entry.running.delete(path);
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
    // Asked before anything is touched: a refused restart must leave the worker
    // exactly as it was, counters included.
    await this.assertNotBusy(key, entry);
    entry.restarts = 0;
    this.clearRetry(entry);
    // Retiring clears the open set, so remember it first: "Retry" is meant to
    // bring the sessions back, not just the process.
    const paths = [...entry.open];
    if (entry.client?.alive || entry.stopped) {
      // The same atomic transition an explicit stop takes: a Feature toggle
      // restarting every project may not end a conversation's work either.
      const outcome = await this.askToRetire(entry, "explicit", "restarting");
      if (!outcome.retired) throw retirementRefused(key, outcome.reason);
    }
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

  /**
   * Retire a worker on purpose. Refused while it is running a session, has a
   * live agent run, or says one of its conversations is holding work (RP-4).
   */
  async stop(cwd: string, message = "stopped"): Promise<void> {
    const key = canonical(cwd);
    const entry = this.entries.get(key);
    if (!entry) return;
    await this.assertNotBusy(key, entry);
    const outcome = await this.askToRetire(entry, "explicit", message);
    if (!outcome.retired) throw retirementRefused(key, outcome.reason);
  }

  /**
   * Ask a worker to retire itself, and end it only if it agreed (RP-4).
   *
   * The pool's part is the bookkeeping around the transition: hold the
   * directory for the whole decision (so a concurrent `get()` waits rather than
   * spawning a second worker), and let the worker own the decision itself.
   */
  private async askToRetire(entry: Entry, mode: WorkerRetireMode, message: string): Promise<RetirementOutcome> {
    const client = entry.client;
    // Nothing live to ask: a crashed, never-started or already-retiring worker
    // has no runtime state to lose, and an explicit retry must still replace it.
    if (!client?.alive || entry.status !== "ready" || entry.stopping || entry.stopped) {
      await this.retire(entry, message);
      return { retired: true };
    }
    if (entry.retiring) {
      await entry.retiring.catch(() => {});
      return { retired: !entry.client?.alive, reason: "a stop was already in flight" };
    }
    const decision = retireWorker(
      {
        cwd: entry.cwd,
        client,
        stop: () => this.retire(entry, message),
        ...(this.options.retireTimeoutMs !== undefined ? { timeoutMs: this.options.retireTimeoutMs } : {}),
        ...(this.options.retireLeaseMs !== undefined ? { leaseMs: this.options.retireLeaseMs } : {}),
      },
      mode,
    );
    entry.retiring = decision.then(() => undefined, () => undefined);
    try {
      return await decision;
    } finally {
      entry.retiring = undefined;
    }
  }

  /**
   * A fork moved a session's file (RP-4). The runtime is the same one; only its
   * key changed, so this worker's bookkeeping moves with it rather than keeping
   * a row for a path nobody serves — a phantom row would make every later
   * safety answer disagree with this pool and freeze the whole lifetime.
   */
  rekeySession(oldPath: string, newPath: string, cwd: string): void {
    const key = canonical(cwd);
    if (oldPath === newPath) {
      this.bindSession(newPath, key);
      return;
    }
    const owner = this.sessionCwd.get(oldPath);
    // Only the worker that actually held the source path may move it.
    if (owner !== undefined && owner !== key) return;
    const entry = this.entries.get(key);
    const activity = this.sessionActivity.get(oldPath);
    this.sessionCwd.delete(oldPath);
    this.sessionActivity.delete(oldPath);
    if (entry) {
      const wasRunning = entry.running.delete(oldPath);
      entry.open.delete(oldPath);
      entry.active.delete(oldPath);
      if (wasRunning) entry.running.add(newPath);
    }
    // A collision means the destination is already known — the fork landed on
    // a path this worker serves. One row wins, and it is the new one.
    this.bindSession(newPath, key);
    if (activity !== undefined) this.sessionActivity.set(newPath, activity);
  }

  /**
   * A worker with work of its own is never stopped on purpose either. The
   * sweep already honours `hasLiveRun`, and an explicit stop must too: a child
   * waiting on a question, queued behind its parent, or simply between turns
   * has an empty `running` set, and retiring its worker kills the run. That is
   * the same promise as the idle sweep's — `feature/set` restarts every open
   * project, and toggling a Feature may not end a live agent run (D-144).
   */
  private async assertNotBusy(key: string, entry: Entry): Promise<void> {
    if (entry.running.size > 0) {
      throw new ProtocolError(
        ErrorCodes.SessionBusy,
        `the worker for ${key} is running an agent; cancel the session before stopping it`,
      );
    }
    if (this.options.hasLiveRun?.(entry.cwd) ?? false) {
      throw new ProtocolError(
        ErrorCodes.SessionBusy,
        `the worker for ${key} has an agent run that has not ended; stop that agent before stopping it`,
      );
    }
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
      warm: false,
      wantedAt: this.now(),
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
      active: new Set(),
      stopping: false,
      stopped: undefined,
      retireReason: undefined,
      running: new Set(),
      retiring: undefined,
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

    // Nothing may start until the host's own before-workers work has settled.
    // A failure there is not a reason to refuse a worker: the cleanup reports
    // itself and the machine carries on.
    if (this.options.beforeSpawn) await this.options.beforeSpawn().catch(() => undefined);
    if (this.closed) throw new ProtocolError(ErrorCodes.DriverUnavailable, "the host is shutting down");
    if (entry.stopped) throw retiringError(entry.cwd);

    this.setStatus(entry, "starting", entry.restarts > 0 ? `restarting (attempt ${entry.restarts})` : "starting the agent");

    let projectTrusted: boolean | undefined;
    if (entry.warm) {
      // Never call the prompting resolver for speculation. Re-check immediately
      // before spawn, after any asynchronous eviction, to avoid stale trust.
      const admission = this.options.prepareTrust?.(entry.cwd);
      if (!admission) throw new Error("readiness admission withdrawn");
      projectTrusted = admission.projectTrusted;
    } else if (this.options.resolveTrust) {
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

    // Minted before the process exists, so the worker knows which spawn it is
    // from its first line of code (RP-8). A host that has run out of distinct
    // generations mints none, and that worker takes no part in pressure.
    const generation = nextWorkerGeneration();
    const clientOptions: WorkerClientOptions = {
      cwd: entry.cwd,
      baseEnv: this.baseEnv,
      ...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
      ...(this.options.sessionDir ? { sessionDir: this.options.sessionDir } : {}),
      ...(this.options.stateDir ? { stateDir: this.options.stateDir } : {}),
      ...(this.options.environmentId ? { environmentId: this.options.environmentId } : {}),
      ...(this.options.providerPayloads ? { providerPayloads: this.options.providerPayloads } : {}),
      ...(this.options.workerMain ? { workerMain: this.options.workerMain } : {}),
      ...(this.options.nodeBinary ? { nodeBinary: this.options.nodeBinary } : {}),
      ...((this.options.env || this.options.envForCwd)
        ? { env: { ...(this.options.env ?? {}), ...(this.options.envForCwd?.(entry.cwd) ?? {}) } }
        : {}),
      ...(projectTrusted !== undefined ? { projectTrusted } : {}),
      onNotification: (n) => this.onWorkerNotification(entry, client, n),
      onExit: (code, signal) => this.onExit(entry, client, code, signal),
      ...(this.options.onStderr ? { onStderr: (t: string) => { if (!entry.warm) this.options.onStderr?.(entry.cwd, t); } } : {}),
    };
    const client = new WorkerClient({ ...clientOptions, ...(generation !== undefined ? { workerGeneration: generation } : {}) });
    entry.workerGeneration = client.workerGeneration;
    entry.resourceRegistration = this.options.resources?.noteWorker(entry.cwd, client.pid);
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
        // A process that never started leaves no identity behind either (RP-8).
        entry.workerGeneration = undefined;
        const message = error instanceof Error ? error.message : String(error);
        this.setStatus(entry, "crashed", `Worker could not start: ${message}. Use "Retry" once the cause is fixed.`);
      }
      throw error;
    }
    // `ready` resolves on the worker's own `pi/worker/status: ready`, which the
    // handler below has already turned into an enriched notification.
    if (this.options.prime && entry.client === client && client.alive) {
      try {
        await this.options.prime(client, entry.cwd, entry.warm);
      } catch (error) {
        if (!entry.warm) this.options.onStderr?.(entry.cwd, `priming failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    return client;
  }

  /**
   * The worker sends its own `ready`/`retired`; re-send them enriched (pid,
   * restarts) so a client sees one shape for every lifecycle event, and keep
   * the pool's bookkeeping in step with the update stream.
   */
  private onWorkerNotification(entry: Entry, client: WorkerClient, notification: JsonRpcNotification): void {
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
        entry.active.add(path);
        this.sessionCwd.set(path, entry.cwd);
        this.sessionActivity.set(path, this.now());
        if (kind === "agent_start") entry.running.add(path);
        if (kind === "agent_end" || kind === "agent_settled") entry.running.delete(path);
      }
    }
    if (!entry.warm) this.options.onNotification(entry.cwd, notification, { generation: client.generation });
  }

  private onExit(entry: Entry, client: WorkerClient, code: number | null, signal: NodeJS.Signals | null): void {
    // Even a superseded process's exit ends what that process started.
    this.options.onWorkerGone?.({ cwd: entry.cwd, generation: client.generation });
    if (entry.client !== client) return; // a superseded process; ignore
    entry.client = undefined;
    this.options.resources?.noteExit(client.pid, entry.resourceRegistration);
    entry.resourceRegistration = undefined;
    // The generation belonged to the process that has gone (RP-8). Keeping it
    // here would leave an identity behind with nothing to answer for it; the
    // next spawn mints a strictly newer one.
    entry.workerGeneration = undefined;
    entry.running.clear();
    entry.active.clear();
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
      await client.request("session/load", { path }).then(
        () => this.bindSession(path, entry.cwd),
        () => entry.open.delete(path),
      );
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
    entry.active.clear();
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
    const now = this.now();
    const candidates = [...this.entries.values()].filter(
      (entry) =>
        entry.client?.alive &&
        (entry.warm || idleMs > 0) &&
        entry.status === "ready" &&
        entry.running.size === 0 &&
        now - (entry.warm ? entry.wantedAt : entry.lastActivity) >= (entry.warm ? (this.options.warmIdleMs ?? 60_000) : idleMs) &&
        !(this.options.isAttached?.(entry.cwd) ?? false),
    );
    if (candidates.length === 0) return;
    // A project with an agent still working is never idle, however long that
    // agent takes: nothing limits a run's length (D-144), and retiring the
    // worker would kill the child mid-sentence. The answer is per candidate —
    // a run in project A is no reason to keep B and C alive.
    for (const entry of candidates) {
      if (this.options.hasLiveRun?.(entry.cwd) ?? false) continue;
      void this.retireIfSafe(entry).catch(() => {});
    }
  }

  /**
   * Retire an idle worker, but only after asking it what its sessions are
   * holding (RP-4).
   *
   * Automatic retirement and automatic session unload apply the *same* answer,
   * so the coarser bookkeeping here can no longer destroy what an unload would
   * refuse to touch: a question nobody answered, a message in the tray, a
   * command still running. A worker that cannot answer keeps the behaviour it
   * always had, which is the same conservative set of guards that got it this
   * far — `running`, `hasLiveRun` and attachment.
   */
  private async retireIfSafe(entry: Entry): Promise<void> {
    // The worker decides, atomically: it closes its own admission, drains what
    // it had accepted and re-checks its conversations under that fence, so
    // nothing can be accepted between the decision and the process ending. A
    // refusal — including one this host could not understand — leaves the
    // worker exactly as it was.
    const outcome = await this.askToRetire(entry, "automatic", "retired after being idle");
    if (!outcome.retired) {
      this.options.onStderr?.(entry.cwd, `session lifetime: not retiring this worker — ${outcome.reason}\n`);
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
    if (entry.warm) return;
    const info = this.infoOf(entry, reopened);
    const params: HostNotifications["pi/worker/status"] = info;
    // A lifecycle notification is the pool's own, not a worker process's: it
    // carries the generation of the client it describes when there is one.
    this.options.onNotification(entry.cwd, { jsonrpc: "2.0", method: "pi/worker/status", params }, {
      generation: entry.client?.generation ?? "",
    });
    this.options.onStatus?.(info);
  }
}

function retiringError(cwd: string): ProtocolError {
  return new ProtocolError(
    ErrorCodes.DriverUnavailable,
    `the worker for ${cwd} is still shutting down; try that again in a moment`,
  );
}
