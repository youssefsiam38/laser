"use client";

import {
  RESOURCE_HISTORY_PAGE_MAX,
  isTerminalRunStatus,
  type ResourceMeasure,
  type ResourceProcess,
  type ResourceRetention,
  type ResourceSnapshot,
} from "@lasercode/protocol";
import { Activity, ChevronDown, Download, RefreshCw, Square, Waypoints } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { requestEndAgent } from "@/components/agents/end-agent";
import { Chart } from "@/components/assistant-ui/elements/chart";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { NumberTicker } from "@/components/assistant-ui/elements/number-ticker";
import { SpecSheet, type SpecRow } from "@/components/assistant-ui/elements/spec-sheet";
import { useWorkbench } from "@/components/workbench";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { revealInFleet } from "@/fleet/fleet-state";
import { dateTime, duration, formatBytes, formatElapsed, relativeTime } from "@/format";
import { cn } from "@/lib/utils";
import { useLaserStable, useLaserState } from "@/runtime";
import { startVisiblePoll } from "@/runtime/visible-poll";

import {
  ROLE_LABELS,
  measureCell,
  physicalMeasure,
  processTree,
  resolveRunAssociation,
  resolveSessionAssociation,
  resolveTaskAssociation,
  retainedStoreRows,
  roleSummaries,
  totalPhysicalSummary,
  type MetricCell,
  type ProcessNode,
  type ResourceActionState,
  type ResourceOptionalStores,
} from "./model.js";

const RESOURCE_POLL_MS = 5_000;

export interface ResourceDiagnosticsProps {
  /** One adapter point for the typed retained-store counters added by T4–T7. */
  optionalStores?: ResourceOptionalStores | undefined;
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

function mergeHistory(current: readonly ResourceSnapshot[], incoming: readonly ResourceSnapshot[]): ResourceSnapshot[] {
  const byId = new Map(current.map((snapshot) => [snapshot.id, snapshot]));
  for (const snapshot of incoming) byId.set(snapshot.id, snapshot);
  return [...byId.values()]
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .slice(-RESOURCE_HISTORY_PAGE_MAX);
}

export function ResourceDiagnostics({ optionalStores }: ResourceDiagnosticsProps) {
  const { client, actions } = useLaserStable();
  const workbench = useWorkbench();
  const sessions = useLaserState((state) => state.sessions);
  const runs = useLaserState((state) => state.agents.runs);
  const tasks = useLaserState((state) => state.tasks.tasks);
  const open = useLaserState((state) => state.open);
  const presence = useLaserState((state) => state.catalogPresence);
  const catalogGroups = useLaserState((state) => state.catalogGroups);
  const sessionsLoaded = useLaserState((state) => state.sessionsLoaded);
  const connection = useLaserState((state) => state.connection);

  const [snapshot, setSnapshot] = useState<ResourceSnapshot>();
  const [history, setHistory] = useState<ResourceSnapshot[]>([]);
  const [retention, setRetention] = useState<ResourceRetention>();
  const [error, setError] = useState<string>();
  const [historyError, setHistoryError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [exportState, setExportState] = useState<"idle" | "saving" | "saved" | "truncated" | "failed">("idle");
  const live = useRef(true);
  const inFlight = useRef(false);

  const actionState = useRef<ResourceActionState>({ sessions: [], runs: {}, tasks: {}, openPaths: new Set() });
  actionState.current = { sessions, runs, tasks, openPaths: new Set(Object.keys(open)), ...(presence ? { presence } : {}) };

  const refresh = useCallback(async (initial = false) => {
    if (inFlight.current || document.visibilityState !== "visible") return;
    inFlight.current = true;
    if (initial) setLoading(true);
    else setRefreshing(true);
    try {
      const result = await client.request("resource/snapshot", { refresh: true });
      if (!live.current) return;
      setSnapshot(result.snapshot);
      setRetention(result.retention);
      setHistory((current) => mergeHistory(current, [result.snapshot]));
      setError(undefined);
    } catch (refreshError) {
      if (live.current) setError(messageOf(refreshError));
    } finally {
      inFlight.current = false;
      if (live.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [client]);

  useEffect(() => {
    live.current = true;
    void refresh(true);
    const stop = startVisiblePoll(() => void refresh(), RESOURCE_POLL_MS);
    return () => {
      live.current = false;
      stop();
    };
  }, [refresh]);

  const loadHistory = useCallback(async () => {
    try {
      const result = await client.request("resource/history", { limit: RESOURCE_HISTORY_PAGE_MAX });
      if (!live.current) return;
      setHistory((current) => mergeHistory(current, result.snapshots));
      setRetention(result.retention);
      setHistoryError(undefined);
    } catch (loadError) {
      if (live.current) setHistoryError(messageOf(loadError));
    }
  }, [client]);

  // Snapshot first, then history: the page includes the sample that caused collection.
  const loadedHistoryFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!snapshot || loadedHistoryFor.current) return;
    loadedHistoryFor.current = snapshot.id;
    void loadHistory();
  }, [loadHistory, snapshot]);

  const saveExport = useCallback(async () => {
    setActionError(undefined);
    setExportState("saving");
    try {
      const result = await client.request("resource/export", {});
      const url = URL.createObjectURL(new Blob([result.document], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "resource-diagnostics.json";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setExportState(result.truncated ? "truncated" : "saved");
    } catch (exportError) {
      setExportState("failed");
      setActionError(`Could not download the redacted report. ${messageOf(exportError)}`);
    }
  }, [client]);

  if (loading && !snapshot) {
    return <div className="flex h-full items-start justify-center pt-16"><GenerationLoader label="Loading resource diagnostics" layout="block" /></div>;
  }
  if (!snapshot) {
    return <div className="mx-auto max-w-160 px-6 py-8"><ErrorState title="Could not read resource diagnostics" detail={error} onRetry={() => void refresh(true)} /></div>;
  }

  const total = totalPhysicalSummary(snapshot, history);
  const roles = roleSummaries(snapshot, history);
  const groups = processTree(snapshot);
  const historyPoints = history.map((sample) => sample.totals.physical.status === "available" ? sample.totals.physical.value : null);
  const completeHistory = historyPoints.filter((point): point is number => point !== null).length;
  const savedSessions = sessionsLoaded && catalogGroups ? catalogGroups.reduce((sum, group) => sum + group.total, 0) : undefined;
  const stores = retainedStoreRows({
    snapshot,
    ...(savedSessions !== undefined ? { savedSessions } : {}),
    rendererViews: Object.keys(open).length,
    pendingMessages: Object.values(open).reduce((sum, view) => sum + view.pending.length + view.queue.steering.length + view.queue.followUp.length, 0),
    ...(optionalStores ? { optional: optionalStores } : {}),
  });
  const stale = Boolean(error) || connection !== "open";

  return (
    <ScrollArea className="h-full">
      <main data-slot="resource-diagnostics" className="mx-auto flex max-w-240 flex-col gap-6 px-4 py-5 sm:px-6">
        <header className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-ink">Resource diagnostics</h2>
              <Badge variant={stale ? "outline" : snapshot.health.ok ? "live" : "attention"}>{stale ? "Stale" : snapshot.health.ok ? "Healthy" : "Needs attention"}</Badge>
            </div>
            <p className="mt-1 max-w-180 text-sm leading-6 text-ink-2">
              Process truth from the host. Physical memory is proportional set size on Linux and private resident memory elsewhere; resident totals are never substituted.
            </p>
            <p className="mt-1 text-xs leading-5 text-ink-3" title={dateTime(snapshot.at)}>
              Last sampled {relativeTime(snapshot.at)} · {snapshot.platform} · collected in {duration(snapshot.durationMs)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" disabled={refreshing} onClick={() => void refresh()}>
              <RefreshCw className={cn(refreshing && "motion-safe:animate-sweep")} />
              {refreshing ? "Refreshing" : "Refresh"}
            </Button>
            <Button type="button" size="sm" variant="secondary" disabled={exportState === "saving"} onClick={() => void saveExport()}>
              <Download />
              {exportState === "saving" ? "Preparing report" : "Download redacted report"}
            </Button>
          </div>
        </header>

        {error ? <ErrorState title="The latest refresh failed; the last good sample is still shown" detail={error} onRetry={() => void refresh()} /> : null}
        {historyError ? <ErrorState title="Could not load retained history; the current sample is still shown" detail={historyError} onRetry={() => void loadHistory()} /> : null}
        {connection !== "open" && !error ? <p role="status" className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2">The host is disconnected. These values are the last sample received.</p> : null}
        {actionError ? <div role="alert" className="flex flex-wrap items-start gap-2 rounded-xl bg-[color-mix(in_oklab,var(--danger)_8%,transparent)] px-3 py-2"><div className="min-w-0 flex-1"><p className="text-sm font-medium text-danger">That action could not be completed</p><p className="mt-0.5 wrap-break-word text-sm text-ink-2">{actionError}</p></div><Button type="button" size="xs" variant="destructive-ghost" onClick={() => setActionError(undefined)}>Dismiss</Button></div> : null}
        <p role="status" className="sr-only">
          {exportState === "saved" ? "Redacted resource report downloaded." : exportState === "truncated" ? "Redacted resource report downloaded; older samples were omitted by the host’s export bound." : ""}
        </p>

        <section aria-labelledby="resource-memory-title" className="flex flex-col gap-3">
          <div>
            <h3 id="resource-memory-title" className="text-sm font-semibold text-ink">Physical memory</h3>
            <p className="mt-0.5 text-xs leading-5 text-ink-2">Peak is the highest complete physical sample still in bounded history, not summed resident high-water marks.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MemoryCard label="Whole application" summary={total} live />
            {roles.map((role) => <MemoryCard key={role.id} label={role.label} summary={role} />)}
          </div>
        </section>

        <section aria-labelledby="resource-history-title" className="rounded-xl border border-line bg-surface p-4">
          <h3 id="resource-history-title" className="text-sm font-semibold text-ink">Bounded history</h3>
          {completeHistory >= 2 ? (
            <Chart
              className="mt-3"
              label="Complete physical samples"
              value={displayMetric(total.current, true)}
              points={historyPoints}
              pointLabel={(value, index) => `${dateTime(history[index]?.at ?? "")}: ${formatBytes(value)}`}
              unavailableLabel={(index) => `${dateTime(history[index]?.at ?? "")}: unavailable`}
            />
          ) : (
            <p className="mt-3 rounded-lg bg-surface-2 px-3 py-4 text-sm text-ink-2">Collecting another complete sample before drawing a trend. Missing measurements are never plotted as zero.</p>
          )}
          {retention ? <RetentionFacts retention={retention} /> : null}
        </section>

        <section aria-labelledby="resource-stores-title" className="flex flex-col gap-3">
          <div>
            <h3 id="resource-stores-title" className="text-sm font-semibold text-ink">Retained state</h3>
            <p className="mt-0.5 text-xs leading-5 text-ink-2">Counts and bytes appear only when their owner reports them. Unavailable rows are contracts for the named containment work, not estimates.</p>
          </div>
          <div className="overflow-hidden rounded-xl border border-line">
            <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,0.65fr)_minmax(7rem,0.4fr)_minmax(7rem,0.4fr)] gap-3 bg-surface-2 px-3 py-2 md:grid">
              {['Store', 'Owner', 'Count', 'Retained bytes'].map((label) => <span key={label} className="eyebrow">{label}</span>)}
            </div>
            {stores.map((store) => (
              <div key={store.id} data-store={store.id} className="grid gap-2 border-t border-line px-3 py-3 first:border-t-0 md:grid-cols-[minmax(0,1fr)_minmax(0,0.65fr)_minmax(7rem,0.4fr)_minmax(7rem,0.4fr)] md:items-start">
                <div className="min-w-0"><p className="text-sm font-medium text-ink">{store.label}</p>{store.handoff ? <p className="text-xs text-ink-3">Contract handoff: M18-{store.handoff}</p> : null}</div>
                <p className="text-xs text-ink-2"><span className="eyebrow me-2 md:hidden">Owner</span>{store.owner}</p>
                <MetricValue label="Count" metric={store.count} />
                <MetricValue label="Retained bytes" metric={store.bytes} bytes />
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="resource-processes-title" className="flex flex-col gap-3">
          <div>
            <h3 id="resource-processes-title" className="text-sm font-semibold text-ink">Processes by role and owner</h3>
            <p className="mt-0.5 text-xs leading-5 text-ink-2">Session, run and task IDs are associations hosted by a process. They do not divide or allocate its memory.</p>
          </div>
          {snapshot.processes.length === 0 ? (
            <div className="rounded-xl border border-line bg-surface px-4 py-8 text-center"><p className="text-sm font-medium text-ink">No owned processes were discovered</p><p className="mt-1 text-xs leading-5 text-ink-2">Refresh after the host has started work. Collection health and retention above are still valid.</p></div>
          ) : groups.map((group) => (
            <div key={group.role} className="overflow-hidden rounded-xl border border-line bg-surface">
              <div className="flex items-center gap-2 bg-surface-2 px-3 py-2"><Waypoints className="size-4 text-ink-3" aria-hidden="true" /><h4 className="text-sm font-medium text-ink">{group.label}</h4><Badge variant="outline">{snapshot.processes.filter((process) => process.role === group.role).length}</Badge></div>
              {group.owners.map((owner) => (
                <div key={owner.id} className="border-t border-line first:border-t-0">
                  <p className="px-3 pt-3 text-xs font-medium text-ink-2">{owner.label}</p>
                  <div className="p-2">{owner.roots.map((node) => <ProcessBranch key={node.process.key} node={node} snapshot={snapshot} state={actionState} native={isNativeDesktop()} workbench={workbench} actions={actions} onError={setActionError} />)}</div>
                </div>
              ))}
            </div>
          ))}
        </section>

        <HealthFacts snapshot={snapshot} />
      </main>
    </ScrollArea>
  );
}

function MemoryCard({ label, summary, live = false }: { label: string; summary: { current: MetricCell; peak: MetricCell; coverage: string }; live?: boolean }) {
  return <div className="rounded-xl border border-line bg-surface p-3">
    <p className="text-sm font-medium text-ink">{label}</p>
    <div className="mt-3 flex flex-col gap-2">
      <div><p className="eyebrow">Current physical</p>{live && summary.current.status === "available" ? <NumberTicker value={formatBytes(summary.current.value)} label={`${label} current physical memory`} className="typed mt-0.5 text-ink" /> : <MetricValue metric={summary.current} bytes />}</div>
      <div><p className="eyebrow">Peak observed</p><MetricValue metric={summary.peak} bytes /></div>
      <p className="text-xs text-ink-3">{summary.coverage}</p>
    </div>
  </div>;
}

function displayMetric(metric: MetricCell, bytes = false): string {
  if (metric.status === "available") return `${bytes ? formatBytes(metric.value) : metric.value.toLocaleString()}${metric.qualifier ? ` · ${metric.qualifier}` : ""}`;
  const known = metric.knownValue === undefined ? "" : ` · known ${bytes ? formatBytes(metric.knownValue) : metric.knownValue.toLocaleString()}`;
  return `Unavailable${known} · ${metric.reason}`;
}

function MetricValue({ label, metric, bytes = false }: { label?: string; metric: MetricCell; bytes?: boolean }) {
  return <p className={cn("min-w-0 text-xs leading-5", metric.status === "available" ? "typed text-ink" : "text-ink-3")} title={metric.status === "unavailable" ? metric.reason : undefined}>
    {label ? <span className="eyebrow me-2 md:hidden">{label}</span> : null}{displayMetric(metric, bytes)}
  </p>;
}

function RetentionFacts({ retention }: { retention: ResourceRetention }) {
  const rows: SpecRow[] = [
    { label: "retained", value: `${retention.snapshots.toLocaleString()} samples · ${retention.processRows.toLocaleString()} process rows · ${formatBytes(retention.bytes)}`, typed: true },
    { label: "independent bounds", value: `${formatElapsed(retention.maxAgeMs)} · ${retention.maxSnapshots.toLocaleString()} samples · ${retention.maxProcessRows.toLocaleString()} rows · ${formatBytes(retention.maxBytes)}`, typed: true },
    { label: "ownership records", value: `${retention.ownershipRecords.toLocaleString()} of ${retention.maxOwnershipRecords.toLocaleString()}${retention.ownershipOverflow ? " · live workers exceed the normal bound" : ""}`, typed: true },
    ...(retention.lastEvictedBy ? [{ label: "last evicted by", value: retention.lastEvictedBy }] : []),
  ];
  return <><SpecSheet bare className="mt-4" rows={rows} /><p className="mt-3 text-xs leading-5 text-ink-3">The host samples only while a diagnostics viewer asks. Age, sample count, process rows and bytes evict independently; this chart shows the newest {RESOURCE_HISTORY_PAGE_MAX} samples.</p></>;
}

function metricRow(label: string, measure: ResourceMeasure, bytes = false, format?: (value: number) => string): SpecRow {
  const cell = measureCell(measure);
  return {
    label,
    value: cell.status === "available" && format ? format(cell.value) : displayMetric(cell, bytes),
    typed: cell.status === "available",
  };
}

interface BranchProps {
  node: ProcessNode;
  snapshot: ResourceSnapshot;
  state: React.MutableRefObject<ResourceActionState>;
  native: boolean;
  workbench: ReturnType<typeof useWorkbench>;
  actions: ReturnType<typeof useLaserStable>["actions"];
  onError: (message: string | undefined) => void;
}

function ProcessBranch(props: BranchProps) {
  const { node, snapshot } = props;
  const [open, setOpen] = useState(false);
  const process = node.process;
  const physical = physicalMeasure(process, snapshot.platform);
  return <div className="border-s border-line ps-2">
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button type="button" className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start outline-none hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11" aria-label={`${open ? "Hide" : "Show"} details for ${process.label}`}>
          <ChevronDown aria-hidden="true" className={cn("size-4 shrink-0 text-ink-3 transition-transform duration-(--motion-fast) motion-reduce:transition-none", open ? "rotate-0" : "-rotate-90 rtl:rotate-90")} />
          <span className="min-w-0 flex-1 truncate text-sm text-ink">{process.label}</span>
          <span className="typed shrink-0 text-ink-2">{physical.status === "available" ? formatBytes(physical.value) : "Unavailable"}</span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ProcessDetails {...props} />
      </CollapsibleContent>
    </Collapsible>
    {node.children.length > 0 ? <div className="ms-3">{node.children.map((child) => <ProcessBranch key={child.process.key} {...props} node={child} />)}</div> : null}
  </div>;
}

function ProcessDetails({ node, snapshot, state, native, workbench, actions, onError }: BranchProps) {
  const process = node.process;
  const rows: SpecRow[] = [
    { label: "identity", value: process.key, typed: true },
    { label: "role", value: ROLE_LABELS[process.role] },
    ...(process.parentKey ? [{ label: "parent", value: process.parentKey, typed: true }] : []),
    metricRow(snapshot.platform === "linux" ? "physical (PSS)" : "physical (private)", physicalMeasure(process, snapshot.platform), true),
    metricRow("private resident", process.memory.privateResident, true),
    metricRow("private commit", process.memory.commit, true),
    metricRow("resident (not additive)", process.memory.resident, true),
    metricRow("peak resident (not additive)", process.memory.peakResident, true),
    metricRow("CPU time", process.cpu.seconds, false, (seconds) => `${seconds.toFixed(1)}s`),
    metricRow("elapsed", process.elapsedMs, false, duration),
    metricRow("I/O read", process.io.readBytes, true),
    metricRow("I/O written", process.io.writeBytes, true),
    { label: "source", value: process.source },
    ...(process.electron ? [metricRow("Electron working set", process.electron.workingSetBytes, true)] : []),
  ];
  const sessionIds = process.associations?.sessionIds ?? [];
  const runIds = process.associations?.runIds ?? [];
  const taskIds = process.associations?.taskIds ?? [];
  const navigate = async (path: string, fleetKey?: string) => {
    workbench.close();
    await actions.openSession(path);
    if (fleetKey) revealInFleet(fleetKey);
  };
  const changed = (reason: string | undefined) => onError(reason ?? "That work changed before the action could run. Refresh diagnostics and try again.");
  return <div className="flex flex-col gap-3 px-2 pb-3 pt-2">
    <SpecSheet bare rows={rows} />
    {sessionIds.length + runIds.length + taskIds.length > 0 ? <div className="flex flex-col gap-2">
      <p className="eyebrow">Associated work</p>
      {sessionIds.map((id) => <AssociationRow key={`session:${id}`} kind="Session" id={id}><Button size="xs" variant="outline" onClick={() => { const target = resolveSessionAssociation(id, state.current); if (!target.path) return changed(target.reason); void navigate(target.path); }}>Open chat</Button></AssociationRow>)}
      {runIds.map((id) => {
        const current = state.current.runs[id];
        return <AssociationRow key={`run:${id}`} kind="Agent run" id={id}>
          <Button size="xs" variant="outline" onClick={() => { const target = resolveRunAssociation(id, state.current); if (!target.path) return changed(target.reason); void navigate(target.path, `agent:${target.path}`); }}>Show in fleet</Button>
          {native && current && !isTerminalRunStatus(current.status) ? <Button size="xs" variant="outline" onClick={() => { const target = resolveRunAssociation(id, state.current); if (!target.run || isTerminalRunStatus(target.run.status)) return changed(target.reason); requestEndAgent(target.run.runId); }}><Square />End agent…</Button> : null}
        </AssociationRow>;
      })}
      {taskIds.map((id) => {
        const current = state.current.tasks[id];
        return <AssociationRow key={`task:${id}`} kind="Background task" id={id}>
          <Button size="xs" variant="outline" onClick={() => { const target = resolveTaskAssociation(id, state.current); if (!target.path) return changed(target.reason); void navigate(target.path, `task:${id}`); }}>Show in fleet</Button>
          {native && current?.status === "running" ? <Button size="xs" variant="outline" onClick={() => { const target = resolveTaskAssociation(id, state.current); if (!target.task || target.task.status !== "running") return changed(target.reason); void actions.tasks.stop(target.task.sessionPath, target.task.id).catch((error: unknown) => changed(messageOf(error))); }}><Square />Stop</Button> : null}
        </AssociationRow>;
      })}
      {process.associations?.truncated ? <p className="text-xs text-ink-3">Some association IDs were omitted by the host’s per-process bound.</p> : null}
    </div> : null}
  </div>;
}

function AssociationRow({ kind, id, children }: { kind: string; id: string; children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-2 py-2"><span className="text-xs font-medium text-ink">{kind}</span><span className="typed min-w-0 flex-1 truncate text-ink-2" title={id}>{id}</span>{children}</div>;
}

function HealthFacts({ snapshot }: { snapshot: ResourceSnapshot }) {
  const collectorRows = snapshot.health.collectors.map((collector) => ({ label: collector.name, value: collector.detail ? `${collector.status} · ${collector.detail}` : collector.status }));
  const rows: SpecRow[] = [
    { label: "process inventory", value: snapshot.health.truncated ? "Truncated at the collection bound" : "Complete discovery within the bound" },
    { label: "Electron cross-check", value: snapshot.health.crossCheck.detail ? `${snapshot.health.crossCheck.status} · ${snapshot.health.crossCheck.detail}` : snapshot.health.crossCheck.status },
    ...collectorRows,
  ];
  return <section aria-labelledby="resource-health-title" className="rounded-xl border border-line bg-surface p-4"><div className="flex items-center gap-2"><Activity className="size-4 text-ink-3" aria-hidden="true" /><h3 id="resource-health-title" className="text-sm font-semibold text-ink">Collection health</h3></div><SpecSheet bare className="mt-3" rows={rows} /></section>;
}

function isNativeDesktop(): boolean {
  const desktop = (globalThis as typeof globalThis & { desktop?: unknown }).desktop;
  return desktop !== null && typeof desktop === "object";
}

export { mergeHistory, RESOURCE_POLL_MS };
