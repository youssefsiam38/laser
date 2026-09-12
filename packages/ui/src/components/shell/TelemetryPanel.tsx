import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Brain,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Cpu,
  Database,
  FileCode2,
  Gauge,
  History,
  Layers3,
  Landmark,
  PanelRightClose,
  RefreshCw,
  Shrink,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { Chart } from "@/components/assistant-ui/elements/chart";
import { ContextRingButton } from "@/components/assistant-ui/elements/context-display";
import { CostMeter } from "@/components/assistant-ui/elements/cost-meter";
import { FileTree, useSessionFileChanges } from "@/components/assistant-ui/elements/file-tree";
import { ProviderLogo } from "@/components/assistant-ui/elements/logos";
import { NumberTicker } from "@/components/assistant-ui/elements/number-ticker";
import { AccountUsage } from "./AccountUsage.js";
import { useWorkbench } from "@/components/workbench/workbench-context";
import { ToolTimeline, useThreadToolTimeline } from "@/components/assistant-ui/elements/tool-timeline";
import { StatusRing } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { money, tokens } from "@/format";
import { cn } from "@/lib/utils";
import { useRunsForRoot } from "@/agents";
import { useLaserStable, useLaserView, useSessionMeta } from "@/runtime";

import { CheckpointHistory } from "@/components/assistant-ui/elements/checkpoint-history";
import {
  backgroundUsageSources,
  historyRows,
  isAccountProvider,
  sessionBillingMode,
  spendSeries,
  usageByModel,
  usageFromEntries,
  type BackgroundUsageSource,
  type UsageTotals,
} from "./model.js";
import { useShell } from "./shell-context.js";

export interface TelemetryPanelProps {
  variant: "panel" | "sheet";
}

/**
 * The session signals a supervisor watches: context, spend, model, file and
 * tool activity, and history. Read-only except compact / fork / jump.
 */
export function TelemetryPanel({ variant }: TelemetryPanelProps) {
  const view = useLaserView();
  const meta = useSessionMeta();
  const shell = useShell();

  return (
    <aside
      aria-label="Telemetry"
      className={cn("flex h-full min-h-0 flex-col bg-surface", variant === "panel" && "w-80 shrink-0 hairline-s")}
    >
      <header className={cn("flex h-12 shrink-0 items-center gap-2 px-4 hairline-b", variant === "sheet" && "pe-12")}>
        <span className="relative flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-live">
          <Activity className="size-4" aria-hidden="true" />
          {meta.running ? (
            <span
              aria-label="Agent is working"
              className="absolute -end-0.5 -top-0.5 size-2 rounded-full border border-surface bg-live motion-safe:animate-attention"
            />
          ) : null}
        </span>
        <h2 className="eyebrow">Telemetry</h2>
        {view && (
          <span className="truncate font-mono text-xs text-ink-3" title={view.path}>
            {view.state.id.slice(0, 8)}
          </span>
        )}
        {variant === "panel" && (
          <TooltipIconButton
            tooltip="Hide telemetry"
            shortcut="]"
            className="ms-auto"
            onClick={() => shell.setTelemetryOpen(false)}
          >
            <PanelRightClose className="rtl:-scale-x-100" />
          </TooltipIconButton>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {view ? (
          <>
            {view.history && !view.history.complete && <LoadedHistoryNotice />}
            <ContextSection />
            <UsageSection />
            <ModelSection />
            <FilesSection />
            <ToolsSection />
            <HistorySection />
          </>
        ) : (
          <NoSession />
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Section({
  title,
  icon: Icon,
  signal,
  action,
  children,
}: {
  title: string;
  icon: LucideIcon;
  signal?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="px-4 py-3 hairline-b">
      <div className="mb-2.5 flex min-h-6 items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-2 text-ink-2">
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
        <h3 className="eyebrow">{title}</h3>
        {signal ? <span className="ms-auto">{signal}</span> : null}
        {action}
      </div>
      {children}
    </section>
  );
}

function InstrumentCard({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("rounded-xl border border-line bg-surface-2/70 p-3", className)}>{children}</div>
  );
}

function NoSession() {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 px-6 text-center">
      <StatusRing status="idle" size={40} thickness={2} aria-hidden="true">
        <span className="font-mono text-xs text-ink-3">—</span>
      </StatusRing>
      <div className="max-w-52">
        <p className="text-sm font-semibold text-ink">Nothing to measure</p>
        <p className="mt-1 text-xs leading-4 text-ink-2">Open a session and its context, spend and history land here.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function ContextSection() {
  const { actions } = useLaserStable();
  const view = useLaserView();
  const meta = useSessionMeta();
  const usage = meta.contextUsage;
  const busy = meta.running || meta.compacting;
  return (
    <Section
      title="Context"
      icon={Gauge}
      action={
        <Button size="xs" variant="outline" disabled={busy || !usage} onClick={() => void actions.compact()}>
          <Shrink />
          {meta.compacting ? "Compacting…" : "Compact"}
        </Button>
      }
    >
      <InstrumentCard className="flex items-center gap-4">
        {/* The one context ring in the app, drawn large. Same component the
            composer and the top bar mount (docs/ux-elements.md "Context
            display"); the rail was the third hand-drawn copy. */}
        {usage ? (
          <ContextRingButton size={64} stroke={3} showLabel side="left" />
        ) : (
          <StatusRing status="idle" size={64} thickness={3} label="Context usage unknown" aria-hidden="true">
            <span className="text-sm text-ink-3">—</span>
          </StatusRing>
        )}
        <div className="min-w-0 flex-1">
          {usage ? (
            <>
              <p className="text-xs leading-4 text-ink-3">Window load</p>
              <p className="mt-0.5 font-mono text-sm font-semibold text-ink tnum">
                {usage.tokens === null ? "—" : tokens(usage.tokens)} <span className="font-normal text-ink-3">/ {tokens(usage.contextWindow)}</span>
              </p>
              <div className="mt-2 flex items-center gap-1.5 text-xs text-ink-2">
                <span
                  aria-hidden="true"
                  className={cn("size-1.5 rounded-full", view?.state.autoCompactionEnabled ? "bg-ok" : "bg-ink-3")}
                />
                Auto-compact {view?.state.autoCompactionEnabled ? "on" : "off"}
              </div>
            </>
          ) : (
            <p className="text-xs leading-4 text-ink-3">No usage reported yet. The first response fills this in.</p>
          )}
        </div>
      </InstrumentCard>
    </Section>
  );
}

function LoadedHistoryNotice() {
  const { actions } = useLaserStable();
  const [loading, setLoading] = useState(false);
  return <div className="flex flex-col items-start gap-2 border-b border-line px-4 py-3 text-xs leading-5 text-ink-2">
    <p>Earlier history is not loaded. Conversation-wide totals and older activity appear when it is.</p>
    <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" aria-disabled={loading} onClick={() => {
      if (loading) return;
      setLoading(true);
      void actions.loadAllEntries().finally(() => setLoading(false));
    }}>{loading ? "Loading history…" : "Load complete history"}</Button>
  </div>;
}

const TOKEN_TONES = ["bg-live", "bg-ok", "bg-attention", "bg-ink-3"] as const;

function TokenComposition({ usage }: { usage: UsageTotals }) {
  const parts = [
    { label: "Input", value: usage.input, icon: ArrowUpFromLine },
    { label: "Output", value: usage.output, icon: ArrowDownToLine },
    { label: "Cache read", value: usage.cacheRead, icon: Database },
    { label: "Cache write", value: usage.cacheWrite, icon: Layers3 },
  ] as const;
  const measured = parts.reduce((sum, part) => sum + part.value, 0);

  return (
    <InstrumentCard>
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-xs leading-4 text-ink-3">Token flow</p>
          <NumberTicker value={tokens(usage.total)} label="Total tokens" className="mt-0.5 font-mono text-lg font-semibold text-ink" />
        </div>
        <span className="font-mono text-xs text-ink-3 tnum">{usage.turns} {usage.turns === 1 ? "turn" : "turns"}</span>
      </div>
      <div className="mt-3 flex h-2 w-full gap-px overflow-hidden rounded-full bg-surface">
        {parts.map((part, index) => {
          const percent = measured > 0 ? (part.value / measured) * 100 : 0;
          if (percent === 0) return null;
          return (
            <span
              key={part.label}
              role="meter"
              aria-label={`${part.label} token share`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percent)}
              className={cn("h-full transition-[width] duration-(--motion-slow) ease-morph motion-reduce:transition-none", TOKEN_TONES[index])}
              style={{ width: `${percent}%` }}
            />
          );
        })}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        {parts.map((part, index) => {
          const Icon = part.icon;
          return (
            <div key={part.label} className="flex min-w-0 items-center gap-2 rounded-lg bg-surface px-2 py-1.5">
              <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-md text-surface", TOKEN_TONES[index])}>
                <Icon className="size-3" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-xs leading-4 text-ink-3">{part.label}</p>
                <p className="font-mono text-xs leading-4 text-ink tnum">{tokens(part.value)}</p>
              </div>
            </div>
          );
        })}
      </div>
    </InstrumentCard>
  );
}

type UsageView = "account" | "api";

function UsageSection() {
  const workbench = useWorkbench();
  const view = useLaserView();
  const entries = view?.entries;
  const childRuns = useRunsForRoot(view?.path);
  const background = useMemo(
    () => backgroundUsageSources(childRuns),
    [childRuns],
  );
  const transcriptMode = useMemo(
    () => (entries ? sessionBillingMode(entries, background) : "none"),
    [background, entries],
  );
  const mode = transcriptMode === "none" && isAccountProvider(view?.state.model?.provider) ? "account" : transcriptMode;
  const [preferred, setPreferred] = useState<UsageView>("account");
  const active: UsageView = mode === "mixed" ? preferred : mode === "account" ? "account" : "api";
  const apiUsage = useMemo<UsageTotals | undefined>(
    () => (entries ? usageFromEntries(entries, "api", background) : undefined),
    [background, entries],
  );
  const accountUsage = view?.state.accountUsage;
  const partial = Boolean(view?.history && !view.history.complete);
  if (partial) return <Section title="Usage" icon={isAccountProvider(view?.state.model?.provider) ? Landmark : CircleDollarSign}>
    {isAccountProvider(view?.state.model?.provider) ? <AccountUsage state={accountUsage} compact /> : <p className="text-xs leading-5 text-ink-2">Load complete history for conversation-wide totals.</p>}
  </Section>;

  return (
    <Section
      title="Usage"
      icon={active === "account" ? Landmark : CircleDollarSign}
      signal={active === "api" && apiUsage ? <Badge variant="mono">{apiUsage.turns} turns</Badge> : undefined}
    >
      {mode === "mixed" ? <UsageTabs active={active} onChange={setPreferred} /> : null}
      {active === "account" ? (
        <>
          <AccountUsage state={accountUsage} compact />
          <Button variant="link" size="sm" className="justify-start text-xs" onClick={() => workbench.open("settings", "usage")}>All usage details <ChevronRight className="rtl:-scale-x-100 size-3" /></Button>
        </>
      ) : (
        <ApiUsage entries={entries} background={background} usage={apiUsage} />
      )}
    </Section>
  );
}

function UsageTabs({ active, onChange }: { active: UsageView; onChange: (view: UsageView) => void }) {
  return (
    <div role="tablist" aria-label="Usage billing view" className="mb-3 grid grid-cols-2 gap-0.5 rounded-lg bg-surface-2 p-0.5">
      {(["account", "api"] as const).map((view) => (
        <Button
          key={view}
          role="tab"
          aria-selected={active === view}
          variant="ghost"
          size="sm"
          className={cn("w-full", active === view && "bg-surface text-ink shadow-float-sm")}
          onClick={() => onChange(view)}
        >
          {view === "account" ? <Landmark /> : <CircleDollarSign />}
          {view === "account" ? "Account" : "API"}
        </Button>
      ))}
    </div>
  );
}

function ApiUsage({
  entries,
  background,
  usage,
}: {
  entries: readonly unknown[] | undefined;
  background: readonly BackgroundUsageSource[];
  usage: UsageTotals | undefined;
}) {
  const lines = useMemo(() => (entries ? usageByModel(entries, "api", background) : []), [background, entries]);
  const series = useMemo(() => (entries ? spendSeries(entries, "api", background) : []), [background, entries]);
  const lastTurn = series.length > 1 ? series[series.length - 1]! - series[series.length - 2]! : series[0];
  return (
    usage ? (
      <div className="flex flex-col gap-4">
        {/* The cost meter and the spend chart (docs/ux-elements.md
            "Observability" and "Structured output"), from API-billed usage
            blocks Pi persists on the session file. */}
        <InstrumentCard>
          <CostMeter
            sessionCostUsd={usage.cost}
            runCostUsd={lastTurn}
            turns={usage.turns}
            lines={lines.map((line) => ({ model: line.model, inputTokens: line.input, outputTokens: line.output, costUsd: line.cost }))}
          />
        </InstrumentCard>
        {series.length > 1 && (
          <InstrumentCard>
            <Chart
              label="Spend over turns"
              value={money(series[series.length - 1] ?? 0)}
              delta={lastTurn !== undefined ? `+${money(lastTurn)} last` : undefined}
              points={series}
              pointLabel={(v, i) => `turn ${i + 1}: ${money(v)}`}
            />
          </InstrumentCard>
        )}
        <TokenComposition usage={usage} />
      </div>
    ) : (
      <p className="text-xs leading-4 text-ink-3">No API spend recorded. Totals appear after an API-billed response.</p>
    )
  );
}


function ModelSection() {
  const meta = useSessionMeta();
  return (
    <Section title="Model" icon={Cpu}>
      <InstrumentCard>
        {meta.model ? (
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-surface text-live shadow-float-sm">
              <ProviderLogo provider={meta.model.provider} className="size-6" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs leading-4 text-ink-3">{meta.model.provider}</p>
              <p className="truncate font-mono text-sm font-medium text-ink" title={`${meta.model.provider}/${meta.model.id}`}>
                {meta.model.id}
              </p>
              <div className="mt-1.5 flex items-center gap-1.5">
                <Brain className="size-3.5 text-ink-3" aria-hidden="true" />
                <span className="text-xs text-ink-2">Thinking</span>
                <Badge variant="mono">{meta.thinkingLevel ?? "—"}</Badge>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 text-sm text-ink-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-surface"><Cpu className="size-5" aria-hidden="true" /></span>
            No model selected
          </div>
        )}
      </InstrumentCard>
    </Section>
  );
}

/**
 * What this session touched on disk, as a tree. Both this and the tool
 * timeline below read the thread's own parts (`useSessionFileChanges`,
 * `useThreadToolTimeline`) rather than new protocol: the tool calls are
 * already in the transcript, so this is a second reading of data the panel
 * can see, not a second source of truth.
 */
function FilesSection() {
  const view = useLaserView();
  const partial = Boolean(view?.history && !view.history.complete);
  const changes = useSessionFileChanges();
  const added = changes.reduce((sum, change) => sum + change.additions, 0);
  const removed = changes.reduce((sum, change) => sum + change.deletions, 0);
  const churn = added + removed;
  return (
    <Section title="Files changed" icon={FileCode2} signal={changes.length > 0 ? <Badge variant="mono">{changes.length}</Badge> : undefined}>
      {changes.length > 0 ? (
        <InstrumentCard className="mb-3">
          <div className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface text-live">
              <FileCode2 className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs leading-4 text-ink-3">{partial ? "Loaded history footprint" : "Session footprint"}</p>
              <NumberTicker
                value={`${changes.length} ${changes.length === 1 ? "file" : "files"}`}
                label="Files changed"
                className="font-mono text-sm font-semibold text-ink"
              />
            </div>
            <div className="text-end font-mono text-xs leading-4 tnum">
              <p className="text-ok">+{added}</p>
              <p className="text-danger">−{removed}</p>
            </div>
          </div>
          {churn > 0 ? (
            <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-surface" role="img" aria-label={`${added} additions and ${removed} deletions`}>
              {added > 0 ? <span className="h-full bg-ok" style={{ width: `${(added / churn) * 100}%` }} /> : null}
              {removed > 0 ? <span className="h-full bg-danger" style={{ width: `${(removed / churn) * 100}%` }} /> : null}
            </div>
          ) : null}
        </InstrumentCard>
      ) : null}
      {partial && changes.length === 0 ? <p className="text-xs leading-5 text-ink-2">No file changes in the loaded history.</p> : <FileTree changes={changes} />}
    </Section>
  );
}

/** Every tool call this session made, in order, with the running one live. */
function ToolsSection() {
  const timeline = useThreadToolTimeline();
  const shell = useShell();
  const { actions } = useLaserStable();
  const view = useLaserView();
  const partial = Boolean(view?.history && !view.history.complete);
  useEffect(() => { if (shell.toolsOpen && partial) void actions.loadAllEntries(); }, [actions, shell.toolsOpen, partial]);
  const visibleSteps = timeline.steps.slice(-14);
  return (
    <Section
      title="Tools"
      icon={Wrench}
      signal={timeline.steps.length > 0 ? <Badge variant={timeline.streaming ? "live" : "mono"}>{timeline.steps.length} {partial ? "loaded" : "calls"}</Badge> : undefined}
    >
      {timeline.steps.length > 0 ? (
        <InstrumentCard className="mb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Activity className={cn("size-4", timeline.streaming ? "text-live" : "text-ink-3")} aria-hidden="true" />
              <span className="text-xs font-medium text-ink">{partial ? "Loaded activity" : "Run activity"}</span>
            </div>
            <span className="font-mono text-xs text-ink-3 tnum">
              {timeline.streaming ? "live" : "settled"}
            </span>
          </div>
          <div
            className="mt-3 flex h-2 items-center gap-1"
            role="img"
            aria-label={`${timeline.steps.length} ${partial ? "loaded " : ""}tool calls; ${timeline.streaming ? "one running" : "all settled"}`}
          >
            {visibleSteps.map((step) => (
              <span
                key={step.id}
                title={`${step.verb}: ${step.chip}`}
                className={cn(
                  "h-full min-w-1 flex-1 rounded-full transition-colors duration-(--motion-slow) ease-morph motion-reduce:transition-none",
                  step.running ? "bg-live motion-safe:animate-attention" : "bg-ink-3",
                )}
              />
            ))}
          </div>
        </InstrumentCard>
      ) : null}
      {partial && timeline.steps.length === 0 ? <p className="text-xs leading-5 text-ink-2">No tools in the loaded history.</p> : <ToolTimeline timeline={timeline} open={shell.toolsOpen} onOpenChange={shell.setToolsOpen} />}
    </Section>
  );
}

// Extension output is not a section here. What an extension has to *show*
// arrives in the tool call that produced it; what it has to *ask* is answered
// inline in the transcript (docs/ux-fleet.md, "Questions").

function HistorySection() {
  const { actions } = useLaserStable();
  const view = useLaserView();
  const meta = useSessionMeta();
  const shell = useShell();
  const entries = view?.entries;
  const rows = useMemo(() => (entries ? historyRows(entries) : []), [entries]);

  // Refresh when opened and when the session settles; never on callback churn.
  const refresh = useRef(actions.refreshEntries);
  refresh.current = actions.refreshEntries;
  const path = view?.path;
  const running = view?.running ?? false;
  useEffect(() => {
    if (shell.historyOpen && path) void refresh.current();
  }, [shell.historyOpen, path, running]);

  return (
    <section className="hairline-b">
      <Collapsible open={shell.historyOpen} onOpenChange={shell.setHistoryOpen}>
        <div className="flex h-11 items-center gap-1 pe-3 ps-4">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="group -ms-1 flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md ps-1 text-start outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live"
            >
              <ChevronRight
                className="rtl:-scale-x-100 size-3.5 shrink-0 text-ink-3 transition-transform duration-(--motion-instant) group-aria-expanded:rotate-90 group-aria-expanded:rtl:-rotate-90"
                aria-hidden="true"
              />
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-2 text-ink-2">
                <History className="size-3.5" aria-hidden="true" />
              </span>
              <span className="eyebrow">History</span>
              {rows.length > 0 && (
                <span className="ms-auto flex items-center gap-1 font-mono text-xs text-ink-3 tnum">
                  <Clock3 className="size-3" aria-hidden="true" />
                  {rows.length}{view?.history && !view.history.complete ? " loaded" : ""}
                </span>
              )}
            </button>
          </CollapsibleTrigger>
          {shell.historyOpen && (
            <TooltipIconButton tooltip="Refresh history" size="icon-xs" className="text-ink-3" onClick={() => void actions.refreshEntries()}>
              <RefreshCw />
            </TooltipIconButton>
          )}
        </div>
        <CollapsibleContent>
          <CheckpointHistory
            rows={rows}
            busy={meta.running || meta.compacting}
            onFork={(id) => void actions.fork(id)}
            onJump={(id) => void actions.jump(id)}
          />
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
