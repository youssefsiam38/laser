/**
 * ResourceService — the host's process inventory (RP-1).
 *
 * Demand-driven: a snapshot happens because somebody asked for one. Nothing
 * samples on a timer, so with diagnostics closed this file costs nothing.
 *
 * Discovery is structural. The roots are processes the host can *prove* it
 * knows in the table it just collected — itself, the workers it spawned, the
 * pids its subsystems registered, and the desktop shell once that shell's
 * claim has been checked against the same table. Everything else in the
 * inventory is there because it descends from one of those, and is honestly
 * labelled `unknown_descendant` rather than guessed at from a command line.
 *
 * Four promises hold this together:
 *
 * - **Identity.** Nothing is attached to a pid; everything is attached to
 *   `(pid, startToken)`, and identity is always taken from one collected
 *   table. A record the table contradicts is pruned, not reinterpreted, so a
 *   reused pid inherits neither a role, an owner nor a number.
 * - **Honest gaps.** A counter we could not read is `unavailable` with a
 *   reason. A sum whose rows are not all measured is not presented as a total.
 *   A cross-check with nothing to compare is not "ok".
 * - **Nothing sensitive.** No argv, no environment, no paths: a project is an
 *   opaque salted id with a sanitized basename, a session is its durable id,
 *   a process is its sanitized executable basename.
 * - **No blast radius.** Every collector call is wrapped, bounded and
 *   asynchronous; the whole snapshot has a deadline and a concurrency limit.
 *   A failure becomes a health entry. Nothing here can touch a worker, a
 *   session or a process — there is no control verb in this slice at all.
 */
import {
  RESOURCE_CROSS_CHECK_TOLERANCE,
  RESOURCE_EXPORT_MAX_BYTES,
  RESOURCE_MEASURE_CONCURRENCY,
  RESOURCE_MIN_COLLECT_INTERVAL_MS,
  RESOURCE_REPORT_MAX_AGE_MS,
  RESOURCE_SNAPSHOT_DEADLINE_MS,
  RESOURCE_SNAPSHOT_PROCESS_MAX,
  RESOURCE_START_TIME_TOLERANCE_MS,
  boundedResourceIds,
  boundedResourceText,
  resourceAvailable,
  resourceUnavailable,
  sanitizeResourceLabel,
  type ResourceAssociations,
  type ResourceCollectorStatus,
  type ResourceCoverage,
  type ResourceCrossCheckStatus,
  type ResourceDesktopReport,
  type ResourceMeasure,
  type ResourceProcess,
  type ResourceProcessRole,
  type ResourceProject,
  type ResourceReportResult,
  type ResourceRetention,
  type ResourceRoleTotals,
  type ResourceSnapshot,
  type ResourceTotals,
} from "@lasercode/protocol";
import { processKey } from "./identity.js";
import { ResourceHistory, type ResourceHistoryOptions } from "./history.js";
import { ProcessOwnershipRegistry, type OwnershipLookups, type OwnershipRecord } from "./ownership.js";
import { LinuxProcessCollector } from "./linux.js";
import { DarwinProcessCollector } from "./darwin.js";
import { WindowsProcessCollector } from "./windows.js";
import { unavailableMetrics, type ProcessCollector, type ProcessRowMetrics, type ProcessTableRow } from "./platform.js";

export interface ResourceServiceOptions {
  /** Override the platform collector (tests, and a platform we do not support). */
  collector?: ProcessCollector;
  platform?: NodeJS.Platform;
  hostPid?: number;
  procRoot?: string;
  lookups?: OwnershipLookups;
  history?: ResourceHistoryOptions;
  /** Floor between collections. Applies to `refresh` too; 0 only in tests. */
  minIntervalMs?: number;
  /** Whole-snapshot deadline; rows not reached say `not_collected`. */
  deadlineMs?: number;
  measureConcurrency?: number;
  now?: () => number;
  /** Asks the desktop shell for fresh metrics. Never a poll: one request per demand. */
  requestDesktopRefresh?: () => void;
}

interface VerifiedReport {
  /** Verified rows, keyed by the identity the host itself observed. */
  rows: Map<string, { type: string; workingSetBytes?: number }>;
  /** The app's main process, as this host identified it. */
  main: { pid: number; key: string };
  receivedAtMs: number;
  accepted: number;
  rejected: number;
}

const ELECTRON_ROLES: Array<[RegExp, ResourceProcessRole]> = [
  [/^browser$/i, "desktop_main"],
  [/^(tab|renderer)$/i, "desktop_renderer"],
  [/^gpu$/i, "desktop_gpu"],
];

export class ResourceService {
  readonly ownership: ProcessOwnershipRegistry;
  private readonly history: ResourceHistory;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly hostPid: number;
  private collector: ProcessCollector | undefined;
  private collectorFailure: string | undefined;
  /** The last report a table proved. Kept when a later, worse one arrives. */
  private report: VerifiedReport | undefined;
  /** The claim itself, re-checked against every new table. */
  private claim: { report: ResourceDesktopReport; receivedAtMs: number } | undefined;
  private rejectedReport: string | undefined;
  private last: { snapshot: ResourceSnapshot; atMs: number } | undefined;
  private inFlight: Promise<ResourceSnapshot> | undefined;
  private counter = 0;

  constructor(private readonly options: ResourceServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.hostPid = options.hostPid ?? process.pid;
    this.ownership = new ProcessOwnershipRegistry(options.lookups ?? {}, { now: this.now });
    this.history = new ResourceHistory({ now: this.now, ...options.history });
  }

  // ----------------------------------------------------------------- reads

  /**
   * Collect, or answer from the last snapshot when one was taken inside the
   * floor. `refresh` expresses intent, not entitlement: a client asking in a
   * loop must not be able to turn a diagnostic into a load generator, so the
   * floor applies to it too. Concurrent askers share one collection.
   */
  async snapshot(params: { refresh?: boolean } = {}): Promise<{ snapshot: ResourceSnapshot; retention: ResourceRetention }> {
    const minInterval = this.options.minIntervalMs ?? RESOURCE_MIN_COLLECT_INTERVAL_MS;
    if (this.last && this.now() - this.last.atMs < minInterval) {
      return { snapshot: this.last.snapshot, retention: this.retention() };
    }
    this.inFlight ??= this.collect().finally(() => {
      this.inFlight = undefined;
    });
    const snapshot = await this.inFlight;
    return { snapshot, retention: this.retention() };
  }

  historyPage(params: { sinceId?: string; limit?: number } = {}): { snapshots: ResourceSnapshot[]; retention: ResourceRetention } {
    return { snapshots: this.history.page(params), retention: this.retention() };
  }

  /**
   * A diagnostic document built from the same sanitized rows — there is no
   * second, richer copy of anything to leak.
   *
   * The byte bound is absolute: oldest snapshots go first, and if one snapshot
   * is still too large its process rows are trimmed. The result is always
   * valid JSON that says what was left out.
   *
   * Each snapshot is serialized once and its size reused, and the document is
   * emitted in the same compact form it was measured in — a bound checked
   * against a different rendering than the one that leaves the host is not a
   * bound at all.
   */
  export(): { document: string; bytes: number; truncated: boolean } {
    const retention = this.retention();
    const serialized = this.history.page({ limit: 60 }).map((snapshot) => ({ snapshot, bytes: Buffer.byteLength(JSON.stringify(snapshot), "utf8") }));
    const envelope = 512; // the wrapper's own fields, generously
    let truncated = false;

    let total = serialized.reduce((sum, entry) => sum + entry.bytes, 0) + envelope;
    while (serialized.length > 1 && total > RESOURCE_EXPORT_MAX_BYTES) {
      total -= serialized.shift()!.bytes;
      truncated = true;
    }

    let snapshots = serialized.map((entry) => entry.snapshot);
    if (total > RESOURCE_EXPORT_MAX_BYTES && snapshots.length === 1) {
      // One snapshot larger than the whole budget: keep its shape and its
      // totals, and say how many rows were left out rather than emitting
      // something that is not the document it claims to be.
      const only = snapshots[0]!;
      const perRow = Math.max(1, Math.floor((only.processes.length ? Buffer.byteLength(JSON.stringify(only.processes), "utf8") : 1) / Math.max(1, only.processes.length)));
      const room = Math.max(0, RESOURCE_EXPORT_MAX_BYTES - envelope * 4);
      const keep = Math.max(1, Math.floor(room / perRow));
      snapshots = [{ ...only, processes: only.processes.slice(0, keep) }];
      truncated = true;
    }

    for (;;) {
      const document = JSON.stringify({ at: new Date(this.now()).toISOString(), platform: this.platformName(), retention, truncated, snapshots });
      const bytes = Buffer.byteLength(document, "utf8");
      if (bytes <= RESOURCE_EXPORT_MAX_BYTES || snapshots.length <= 1) return { document, bytes, truncated };
      // The estimate was close but not exact (a wide row, a long label): drop
      // the oldest and check the real bytes again rather than hope.
      snapshots = snapshots.slice(1);
      truncated = true;
    }
  }

  // ---------------------------------------------------------------- inputs

  /**
   * Electron's metrics, from the local shell.
   *
   * The claim is checked against the host's own process table: the reported
   * main must be a process that exists, with the creation time the report
   * gives it, and every accepted row must be in that main's subtree *now*,
   * with its own creation time matching. No relationship to the host is
   * required — a host the shell adopted rather than spawned is ordinary — and
   * a row that cannot be verified is rejected on its own.
   *
   * A rejected report never displaces a verified one: the cross-check keeps
   * the last thing it could prove, and says how old it is.
   */
  async receiveDesktopReport(report: ResourceDesktopReport): Promise<ResourceReportResult> {
    const previousClaim = this.claim;
    const previousReport = this.report;
    this.claim = { report, receivedAtMs: this.now() };
    const table = await this.readTable([]);
    if (table.length === 0) {
      // No table: the claim waits for the next snapshot rather than being
      // believed or thrown away.
      return { accepted: 0, rejected: 0, verified: false, pending: true };
    }
    const verified = this.verifyClaim(table);
    if (verified && verified !== previousReport) {
      return { accepted: verified.accepted, rejected: verified.rejected, verified: true };
    }
    // This claim proved nothing. The last one that did keeps standing, and the
    // claim the host re-checks stays the one it could believe.
    this.claim = previousClaim;
    return { accepted: 0, rejected: report.processes.length, verified: false };
  }

  /** RP-6 / RP-7 publish background-command and helper pids here. */
  observeProcessRegistrations(projectCwd: string | undefined, registrations: readonly unknown[]): number {
    return this.ownership.observeProcessRegistrations(projectCwd, registrations);
  }

  // ------------------------------------------------------------ collection

  private async collect(): Promise<ResourceSnapshot> {
    const started = this.now();
    const deadline = started + (this.options.deadlineMs ?? RESOURCE_SNAPSHOT_DEADLINE_MS);
    const collectors: ResourceCollectorStatus[] = [];
    const table = await this.readTable(collectors);
    const byPid = new Map<number, ProcessTableRow>();
    for (const row of table) byPid.set(row.pid, row);

    const children = new Map<number, ProcessTableRow[]>();
    for (const row of table) {
      if (row.ppid === undefined) continue;
      const list = children.get(row.ppid);
      if (list) list.push(row);
      else children.set(row.ppid, [row]);
    }

    // Records are proved against this table before they can be a root; stale
    // ones are pruned here and add nothing to discovery.
    const live = table.length > 0 ? this.ownership.reconcile(table) : [];
    const records = new Map<string, OwnershipRecord>();
    for (const record of live) {
      if (record.startToken) records.set(processKey(record.pid, record.startToken), record);
    }

    const verified = table.length > 0 ? this.verifyClaim(table) : this.report;
    const desktopRoot = this.desktopRootIn(byPid, verified);

    const roots: ProcessTableRow[] = [];
    const pushRoot = (row: ProcessTableRow | undefined): void => {
      if (row && !roots.some((existing) => existing.pid === row.pid)) roots.push(row);
    };
    pushRoot(desktopRoot);
    pushRoot(byPid.get(this.hostPid));
    for (const record of live) pushRoot(byPid.get(record.pid));

    const kept: ProcessTableRow[] = [];
    const seen = new Set<number>();
    let truncated = false;
    const queue = [...roots];
    while (queue.length > 0) {
      const row = queue.shift()!;
      if (seen.has(row.pid)) continue;
      seen.add(row.pid);
      if (kept.length >= RESOURCE_SNAPSHOT_PROCESS_MAX) {
        truncated = true;
        break;
      }
      kept.push(row);
      for (const child of children.get(row.pid) ?? []) queue.push(child);
    }
    const keptPids = new Set(kept.map((row) => row.pid));

    const metrics = await this.measureAll(kept, collectors, deadline);
    if (metrics.skipped > 0) truncated = true;

    const processes: ResourceProcess[] = [];
    // Kept rows are in breadth-first order from the roots, so a parent is
    // always described before its children and inheritance can walk upward
    // through what is already there.
    const context = new Map<string, { project?: ResourceProject; associations?: ResourceAssociations }>();
    for (const [index, row] of kept.entries()) {
      const described = this.describe(row, metrics.rows[index]!, byPid, keptPids, records, verified, context);
      processes.push(described);
    }

    const crossCheck = this.crossCheck(processes, verified);
    const snapshot: ResourceSnapshot = {
      id: `rs_${++this.counter}`,
      at: new Date(started).toISOString(),
      platform: this.platformName(),
      durationMs: Math.max(0, this.now() - started),
      processes,
      totals: totalsOf(processes),
      byRole: roleTotalsOf(processes),
      health: {
        ok: collectors.every((entry) => entry.status !== "failed"),
        collectors,
        truncated,
        crossCheck,
      },
    };

    this.history.add(snapshot);
    this.last = { snapshot, atMs: this.now() };
    // Ask the shell for fresh metrics *after* answering: the next question gets
    // a current cross-check, and nothing polls in between.
    if (crossCheck.status !== "ok") this.options.requestDesktopRefresh?.();
    return snapshot;
  }

  /**
   * Measure the kept rows with a bounded number in flight and a deadline over
   * the whole set. macOS measures each process with its own subprocess, so
   * without both of these one snapshot of a wide tree could take a minute.
   */
  private async measureAll(
    rows: ProcessTableRow[],
    collectors: ResourceCollectorStatus[],
    deadline: number,
  ): Promise<{ rows: ProcessRowMetrics[]; skipped: number }> {
    const out = new Array<ProcessRowMetrics>(rows.length);
    const concurrency = Math.max(1, this.options.measureConcurrency ?? RESOURCE_MEASURE_CONCURRENCY);
    let next = 0;
    let skipped = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= rows.length) return;
        if (this.now() >= deadline) {
          out[index] = unavailableMetrics("not_collected", "the snapshot's time budget was reached");
          skipped += 1;
          continue;
        }
        out[index] = await this.measure(rows[index]!, collectors);
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, rows.length)) }, () => worker()));
    return { rows: out, skipped };
  }

  private async readTable(collectors: ResourceCollectorStatus[]): Promise<ProcessTableRow[]> {
    const collector = this.ensureCollector();
    if (!collector) {
      collectors.push({ name: `${this.platform}-unsupported`, status: "unsupported", detail: boundedResourceText(this.collectorFailure ?? `no process collector for ${this.platform}`) });
      return [];
    }
    try {
      const table = await collector.table();
      collectors.push({ name: collector.name, status: "ok" });
      return table;
    } catch (error) {
      collectors.push({ name: collector.name, status: "failed", detail: boundedResourceText(messageOf(error)) });
      return [];
    }
  }

  private async measure(row: ProcessTableRow, collectors: ResourceCollectorStatus[]): Promise<ProcessRowMetrics> {
    const collector = this.ensureCollector();
    if (!collector) return unavailableMetrics("unsupported_platform");
    try {
      return await collector.measure(row);
    } catch (error) {
      // One unreadable process costs that row its numbers, nothing else.
      if (!collectors.some((entry) => entry.name === `${collector.name}-measure`)) {
        collectors.push({ name: `${collector.name}-measure`, status: "failed", detail: boundedResourceText(messageOf(error)) });
      }
      return unavailableMetrics("collector_failed", messageOf(error));
    }
  }

  private ensureCollector(): ProcessCollector | undefined {
    if (this.options.collector) return this.options.collector;
    if (this.collector) return this.collector;
    if (this.collectorFailure) return undefined;
    try {
      if (this.platform === "linux") this.collector = new LinuxProcessCollector(this.options.procRoot ? { procRoot: this.options.procRoot } : {});
      else if (this.platform === "darwin") this.collector = new DarwinProcessCollector();
      else if (this.platform === "win32") this.collector = new WindowsProcessCollector();
      else this.collectorFailure = `${this.platform} has no process collector`;
    } catch (error) {
      this.collectorFailure = messageOf(error);
    }
    return this.collector;
  }

  // ------------------------------------------------------- desktop metrics

  /**
   * Check the shell's claim against one collected table. Rows that survive are
   * keyed by the identity the host observed, so a later table that disagrees
   * simply stops matching them.
   */
  private verifyClaim(table: readonly ProcessTableRow[]): VerifiedReport | undefined {
    const claim = this.claim;
    if (!claim) return this.report;
    const byPid = new Map<number, ProcessTableRow>();
    for (const row of table) byPid.set(row.pid, row);

    const main = byPid.get(claim.report.main.pid);
    if (!main || !startsWhenClaimed(main, claim.report.main.creationTime)) {
      this.rejectedReport = main
        ? "the reported app process is not the one running under that process id"
        : "the reported app process is not running on this machine";
      return this.report; // Keep the last thing we could prove.
    }

    const subtree = descendantsOf(main.pid, table);
    const rows = new Map<string, { type: string; workingSetBytes?: number }>();
    let rejected = 0;
    for (const reported of claim.report.processes) {
      const row = byPid.get(reported.pid);
      if (!row || !subtree.has(row.pid) || !startsWhenClaimed(row, reported.creationTime)) {
        rejected += 1;
        continue;
      }
      rows.set(processKey(row.pid, row.startToken), {
        // Untrusted text from a local client, and it is retained and exported:
        // it is sanitized and bounded before it is kept, not when it is shown.
        type: sanitizeResourceLabel(reported.type, 32),
        ...(reported.workingSetBytes !== undefined ? { workingSetBytes: reported.workingSetBytes } : {}),
      });
    }

    if (rows.size === 0) {
      this.rejectedReport = "no reported process could be tied to the app's own process tree";
      return this.report;
    }
    this.rejectedReport = undefined;
    this.report = {
      rows,
      main: { pid: main.pid, key: processKey(main.pid, main.startToken) },
      receivedAtMs: claim.receivedAtMs,
      accepted: rows.size,
      rejected,
    };
    return this.report;
  }

  /** The verified desktop main in this table, if this table still shows it. */
  private desktopRootIn(byPid: Map<number, ProcessTableRow>, verified: VerifiedReport | undefined): ProcessTableRow | undefined {
    if (!verified) return undefined;
    const row = byPid.get(verified.main.pid);
    return row && processKey(row.pid, row.startToken) === verified.main.key ? row : undefined;
  }

  private describe(
    row: ProcessTableRow,
    metrics: ProcessRowMetrics,
    byPid: Map<number, ProcessTableRow>,
    keptPids: Set<number>,
    records: Map<string, OwnershipRecord>,
    verified: VerifiedReport | undefined,
    context: Map<string, { project?: ResourceProject; associations?: ResourceAssociations }>,
  ): ResourceProcess {
    const key = processKey(row.pid, row.startToken);
    const record = records.get(key);
    const electron = verified?.rows.get(key);

    let role: ResourceProcessRole = "unknown_descendant";
    if (row.pid === this.hostPid) role = "host";
    else if (record) role = record.role;
    else if (verified && key === verified.main.key) role = "desktop_main";
    else if (electron) role = electronRole(electron.type);

    const parent = row.ppid !== undefined ? byPid.get(row.ppid) : undefined;
    // Only a row that is actually in this snapshot may be pointed at: a
    // truncated collection must not leave a link to something nobody can read.
    const parentKey = parent && keptPids.has(parent.pid) ? processKey(parent.pid, parent.startToken) : undefined;

    let project = record?.projectCwd ? this.ownership.projectIdentity(record.projectCwd) : undefined;
    let associations = this.associationsFor(record);
    if (!record && parentKey) {
      // A descendant nobody registered still belongs somewhere: it inherits
      // the nearest proved ancestor's project and work ids as *context*. It
      // keeps the role `unknown_descendant`, and none of its memory is
      // attributed to that work — an association is not an allocation.
      const inherited = context.get(parentKey);
      project = inherited?.project;
      associations = inherited?.associations;
    }
    context.set(key, { ...(project ? { project } : {}), ...(associations ? { associations } : {}) });

    return {
      key,
      pid: row.pid,
      startToken: row.startToken,
      ...(row.ppid !== undefined ? { ppid: row.ppid } : {}),
      ...(parentKey ? { parentKey } : {}),
      role,
      label: record?.label ?? row.label,
      ...(project ? { project } : {}),
      ...(associations ? { associations } : {}),
      memory: metrics.memory,
      cpu: metrics.cpu,
      elapsedMs: metrics.elapsedMs,
      io: metrics.io,
      source: (this.options.collector ?? this.collector)?.source ?? "proc",
      ...(electron && verified
        ? {
            electron: {
              type: electron.type,
              workingSetBytes: electron.workingSetBytes === undefined
                ? resourceUnavailable("not_collected", "the app reported no working set for this process")
                : resourceAvailable(electron.workingSetBytes),
              reportAgeMs: Math.max(0, this.now() - verified.receivedAtMs),
            },
          }
        : {}),
    };
  }

  /** Work a process is associated with. Never an allocation of its memory. */
  private associationsFor(record: OwnershipRecord | undefined): ResourceAssociations | undefined {
    if (!record) return undefined;
    const lookups = this.ownership.lookups;
    const sessions: string[] = [];
    const runs: string[] = [];
    const tasks: string[] = [];
    try {
      if (record.projectCwd) {
        sessions.push(...(lookups.sessionIdsOf?.(record.projectCwd) ?? []));
        runs.push(...(lookups.runIdsOf?.(record.projectCwd) ?? []));
        tasks.push(...(lookups.taskIdsOf?.(record.projectCwd) ?? []));
      }
      if (record.sessionPath) {
        const id = this.ownership.sessionIdOf(record.sessionPath);
        if (id) sessions.push(id);
      }
    } catch {
      // A catalog that cannot answer costs the row its associations, not the snapshot.
    }
    if (record.runId) runs.push(record.runId);
    if (record.taskId) tasks.push(record.taskId);

    const sessionIds = boundedResourceIds([...new Set(sessions)]);
    const runIds = boundedResourceIds([...new Set(runs)]);
    const taskIds = boundedResourceIds([...new Set(tasks)]);
    const truncated = sessionIds.truncated || runIds.truncated || taskIds.truncated;
    if (sessionIds.ids.length === 0 && runIds.ids.length === 0 && taskIds.ids.length === 0) return undefined;
    return {
      ...(sessionIds.ids.length ? { sessionIds: sessionIds.ids } : {}),
      ...(runIds.ids.length ? { runIds: runIds.ids } : {}),
      ...(taskIds.ids.length ? { taskIds: taskIds.ids } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  }

  /**
   * The cross-check is a comparison, so it reports what it actually compared.
   * Rows the shell described but whose memory neither side could measure prove
   * nothing, and a cross-check with no comparable pair is never "ok".
   */
  private crossCheck(processes: ResourceProcess[], verified: VerifiedReport | undefined): { status: ResourceCrossCheckStatus; detail?: string } {
    if (!verified) {
      return this.rejectedReport
        ? { status: "unverified", detail: boundedResourceText(this.rejectedReport) }
        : { status: "unavailable", detail: "the app has not reported its own metrics yet" };
    }
    // Age is measured from when the host received it. A client clock — or a
    // client — cannot keep a stale report looking fresh.
    const ageMs = this.now() - verified.receivedAtMs;
    if (ageMs > RESOURCE_REPORT_MAX_AGE_MS) {
      return { status: "stale", detail: "the app's metrics are older than a minute; a refresh was requested" };
    }

    let compared = 0;
    let diverged: ResourceProcess | undefined;
    for (const row of processes) {
      const theirs = row.electron?.workingSetBytes;
      const ours = row.memory.resident;
      if (!theirs || theirs.status !== "available" || ours.status !== "available") continue;
      compared += 1;
      const scale = Math.max(theirs.value, ours.value);
      if (scale > 0 && Math.abs(theirs.value - ours.value) / scale > RESOURCE_CROSS_CHECK_TOLERANCE) diverged ??= row;
    }
    if (compared === 0) {
      return { status: "unverified", detail: "the app's metrics carried no figure this host could compare" };
    }
    if (diverged) {
      return { status: "diverged", detail: `${diverged.label} differs from the app's own working set by more than ${Math.round(RESOURCE_CROSS_CHECK_TOLERANCE * 100)}%` };
    }
    return { status: "ok" };
  }

  private retention(): ResourceRetention {
    return { ...this.history.retention(), ownershipRecords: this.ownership.size(), maxOwnershipRecords: this.ownership.maxRecordsBound };
  }

  private platformName(): ResourceSnapshot["platform"] {
    return this.platform === "linux" || this.platform === "darwin" || this.platform === "win32" ? this.platform : "other";
  }
}

/** Does this process's start time match what an outside claim says it is? */
function startsWhenClaimed(row: ProcessTableRow, creationTime: number | undefined): boolean {
  // A claim with no creation time, or a platform that cannot say when a
  // process started, cannot be checked — and an unverifiable row is refused
  // rather than believed.
  if (creationTime === undefined || row.startedAtMs === undefined) return false;
  return Math.abs(row.startedAtMs - creationTime) <= RESOURCE_START_TIME_TOLERANCE_MS;
}

/** Every pid under `root` in this table, including the root itself. */
function descendantsOf(root: number, table: readonly ProcessTableRow[]): Set<number> {
  const children = new Map<number, number[]>();
  for (const row of table) {
    if (row.ppid === undefined) continue;
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  const out = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

/**
 * The physical figure for one row: PSS where the platform has it, otherwise
 * private resident. A resident/working set is never used — counting shared
 * pages in full and calling the sum "memory used" is the dishonest metric
 * RP-1 exists to avoid.
 */
export function physicalOf(row: ResourceProcess): number | undefined {
  if (row.memory.pss.status === "available") return row.memory.pss.value;
  if (row.memory.privateResident.status === "available") return row.memory.privateResident.value;
  return undefined;
}

function coverageOf(processes: ResourceProcess[], measured: number): ResourceCoverage {
  return { processes: processes.length, measured, complete: processes.length > 0 && measured === processes.length };
}

function sum(processes: ResourceProcess[], pick: (row: ResourceProcess) => number | undefined): { total: number; measured: number } {
  let total = 0;
  let measured = 0;
  for (const row of processes) {
    const value = pick(row);
    if (value === undefined) continue;
    total += value;
    measured += 1;
  }
  return { total, measured };
}

function completeOrUnavailable(total: number, coverage: ResourceCoverage): ResourceMeasure {
  return coverage.complete ? resourceAvailable(total) : resourceUnavailable("incomplete_coverage", `${coverage.measured} of ${coverage.processes} processes were measured`);
}

export function totalsOf(processes: ResourceProcess[]): ResourceTotals {
  const physical = sum(processes, physicalOf);
  const resident = sum(processes, (row) => (row.memory.resident.status === "available" ? row.memory.resident.value : undefined));
  const coverage = coverageOf(processes, physical.measured);
  const residentCoverage = coverageOf(processes, resident.measured);
  return {
    coverage,
    knownPhysicalBytes: physical.total,
    physical: completeOrUnavailable(physical.total, coverage),
    residentCoverage,
    knownResidentBytes: resident.total,
    residentSum: completeOrUnavailable(resident.total, residentCoverage),
  };
}

export function roleTotalsOf(processes: ResourceProcess[]): ResourceRoleTotals[] {
  const byRole = new Map<ResourceProcessRole, ResourceProcess[]>();
  for (const row of processes) {
    const list = byRole.get(row.role);
    if (list) list.push(row);
    else byRole.set(row.role, [row]);
  }
  return [...byRole.entries()].map(([role, rows]) => {
    const physical = sum(rows, physicalOf);
    const coverage = coverageOf(rows, physical.measured);
    return { role, coverage, knownPhysicalBytes: physical.total, physical: completeOrUnavailable(physical.total, coverage) };
  });
}

function electronRole(type: string): ResourceProcessRole {
  for (const [pattern, role] of ELECTRON_ROLES) if (pattern.test(type)) return role;
  return "desktop_utility";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
