import type * as React from "react";
import { useEffect, useMemo, useRef } from "react";
import { Brain, ChevronRight, Cpu, PanelRightClose, RefreshCw, Shrink } from "lucide-react";

import { StatusRing } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { money, tokens } from "@/format";
import { cn } from "@/lib/utils";
import { usePiorbitStable, usePiorbitView, useSessionMeta } from "@/runtime";

import { HistoryTree } from "./HistoryTree.js";
import { historyRows, usageFromEntries, type UsageTotals } from "./model.js";
import { useShell } from "./shell-context.js";

export interface TelemetryPanelProps {
  variant: "panel" | "sheet";
}

/**
 * The numbers a supervisor watches: context, spend, model, worker, extension
 * state, and the session tree. Read-only except compact / fork / jump.
 */
export function TelemetryPanel({ variant }: TelemetryPanelProps) {
  const view = usePiorbitView();
  const shell = useShell();

  return (
    <aside
      aria-label="Telemetry"
      className={cn("flex h-full min-h-0 flex-col bg-surface", variant === "panel" && "w-80 shrink-0 hairline-l")}
    >
      <header className={cn("flex h-12 shrink-0 items-center gap-2 px-4 hairline-b", variant === "sheet" && "pe-12")}>
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
            <PanelRightClose />
          </TooltipIconButton>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {view ? (
          <>
            <ContextSection />
            <UsageSection />
            <ModelSection />
            <WorkerSection />
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

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="px-4 py-3 hairline-b">
      <div className="mb-2 flex h-5 items-center justify-between gap-2">
        <h3 className="eyebrow">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <>
      <dt className="text-xs leading-5 text-ink-2">{label}</dt>
      <dd className={cn("text-end font-mono text-xs leading-5 tnum", strong ? "font-medium text-ink" : "text-ink")}>
        {value}
      </dd>
    </>
  );
}

function Stats({ children }: { children: React.ReactNode }) {
  return <dl className="grid grid-cols-[auto_1fr] gap-x-3">{children}</dl>;
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
  const { actions } = usePiorbitStable();
  const view = usePiorbitView();
  const meta = useSessionMeta();
  const usage = meta.contextUsage;
  const pct = usage?.percent ?? null;
  const busy = meta.running || meta.compacting;
  return (
    <Section
      title="Context"
      action={
        <Button size="xs" variant="outline" disabled={busy || !usage} onClick={() => void actions.compact()}>
          <Shrink />
          {meta.compacting ? "Compacting…" : "Compact"}
        </Button>
      }
    >
      <div className="flex items-center gap-4">
        <StatusRing
          percent={pct ?? 0}
          size={64}
          thickness={3}
          showLabel={pct !== null}
          label={pct === null ? "Context usage unknown" : `${Math.round(pct)}% of context used`}
        >
          {pct === null ? <span className="text-ink-3">—</span> : undefined}
        </StatusRing>
        <div className="min-w-0 flex-1">
          {usage ? (
            <Stats>
              <Stat label="Tokens" value={usage.tokens === null ? "—" : tokens(usage.tokens)} strong />
              <Stat label="Window" value={tokens(usage.contextWindow)} />
              <Stat label="Auto-compact" value={view?.state.autoCompactionEnabled ? "on" : "off"} />
            </Stats>
          ) : (
            <p className="text-xs leading-4 text-ink-3">No usage reported yet. The first response fills this in.</p>
          )}
        </div>
      </div>
    </Section>
  );
}

function UsageSection() {
  const view = usePiorbitView();
  const entries = view?.entries;
  const usage = useMemo<UsageTotals | undefined>(() => (entries ? usageFromEntries(entries) : undefined), [entries]);
  return (
    <Section title="Spend">
      {usage ? (
        <Stats>
          <Stat label="Input" value={tokens(usage.input)} />
          <Stat label="Output" value={tokens(usage.output)} />
          <Stat label="Cache read" value={tokens(usage.cacheRead)} />
          <Stat label="Cache write" value={tokens(usage.cacheWrite)} />
          <Stat label="Total tokens" value={tokens(usage.total)} />
          <Stat label="Cost" value={money(usage.cost)} strong />
          <Stat label="Per turn" value={usage.turns > 0 ? money(usage.cost / usage.turns) : "—"} />
        </Stats>
      ) : (
        <p className="text-xs leading-4 text-ink-3">No spend recorded. Totals appear once Pi persists a response.</p>
      )}
    </Section>
  );
}

function ModelSection() {
  const meta = useSessionMeta();
  return (
    <Section title="Model">
      <ul className="flex flex-col gap-1.5">
        <li className="flex items-center gap-2 text-xs leading-5">
          <Cpu className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
          {meta.model ? (
            <span className="truncate font-mono text-xs text-ink" title={`${meta.model.provider}/${meta.model.id}`}>
              <span className="text-ink-3">{meta.model.provider}/</span>
              {meta.model.id}
            </span>
          ) : (
            <span className="text-ink-3">No model selected</span>
          )}
        </li>
        <li className="flex items-center gap-2 text-xs leading-5">
          <Brain className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
          <span className="text-ink-2">Thinking</span>
          <Badge variant="mono">{meta.thinkingLevel ?? "—"}</Badge>
        </li>
      </ul>
      <p className="mt-2 text-xs leading-4 text-ink-3">Change both from the composer.</p>
    </Section>
  );
}

const WORKER_TONE: Record<string, { color: string; label: string }> = {
  ready: { color: "bg-ok", label: "Ready" },
  starting: { color: "bg-attention motion-safe:animate-attention", label: "Starting" },
  crashed: { color: "bg-danger", label: "Crashed" },
  retired: { color: "bg-ink-3", label: "Retired" },
};

function WorkerSection() {
  const meta = useSessionMeta();
  const view = usePiorbitView();
  const worker = meta.worker;
  const tone = worker ? (WORKER_TONE[worker.status] ?? { color: "bg-ink-3", label: worker.status }) : undefined;
  return (
    <Section title="Worker">
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className={cn("mt-[7px] size-2 shrink-0 rounded-full", tone?.color ?? "bg-line")} />
        <div className="min-w-0 flex-1">
          <p className="text-xs leading-5 text-ink">
            {tone ? tone.label : "No status yet"}
            {view && <span className="ms-1.5 font-mono text-xs text-ink-3">{view.state.cwd.split("/").filter(Boolean).at(-1)}</span>}
          </p>
          {worker?.message && <p className="text-xs leading-4 break-words text-ink-2">{worker.message}</p>}
          {!worker && <p className="text-xs leading-4 text-ink-3">One Pi process per project directory.</p>}
        </div>
      </div>
    </Section>
  );
}

// Extension output is not a rail section any more: `setWidget` lines render as
// `stream` islands in the dock (or as pills above the composer on a phone) and
// `setStatus` as entries in the status line, both through the panel contract's
// fallback (docs/ux-panels.md, src/panels/fallback.ts).

function HistorySection() {
  const { actions } = usePiorbitStable();
  const view = usePiorbitView();
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
                className="size-3.5 shrink-0 text-ink-3 transition-transform duration-(--motion-instant) group-aria-expanded:rotate-90"
                aria-hidden="true"
              />
              <span className="eyebrow">History</span>
              {rows.length > 0 && <span className="font-mono text-xs text-ink-3 tnum">{rows.length}</span>}
            </button>
          </CollapsibleTrigger>
          {shell.historyOpen && (
            <TooltipIconButton tooltip="Refresh history" size="icon-xs" className="text-ink-3" onClick={() => void actions.refreshEntries()}>
              <RefreshCw />
            </TooltipIconButton>
          )}
        </div>
        <CollapsibleContent>
          <HistoryTree
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
