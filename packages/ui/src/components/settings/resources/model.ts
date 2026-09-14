import {
  RESOURCE_PROCESS_ROLES,
  type AgentRun,
  type BackgroundTask,
  type ResourceMeasure,
  type ResourceProcess,
  type ResourceProcessRole,
  type ResourceSnapshot,
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

export function physicalMeasure(process: ResourceProcess, platform: ResourceSnapshot["platform"]): ResourceMeasure {
  if (platform === "linux") return process.memory.pss;
  return process.memory.privateResident;
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
    const rows = snapshot.processes.filter((process) => group.roles.has(process.role));
    const measured = rows.filter((process) => physicalMeasure(process, snapshot.platform).status === "available").length;
    return {
      id: group.id,
      label: group.label,
      current: roleCurrent(snapshot, group.roles),
      peak: peakCell(history, group.roles),
      coverage: `${measured} of ${rows.length} processes measured`,
      processCount: rows.length,
    };
  });
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
  const roots: ProcessNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.process.parentKey ? nodes.get(node.process.parentKey) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (left: ProcessNode, right: ProcessNode) => left.process.label.localeCompare(right.process.label) || left.process.key.localeCompare(right.process.key);
  const visit = (node: ProcessNode, ancestors: Set<string>): void => {
    if (ancestors.has(node.process.key)) {
      node.children = [];
      return;
    }
    const next = new Set(ancestors).add(node.process.key);
    node.children.sort(sort);
    node.children.forEach((child) => visit(child, next));
  };
  roots.sort(sort);
  roots.forEach((root) => visit(root, new Set()));
  return roots;
}

export type ResourceOptionalStoreKey =
  | "workerSessions"
  | "workerReplay"
  | "workerCaches"
  | "rendererViews"
  | "taskRegistry"
  | "deliveryRegistry"
  | "providerQueues";

export interface OptionalStoreValue {
  count?: number | undefined;
  bytes?: number | undefined;
}

/** One future-facing adapter: later typed producers replace unavailable cells here, not in rendering branches. */
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
const optionalCell = (value: number | undefined, handoff: string): MetricCell => value === undefined ? unavailable(`Awaiting ${handoff} typed producer`) : available(value);

export function associatedIds(snapshot: ResourceSnapshot, kind: "sessionIds" | "runIds" | "taskIds"): { ids: string[]; truncated: boolean } {
  const ids = new Set<string>();
  let truncated = false;
  for (const process of snapshot.processes) {
    for (const id of process.associations?.[kind] ?? []) ids.add(id);
    truncated ||= process.associations?.truncated === true;
  }
  return { ids: [...ids].sort(), truncated };
}

export function retainedStoreRows(input: RetainedStoreInputs): RetainedStoreRow[] {
  const sessions = associatedIds(input.snapshot, "sessionIds");
  const runs = associatedIds(input.snapshot, "runIds");
  const tasks = associatedIds(input.snapshot, "taskIds");
  const optional = input.optional ?? {};
  const association = (value: { ids: string[]; truncated: boolean }): MetricCell => available(value.ids.length, value.truncated ? "at least; association list was truncated" : undefined);
  const future = (id: ResourceOptionalStoreKey, label: string, owner: string, handoff: RetainedStoreRow["handoff"]): RetainedStoreRow => ({
    id,
    label,
    owner,
    count: optionalCell(optional[id]?.count, `M18-${handoff}`),
    bytes: optionalCell(optional[id]?.bytes, `M18-${handoff}`),
    handoff,
  });
  return [
    { id: "processes", label: "Owned processes", owner: "Host inventory", count: available(input.snapshot.processes.length), bytes: unavailable("Process memory is shown above; this is not a retained store") },
    { id: "workers", label: "Project workers", owner: "Host inventory", count: available(input.snapshot.processes.filter((process) => process.role === "project_worker").length), bytes: unavailable("Worker memory is shown above; this is not a retained store") },
    { id: "associated-sessions", label: "Associated sessions", owner: "RP-1 snapshot", count: association(sessions), bytes: unavailable("Associations do not allocate process memory") },
    { id: "associated-runs", label: "Associated agent runs", owner: "RP-1 snapshot", count: association(runs), bytes: unavailable("Associations do not allocate process memory") },
    { id: "associated-tasks", label: "Associated background tasks", owner: "RP-1 snapshot", count: association(tasks), bytes: unavailable("Associations do not allocate process memory") },
    { id: "saved-sessions", label: "Saved sessions", owner: "Host catalog", count: input.savedSessions === undefined ? unavailable("The complete session catalog has not loaded") : available(input.savedSessions), bytes: unavailable("No typed retained-byte counter is available") },
    { id: "renderer-pending", label: "Queued messages in cached views", owner: "This viewer", count: available(input.pendingMessages), bytes: unavailable("Renderer retained bytes await M18-T5"), handoff: "T5" },
    {
      id: "rendererViews",
      label: "Cached conversation views",
      owner: "This viewer",
      count: available(optional.rendererViews?.count ?? input.rendererViews),
      bytes: optionalCell(optional.rendererViews?.bytes, "M18-T5"),
      handoff: "T5",
    },
    future("workerSessions", "Worker session runtimes", "Project workers", "T4"),
    future("workerReplay", "Worker replay buffers", "Project workers", "T4"),
    future("workerCaches", "Worker project and session caches", "Project workers", "T4"),
    future("taskRegistry", "Task records and retained tails", "Workers / host", "T6"),
    future("deliveryRegistry", "Transcript delivery paths and queues", "Host", "T6"),
    future("providerQueues", "Provider-log and request queues", "Workers", "T7"),
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
  if (!run) return { reason: "This run is no longer in the current run registry" };
  if (!reachable(run.sessionPath, state)) return { reason: "This run’s session is no longer reachable" };
  return { path: run.sessionPath, run };
}

export function resolveTaskAssociation(id: string, state: ResourceActionState): { path?: string; task?: BackgroundTask; reason?: string } {
  const task = state.tasks[id];
  if (!task) return { reason: "This task is no longer in the current task registry" };
  if (!reachable(task.sessionPath, state)) return { reason: "This task’s session is no longer reachable" };
  return { path: task.sessionPath, task };
}
