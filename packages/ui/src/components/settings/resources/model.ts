import {
  RESOURCE_PROCESS_ROLES,
  aggregateMemoryPressureLevel,
  type AgentRun,
  type MemoryPressureAction,
  type MemoryPressureActionResult,
  type MemoryPressureInput,
  type MemoryPressureLevelState,
  type MemoryPressureOutcome,
  type MemoryPressureReason,
  type MemoryPressureRefusal,
  type MemoryPressureRole,
  type MemoryPressureRoleState,
  type MemoryPressureSummary,
  type BackgroundTask,
  type ResourceMeasure,
  type ResourceProcess,
  type ResourceProcessRole,
  type ResourceRetainedStores,
  type ResourceSnapshot,
  type ResourceStoreKey,
  type SessionSummary,
} from "@lasercode/protocol";

export type MetricCell =
  | { status: "available"; value: number; qualifier?: string | undefined }
  | { status: "unavailable"; reason: string; knownValue?: number | undefined };

export interface PhysicalSummary {
  current: MetricCell;
  peak: MetricCell;
  coverage: string;
}

export const ROLE_LABELS: Readonly<Record<ResourceProcessRole, string>> = {
  desktop_main: "Desktop main",
  desktop_renderer: "Renderer",
  desktop_gpu: "Desktop GPU",
  desktop_utility: "Desktop utility",
  host: "Host",
  project_worker: "Project workers",
  background_command: "Background commands",
  helper: "Helpers",
  unknown_descendant: "Unknown descendants",
};

const UNAVAILABLE_LABELS: Readonly<Record<Exclude<ResourceMeasure, { status: "available" }>["reason"], string>> = {
  unsupported_platform: "Not available on this platform",
  permission_denied: "The operating system did not allow this measurement",
  process_gone: "The process ended before it could be measured",
  collector_failed: "The operating system measurement failed",
  not_collected: "Not collected within this sample’s bound",
  incomplete_coverage: "Not every process was measured",
};

export function measureCell(measure: ResourceMeasure): MetricCell {
  if (measure.status === "available") return { status: "available", value: measure.value };
  const reason = UNAVAILABLE_LABELS[measure.reason];
  return { status: "unavailable", reason: measure.detail ? `${reason}: ${measure.detail}` : reason };
}

export type PhysicalMeasureKind = "pss" | "privateResident";

/** Match the host's physical-memory authority: prefer PSS, then private resident. */
export function physicalMeasureKind(process: ResourceProcess): PhysicalMeasureKind {
  return process.memory.pss.status === "available" ? "pss" : "privateResident";
}

export function physicalMeasure(process: ResourceProcess): ResourceMeasure {
  return process.memory[physicalMeasureKind(process)];
}

function peakCell(snapshots: readonly ResourceSnapshot[], roles?: ReadonlySet<ResourceProcessRole>): MetricCell {
  const values: number[] = [];
  for (const snapshot of snapshots) {
    if (!roles) {
      if (snapshot.totals.physical.status === "available") values.push(snapshot.totals.physical.value);
      continue;
    }
    const totals = snapshot.byRole.filter((entry) => roles.has(entry.role));
    if (totals.length !== roles.size || totals.some((entry) => entry.physical.status !== "available")) continue;
    values.push(totals.reduce((sum, entry) => sum + (entry.physical.status === "available" ? entry.physical.value : 0), 0));
  }
  return values.length > 0
    ? { status: "available", value: Math.max(...values) }
    : { status: "unavailable", reason: "No complete sample is available in retained history" };
}

function roleCurrent(snapshot: ResourceSnapshot, roles: ReadonlySet<ResourceProcessRole>): MetricCell {
  const totals = snapshot.byRole.filter((entry) => roles.has(entry.role));
  if (totals.length !== roles.size) return { status: "unavailable", reason: "No process with this role was discovered" };
  if (totals.some((entry) => entry.physical.status !== "available")) {
    const measured = totals.reduce((sum, entry) => sum + entry.coverage.measured, 0);
    const processes = totals.reduce((sum, entry) => sum + entry.coverage.processes, 0);
    const known = totals.reduce((sum, entry) => sum + entry.knownPhysicalBytes, 0);
    return { status: "unavailable", reason: `${measured} of ${processes} processes measured`, ...(known > 0 ? { knownValue: known } : {}) };
  }
  return { status: "available", value: totals.reduce((sum, entry) => sum + (entry.physical.status === "available" ? entry.physical.value : 0), 0) };
}

export function totalPhysicalSummary(snapshot: ResourceSnapshot, history: readonly ResourceSnapshot[]): PhysicalSummary {
  const current = measureCell(snapshot.totals.physical);
  if (current.status === "unavailable") {
    current.reason = `${snapshot.totals.coverage.measured} of ${snapshot.totals.coverage.processes} processes measured`;
    if (snapshot.totals.knownPhysicalBytes > 0) current.knownValue = snapshot.totals.knownPhysicalBytes;
  }
  return {
    current,
    peak: peakCell(history),
    coverage: `${snapshot.totals.coverage.measured} of ${snapshot.totals.coverage.processes} processes measured`,
  };
}

export interface RoleSummary extends PhysicalSummary {
  id: "renderer" | "host" | "workers";
  label: string;
  processCount: number;
}

const SUMMARY_ROLES = [
  { id: "renderer", label: "Renderer", roles: new Set<ResourceProcessRole>(["desktop_renderer"]) },
  { id: "host", label: "Host", roles: new Set<ResourceProcessRole>(["host"]) },
  { id: "workers", label: "Workers", roles: new Set<ResourceProcessRole>(["project_worker"]) },
] as const;

export function roleSummaries(snapshot: ResourceSnapshot, history: readonly ResourceSnapshot[]): RoleSummary[] {
  return SUMMARY_ROLES.map((group) => {
    const totals = snapshot.byRole.filter((entry) => group.roles.has(entry.role));
    const measured = totals.reduce((sum, entry) => sum + entry.coverage.measured, 0);
    const processes = totals.reduce((sum, entry) => sum + entry.coverage.processes, 0);
    return {
      id: group.id,
      label: group.label,
      current: roleCurrent(snapshot, group.roles),
      peak: peakCell(history, group.roles),
      coverage: `${measured} of ${processes} processes measured`,
      processCount: processes,
    };
  });
}

export const PRESSURE_LEVEL_LABELS = {
  normal: "Normal",
  warning: "Memory is tight",
  critical: "Memory is critically low",
  unknown: "Not measured yet",
} as const satisfies Readonly<Record<MemoryPressureLevelState, string>>;

export const PRESSURE_ROLE_LABELS = {
  host: "This app’s host",
  project_worker: "Project workers",
  machine: "This computer",
  desktop_renderer: "This window",
} as const satisfies Readonly<Record<MemoryPressureRole, string>>;

export const PRESSURE_INPUT_LABELS = {
  physical: "Physical memory",
  heap: "JavaScript heap",
  machine_available: "Memory available on this computer",
} as const satisfies Readonly<Record<MemoryPressureInput["kind"], string>>;

export const PRESSURE_REASON_SENTENCES = {
  pins_held: "Work in a conversation is still using this memory.",
  membership_held: "Someone is still following this conversation.",
  safety_incomplete: "The owner could not safely describe everything it holds.",
  arrival_fence: "New work arrived before this release could finish.",
  generation_mismatch: "The process changed before this release could finish.",
  directive_timeout: "The process did not answer within the bounded wait.",
  malformed_answer: "The answer could not be read safely.",
  sample_unavailable: "No memory measurement was available.",
  sample_stale: "The newest memory measurement was too old to use.",
  cooldown: "Memory was released recently, so another pass is waiting.",
  work_budget: "This bounded pass finished; more can be released on the next pass.",
} as const satisfies Readonly<Record<MemoryPressureReason, string>>;

export const PRESSURE_ACTION_LABELS = {
  ephemeral_caches: "Rebuildable caches",
  renderer_views: "Conversation views",
  replay_suffixes: "Reconnect history",
  task_records: "Finished command records",
  idle_session_unload: "Idle conversations",
  worker_retirement: "Idle project workers",
  admission_refused: "Paused heavy work",
} as const satisfies Readonly<Record<MemoryPressureAction, string>>;

export const PRESSURE_OUTCOME_LABELS = {
  released: "Released memory",
  nothing_to_give: "Nothing was available to release",
  held: "Kept for active work",
  unavailable: "Could not measure safely",
  refused: "Paused",
  budget_reached: "Bound reached",
} as const satisfies Readonly<Record<MemoryPressureOutcome, string>>;

export const PRESSURE_REFUSAL_COPY = {
  whole_transcript: {
    label: "Loading a whole conversation at once",
    guidance: "Load earlier messages a page at a time, then try again after memory recovers.",
  },
  older_history: {
    label: "Loading more older messages",
    guidance: "Keep working with the messages already loaded, then try again after memory recovers.",
  },
  background_session: {
    label: "Preparing another conversation in the background",
    guidance: "Open that conversation when you need it rather than preparing it ahead of time.",
  },
  speculative_worker: {
    label: "Preparing project work ahead of time",
    guidance: "Start that work explicitly when you are ready for it.",
  },
  new_project_worker: {
    label: "Starting work in another project",
    guidance: "Finish or close other project work, then try again.",
  },
  worker_free_full_read: {
    label: "Reading a whole saved conversation at once",
    guidance: "Open the conversation and load earlier messages a page at a time.",
  },
} as const satisfies Readonly<Record<MemoryPressureRefusal, { label: string; guidance: string }>>;

export interface PressureHostState {
  available: boolean;
  level: MemoryPressureLevelState;
  roles: MemoryPressureRoleState[];
  totals?: MemoryPressureSummary["totals"] | undefined;
  refusing: MemoryPressureRefusal[];
}

/** The host decides from itself, workers and the machine; never its unknown renderer row. */
export function pressureHostState(summary: MemoryPressureSummary | undefined): PressureHostState {
  if (!summary) return { available: false, level: "unknown", roles: [], refusing: [] };
  const roles = summary.roles.filter((row) => row.role !== "desktop_renderer");
  return {
    available: true,
    level: aggregateMemoryPressureLevel(roles.map((row) => row.level)),
    roles,
    totals: summary.totals,
    refusing: [...summary.refusing],
  };
}

export function pressureCoverage(role: MemoryPressureRoleState): string {
  const { expected, answered } = role.coverage;
  if (expected === 0) return role.role === "project_worker" ? "No live project workers to measure" : "Nothing live to measure";
  if (role.coverage.complete) return `${answered} of ${expected} answered`;
  return `${answered} of ${expected} answered · coverage is incomplete`;
}

export interface PressureRefusalView {
  kind: MemoryPressureRefusal;
  label: string;
  guidance: string;
  owners: string;
}

export function pressureRefusalViews(
  host: readonly MemoryPressureRefusal[],
  window: readonly MemoryPressureRefusal[],
): PressureRefusalView[] {
  const kinds = new Set<MemoryPressureRefusal>([...host, ...window]);
  return [...kinds].map((kind) => {
    const owners = [host.includes(kind) ? "Application" : undefined, window.includes(kind) ? "This window" : undefined]
      .filter((owner): owner is string => owner !== undefined)
      .join(" and ");
    return { kind, ...PRESSURE_REFUSAL_COPY[kind], owners };
  });
}

export interface PressureActionView {
  action: MemoryPressureAction;
  label: string;
  outcome: string;
  reason: string;
  released?: { count?: number | undefined; bytes?: number | undefined } | undefined;
}

/** A local action row projected only through fixed enum language. */
export function pressureActionView(row: MemoryPressureActionResult): PressureActionView {
  const reason = row.reason
    ? PRESSURE_REASON_SENTENCES[row.reason]
    : row.refusal
      ? PRESSURE_REFUSAL_COPY[row.refusal].guidance
      : PRESSURE_OUTCOME_LABELS[row.outcome];
  return {
    action: row.action,
    label: PRESSURE_ACTION_LABELS[row.action],
    outcome: PRESSURE_OUTCOME_LABELS[row.outcome],
    reason,
    ...(row.released ? { released: row.released } : {}),
  };
}

export interface ProcessNode {
  process: ResourceProcess;
  children: ProcessNode[];
}

export interface ProcessOwnerGroup {
  id: string;
  label: string;
  roots: ProcessNode[];
}

export interface ProcessRoleGroup {
  role: ResourceProcessRole;
  label: string;
  owners: ProcessOwnerGroup[];
}

const roleOrder = new Map<ResourceProcessRole, number>(RESOURCE_PROCESS_ROLES.map((role, index) => [role, index]));

export function processTree(snapshot: ResourceSnapshot): ProcessRoleGroup[] {
  const roles = new Map<ResourceProcessRole, Map<string, ResourceProcess[]>>();
  for (const process of snapshot.processes) {
    let owners = roles.get(process.role);
    if (!owners) roles.set(process.role, owners = new Map());
    const ownerId = process.project?.id ?? "application";
    const rows = owners.get(ownerId);
    if (rows) rows.push(process);
    else owners.set(ownerId, [process]);
  }
  return [...roles.entries()]
    .sort(([left], [right]) => (roleOrder.get(left) ?? 99) - (roleOrder.get(right) ?? 99))
    .map(([role, owners]) => ({
      role,
      label: ROLE_LABELS[role],
      owners: [...owners.entries()]
        .map(([id, rows]) => ({ id, label: rows[0]?.project?.label ?? "Application", roots: nodesFor(rows) }))
        .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id)),
    }));
}

function nodesFor(processes: readonly ResourceProcess[]): ProcessNode[] {
  const nodes = new Map<string, ProcessNode>(processes.map((process) => [process.key, { process, children: [] }]));
  const cyclic = new Set<string>();

  for (const node of nodes.values()) {
    const path: string[] = [];
    const seen = new Map<string, number>();
    let current: ProcessNode | undefined = node;
    while (current) {
      const previous = seen.get(current.process.key);
      if (previous !== undefined) {
        path.slice(previous).forEach((key) => cyclic.add(key));
        break;
      }
      seen.set(current.process.key, path.length);
      path.push(current.process.key);
      current = current.process.parentKey ? nodes.get(current.process.parentKey) : undefined;
    }
  }

  const roots: ProcessNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.process.parentKey ? nodes.get(node.process.parentKey) : undefined;
    if (cyclic.has(node.process.key) || !parent || parent === node) roots.push(node);
    else parent.children.push(node);
  }
  const sort = (left: ProcessNode, right: ProcessNode) =>
    left.process.label.localeCompare(right.process.label) || left.process.key.localeCompare(right.process.key);
  const visit = (node: ProcessNode): void => {
    node.children.sort(sort);
    node.children.forEach(visit);
  };
  roots.sort(sort);
  roots.forEach(visit);
  return roots;
}

/**
 * The same key set the host publishes, so a producer added there cannot drift
 * away from the row that displays it.
 */
export type ResourceOptionalStoreKey = ResourceStoreKey;

export interface OptionalStoreValue {
  count?: number | undefined;
  bytes?: number | undefined;
}

/**
 * One adapter for retained-state counters a viewer knows locally, or that a
 * later slice reports before the host's snapshot carries it. The snapshot's
 * own typed entries win where both exist.
 */
export type ResourceOptionalStores = Partial<Record<ResourceOptionalStoreKey, OptionalStoreValue>>;

export interface RetainedStoreInputs {
  snapshot: ResourceSnapshot;
  savedSessions?: number | undefined;
  rendererViews: number;
  pendingMessages: number;
  optional?: ResourceOptionalStores | undefined;
}

export interface RetainedStoreRow {
  id: string;
  label: string;
  owner: string;
  count: MetricCell;
  bytes: MetricCell;
  handoff?: "T4" | "T5" | "T6" | "T7" | undefined;
}

const unavailable = (reason: string): MetricCell => ({ status: "unavailable", reason });
const available = (value: number, qualifier?: string): MetricCell => ({ status: "available", value, ...(qualifier ? { qualifier } : {}) });
const optionalCell = (value: number | undefined, unavailableReason: string): MetricCell =>
  value === undefined ? unavailable(unavailableReason) : available(value);

export function associatedIds(snapshot: ResourceSnapshot, kind: "sessionIds" | "runIds" | "taskIds"): { ids: string[]; truncated: boolean } {
  const ids = new Set<string>();
  let truncated = false;
  for (const process of snapshot.processes) {
    for (const id of process.associations?.[kind] ?? []) ids.add(id);
    truncated ||= process.associations?.truncated === true;
  }
  return { ids: [...ids].sort(), truncated };
}

/** How much of a worker-aggregated counter the host actually heard back. */
function coverageContext(coverage: ResourceRetainedStores["coverage"] | undefined): string | undefined {
  if (!coverage || coverage.complete) return undefined;
  return `${coverage.answered} of ${coverage.workers} workers answered`;
}

export function retainedStoreRows(input: RetainedStoreInputs): RetainedStoreRow[] {
  const sessions = associatedIds(input.snapshot, "sessionIds");
  const runs = associatedIds(input.snapshot, "runIds");
  const tasks = associatedIds(input.snapshot, "taskIds");
  const optional = input.optional ?? {};
  const entries = input.snapshot.stores?.entries ?? {};
  const incomplete = coverageContext(input.snapshot.stores?.coverage);
  const association = (value: { ids: string[]; truncated: boolean }): MetricCell => available(
    value.ids.length,
    value.truncated ? "at least; association list was truncated" : undefined,
  );
  /**
   * One retained-state row, from whichever producer reports it: the host's own
   * typed snapshot first, then the local adapter. `aggregated` marks a counter
   * summed across live workers — when one did not answer, its count is *at
   * least* that many and its bytes are refused outright, because a partial sum
   * presented as a total is the one thing this surface exists not to do. The
   * refusal does not depend on the producer having left the figure out: a byte
   * total that arrives while a worker is still silent is a partial total, and
   * this surface will not draw one however it was sent. A counter nobody
   * reports is still named plainly, never a zero.
   */
  const store = (
    id: ResourceOptionalStoreKey,
    label: string,
    owner: string,
    handoff: RetainedStoreRow["handoff"],
    aggregated = false,
  ): RetainedStoreRow => {
    const value = entries[id] ?? optional[id];
    const partial = aggregated && incomplete !== undefined;
    return {
      id,
      label,
      owner,
      count: value?.count === undefined
        ? unavailable(`This count is not currently reported by ${owner}`)
        : available(value.count, partial ? `at least; ${incomplete}` : undefined),
      bytes: partial || value?.bytes === undefined
        ? unavailable(partial && value !== undefined
          ? `Retained bytes are complete only when every live worker answers; ${incomplete}`
          : `Retained bytes are not currently reported by ${owner}`)
        : available(value.bytes),
      handoff,
    };
  };
  return [
    {
      id: "processes",
      label: "Owned processes",
      owner: "Host inventory",
      count: available(input.snapshot.processes.length),
      bytes: unavailable("Process memory is shown above; this is not a retained store"),
    },
    {
      id: "workers",
      label: "Project workers",
      owner: "Host inventory",
      count: available(input.snapshot.processes.filter((process) => process.role === "project_worker").length),
      bytes: unavailable("Worker memory is shown above; this is not a retained store"),
    },
    {
      id: "associated-sessions",
      label: "Associated sessions",
      owner: "Host snapshot",
      count: association(sessions),
      bytes: unavailable("Associations do not allocate process memory"),
    },
    {
      id: "associated-runs",
      label: "Associated agent runs",
      owner: "Host snapshot",
      count: association(runs),
      bytes: unavailable("Associations do not allocate process memory"),
    },
    {
      id: "associated-tasks",
      label: "Associated background tasks",
      owner: "Host snapshot",
      count: association(tasks),
      bytes: unavailable("Associations do not allocate process memory"),
    },
    {
      id: "saved-sessions",
      label: "Saved sessions",
      owner: "Host catalog",
      count: input.savedSessions === undefined
        ? unavailable("The complete session catalog has not loaded")
        : available(input.savedSessions),
      bytes: unavailable("The host catalog does not currently report retained bytes"),
    },
    {
      id: "renderer-pending",
      label: "Queued messages in cached views",
      owner: "This viewer",
      count: available(input.pendingMessages),
      bytes: unavailable("This viewer does not currently report retained bytes"),
      handoff: "T5",
    },
    {
      id: "rendererViews",
      label: "Cached conversation views",
      owner: "This viewer",
      count: available(optional.rendererViews?.count ?? input.rendererViews),
      bytes: optionalCell(optional.rendererViews?.bytes, "Retained bytes are not currently reported by this viewer"),
      handoff: "T5",
    },
    store("workerSessions", "Worker session runtimes", "Project workers", "T4", true),
    store("workerReplay", "Worker replay buffers", "Project workers", "T4", true),
    store("workerCaches", "Worker project and session caches", "Project workers", "T4", true),
    store("taskRegistry", "Task records and retained tails", "Workers / host", "T6", true),
    // Host-only, so it is exact whatever the workers did: membership lives in
    // this process and nothing was waited on to count it.
    store("deliveryRegistry", "Transcript delivery paths and queues", "Host", "T6"),
    store("providerQueues", "Provider-log and request queues", "Host / workers", "T7", true),
  ];
}

export interface ResourceActionState {
  sessions: readonly SessionSummary[];
  runs: Readonly<Record<string, AgentRun>>;
  tasks: Readonly<Record<string, BackgroundTask>>;
  openPaths: ReadonlySet<string>;
  presence?: Readonly<Record<string, boolean>> | undefined;
}

const reachable = (path: string, state: ResourceActionState): boolean =>
  state.presence?.[path] !== false && (state.openPaths.has(path) || state.sessions.some((session) => session.path === path));

export function resolveSessionAssociation(id: string, state: ResourceActionState): { path?: string; reason?: string } {
  const matches = state.sessions.filter((session) => session.id === id && reachable(session.path, state));
  if (matches.length === 1) return { path: matches[0]!.path };
  return { reason: matches.length > 1 ? "This session id is ambiguous across projects" : "This session is not reachable in the current catalog" };
}

export function resolveRunAssociation(id: string, state: ResourceActionState): { path?: string; run?: AgentRun; reason?: string } {
  const run = state.runs[id];
  if (!run) return { reason: "This run is not currently known to the run registry" };
  if (!reachable(run.sessionPath, state)) return { reason: "This run’s session is not currently reachable" };
  return { path: run.sessionPath, run };
}

export function resolveTaskAssociation(id: string, state: ResourceActionState): { path?: string; task?: BackgroundTask; reason?: string } {
  const task = state.tasks[id];
  if (!task) return { reason: "This task is not currently known to the task registry" };
  if (!reachable(task.sessionPath, state)) return { reason: "This task’s session is not currently reachable" };
  return { path: task.sessionPath, task };
}
