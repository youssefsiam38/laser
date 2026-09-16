/**
 * What one session's commands are allowed to hold, and what it does about it
 * (RP-6).
 *
 * Split out of `background-work.ts`, which was a module about running commands
 * with a retention policy wound through it. The policy is one thing: a set of
 * bounds, a set of running totals that are exact by construction, and **one**
 * way of making room that both admission and enforcement go through.
 *
 * Three properties are the point:
 *
 * - **Totals are incremental.** Every log reports a change, and the session
 *   adjusts its totals by the difference for that one log. Nothing walks the
 *   session's logs on a command's output path; the walk happens only when room
 *   has to be made, which is rare and bounded by the number of commands.
 * - **Admission precedes retention.** `admit` is asked before a byte is kept,
 *   because bytes already handed to the platform cannot be taken back. The
 *   ceiling is therefore an invariant, not something corrected afterwards.
 * - **Nothing stops a command.** Making room releases bytes that have already
 *   been written — never a process, never a queue the model is waiting on.
 */
import type { BackgroundTaskRetention } from "@lasercode/protocol";
import type { TaskLog } from "./task-log.js";

// --- what a finished command is allowed to keep ----------------------------
//
// The counts match `MAX_TASKS_PER_SESSION` in the host's register and
// `MAX_INDEXED_TASKS_PER_SESSION` in the worker's index on purpose: the three
// layers forget in the same order, so the fleet never draws a row whose
// metadata one layer has quietly dropped (docs/ux-fleet.md R8). Forgetting a
// record here releases memory and nothing else: the fleet row lives in those
// two registers, and the bytes on disk have their own budget.

/** Bytes of the end of the output a finished command keeps in memory. */
export const TASK_EXCERPT_BYTES = 8 * 1024;
/** Finished commands one session keeps in memory. */
export const TERMINAL_TASKS_MAX = 200;
/** How long a finished command's compact record stays in memory. */
export const TERMINAL_TASK_MAX_AGE_MS = 60 * 60_000;
/** Excerpt bytes across every finished command of one session. */
export const TERMINAL_EXCERPT_BYTES_MAX = 2 * 1024 * 1024;
/** Bytes this session's logs may occupy, unless the worker lowers it. */
export const SESSION_LOG_BYTES_MAX = 128 * 1024 * 1024;
/**
 * Live tail buffers, across every running command of one session.
 *
 * A per-command window is not a bound: fifty commands running at once would be
 * fifty windows. Over this ceiling the oldest live tails are shrunk to a small
 * activity excerpt and then released — their output is still on disk and still
 * counted, their rows still say what they are doing, and not one command is
 * paused or stopped for it.
 */
export const SESSION_LIVE_TAIL_BYTES_MAX = 8 * 1024 * 1024;
/** What a shrunk live tail keeps: enough for the row's line and the exit message. */
export const SHRUNK_TAIL_BYTES = 16 * 1024;
/** How often the age of finished records is checked, on one unref'd timer. */
export const AGE_SWEEP_INTERVAL_MS = 60_000;

/**
 * What a session keeps of its finished commands while its worker is short of
 * memory (RP-8).
 *
 * The ordinary bounds above are what a session may hold when nothing is wrong.
 * These are what it keeps for one sweep when the worker asks — tighter in all
 * three dimensions, and decided now rather than derived from anything: an
 * excerpt is {@link TASK_EXCERPT_BYTES}, so fifty of them are about 400 KiB
 * and twenty about 160 KiB, which is why the count binds first at `warning`
 * and the bytes bind first at `critical`. Fifteen minutes is "this turn" and
 * five is "right now"; anything older is one `task_output` away from its
 * durable log, which none of this touches.
 */
export const PRESSURE_TERMINAL_BOUNDS = {
  warning: { records: 50, ageMs: 15 * 60_000, excerptBytes: 512 * 1024 },
  critical: { records: 20, ageMs: 5 * 60_000, excerptBytes: 128 * 1024 },
} as const;

/**
 * Finished commands pressure never forgets, whatever it is asked for.
 *
 * The newest few are the ones an agent is most likely to read next, and a
 * sweep that emptied a session's memory of its own work would cost more than
 * the bytes it gave back.
 */
export const PRESSURE_KEEP_NEWEST = 5;

/** What the session needs of a command to apply its bounds. Nothing more. */
export interface RetainedTask {
  id: string;
  /** When it started, so live commands have an order too. */
  startedAtMs: number;
  /** `undefined` while it runs; the moment it ended otherwise. */
  endedAtMs?: number | undefined;
  log: TaskLog;
  /** Bytes of the live tail buffer, or 0 once it has been released. */
  tailBytes(): number;
  /** Shrink the live tail to `limit` bytes. Returns the bytes it gave back. */
  shrinkTail(limit: number): number;
  /** Release the live tail entirely, keeping a bounded excerpt. Returns bytes freed. */
  releaseTail(): number;
  /** Bytes of the compact excerpt a finished command keeps. */
  excerptBytes(): number;
}

interface Tracked {
  task: RetainedTask;
  live: boolean;
  /** This log's last accounted contribution, so a change is a difference. */
  disk: number;
  pending: number;
  tail: number;
  excerpt: number;
}

/**
 * Logs of records a bound forgot: still this session's to account for and to
 * release, because nothing else may remove bytes this runtime wrote.
 */
interface Orphan {
  log: TaskLog;
  disk: number;
  pending: number;
}

export interface SessionRetentionOptions {
  /** Called when a bound forgets a record, so the module can drop it too. */
  forget(id: string): void;
  now?: () => number;
  /** Called when the totals change materially, so the session can publish them. */
  onChange?: () => void;
}

/**
 * The age bound's clock: **one** timer for the whole process, however many
 * sessions a worker holds.
 *
 * Age is a property of a record, so it cannot wait for another command to
 * finish; but it is the same property in every session, so it does not need a
 * timer each. Sessions register here and are swept together; the timer exists
 * only while somebody is registered, and it never keeps the process alive.
 */
interface AgeScheduler {
  setInterval(fn: () => void, ms: number): { unref?: () => void };
  clearInterval(handle: unknown): void;
}

const aging = new Set<{ enforceRecordBounds(): void }>();
let ageHandle: { unref?: () => void } | undefined;
let ageTimersCreated = 0;
let ageScheduler: AgeScheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

/** Test seam: drive the one timer without a wall clock. */
export function setAgeScheduler(next: AgeScheduler | undefined): void {
  if (ageHandle !== undefined) {
    ageScheduler.clearInterval(ageHandle);
    ageHandle = undefined;
  }
  ageScheduler = next ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  };
  if (aging.size > 0) startAging();
}

/** Evidence for a test: timers ever created, and sessions registered now. */
export function ageSchedulerState(): { timersCreated: number; running: boolean; sessions: number } {
  return { timersCreated: ageTimersCreated, running: ageHandle !== undefined, sessions: aging.size };
}

function startAging(): void {
  if (ageHandle !== undefined) return;
  ageTimersCreated += 1;
  const handle = ageScheduler.setInterval(() => {
    for (const session of [...aging]) session.enforceRecordBounds();
  }, AGE_SWEEP_INTERVAL_MS);
  handle?.unref?.();
  ageHandle = handle;
}

function registerAging(session: { enforceRecordBounds(): void }): void {
  aging.add(session);
  startAging();
}

function unregisterAging(session: { enforceRecordBounds(): void }): void {
  aging.delete(session);
  if (aging.size > 0 || ageHandle === undefined) return;
  ageScheduler.clearInterval(ageHandle);
  ageHandle = undefined;
}

export class SessionRetention {
  private readonly tracked = new Map<string, Tracked>();
  private readonly orphans: Orphan[] = [];
  private readonly now: () => number;
  private budget = SESSION_LOG_BYTES_MAX;
  private disk = 0;
  private pending = 0;
  private tails = 0;
  private excerpts = 0;
  private liveCount = 0;
  private terminalCount = 0;
  evicted = 0;
  released = 0;
  tailsShrunk = 0;
  constructor(private readonly options: SessionRetentionOptions) {
    this.now = options.now ?? Date.now;
    // Age is checked for every session of this process on one shared timer,
    // not on a timer each: fifty sessions are fifty registrations, one clock.
    registerAging(this);
  }

  /** Leave the shared age sweep. The records themselves are the runtime's to drop. */
  dispose(): void {
    unregisterAging(this);
  }

  /** Bytes this session's logs may occupy. Zero is a legitimate share. */
  setBudget(bytes: number): void {
    this.budget = Math.max(0, Math.min(SESSION_LOG_BYTES_MAX, Math.floor(bytes)));
    this.enforceBudget();
  }

  get budgetBytes(): number {
    return this.budget;
  }

  /** Disk plus everything on its way there: what the ceiling is checked against. */
  get heldBytes(): number {
    return this.disk + this.pending;
  }

  /** A command started. Its log reports changes through {@link note}. */
  track(task: RetainedTask): void {
    this.tracked.set(task.id, { task, live: true, disk: 0, pending: 0, tail: 0, excerpt: 0 });
    this.liveCount += 1;
    this.note(task.id);
  }

  /** A command ended and was compacted: it stops being live work. */
  markTerminal(id: string): void {
    const entry = this.tracked.get(id);
    if (!entry || !entry.live) return;
    entry.live = false;
    this.liveCount -= 1;
    this.terminalCount += 1;
    this.note(id);
    this.enforceRecordBounds();
  }

  /**
   * One log's contribution changed. O(1): the difference for that log alone,
   * never a walk of the session.
   */
  note(id: string): void {
    const entry = this.tracked.get(id);
    if (!entry) return;
    const disk = entry.task.log.diskBytes;
    const pending = entry.task.log.pendingBytes;
    const tail = entry.task.tailBytes();
    const excerpt = entry.task.excerptBytes();
    this.disk += disk - entry.disk;
    this.pending += pending - entry.pending;
    this.tails += tail - entry.tail;
    this.excerpts += excerpt - entry.excerpt;
    entry.disk = disk;
    entry.pending = pending;
    entry.tail = tail;
    entry.excerpt = excerpt;
  }

  /**
   * May this log keep `bytes` more?
   *
   * Asked before the bytes are retained. Room is made through the one policy
   * below; if it still does not fit — a share of zero, a chunk larger than the
   * whole share, or a session whose remaining bytes are all in flight — the
   * answer is no and the caller abandons that command's body.
   */
  admit(log: TaskLog, bytes: number): boolean {
    if (this.heldBytes + bytes <= this.budget) return true;
    this.makeRoom(this.budget - bytes, log);
    return this.heldBytes + bytes <= this.budget;
  }

  /** Bring what is held back inside the share; used when the share changes. */
  enforceBudget(): void {
    if (this.heldBytes <= this.budget) return;
    this.makeRoom(this.budget, undefined);
  }

  /**
   * The one way room is ever made, for admission and for enforcement alike.
   *
   * Order: logs nobody holds a record for, then finished commands oldest
   * first, then the older segment of a running command's window, then a
   * running command's window entirely — oldest first, and `except` (the log
   * asking for room) last of all, so a command does not release its own body
   * to keep somebody else's. Nothing is paused, throttled or ended.
   */
  private makeRoom(target: number, except: TaskLog | undefined): void {
    const enough = (): boolean => this.heldBytes <= target;
    for (let index = 0; index < this.orphans.length && !enough(); index += 1) {
      const orphan = this.orphans[index]!;
      if (!orphan.log.usable) continue;
      this.releaseOrphan(orphan);
    }
    this.orphans.splice(0, this.orphans.length, ...this.orphans.filter((orphan) => orphan.log.usable));
    const ordered = [...this.tracked.values()].sort(byAge);
    for (const entry of ordered) {
      if (enough()) return;
      if (entry.live || entry.task.log === except) continue;
      this.releaseLog(entry, "all");
    }
    for (const entry of ordered) {
      if (enough()) return;
      if (!entry.live || entry.task.log === except) continue;
      this.releaseLog(entry, "oldest");
    }
    for (const entry of ordered) {
      if (enough()) return;
      if (!entry.live || entry.task.log === except) continue;
      this.releaseLog(entry, "all");
    }
    if (enough()) return;
    // Last of all: the log that asked. Its own body is what is left to give.
    const own = except ? [...this.tracked.values()].find((entry) => entry.task.log === except) : undefined;
    if (own) this.releaseLog(own, "all");
  }

  private releaseLog(entry: Tracked, how: "oldest" | "all"): void {
    const result = how === "oldest" ? entry.task.log.releaseOldest() : entry.task.log.release();
    if (result.changed) this.released += 1;
    this.note(entry.task.id);
  }

  private releaseOrphan(orphan: Orphan): void {
    const result = orphan.log.release();
    if (result.changed) this.released += 1;
    this.disk -= orphan.disk;
    this.pending -= orphan.pending;
    orphan.disk = 0;
    orphan.pending = 0;
  }

  /**
   * The three independent bounds on finished commands: how many, how old, how
   * many excerpt bytes. A running command is exempt from all three.
   */
  enforceRecordBounds(): void {
    this.sweepTerminal({
      records: TERMINAL_TASKS_MAX,
      ageMs: TERMINAL_TASK_MAX_AGE_MS,
      excerptBytes: TERMINAL_EXCERPT_BYTES_MAX,
      keepNewest: 0,
      trimOrphans: true,
    });
  }

  /**
   * Keep less of what is finished, for one sweep, because the worker is short
   * of memory (RP-8).
   *
   * The same forgetting the ordinary bounds do, with tighter numbers and a
   * floor: {@link PRESSURE_KEEP_NEWEST} finished commands always stay. It is
   * one pass over the records already here, it stores no mode and starts no
   * timer, and running it again changes nothing — the bounds are absolute, so
   * the second sweep finds the session already inside them.
   *
   * What it does not do is as much of the point. A running command keeps its
   * record, its tail, its pending writes and its process; a durable log keeps
   * every byte, every segment and its digest; the ordinary bounds are
   * unchanged; and a forgotten record is still a row in the worker's index and
   * still readable through its log, which is where `task_output` looks when
   * this module no longer remembers it.
   */
  releaseUnder(level: "warning" | "critical"): void {
    const bounds = PRESSURE_TERMINAL_BOUNDS[level];
    this.sweepTerminal({
      records: bounds.records,
      ageMs: bounds.ageMs,
      excerptBytes: bounds.excerptBytes,
      keepNewest: PRESSURE_KEEP_NEWEST,
      // Orphan logs are *durable* bytes, and releasing them is the worker's
      // disk budget (RP-6), not memory pressure's business.
      trimOrphans: false,
    });
  }

  /**
   * One pass over the finished records, oldest first, against three bounds and
   * a floor.
   *
   * `keepNewest` protects the tail of that order, so a bound can empty a
   * session's older memory without taking the handful it is most likely to be
   * asked for next.
   */
  private sweepTerminal(limits: { records: number; ageMs: number; excerptBytes: number; keepNewest: number; trimOrphans: boolean }): void {
    const now = this.now();
    // A finished command whose log is still draining is not finished with this
    // module yet. `close()` does not wait for the writes already handed to the
    // platform, and this record is the only thing that still publishes where
    // that log's bytes are: forget it now and a rotation moments later moves
    // segments nobody will be told about, leaving the worker's row naming a
    // file that no longer exists. So a record with bytes in flight is passed
    // over by every bound — the ordinary ones and pressure alike — and is left
    // exactly as it is: its counters, its log, its digest and its publication
    // owner untouched. A session may therefore sit over a bound while writes
    // are outstanding; that is the honest state, and the next sweep, once the
    // drain is observed, releases it.
    // Asked of the log itself rather than of the counter beside it: the
    // counter is refreshed when a log reports a change, and a record that has
    // just been forgotten by another bound stops reporting. What matters here
    // is whether bytes are in flight *now*.
    const draining = (entry: Tracked): boolean => entry.task.log.pendingBytes > 0;
    let ordered = [...this.tracked.values()].filter((entry) => !entry.live && !draining(entry)).sort(byAge);
    const protectedCount = Math.max(0, Math.min(limits.keepNewest, ordered.length));
    const total = ordered.length;
    /** How many of the oldest may still go before the floor is reached. */
    let mayForget = total - protectedCount;
    /**
     * Excerpt bytes held by **finished** commands alone.
     *
     * `this.excerpts` is the session's whole excerpt total, and a *running*
     * command has one too once its live tail has been released. The bound here
     * is about finished work, as its name and its documentation both say, so a
     * running command's excerpt must not be able to push finished ones out.
     */
    let terminalExcerpts = ordered.reduce((sum, entry) => sum + entry.excerpt, 0);
    const forget = (entry: Tracked): void => {
      this.tracked.delete(entry.task.id);
      this.terminalCount -= 1;
      this.disk -= entry.disk;
      this.pending -= entry.pending;
      this.tails -= entry.tail;
      this.excerpts -= entry.excerpt;
      terminalExcerpts -= entry.excerpt;
      this.evicted += 1;
      // The bytes are still this session's to account for and to release: an
      // in-memory bound never deletes a durable log.
      if (entry.task.log.usable) {
        this.orphans.push({ log: entry.task.log, disk: entry.disk, pending: entry.pending });
        this.disk += entry.disk;
        this.pending += entry.pending;
      }
      this.options.forget(entry.task.id);
      ordered = ordered.filter((candidate) => candidate !== entry);
      mayForget -= 1;
    };
    for (const entry of [...ordered]) {
      if (mayForget <= 0) break;
      const endedAt = entry.task.endedAtMs;
      if (endedAt !== undefined && now - endedAt > limits.ageMs) forget(entry);
    }
    while (mayForget > 0 && ordered.length > limits.records) forget(ordered[0]!);
    while (mayForget > 0 && ordered.length > 0 && terminalExcerpts > limits.excerptBytes) forget(ordered[0]!);
    if (limits.trimOrphans) {
      while (this.orphans.length > TERMINAL_TASKS_MAX) {
        const oldest = this.orphans.shift();
        if (oldest) this.releaseOrphan(oldest);
      }
    }
    this.options.onChange?.();
  }

  /**
   * Keep the memory of live commands inside one ceiling for the whole session:
   * oldest first, shrunk to an excerpt and then released. Nothing is paused
   * and no row is lost.
   */
  enforceLiveTailBudget(): void {
    if (this.tails <= SESSION_LIVE_TAIL_BYTES_MAX) return;
    const live = [...this.tracked.values()].filter((entry) => entry.live).sort(byAge);
    for (const entry of live) {
      if (this.tails <= SESSION_LIVE_TAIL_BYTES_MAX) break;
      if (entry.task.tailBytes() <= SHRUNK_TAIL_BYTES) continue;
      entry.task.shrinkTail(SHRUNK_TAIL_BYTES);
      this.tailsShrunk += 1;
      this.note(entry.task.id);
    }
    for (const entry of live) {
      if (this.tails <= SESSION_LIVE_TAIL_BYTES_MAX) break;
      if (entry.task.tailBytes() === 0) continue;
      entry.task.releaseTail();
      this.tailsShrunk += 1;
      this.note(entry.task.id);
    }
  }

  /** What this session is holding, exactly, including logs no record points at. */
  snapshot(): BackgroundTaskRetention {
    // Orphan logs drain after their record is gone, so their contribution is
    // re-read here — on the publishing path, never on a command's.
    for (const orphan of this.orphans) {
      const disk = orphan.log.diskBytes;
      const pending = orphan.log.pendingBytes;
      this.disk += disk - orphan.disk;
      this.pending += pending - orphan.pending;
      orphan.disk = disk;
      orphan.pending = pending;
    }
    return {
      live: this.liveCount,
      terminal: this.terminalCount,
      liveTailBytes: this.tails,
      excerptBytes: this.excerpts,
      logBytes: this.disk,
      pendingLogBytes: this.pending,
      evicted: this.evicted,
      released: this.released,
      tailsShrunk: this.tailsShrunk,
    };
  }
}

/** Oldest first: finished by when they ended, running by when they started. */
function byAge(left: Tracked, right: Tracked): number {
  return (left.task.endedAtMs ?? left.task.startedAtMs) - (right.task.endedAtMs ?? right.task.startedAtMs);
}

// ---------------------------------------------------------------------------
// Where the logs live, and what becomes of the ones a crashed run left
// ---------------------------------------------------------------------------

/**
 * The private directory this **process** writes command logs into, and the
 * salt that turns a session id into an opaque directory name.
 *
 * Both are per process, not per session and not per registration: a second
 * salt would mean two names for one session, and a second root would mean a
 * second directory to sweep and a second thing to get the permissions of
 * wrong.
 */
let processRoot: string | undefined;
let processSalt: Buffer | undefined;

export function resetLogRootForTests(): void {
  processRoot = undefined;
  processSalt = undefined;
}

export function logRootFor(configured: string | undefined, make: () => string): string {
  if (processRoot) return processRoot;
  processRoot = configured ?? make();
  return processRoot;
}

export function logSalt(make: () => Buffer): Buffer {
  if (!processSalt) processSalt = make();
  return processSalt;
}

/**
 * There is deliberately **no sweep here.**
 *
 * Every worker of a host writes into the same private root, and a directory's
 * modification time says nothing about whether a command is still writing into
 * it: a quiet command holding one segment open for a day leaves a directory
 * that looks exactly like a crashed run's. A worker that deleted "old"
 * directories from that shared root would eventually delete another worker's
 * live session.
 *
 * So a runtime removes only what it owns — its own tasks' segments, through
 * the budget and the bounds above — and crash recovery belongs to the host,
 * which does it once at start, before any worker exists to be writing
 * (`packages/host/src/tasks/cleanup.ts`).
 */
