/**
 * Process inventory and resource snapshots (RP-1).
 *
 * A host-owned, demand-driven answer to "what is this application actually
 * using, and who owns it". Three rules shape every type here:
 *
 * 1. **Identity is `(pid, startToken)`, never a pid.** A pid is reused; a
 *    measurement or an association attached to a reused pid would be a lie
 *    about somebody else's process. Every row carries both, joined in `key`.
 * 2. **A missing number is `unavailable`, never `0`.** Platforms expose
 *    different counters and some need permissions we do not have. A zero would
 *    read as "this process uses no memory", which is never what we learned.
 * 3. **Nothing here carries argv, environment, provider payloads or paths.**
 *    A row's words are a sanitized executable basename, an opaque salted
 *    project id with a sanitized label, and ids the host already publishes
 *    (durable session ids, run ids, task ids). The collector does not read
 *    `cmdline` or `environ` at all — the fields are not read, not redacted.
 *
 * Two further honesties are types rather than conventions. Totals carry their
 * own coverage, so a partial sum can never be presented as the application's
 * physical total (`ResourceTotals`). And Electron's own metrics are cross-check
 * metadata attached to a row we discovered ourselves, never a measurement
 * source and never private memory (`ResourceProcess.electron`).
 *
 * An agent run is not a process: runs appear as bounded *associations* on the
 * project worker that hosts them, explicitly not as an allocation of its
 * memory.
 *
 * Handoff (RP-6 / RP-7): background commands and internal helpers are named in
 * {@link RESOURCE_PROCESS_ROLES} and can be attributed the moment their owners
 * publish pids through {@link ResourceProcessRegistration}. Until then their
 * processes are honest `unknown_descendant` rows under the worker that spawned
 * them. Wiring those two producers is part of finishing M18, not of this slice.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Roles and reasons
// ---------------------------------------------------------------------------

/**
 * What a process is, derived structurally — from known roots, the live parent
 * chain and spawn registrations. Never from a command line.
 */
export const RESOURCE_PROCESS_ROLES = [
  "desktop_main",
  "desktop_renderer",
  "desktop_gpu",
  "desktop_utility",
  "host",
  "project_worker",
  "background_command",
  "helper",
  "unknown_descendant",
] as const;

export type ResourceProcessRole = (typeof RESOURCE_PROCESS_ROLES)[number];

/** Why a number is missing. Always one of these, never an empty measurement. */
export const RESOURCE_UNAVAILABLE_REASONS = [
  /** The operating system exposes no such counter to an unprivileged reader. */
  "unsupported_platform",
  /** The counter exists and we were refused. */
  "permission_denied",
  /** The process ended between discovery and measurement. */
  "process_gone",
  /** The collector errored, timed out, or returned something unparsable. */
  "collector_failed",
  /** Deliberately not read (row cap, demand-driven budget). */
  "not_collected",
  /** A sum whose rows are not all measured: a partial total is not a total. */
  "incomplete_coverage",
] as const;

export type ResourceUnavailableReason = (typeof RESOURCE_UNAVAILABLE_REASONS)[number];

/** A number we actually read, or the reason we did not. Never a zero stand-in. */
export type ResourceMeasure =
  | { status: "available"; value: number }
  | { status: "unavailable"; reason: ResourceUnavailableReason; detail?: string };

/** Where a row's numbers came from. `electron` is never a measurement source. */
export type ResourceMeasurementSource = "proc" | "ps" | "cim";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Retained history: age. Independent of every other bound. */
export const RESOURCE_HISTORY_MAX_AGE_MS = 60 * 60_000;
/** Retained history: snapshots. */
export const RESOURCE_HISTORY_MAX_SNAPSHOTS = 3600;
/** Retained history: process rows across all retained snapshots. */
export const RESOURCE_HISTORY_MAX_PROCESS_ROWS = 20_000;
/** Retained history: bytes of retained snapshots. */
export const RESOURCE_HISTORY_MAX_BYTES = 64 * 1024 * 1024;
/** Snapshots one `resource/history` reply may carry. */
export const RESOURCE_HISTORY_PAGE_MAX = 60;
/** Rows one snapshot may carry before discovery stops and says it was cut. */
export const RESOURCE_SNAPSHOT_PROCESS_MAX = 512;
/** Characters of any label. */
export const RESOURCE_LABEL_MAX = 64;
/** Characters of any human-readable detail (a failure reason, a note). */
export const RESOURCE_DETAIL_MAX = 200;
/** Characters of any id repeated on the wire (session, run, task, project). */
export const RESOURCE_ID_MAX = 128;
/** Associated ids of one kind kept on a row before the list is marked truncated. */
export const RESOURCE_ASSOCIATIONS_MAX = 20;
/** Bytes of a diagnostic export document. */
export const RESOURCE_EXPORT_MAX_BYTES = 4 * 1024 * 1024;
/**
 * A repeat request inside this window is answered from the last snapshot,
 * `refresh` or not. The floor is the protection against a client that asks in
 * a loop; an opt-out would remove the protection it exists to provide.
 */
export const RESOURCE_MIN_COLLECT_INTERVAL_MS = 250;
/**
 * A whole snapshot must finish inside this. Rows not reached say
 * `not_collected` rather than making a person wait: macOS measures each
 * process with its own bounded command, and a wide tree could otherwise take
 * a minute.
 */
export const RESOURCE_SNAPSHOT_DEADLINE_MS = 6000;
/** Per-process measurements in flight at once. */
export const RESOURCE_MEASURE_CONCURRENCY = 8;
/** Spawn records kept at once; live project workers are never evicted. */
export const RESOURCE_OWNERSHIP_MAX_RECORDS = 512;
/** A registration nothing has confirmed for this long is forgotten. */
export const RESOURCE_OWNERSHIP_MAX_AGE_MS = 60 * 60_000;
/**
 * How far a reported creation time may sit from the one the operating system
 * reports before the two are not the same process.
 *
 * This is a resolution allowance, not a grace period. Linux derives a start
 * time from boot time plus clock ticks and `btime` is whole seconds; macOS
 * `ps lstart` is whole seconds; Windows is finer than either. One second of
 * disagreement is therefore expected and anything beyond it is not the same
 * process — so the window is a second plus a little, not long enough for a
 * recycled pid to walk through.
 *
 * The limitation this cannot remove is the platforms' own: two processes that
 * take the same pid inside a single second are indistinguishable by start
 * time. Every other guard (the exit callback, the table reconciliation, the
 * per-collection re-verification) is what covers that case.
 */
export const RESOURCE_START_TIME_TOLERANCE_MS = 1500;
/**
 * Rows of the last collected process table kept for verifying a metrics report
 * that arrives between snapshots. Bounded because it is a copy of something
 * that was already read, not a reason to read again.
 */
export const RESOURCE_TABLE_CACHE_MAX_ROWS = 4096;
/** A desktop metrics report older than this is stale and says so. */
export const RESOURCE_REPORT_MAX_AGE_MS = 60_000;
/** Rows one desktop report may carry. */
export const RESOURCE_REPORT_PROCESS_MAX = 256;
/**
 * How far Electron's working set may differ from our own resident figure
 * before the cross-check calls it divergence. They measure differently, so a
 * small gap is expected and a large one is worth saying out loud.
 */
export const RESOURCE_CROSS_CHECK_TOLERANCE = 0.5;

// ---------------------------------------------------------------------------
// Value helpers (pure; shared by the host, its tests and any reader)
// ---------------------------------------------------------------------------

export function resourceAvailable(value: number): ResourceMeasure {
  return { status: "available", value };
}

export function resourceUnavailable(reason: ResourceUnavailableReason, detail?: string): ResourceMeasure {
  const bounded = detail ? boundedResourceText(detail, RESOURCE_DETAIL_MAX) : undefined;
  return bounded ? { status: "unavailable", reason, detail: bounded } : { status: "unavailable", reason };
}

/** A number when we have one, the given reason when we do not. */
export function resourceMeasure(value: number | undefined, reason: ResourceUnavailableReason, detail?: string): ResourceMeasure {
  return value === undefined || !Number.isFinite(value) ? resourceUnavailable(reason, detail) : resourceAvailable(value);
}

/** Cut any free text to its bound. Never throws, never returns undefined for a non-empty input. */
export function boundedResourceText(text: string, max = RESOURCE_DETAIL_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) : flat;
}

/**
 * A label safe to show and safe to store: letters, digits and `. _ -` only,
 * bounded. Everything else becomes `-`, so a hostile executable name, project
 * directory or window title cannot smuggle text through a diagnostic.
 */
export function sanitizeResourceLabel(text: string, max = RESOURCE_LABEL_MAX): string {
  const cleaned = text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) return "unknown";
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

/** Bound an id list and say when it was cut. Ids themselves are length-bounded. */
export function boundedResourceIds(ids: readonly string[], max = RESOURCE_ASSOCIATIONS_MAX): { ids: string[]; truncated: boolean } {
  const kept = ids.slice(0, max).map((id) => (id.length > RESOURCE_ID_MAX ? id.slice(0, RESOURCE_ID_MAX) : id));
  return { ids: kept, truncated: ids.length > max };
}

// ---------------------------------------------------------------------------
// The inventory
// ---------------------------------------------------------------------------

/**
 * Work a process is associated with. These are **associations, not an
 * allocation**: a project worker hosts many sessions and runs in one address
 * space, and nothing here claims to divide its memory between them.
 */
export interface ResourceAssociations {
  /** Durable session ids — never session file paths. */
  sessionIds?: string[];
  runIds?: string[];
  taskIds?: string[];
  /** At least one list hit {@link RESOURCE_ASSOCIATIONS_MAX}. */
  truncated?: boolean;
}

/** A project, without its path: an opaque salted id and a sanitized label. */
export interface ResourceProject {
  /** Opaque and stable for one host run. Not derivable back to a directory. */
  id: string;
  /** Sanitized basename, for a person reading a row. */
  label: string;
}

export interface ResourceProcessMemory {
  /** Proportional set size (Linux `smaps_rollup`): shared pages counted once. */
  pss: ResourceMeasure;
  /** Resident set / working set. Counts shared pages in full; never a total. */
  resident: ResourceMeasure;
  /** High-water mark of the above. */
  peakResident: ResourceMeasure;
  /** Private resident / macOS physical footprint: pages nobody else holds. */
  privateResident: ResourceMeasure;
  /** Private commit (Windows). */
  commit: ResourceMeasure;
}

export interface ResourceProcess {
  /** `${pid}@${startToken}` — the only identity anything may be attached to. */
  key: string;
  pid: number;
  /**
   * Opaque platform token for *this run* of the pid: Linux boot id plus start
   * ticks, `ps lstart` elsewhere, CIM `CreationDate` on Windows.
   */
  startToken: string;
  ppid?: number;
  /** Present when the parent is in this inventory too. */
  parentKey?: string;
  role: ResourceProcessRole;
  /** Sanitized executable basename. Never argv, never a path. */
  label: string;
  project?: ResourceProject;
  associations?: ResourceAssociations;
  memory: ResourceProcessMemory;
  cpu: { seconds: ResourceMeasure };
  elapsedMs: ResourceMeasure;
  io: { readBytes: ResourceMeasure; writeBytes: ResourceMeasure };
  source: ResourceMeasurementSource;
  /**
   * Electron's own view of a row we discovered and verified ourselves. Pure
   * cross-check metadata: a working set is not private memory, and this never
   * feeds a total.
   */
  electron?: { type: string; workingSetBytes: ResourceMeasure; reportAgeMs: number };
}

/** How much of a sum was actually measured. A partial sum is never a total. */
export interface ResourceCoverage {
  processes: number;
  measured: number;
  complete: boolean;
}

export interface ResourceTotals {
  /** Coverage of the physical figure below. */
  coverage: ResourceCoverage;
  /** Sum over measured rows only. Honest name: it is what we know, not the total. */
  knownPhysicalBytes: number;
  /** Available only when `coverage.complete`; otherwise `incomplete_coverage`. */
  physical: ResourceMeasure;
  residentCoverage: ResourceCoverage;
  /** Sum of resident sizes. Double counts shared pages by construction. */
  knownResidentBytes: number;
  residentSum: ResourceMeasure;
}

export interface ResourceRoleTotals {
  role: ResourceProcessRole;
  coverage: ResourceCoverage;
  knownPhysicalBytes: number;
  physical: ResourceMeasure;
}

export interface ResourceCollectorStatus {
  name: string;
  status: "ok" | "failed" | "unsupported";
  detail?: string;
}

/** Whether Electron's own metrics could be trusted and used for this snapshot. */
export type ResourceCrossCheckStatus =
  /** Verified report, rows agree within tolerance. */
  | "ok"
  /** Verified report, at least one row differs beyond tolerance. */
  | "diverged"
  /** A report exists but is older than {@link RESOURCE_REPORT_MAX_AGE_MS}. */
  | "stale"
  /** A report arrived and could not be tied to this host's own process tree. */
  | "unverified"
  /** No report yet — the usual state of the first snapshot after a start. */
  | "unavailable";

export interface ResourceHealth {
  ok: boolean;
  collectors: ResourceCollectorStatus[];
  /** Discovery hit {@link RESOURCE_SNAPSHOT_PROCESS_MAX}: a partial truth, said out loud. */
  truncated: boolean;
  crossCheck: { status: ResourceCrossCheckStatus; detail?: string };
}

export interface ResourceSnapshot {
  id: string;
  at: string;
  platform: "linux" | "darwin" | "win32" | "other";
  durationMs: number;
  processes: ResourceProcess[];
  totals: ResourceTotals;
  byRole: ResourceRoleTotals[];
  health: ResourceHealth;
}

export interface ResourceRetention {
  maxAgeMs: number;
  maxSnapshots: number;
  maxProcessRows: number;
  maxBytes: number;
  snapshots: number;
  processRows: number;
  bytes: number;
  /** Which independent bound evicted last, so retention can be explained. */
  lastEvictedBy?: "age" | "snapshots" | "rows" | "bytes";
  /** Spawn records held right now, and their own independent bound. */
  ownershipRecords: number;
  maxOwnershipRecords: number;
  /**
   * Set when more records are held than the bound above, which happens only
   * when that many project workers are proved live at once: a record for a
   * running worker is the only proof of what that process is, so it is kept
   * and the overflow is said out loud rather than implied away.
   */
  ownershipOverflow?: "live_workers";
}

// ---------------------------------------------------------------------------
// Inputs the host accepts
// ---------------------------------------------------------------------------

/**
 * Electron's `app.getAppMetrics()`, reduced to what a cross-check needs.
 *
 * Accepted only over a local connection, only as metrics, and only after the
 * host has verified the claim against its **own** process table: the reported
 * main process exists with the creation time the report gives it, and every
 * accepted row is in that main's current subtree with its own creation time
 * matching. Nothing about ancestry of the host is required — a host the shell
 * adopted rather than spawned is the normal case — and a row that cannot be
 * verified is rejected on its own. The report never creates a row, never
 * relabels an unrelated process, and carries no control verb.
 *
 * `creationTime` is Electron's own `ProcessMetric.creationTime`: milliseconds
 * since the epoch. It is what stops a recycled renderer pid from inheriting
 * the metrics of the renderer that used to hold it.
 */
export interface ResourceDesktopReport {
  /** ISO time the metrics were taken. Advisory: the host times its own receipt. */
  at: string;
  main: { pid: number; creationTime?: number };
  processes: Array<{
    pid: number;
    creationTime?: number;
    /** Electron's own process type (`Browser`, `Tab`, `GPU`, `Utility`, …). */
    type: string;
    workingSetBytes?: number;
  }>;
}

/** What the host did with a report. Counts are rows it can actually use. */
export interface ResourceReportResult {
  /** Rows tied to a real process in the verified subtree. */
  accepted: number;
  /** Rows refused: unknown pid, wrong creation time, outside the subtree. */
  rejected: number;
  verified: boolean;
  /** The host has no process table yet; the report is verified at the next snapshot. */
  pending?: true;
}

/**
 * A pid a host subsystem knows the meaning of, registered as it is spawned.
 *
 * This is the contract RP-6 (background commands) and RP-7 (helpers) publish
 * into, including through a worker-originated typed report: the worker is the
 * only party that knows which session a command belongs to. `sessionPath` is
 * host-internal and is resolved to a durable session id before anything
 * reaches a client, a history entry or an export.
 */
export interface ResourceProcessRegistration {
  pid: number;
  role: "background_command" | "helper";
  /** Host-internal only. Never echoed to a client. */
  sessionPath?: string;
  taskId?: string;
  runId?: string;
  /** Sanitized when present; the collector otherwise uses the executable basename. */
  label?: string;
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/**
 * Validation for this family, beside the types it validates.
 *
 * `schemas.ts` stays the registry that maps a method to its schema; the shapes
 * themselves live where the vocabulary does, so a change to a type and its
 * validation is one file, not two.
 */
const resourcePidSchema = z.number().int().positive().max(0xffffffff);
const creationTimeSchema = z.number().finite().nonnegative();

export const resourceDesktopReportSchema = z
  .object({
    at: z.string().min(1).max(64),
    main: z.object({ pid: resourcePidSchema, creationTime: creationTimeSchema.optional() }).strict(),
    processes: z
      .array(
        z
          .object({
            pid: resourcePidSchema,
            creationTime: creationTimeSchema.optional(),
            type: z.string().min(1).max(RESOURCE_LABEL_MAX),
            workingSetBytes: z.number().nonnegative().finite().optional(),
          })
          .strict(),
      )
      .max(RESOURCE_REPORT_PROCESS_MAX),
  })
  .strict();

/**
 * A pid whose meaning a host subsystem knows (RP-6 background commands, RP-7
 * helpers), including one arriving in a worker-originated typed report. The
 * host validates it here before it may name anything.
 */
export const resourceProcessRegistrationSchema = z
  .object({
    pid: resourcePidSchema,
    role: z.enum(["background_command", "helper"]),
    sessionPath: z.string().min(1).max(4096).optional(),
    taskId: z.string().min(1).max(RESOURCE_ID_MAX).optional(),
    runId: z.string().min(1).max(RESOURCE_ID_MAX).optional(),
    label: z.string().min(1).max(RESOURCE_LABEL_MAX).optional(),
  })
  .strict();

/** Method → params, for the registry in `schemas.ts`. */
export const resourceParamsSchemas = {
  "resource/snapshot": z.object({ refresh: z.boolean().optional() }).strict(),
  "resource/history": z
    .object({ sinceId: z.string().min(1).max(RESOURCE_ID_MAX).optional(), limit: z.number().int().positive().max(RESOURCE_HISTORY_PAGE_MAX).optional() })
    .strict(),
  "resource/export": z.object({}).strict(),
  "resource/report": resourceDesktopReportSchema,
};

declare module "./messages.js" {
  interface ClientRequests {
    /**
     * Collect now (or answer from the snapshot taken within
     * {@link RESOURCE_MIN_COLLECT_INTERVAL_MS}). Collection happens because
     * somebody asked; nothing samples in the background.
     */
    "resource/snapshot": {
      params: { refresh?: boolean };
      result: { snapshot: ResourceSnapshot; retention: ResourceRetention };
    };
    /** Bounded page over retained history, newest last. */
    "resource/history": {
      params: { sinceId?: string; limit?: number };
      result: { snapshots: ResourceSnapshot[]; retention: ResourceRetention };
    };
    /** Redacted diagnostic document built from the same sanitized rows. */
    "resource/export": {
      params: {};
      result: { document: string; bytes: number; truncated: boolean };
    };
    /**
     * Local desktop shell only. Metrics for cross-checking; never control, and
     * never a source of rows the host did not discover itself.
     */
    "resource/report": {
      params: ResourceDesktopReport;
      result: ResourceReportResult;
    };
  }

  interface HostNotifications {
    /**
     * Somebody asked for a snapshot and the desktop's metrics were missing or
     * stale. The shell answers with one `resource/report`. There is no polling:
     * with diagnostics closed, nothing asks and nothing is collected.
     */
    "resource/refresh_request": {};
  }
}
