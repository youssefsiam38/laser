/**
 * ResourceService — the host's process inventory (RP-1).
 *
 * Demand-driven: a snapshot happens because somebody asked for one. Nothing
 * samples on a timer, so with diagnostics closed this file costs nothing.
 *
 * Discovery is structural. The roots are processes the host already knows —
 * itself, the workers it spawned, the pids its subsystems registered, and the
 * desktop shell once that shell has been *proved* to be this host's own
 * ancestor. Everything else in the inventory is there because it descends from
 * one of those, and is honestly labelled `unknown_descendant` rather than
 * guessed at from a command line.
 *
 * Four promises hold this together:
 *
 * - **Identity.** Nothing is attached to a pid; everything is attached to
 *   `(pid, startToken)`. A registration whose token no longer matches is
 *   dropped, so a reused pid inherits neither a role, an owner nor a number.
 * - **Honest gaps.** A counter we could not read is `unavailable` with a
 *   reason. A sum whose rows are not all measured is not presented as a total.
 * - **Nothing sensitive.** No argv, no environment, no paths: a project is an
 *   opaque salted id with a sanitized basename, a session is its durable id,
 *   a process is its sanitized executable basename.
 * - **No blast radius.** Every collector call is wrapped and bounded; a failure
 *   becomes a health entry. Nothing here can touch a worker, a session or a
 *   process — there is no control verb in this slice at all.
 */
import {
  RESOURCE_CROSS_CHECK_TOLERANCE,
  RESOURCE_EXPORT_MAX_BYTES,
  RESOURCE_MIN_COLLECT_INTERVAL_MS,
  RESOURCE_REPORT_MAX_AGE_MS,
  RESOURCE_SNAPSHOT_PROCESS_MAX,
  boundedResourceIds,
  boundedResourceText,
  resourceAvailable,
  resourceUnavailable,
  type ResourceAssociations,
  type ResourceCollectorStatus,
  type ResourceCoverage,
  type ResourceCrossCheckStatus,
  type ResourceDesktopReport,
  type ResourceMeasure,
  type ResourceProcess,
  type ResourceProcessRole,
  type ResourceRetention,
  type ResourceRoleTotals,
  type ResourceSnapshot,
  type ResourceTotals,
} from "@lasercode/protocol";
import { ancestorChain, processKey, type IdentityIo } from "./identity.js";
import { ResourceHistory, type ResourceHistoryOptions } from "./history.js";
import { ProcessOwnershipRegistry, type OwnershipLookups } from "./ownership.js";
import { LinuxProcessCollector } from "./linux.js";
import { DarwinProcessCollector } from "./darwin.js";
import { WindowsProcessCollector } from "./windows.js";
import { unavailableMetrics, type ProcessCollector, type ProcessRowMetrics, type ProcessTableRow } from "./platform.js";

export interface ResourceServiceOptions {
  /** Override the platform collector (tests, and a platform we do not support). */
  collector?: ProcessCollector;
  platform?: NodeJS.Platform;
  hostPid?: number;
  /** The host's parent as recorded at start, before any reparenting. */
  hostParentPid?: number;
  identityIo?: IdentityIo;
  lookups?: OwnershipLookups;
  history?: ResourceHistoryOptions;
  minIntervalMs?: number;
  now?: () => number;
  /** Asks the desktop shell for fresh metrics. Never a poll: one request per demand. */
  requestDesktopRefresh?: () => void;
  /** Injectable ancestor walk, so verification can be tested without a real tree. */
  ancestorsOf?: (pid: number) => Array<{ pid: number; startToken: string }>;
  /** Injectable identity read for spawn records, for the same reason. */
  startTokenOf?: (pid: number) => string | undefined;
}

interface StoredReport {
  report: ResourceDesktopReport;
  receivedAtMs: number;
  /** The desktop main we verified, with the identity we observed ourselves. */
  root: { pid: number; startToken: string };
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
  private readonly hostParentPid: number | undefined;
  private readonly identityIo: IdentityIo;
  private collector: ProcessCollector | undefined;
  private collectorFailure: string | undefined;
  private report: StoredReport | undefined;
  private rejectedReport: string | undefined;
  private last: { snapshot: ResourceSnapshot; atMs: number } | undefined;
  private inFlight: Promise<ResourceSnapshot> | undefined;
  private counter = 0;

  constructor(private readonly options: ResourceServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.hostPid = options.hostPid ?? process.pid;
    this.hostParentPid = options.hostParentPid ?? process.ppid;
    this.identityIo = options.identityIo ?? {};
    this.ownership = new ProcessOwnershipRegistry(
      this.identityIo,
      options.lookups ?? {},
      ...(options.startTokenOf ? [options.startTokenOf] : []),
    );
    this.history = new ResourceHistory({ now: this.now, ...options.history });
  }

  // ----------------------------------------------------------------- reads

  async snapshot(params: { refresh?: boolean } = {}): Promise<{ snapshot: ResourceSnapshot; retention: ResourceRetention }> {
    const minInterval = this.options.minIntervalMs ?? RESOURCE_MIN_COLLECT_INTERVAL_MS;
    if (!params.refresh && this.last && this.now() - this.last.atMs < minInterval) {
      return { snapshot: this.last.snapshot, retention: this.history.retention() };
    }
    // Concurrent askers share one collection: two open diagnostics must not
    // double the cost of the answer.
    this.inFlight ??= this.collect().finally(() => {
      this.inFlight = undefined;
    });
    const snapshot = await this.inFlight;
    return { snapshot, retention: this.history.retention() };
  }

  historyPage(params: { sinceId?: string; limit?: number } = {}): { snapshots: ResourceSnapshot[]; retention: ResourceRetention } {
    return { snapshots: this.history.page(params), retention: this.history.retention() };
  }

  /**
   * A diagnostic document built from the same sanitized rows — there is no
   * second, richer copy of anything to leak. Oldest snapshots are dropped
   * until the document fits its byte bound, and it says when that happened.
   */
  export(): { document: string; bytes: number; truncated: boolean } {
    const retention = this.history.retention();
    let snapshots = this.history.page({ limit: 60 });
    let truncated = false;
    for (;;) {
      const document = JSON.stringify({ at: new Date(this.now()).toISOString(), platform: this.platformName(), retention, truncated, snapshots }, null, 2);
      const bytes = Buffer.byteLength(document, "utf8");
      if (bytes <= RESOURCE_EXPORT_MAX_BYTES || snapshots.length <= 1) return { document, bytes, truncated };
      snapshots = snapshots.slice(Math.ceil(snapshots.length / 2));
      truncated = true;
    }
  }

  // ---------------------------------------------------------------- inputs

  /**
   * Electron's metrics, from the local shell.
   *
   * Accepted only when the claimed main process is genuinely this host's own
   * ancestor, with the identity the host observes itself. An arbitrary local
   * client cannot relabel a process it does not own, and nothing it sends can
   * act on a process: the payload is pids and counters, and the only thing the
   * host does with it is compare.
   */
  receiveDesktopReport(report: ResourceDesktopReport): { accepted: number; rejected: number; verified: boolean } {
    const chain = (this.options.ancestorsOf ?? ((pid: number) => ancestorChain(pid, this.identityIo)))(this.hostPid);
    const candidates = [...chain];
    const verified = candidates.find((ancestor) => ancestor.pid === report.main.pid);
    const tokenMatches = verified && (!report.main.startToken || report.main.startToken === verified.startToken);
    if (!verified || !tokenMatches) {
      this.report = undefined;
      this.rejectedReport = verified
        ? "the shell's own identity for its main process did not match this machine's"
        : this.hostParentPid === report.main.pid
          ? "the process that started this host has gone, so its metrics cannot be tied to it"
          : "the reported desktop process is not this host's own shell";
      return { accepted: 0, rejected: report.processes.length, verified: false };
    }
    this.report = { report, receivedAtMs: this.now(), root: verified };
    this.rejectedReport = undefined;
    return { accepted: report.processes.length, rejected: 0, verified: true };
  }

  /** RP-6 / RP-7 publish background-command and helper pids here. */
  observeProcessRegistrations(projectCwd: string | undefined, registrations: readonly unknown[]): number {
    return this.ownership.observeProcessRegistrations(projectCwd, registrations);
  }

  // ------------------------------------------------------------ collection

  private async collect(): Promise<ResourceSnapshot> {
    const started = this.now();
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

    const desktopRoot = this.verifiedDesktopRoot(byPid);
    const roots: ProcessTableRow[] = [];
    const pushRoot = (row: ProcessTableRow | undefined): void => {
      if (row && !roots.some((existing) => existing.pid === row.pid)) roots.push(row);
    };
    pushRoot(desktopRoot);
    pushRoot(byPid.get(this.hostPid));
    for (const record of this.ownership.roots()) pushRoot(byPid.get(record.pid));

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

    const processes: ResourceProcess[] = [];
    for (const row of kept) {
      const metrics = await this.measure(row, collectors);
      processes.push(this.describe(row, metrics, byPid, seen, desktopRoot));
    }

    const crossCheck = this.crossCheck(processes);
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
      if (this.platform === "linux") this.collector = new LinuxProcessCollector(this.identityIo.procRoot ? { procRoot: this.identityIo.procRoot } : {});
      else if (this.platform === "darwin") this.collector = new DarwinProcessCollector();
      else if (this.platform === "win32") this.collector = new WindowsProcessCollector();
      else this.collectorFailure = `${this.platform} has no process collector`;
    } catch (error) {
      this.collectorFailure = messageOf(error);
    }
    return this.collector;
  }

  /** The desktop main, only when a verified report says so and identity still agrees. */
  private verifiedDesktopRoot(byPid: Map<number, ProcessTableRow>): ProcessTableRow | undefined {
    if (!this.report) return undefined;
    const row = byPid.get(this.report.root.pid);
    return row && row.startToken === this.report.root.startToken ? row : undefined;
  }

  private describe(
    row: ProcessTableRow,
    metrics: ProcessRowMetrics,
    byPid: Map<number, ProcessTableRow>,
    keptPids: Set<number>,
    desktopRoot: ProcessTableRow | undefined,
  ): ResourceProcess {
    const key = processKey(row.pid, row.startToken);
    const record = this.ownership.lookup(row.pid, row.startToken);
    const electron = this.electronRowFor(row, desktopRoot);

    let role: ResourceProcessRole = "unknown_descendant";
    if (row.pid === this.hostPid) role = "host";
    else if (record) role = record.role;
    else if (desktopRoot && row.pid === desktopRoot.pid) role = "desktop_main";
    else if (electron) role = electronRole(electron.type);

    const parent = row.ppid !== undefined ? byPid.get(row.ppid) : undefined;
    const project = record?.projectCwd ? this.ownership.projectIdentity(record.projectCwd) : undefined;
    const associations = this.associationsFor(record);

    return {
      key,
      pid: row.pid,
      startToken: row.startToken,
      ...(row.ppid !== undefined ? { ppid: row.ppid } : {}),
      ...(parent && keptPids.has(parent.pid) ? { parentKey: processKey(parent.pid, parent.startToken) } : {}),
      role,
      label: record?.label ?? row.label,
      ...(project ? { project } : {}),
      ...(associations ? { associations } : {}),
      memory: metrics.memory,
      cpu: metrics.cpu,
      elapsedMs: metrics.elapsedMs,
      io: metrics.io,
      source: (this.options.collector ?? this.collector)?.source ?? "proc",
      ...(electron
        ? {
            electron: {
              type: boundedResourceText(electron.type, 32),
              workingSetBytes: electron.workingSetBytes === undefined
                ? resourceUnavailable("not_collected", "the shell reported no working set for this process")
                : resourceAvailable(electron.workingSetBytes),
              reportAgeMs: Math.max(0, this.now() - (this.report?.receivedAtMs ?? this.now())),
            },
          }
        : {}),
    };
  }

  /**
   * A reported row is usable only when it belongs to the verified desktop tree
   * *as this host sees it* and its identity matches. Anything else is ignored.
   */
  private electronRowFor(row: ProcessTableRow, desktopRoot: ProcessTableRow | undefined): { type: string; workingSetBytes?: number } | undefined {
    if (!this.report || !desktopRoot) return undefined;
    const reported = this.report.report.processes.find((entry) => entry.pid === row.pid);
    if (!reported) return undefined;
    if (reported.startToken && reported.startToken !== row.startToken) return undefined;
    return { type: reported.type, ...(reported.workingSetBytes !== undefined ? { workingSetBytes: reported.workingSetBytes } : {}) };
  }

  /** Work a process is associated with. Never an allocation of its memory. */
  private associationsFor(record: ReturnType<ProcessOwnershipRegistry["lookup"]>): ResourceAssociations | undefined {
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

  private crossCheck(processes: ResourceProcess[]): { status: ResourceCrossCheckStatus; detail?: string } {
    if (this.rejectedReport) return { status: "unverified", detail: boundedResourceText(this.rejectedReport) };
    if (!this.report) return { status: "unavailable", detail: "the desktop shell has not reported its own metrics yet" };
    const ageMs = this.now() - Date.parse(this.report.report.at || new Date(this.report.receivedAtMs).toISOString());
    const matched = processes.filter((row) => row.electron);
    if (matched.length === 0) {
      return { status: "unverified", detail: "no reported process could be tied to this host's own process tree" };
    }
    if (!Number.isFinite(ageMs) || ageMs > RESOURCE_REPORT_MAX_AGE_MS) {
      return { status: "stale", detail: "the shell's metrics are older than a minute; a refresh was requested" };
    }
    for (const row of matched) {
      const theirs = row.electron!.workingSetBytes;
      const ours = row.memory.resident;
      if (theirs.status !== "available" || ours.status !== "available") continue;
      const scale = Math.max(theirs.value, ours.value);
      if (scale > 0 && Math.abs(theirs.value - ours.value) / scale > RESOURCE_CROSS_CHECK_TOLERANCE) {
        return { status: "diverged", detail: `${row.label} differs from the shell's own working set by more than ${Math.round(RESOURCE_CROSS_CHECK_TOLERANCE * 100)}%` };
      }
    }
    return { status: "ok" };
  }

  private platformName(): ResourceSnapshot["platform"] {
    return this.platform === "linux" || this.platform === "darwin" || this.platform === "win32" ? this.platform : "other";
  }
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
