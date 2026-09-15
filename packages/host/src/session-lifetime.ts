/**
 * Bounded worker session lifetime (RP-4): the policy that decides *when* a
 * runtime nobody is following should be released.
 *
 * Three parties, three jobs, and none of them does another's:
 *
 * - **membership** (RP-6, `SessionMembershipView`) is the one authority on who
 *   is following what. This reads `holders(path)` and never writes it.
 * - **the worker** is the one authority on whether a release is safe: it sees
 *   the turn, the question, the queued message, the run and the command, and
 *   it answers `pi/session/unload` with the pins when it refuses.
 * - **this file** only chooses candidates and a moment: a session nobody holds
 *   that has been quiet for longer than the threshold, or one pushed out of a
 *   worker's loaded set by a newer conversation.
 *
 * It is deliberately earlier than worker retirement. Releasing one dormant
 * conversation costs a person nothing — coming back re-opens it from the
 * canonical record — while retiring the whole worker costs every session in
 * that project a cold start. So the session threshold is a fraction of the
 * worker's, and the constructor refuses a configuration where it is not: a
 * lifetime whose sweep fires after retirement has already happened would be a
 * policy that never runs, which is worse than one that is switched off.
 */
import type { SessionPin } from "@lasercode/protocol";

export interface SessionLifetimeDeps {
  /** Connections and scopes following this session right now (RP-6). Read-only. */
  holders(path: string): number;
  /** Every session a live, ready worker holds, with its project directory. */
  loadedSessions(): Array<{ cwd: string; path: string }>;
  /** When that session last produced or received something. */
  lastActivity(path: string): number | undefined;
  /** Ask the owning worker to release it; the worker decides and says why not. */
  unload(cwd: string, path: string, reason: "idle" | "budget"): Promise<{ unloaded: boolean; pins: SessionPin[] }>;
  log?: (line: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (timer: ReturnType<typeof setInterval>) => void;
}

export interface SessionLifetimeOptions {
  /** The worker idle-retirement threshold this must stay ahead of. 0 disables retirement. */
  workerIdleMs?: number;
  /** Quiet time before a session nobody follows is released. Derived when absent. */
  sessionIdleMs?: number;
  /** How often candidates are considered. Derived when absent. */
  sweepMs?: number;
  /** Loaded sessions one worker keeps; over this, the least recent go early. */
  maxLoadedPerWorker?: number;
  /** Releases attempted per sweep, so one tick can never be unbounded work. */
  maxUnloadsPerTick?: number;
}

/** The worker's own default idle retirement, mirrored so the derivation has a base. */
const DEFAULT_WORKER_IDLE_MS = 10 * 60_000;
/** Longest a dormant runtime is kept when the worker's own threshold is far away. */
const SESSION_IDLE_CEILING_MS = 2 * 60_000;
const SWEEP_CEILING_MS = 30_000;
const SWEEP_FLOOR_MS = 10;
const DEFAULT_MAX_LOADED_PER_WORKER = 8;
const DEFAULT_MAX_UNLOADS_PER_TICK = 8;

export interface SessionLifetimeCounters {
  sweeps: number;
  considered: number;
  unloaded: number;
  refused: number;
  /** Refusals by the pin that caused them, so a policy that never fires is explainable. */
  pins: Record<string, number>;
}

export class SessionLifetime {
  readonly sessionIdleMs: number;
  readonly sweepMs: number;
  readonly maxLoadedPerWorker: number;
  private readonly maxUnloadsPerTick: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private sweeping: Promise<void> | undefined;
  private stopped = false;
  private readonly counters: SessionLifetimeCounters = { sweeps: 0, considered: 0, unloaded: 0, refused: 0, pins: {} };

  constructor(private readonly deps: SessionLifetimeDeps, options: SessionLifetimeOptions = {}) {
    this.now = deps.now ?? Date.now;
    const workerIdleMs = options.workerIdleMs ?? DEFAULT_WORKER_IDLE_MS;
    this.sessionIdleMs = options.sessionIdleMs ?? derivedSessionIdle(workerIdleMs);
    this.sweepMs = options.sweepMs ?? clamp(Math.round(this.sessionIdleMs / 3), SWEEP_FLOOR_MS, SWEEP_CEILING_MS);
    this.maxLoadedPerWorker = options.maxLoadedPerWorker ?? DEFAULT_MAX_LOADED_PER_WORKER;
    this.maxUnloadsPerTick = options.maxUnloadsPerTick ?? DEFAULT_MAX_UNLOADS_PER_TICK;
    // Retirement disabled (0) means there is nothing to stay ahead of.
    if (workerIdleMs > 0 && this.sessionIdleMs + 2 * this.sweepMs >= workerIdleMs) {
      throw new Error(
        `session unload must precede worker retirement: ${this.sessionIdleMs} ms + 2 × ${this.sweepMs} ms is not inside ${workerIdleMs} ms`,
      );
    }
  }

  /** Begin sweeping. Idempotent; the timer never keeps the process alive. */
  start(): void {
    if (this.timer || this.stopped) return;
    const schedule = this.deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    this.timer = schedule(() => void this.sweep().catch(() => {}), this.sweepMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) (this.deps.clearTimer ?? ((timer: ReturnType<typeof setInterval>) => clearInterval(timer)))(this.timer);
    this.timer = undefined;
  }

  counts(): SessionLifetimeCounters {
    return { ...this.counters, pins: { ...this.counters.pins } };
  }

  /**
   * One pass: release the dormant sessions nobody is following.
   *
   * Two independent reasons, both bounded. A session is *idle* when nothing has
   * happened in it for longer than the threshold; a worker is *over its set*
   * when it holds more conversations than it should, and then the least
   * recently active ones go even if they are not old yet. Concurrent sweeps
   * collapse into the one in flight, so a slow worker cannot pile them up.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    const pass = this.run().finally(() => {
      this.sweeping = undefined;
    });
    this.sweeping = pass;
    return pass;
  }

  private async run(): Promise<void> {
    if (this.stopped) return;
    this.counters.sweeps += 1;
    const now = this.now();
    const byWorker = new Map<string, Array<{ path: string; activity: number }>>();
    for (const { cwd, path } of this.deps.loadedSessions()) {
      const rows = byWorker.get(cwd) ?? [];
      rows.push({ path, activity: this.deps.lastActivity(path) ?? now });
      byWorker.set(cwd, rows);
    }

    const candidates: Array<{ cwd: string; path: string; reason: "idle" | "budget"; activity: number }> = [];
    for (const [cwd, rows] of byWorker) {
      // Oldest first: both reasons want the least recently active sessions.
      rows.sort((a, b) => a.activity - b.activity);
      const free = rows.filter((row) => this.deps.holders(row.path) === 0);
      const overBudget = Math.max(0, rows.length - this.maxLoadedPerWorker);
      free.forEach((row, index) => {
        const idle = now - row.activity >= this.sessionIdleMs;
        const budget = index < overBudget;
        if (idle || budget) candidates.push({ cwd, path: row.path, reason: idle ? "idle" : "budget", activity: row.activity });
      });
    }
    if (candidates.length === 0) return;
    candidates.sort((a, b) => a.activity - b.activity);

    for (const candidate of candidates.slice(0, this.maxUnloadsPerTick)) {
      if (this.stopped) return;
      // Re-checked immediately before asking: a person may have opened it while
      // this pass was walking the list, and a held session is never released.
      if (this.deps.holders(candidate.path) > 0) continue;
      this.counters.considered += 1;
      try {
        const answer = await this.deps.unload(candidate.cwd, candidate.path, candidate.reason);
        if (answer.unloaded) {
          this.counters.unloaded += 1;
          continue;
        }
        if (answer.pins.length === 0) continue;
        this.counters.refused += 1;
        for (const pin of answer.pins) this.counters.pins[pin.kind] = (this.counters.pins[pin.kind] ?? 0) + 1;
      } catch (error) {
        // A worker that cannot answer keeps its session: a failed release is
        // not a reason to do anything else to it.
        this.deps.log?.(`session lifetime: release refused by the worker for ${candidate.cwd} — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/**
 * A quarter of the worker's own threshold, capped at two minutes.
 *
 * A fraction rather than a floor on purpose: an accelerated configuration (the
 * resource soak retires workers after seconds) must still release sessions
 * *before* that happens, and a fixed floor would overtake it.
 */
function derivedSessionIdle(workerIdleMs: number): number {
  if (workerIdleMs <= 0) return SESSION_IDLE_CEILING_MS;
  return Math.max(1, Math.min(Math.round(workerIdleMs / 4), SESSION_IDLE_CEILING_MS));
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
