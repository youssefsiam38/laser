/**
 * Who owns a process, from facts the host already has.
 *
 * Two kinds of fact, and nothing else: **spawn records** (the host started this
 * pid, for this project / this task) and **structure** (this pid descends from
 * one we know). No command line is read, no environment is inspected, and no
 * claim from a client can create a record here.
 *
 * A record is only a claim until a collected process table proves it. Proving
 * it at registration would mean reading a single pid at a second moment — and
 * a second moment is exactly where a reused pid hides — so instead a record is
 * adopted by the first table that still shows that pid, and only when that
 * process started in the window the registration says it should have. From
 * then on the token is the record's identity: a table that disagrees means the
 * pid changed hands, and the record is pruned rather than applied.
 *
 * Exits are generation-safe. A spawn hands back a generation and the exit
 * quotes it, so a late exit callback from a dead worker cannot delete the
 * record of the worker that replaced it at the same pid.
 *
 * Paths live here and only here. A project becomes an opaque salted id plus a
 * sanitized basename before it reaches a snapshot, and a session path becomes
 * the session's durable id; neither path is retained on a row.
 */
import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import {
  RESOURCE_ID_MAX,
  RESOURCE_OWNERSHIP_MAX_AGE_MS,
  RESOURCE_OWNERSHIP_MAX_RECORDS,
  RESOURCE_START_TIME_TOLERANCE_MS,
  resourceProcessRegistrationSchema,
  sanitizeResourceLabel,
  type ResourceProcessRegistration,
  type ResourceProcessRole,
  type ResourceProject,
} from "@lasercode/protocol";

/**
 * How long an unproven record may wait for its first table when the platform
 * cannot tell us when a process started. Reuse of a pid inside this window,
 * with no exit reported, is the one case this cannot separate; it is bounded
 * and written down rather than hidden.
 */
export const UNPROVEN_ADOPTION_WINDOW_MS = 5 * 60_000;

export interface OwnershipRecord {
  pid: number;
  /** Increases per registration; an exit must quote the one it belongs to. */
  generation: number;
  /** The identity a table proved. `undefined` until the first table adopts it. */
  startToken: string | undefined;
  role: ResourceProcessRole;
  registeredAtMs: number;
  /** Host-internal. Never leaves this module as a path. */
  projectCwd?: string;
  /** Host-internal. Never leaves this module as a path. */
  sessionPath?: string;
  taskId?: string;
  runId?: string;
  label?: string;
}

/** One row of the collected table, as far as ownership is concerned. */
export interface ObservedProcess {
  pid: number;
  startToken: string;
  /** Epoch milliseconds, when the platform can say. */
  startedAtMs?: number;
}

/** How the host resolves already-known ids for a row. All calls are transient. */
export interface OwnershipLookups {
  /** Durable session ids for the sessions a project's worker currently holds. */
  sessionIdsOf?(projectCwd: string): string[];
  /** Live agent run ids of a project. Associations of the worker, not an allocation. */
  runIdsOf?(projectCwd: string): string[];
  /** Background task ids of a project. */
  taskIdsOf?(projectCwd: string): string[];
  /** Durable id of one session file. */
  sessionIdOf?(sessionPath: string): string | undefined;
}

export interface OwnershipOptions {
  now?: () => number;
  maxRecords?: number;
  maxAgeMs?: number;
}

export class ProcessOwnershipRegistry {
  private readonly records = new Map<number, OwnershipRecord>();
  private readonly projects = new Map<string, ResourceProject>();
  private readonly now: () => number;
  private readonly maxRecords: number;
  private readonly maxAgeMs: number;
  private generation = 0;
  /**
   * Per host run. A diagnostic must be comparable within a session and must not
   * hand anyone a stable hash of somebody's directory layout.
   */
  private readonly salt = randomBytes(16);

  constructor(
    public readonly lookups: OwnershipLookups = {},
    options: OwnershipOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxRecords = options.maxRecords ?? RESOURCE_OWNERSHIP_MAX_RECORDS;
    this.maxAgeMs = options.maxAgeMs ?? RESOURCE_OWNERSHIP_MAX_AGE_MS;
  }

  /**
   * A project's worker, recorded as the child is spawned. Returns the
   * generation the matching `noteExit` must quote.
   */
  noteWorker(projectCwd: string, pid: number | undefined): number | undefined {
    if (pid === undefined) return undefined;
    return this.put({ pid, role: "project_worker", projectCwd });
  }

  /**
   * RP-6 / RP-7 hand their pids in here, including through a worker-originated
   * typed report. Invalid rows are dropped individually; a bad report never
   * throws into the caller's path. Returns how many were accepted.
   */
  observeProcessRegistrations(projectCwd: string | undefined, registrations: readonly unknown[]): number {
    let accepted = 0;
    for (const raw of registrations.slice(0, 256)) {
      const parsed = resourceProcessRegistrationSchema.safeParse(raw);
      if (!parsed.success) continue;
      const registration = parsed.data as ResourceProcessRegistration;
      this.put({
        pid: registration.pid,
        role: registration.role,
        ...(projectCwd ? { projectCwd } : {}),
        ...(registration.sessionPath ? { sessionPath: registration.sessionPath } : {}),
        ...(registration.taskId ? { taskId: registration.taskId } : {}),
        ...(registration.runId ? { runId: registration.runId } : {}),
        ...(registration.label ? { label: sanitizeResourceLabel(registration.label) } : {}),
      });
      accepted += 1;
    }
    return accepted;
  }

  /**
   * The process ended. `generation` makes this safe against a late callback:
   * without it an exit from a worker that died could delete the record of the
   * worker that took its pid. Omitted, it still means "forget this pid", which
   * is what a caller with no generation can honestly say.
   */
  noteExit(pid: number | undefined, generation?: number): void {
    if (pid === undefined) return;
    const record = this.records.get(pid);
    if (!record) return;
    if (generation !== undefined && record.generation !== generation) return;
    this.records.delete(pid);
  }

  /**
   * Reconcile every record against a freshly collected table.
   *
   * This is the only place a record becomes usable, and the only place one is
   * pruned: a pid that is gone, a pid that is now somebody else, and a claim
   * that could not be adopted inside its window all leave here. Returns the
   * records that are proved to describe a process in this table.
   */
  reconcile(table: readonly ObservedProcess[]): OwnershipRecord[] {
    const observed = new Map<number, ObservedProcess>();
    for (const row of table) observed.set(row.pid, row);
    const now = this.now();
    const live: OwnershipRecord[] = [];

    for (const [pid, record] of [...this.records]) {
      const row = observed.get(pid);
      if (!row) {
        // Gone, or never there. A stale record must not become a discovery
        // root: it would add nothing and could name a stranger's subtree.
        if (now - record.registeredAtMs > this.maxAgeMs) this.records.delete(pid);
        continue;
      }
      if (record.startToken === undefined) {
        if (!this.adopt(record, row, now)) {
          if (now - record.registeredAtMs > UNPROVEN_ADOPTION_WINDOW_MS) this.records.delete(pid);
          continue;
        }
      } else if (record.startToken !== row.startToken) {
        this.records.delete(pid); // The pid changed hands.
        continue;
      }
      live.push(record);
    }
    this.prune();
    return live;
  }

  /** Every record held right now, proved or not. Retention evidence. */
  size(): number {
    return this.records.size;
  }

  /** The record bound in force, reported beside snapshot retention. */
  get maxRecordsBound(): number {
    return this.maxRecords;
  }

  /** The record for this exact process, or `undefined`. */
  lookup(pid: number, startToken: string): OwnershipRecord | undefined {
    const record = this.records.get(pid);
    if (!record || record.startToken !== startToken) return undefined;
    return record;
  }

  /** Opaque for one host run, with a sanitized label a person can read. */
  projectIdentity(projectCwd: string): ResourceProject {
    const cached = this.projects.get(projectCwd);
    if (cached) return cached;
    const id = createHash("sha256").update(this.salt).update(projectCwd).digest("hex").slice(0, 16);
    const identity: ResourceProject = { id, label: sanitizeResourceLabel(basename(projectCwd) || "project") };
    this.projects.set(projectCwd, identity);
    return identity;
  }

  /** A session path becomes its durable id, bounded. Never the path itself. */
  sessionIdOf(sessionPath: string): string | undefined {
    const id = this.lookups.sessionIdOf?.(sessionPath);
    if (!id) return undefined;
    return id.length > RESOURCE_ID_MAX ? id.slice(0, RESOURCE_ID_MAX) : id;
  }

  /**
   * Take this table's identity for an unproven record, but only if the process
   * it found started when the registration says it should have: a spawn is
   * recorded immediately after the child exists, so its start time is at or
   * just before the registration, and a process that started *after* the
   * registration is the next owner of that pid, not ours.
   */
  private adopt(record: OwnershipRecord, row: ObservedProcess, now: number): boolean {
    if (row.startedAtMs !== undefined) {
      const skew = row.startedAtMs - record.registeredAtMs;
      if (skew > RESOURCE_START_TIME_TOLERANCE_MS) return false;
      if (record.registeredAtMs - row.startedAtMs > UNPROVEN_ADOPTION_WINDOW_MS) return false;
    } else if (now - record.registeredAtMs > UNPROVEN_ADOPTION_WINDOW_MS) {
      // No start time to compare, and too old to assume. Say nothing about it.
      return false;
    }
    record.startToken = row.startToken;
    return true;
  }

  private put(record: Omit<OwnershipRecord, "generation" | "startToken" | "registeredAtMs">): number {
    const generation = ++this.generation;
    this.records.set(record.pid, { ...record, generation, startToken: undefined, registeredAtMs: this.now() });
    this.prune();
    return generation;
  }

  /**
   * Records are bounded on their own, independently of snapshot history: age
   * first, then count. A live project worker is never evicted — its record is
   * the only proof of what that process is — so the count bound drops the
   * oldest other records, and reports honestly if there is nothing else to
   * drop by keeping the workers.
   */
  private prune(): void {
    const now = this.now();
    for (const [pid, record] of [...this.records]) {
      if (record.role !== "project_worker" && now - record.registeredAtMs > this.maxAgeMs) this.records.delete(pid);
    }
    if (this.records.size <= this.maxRecords) return;
    const evictable = [...this.records.values()]
      .filter((record) => record.role !== "project_worker")
      .sort((a, b) => a.registeredAtMs - b.registeredAtMs || a.generation - b.generation);
    for (const record of evictable) {
      if (this.records.size <= this.maxRecords) return;
      this.records.delete(record.pid);
    }
  }
}
