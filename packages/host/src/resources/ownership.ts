/**
 * Who owns a process, from facts the host already has.
 *
 * Two kinds of fact, and nothing else: **spawn records** (the host started this
 * pid, for this project / this task) and **structure** (this pid descends from
 * one we know). No command line is read, no environment is inspected, and no
 * claim from a client can create a record here.
 *
 * Every record carries the start token observed at spawn time. At collection
 * time the token is compared with the one the process has now; a record that
 * does not match is stale — the pid was reused — and it is dropped instead of
 * being applied to a stranger.
 *
 * Paths live here and only here. A project becomes an opaque salted id plus a
 * sanitized basename before it reaches a snapshot, and a session path becomes
 * the session's durable id; neither path is retained on a row.
 */
import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import {
  RESOURCE_ID_MAX,
  resourceProcessRegistrationSchema,
  sanitizeResourceLabel,
  type ResourceProcessRegistration,
  type ResourceProcessRole,
  type ResourceProject,
} from "@lasercode/protocol";
import { processStartToken, type IdentityIo } from "./identity.js";

export interface OwnershipRecord {
  pid: number;
  /**
   * Observed when the process was registered. `undefined` means the platform
   * could not tell us, and then the record is never applied: an unprovable
   * identity attributes nothing.
   */
  startToken: string | undefined;
  role: ResourceProcessRole;
  /** Host-internal. Never leaves this module as a path. */
  projectCwd?: string;
  /** Host-internal. Never leaves this module as a path. */
  sessionPath?: string;
  taskId?: string;
  runId?: string;
  label?: string;
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

export class ProcessOwnershipRegistry {
  private readonly records = new Map<number, OwnershipRecord>();
  private readonly projects = new Map<string, ResourceProject>();
  /**
   * Per host run. A diagnostic must be comparable within a session and must not
   * hand anyone a stable hash of somebody's directory layout.
   */
  private readonly salt = randomBytes(16);

  constructor(
    private readonly io: IdentityIo = {},
    public readonly lookups: OwnershipLookups = {},
    /** Injectable identity read, so a fixture tree can be registered against. */
    private readonly tokenOf: (pid: number) => string | undefined = (pid) => processStartToken(pid, io),
  ) {}

  /** A project's worker. Called by the pool as the child is spawned. */
  noteWorker(projectCwd: string, pid: number | undefined): void {
    if (pid === undefined) return;
    this.put({ pid, startToken: this.tokenOf(pid), role: "project_worker", projectCwd });
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
        startToken: this.tokenOf(registration.pid),
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

  noteExit(pid: number | undefined): void {
    if (pid !== undefined) this.records.delete(pid);
  }

  /** Every registered pid, for discovery roots. Identity is proved at collection. */
  roots(): OwnershipRecord[] {
    return [...this.records.values()];
  }

  /**
   * The record for this exact process, or `undefined`. A record with no token,
   * or one whose token differs from what the process carries now, is not this
   * process: the pid was reused, or we could never prove it was not.
   */
  lookup(pid: number, startToken: string): OwnershipRecord | undefined {
    const record = this.records.get(pid);
    if (!record || !record.startToken || record.startToken !== startToken) return undefined;
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

  private put(record: OwnershipRecord): void {
    this.records.set(record.pid, record);
  }
}
