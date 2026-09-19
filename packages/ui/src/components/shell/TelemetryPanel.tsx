import { useEffect, useRef, useState } from "react";
import { Activity, PanelRightClose } from "lucide-react";

import { StatusRing } from "@/components/status";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useWorkbench } from "@/components/workbench/workbench-context";
import { cn } from "@/lib/utils";
import { useLaserStable, useSessionMeta } from "@/runtime";

import { ContextSection } from "@/components/telemetry/context-section.js";
import { FilesSection } from "@/components/telemetry/files-section.js";
import { scopeBarText } from "@/components/telemetry/format.js";
import { HistorySection } from "@/components/telemetry/history-section.js";
import { ModelSection } from "@/components/telemetry/model-section.js";
import { useSessionChanges, useSessionTelemetry } from "@/components/telemetry/queries.js";
import { ScopeBar } from "@/components/telemetry/section.js";
import { SpendSection } from "@/components/telemetry/spend-section.js";
import { WorkSection } from "@/components/telemetry/work-section.js";
import { useShell } from "./shell-context.js";

export interface TelemetryPanelProps {
  variant: "panel" | "sheet";
}

/**
 * The session signals a supervisor watches: context, spend, model, work,
 * files and history. Read-only except compact / fork / jump.
 */
export function TelemetryPanel({ variant }: TelemetryPanelProps) {
  const meta = useSessionMeta();
  const shell = useShell();
  const { status: telemetryStatus, telemetry } = useSessionTelemetry();
  const workbench = useWorkbench();
  const { actions } = useLaserStable();
  const [filesRefresh, setFilesRefresh] = useState(0);
  const running = meta.running || meta.compacting;
  const wasRunning = useRef(false);
  useEffect(() => {
    wasRunning.current = false;
  }, [meta.path]);
  useEffect(() => {
    if (wasRunning.current && !running) setFilesRefresh((n) => n + 1);
    wasRunning.current = running;
  }, [running]);
  const files = useSessionChanges(meta.path, meta.session?.cwd, filesRefresh);

  const [contextOpen, setContextOpen] = useState(true);
  const [spendOpen, setSpendOpen] = useState(true);
  const [modelOpen, setModelOpen] = useState(true);
  const [workOpen, setWorkOpen] = useState(true);
  const [filesOpen, setFilesOpen] = useState(true);

  return (
    <aside
      aria-label="Telemetry"
      className={cn("flex h-full min-h-0 flex-col bg-surface", variant === "panel" && "w-80 shrink-0 hairline-s")}
    >
      <header className={cn("flex h-11 shrink-0 items-center gap-2 px-3 hairline-b", variant === "sheet" && "pe-12")}>
        <span className="relative flex size-4 shrink-0 items-center justify-center text-live">
          <Activity className="size-4" aria-hidden="true" />
          {meta.running ? (
            <span
              aria-label="Agent is working"
              className="absolute -end-1 -top-1 size-2 rounded-full border border-surface bg-live motion-safe:animate-attention"
            />
          ) : null}
        </span>
        <h2 className="eyebrow">Telemetry</h2>
        {meta.session && (
          <span className="truncate typed text-ink-3" title={meta.path}>
            {meta.session.id.slice(0, 8)}
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
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {meta.session ? (
          <>
            <ScopeBar text={scopeBarText(telemetry?.history, telemetryStatus)} />
            <ContextSection
              context={telemetry?.context}
              busy={meta.running || meta.compacting}
              compacting={meta.compacting}
              open={contextOpen}
              onOpenChange={setContextOpen}
              onCompact={() => void actions.compact()}
            />
            <SpendSection
              spend={telemetry?.spend}
              open={spendOpen}
              onOpenChange={setSpendOpen}
              onOpenUsage={() => workbench.open("settings", "usage")}
            />
            <ModelSection model={telemetry?.model} open={modelOpen} onOpenChange={setModelOpen} />
            <WorkSection work={telemetry?.work} open={workOpen} onOpenChange={setWorkOpen} />
            <FilesSection
              changes={files.changes}
              status={files.status}
              message={files.message}
              sessionKey={meta.path}
              open={filesOpen}
              onOpenChange={setFilesOpen}
              onRefresh={() => setFilesRefresh((n) => n + 1)}
            />
            <HistorySection history={telemetry?.history} />
          </>
        ) : (
          <NoSession />
        )}
      </div>
    </aside>
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
