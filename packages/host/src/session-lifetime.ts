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
import type { MemoryPressureActionResult, SessionPin } from "@lasercode/protocol";
import type { PressureAllowDecision } from "./pressure/pass.js";

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
  /** Rows one worker's scan may look at in a sweep, refusals included. */
  maxScanPerWorker?: number;
}

/** The worker's own default idle retirement, mirrored so the derivation has a base. */
const DEFAULT_WORKER_IDLE_MS = 10 * 60_000;
/** Longest a dormant runtime is kept when the worker's own threshold is far away. */
const SESSION_IDLE_CEILING_MS = 2 * 60_000;
const SWEEP_CEILING_MS = 30_000;
const SWEEP_FLOOR_MS = 10;
const DEFAULT_MAX_LOADED_PER_WORKER = 8;
const DEFAULT_MAX_UNLOADS_PER_TICK = 8;
const DEFAULT_MAX_SCAN_PER_WORKER = 32;

export interface SessionLifetimeCounters {
  sweeps: number;
  /** Rows the scan looked at, whether or not it asked about them. */
  scanned: number;
  considered: number;
  unloaded: number;
  refused: number;
  /** Rows skipped because they refused recently and are waiting their turn. */
  skippedBackoff: number;
  /** Releases asked for because a worker was over its set, and how many landed. */
  budgetTarget: number;
  budgetRemoved: number;
  /** Refusals by the pin that caused them, so a policy that never fires is explainable. */
  pins: Record<string, number>;
}

export class SessionLifetime {
  readonly sessionIdleMs: number;
  readonly sweepMs: number;
  readonly maxLoadedPerWorker: number;
  readonly maxScanPerWorker: number;
  private readonly maxUnloadsPerTick: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private sweeping: Promise<void> | undefined;
  private stopped = false;
  private readonly counters: SessionLifetimeCounters = {
    sweeps: 0, scanned: 0, considered: 0, unloaded: 0, refused: 0, skippedBackoff: 0, budgetTarget: 0, budgetRemoved: 0, pins: {},
  };
  /** Rows that refused recently, with their strike count: bounded by the live set. */
  private readonly refusals = new Map<string, { strikes: number; until: number; cause: "pins" | "unavailable" }>();
  /** Which worker this sweep starts with, so no project is always last. */
  private rotation = 0;

  constructor(private readonly deps: SessionLifetimeDeps, options: SessionLifetimeOptions = {}) {
    this.now = deps.now ?? Date.now;
    const workerIdleMs = options.workerIdleMs ?? DEFAULT_WORKER_IDLE_MS;
    this.sessionIdleMs = options.sessionIdleMs ?? derivedSessionIdle(workerIdleMs);
    this.sweepMs = options.sweepMs ?? clamp(Math.round(this.sessionIdleMs / 3), SWEEP_FLOOR_MS, SWEEP_CEILING_MS);
    this.maxLoadedPerWorker = options.maxLoadedPerWorker ?? DEFAULT_MAX_LOADED_PER_WORKER;
    this.maxUnloadsPerTick = options.maxUnloadsPerTick ?? DEFAULT_MAX_UNLOADS_PER_TICK;
    this.maxScanPerWorker = options.maxScanPerWorker ?? DEFAULT_MAX_SCAN_PER_WORKER;
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

  /**
   * Step 5 of one host pressure pass: choose at most one loaded session by the
   * same oldest-first, membership, pin and refusal-backoff rules as the sweep.
   * `allow` answers at the destructive boundary whether this candidate belongs
   * to the pass and whether that exact worker generation is still live.
   */
  async pressurePass(
    allow: (cwd: string) => PressureAllowDecision,
  ): Promise<MemoryPressureActionResult> {
    if (this.stopped) return { action: "idle_session_unload", outcome: "unavailable" };
    const at = this.now();
    const rows = this.deps.loadedSessions()
      .map(({ cwd, path }) => ({ cwd, path, activity: this.deps.lastActivity(path) ?? at }))
      .sort((a, b) => a.activity - b.activity || a.path.localeCompare(b.path));
    const loadedByWorker = new Map<string, number>();
    for (const row of rows) loadedByWorker.set(row.cwd, (loadedByWorker.get(row.cwd) ?? 0) + 1);
    let membershipHeld = false;
    let pinsHeld = false;
    let unavailable = false;
    for (const row of rows) {
      const idle = at - row.activity >= this.sessionIdleMs;
      const overBudget = (loadedByWorker.get(row.cwd) ?? 0) > this.maxLoadedPerWorker;
      if (!idle && !overBudget) continue;
      const decision = allow(row.cwd);
      if (decision === "not_in_pass") continue;
      if (decision === "generation_moved") {
        return { action: "idle_session_unload", outcome: "refused", reason: "generation_mismatch" };
      }
      this.counters.scanned += 1;
      const backoff = this.refusals.get(row.path);
      if (backoff && backoff.until > at) {
        if (backoff.cause === "pins") pinsHeld = true;
        else unavailable = true;
        continue;
      }
      if (this.deps.holders(row.path) > 0) {
        membershipHeld = true;
        continue;
      }
      // Membership is re-checked immediately before the only destructive call.
      if (this.deps.holders(row.path) > 0) return { action: "idle_session_unload", outcome: "held", reason: "membership_held" };
      this.counters.considered += 1;
      this.counters.budgetTarget += 1;
      try {
        const answer = await this.deps.unload(row.cwd, row.path, "budget");
        if (answer.unloaded) {
          this.counters.unloaded += 1;
          this.counters.budgetRemoved += 1;
          this.refusals.delete(row.path);
          return { action: "idle_session_unload", outcome: "released", released: { count: 1 } };
        }
        if (answer.pins.length > 0) {
          this.counters.refused += 1;
          for (const pin of answer.pins) this.counters.pins[pin.kind] = (this.counters.pins[pin.kind] ?? 0) + 1;
          this.backOff(row.path, at, "pins");
          return { action: "idle_session_unload", outcome: "held", reason: "pins_held" };
        }
        return { action: "idle_session_unload", outcome: "unavailable" };
      } catch {
        this.backOff(row.path, at, "unavailable");
        return { action: "idle_session_unload", outcome: "unavailable" };
      }
    }
    if (membershipHeld) return { action: "idle_session_unload", outcome: "held", reason: "membership_held" };
    if (pinsHeld) return { action: "idle_session_unload", outcome: "held", reason: "pins_held" };
    if (unavailable) return { action: "idle_session_unload", outcome: "unavailable" };
    return { action: "idle_session_unload", outcome: "nothing_to_give" };
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
    this.forgetGoneSessions(byWorker);
    if (byWorker.size === 0) return;

    // Fairness first: every worker gets its share of this tick before the
    // global cap applies, and the worker that goes first rotates, so one busy
    // project cannot starve the others sweep after sweep.
    const workers = [...byWorker.keys()].sort();
    const start = this.rotation % workers.length;
    this.rotation = (this.rotation + 1) % Math.max(1, workers.length);
    const share = Math.max(1, Math.ceil(this.maxUnloadsPerTick / workers.length));
    let attempts = 0;

    for (let index = 0; index < workers.length; index += 1) {
      if (this.stopped || attempts >= this.maxUnloadsPerTick) return;
      const cwd = workers[(start + index) % workers.length]!;
      const rows = byWorker.get(cwd)!;
      // Oldest first: both reasons want the least recently active sessions.
      rows.sort((a, b) => a.activity - b.activity);
      const free = rows.filter((row) => this.deps.holders(row.path) === 0);
      // How many *successful* removals this worker owes, not how many rows are
      // old: a refusal must not stop the scan at the same row for ever.
      let owed = Math.max(0, rows.length - this.maxLoadedPerWorker);
      let used = 0;
      let scanned = 0;

      for (const row of free) {
        if (this.stopped) return;
        if (used >= share || attempts >= this.maxUnloadsPerTick) break;
        if (scanned >= this.maxScanPerWorker) break;
        scanned += 1;
        this.counters.scanned += 1;
        const idle = now - row.activity >= this.sessionIdleMs;
        const budget = owed > 0;
        if (!idle && !budget) break;
        // A row that refused recently waits its turn, so the scan moves on to
        // the next one instead of retrying the same pin every sweep.
        const backoff = this.refusals.get(row.path);
        if (backoff && backoff.until > now) {
          this.counters.skippedBackoff += 1;
          continue;
        }
        // Re-checked immediately before asking: a person may have opened it
        // while this pass was walking the list.
        if (this.deps.holders(row.path) > 0) {
          this.refusals.delete(row.path);
          continue;
        }
        used += 1;
        attempts += 1;
        this.counters.considered += 1;
        const reason = budget ? "budget" : "idle";
        if (reason === "budget") this.counters.budgetTarget += 1;
        try {
          const answer = await this.deps.unload(cwd, row.path, reason);
          if (answer.unloaded) {
            this.counters.unloaded += 1;
            if (reason === "budget") {
              this.counters.budgetRemoved += 1;
              owed -= 1;
            }
            this.refusals.delete(row.path);
            continue;
          }
          if (answer.pins.length === 0) continue;
          this.counters.refused += 1;
          for (const pin of answer.pins) this.counters.pins[pin.kind] = (this.counters.pins[pin.kind] ?? 0) + 1;
          this.backOff(row.path, now, "pins");
        } catch (error) {
          // A worker that cannot answer keeps its session: a failed release is
          // not a reason to do anything else to it.
          this.backOff(row.path, now, "unavailable");
          this.deps.log?.(`session lifetime: release refused by the worker for ${cwd} — ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  /**
   * Wait longer before asking about a session that just refused, doubling each
   * time and capped, so a permanently pinned conversation costs one attempt
   * occasionally instead of the whole tick for ever.
   */
  private backOff(path: string, now: number, cause: "pins" | "unavailable"): void {
    const previous = this.refusals.get(path);
    const strikes = Math.min((previous?.strikes ?? 0) + 1, 8);
    const wait = Math.min(this.sweepMs * 2 ** strikes, this.sessionIdleMs);
    this.refusals.set(path, { strikes, until: now + wait, cause });
  }

  /** Drop backoff state for sessions this worker no longer holds; bounded by construction. */
  private forgetGoneSessions(byWorker: Map<string, Array<{ path: string }>>): void {
    if (this.refusals.size === 0) return;
    const live = new Set<string>();
    for (const rows of byWorker.values()) for (const row of rows) live.add(row.path);
    for (const path of [...this.refusals.keys()]) if (!live.has(path)) this.refusals.delete(path);
  }
}

function derivedSessionIdle(workerIdleMs: number): number {
  if (workerIdleMs <= 0) return SESSION_IDLE_CEILING_MS;
  return Math.max(1, Math.min(Math.round(workerIdleMs / 4), SESSION_IDLE_CEILING_MS));
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
