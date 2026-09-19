import { useEffect, useState } from "react";
import { Activity, PanelRightClose } from "lucide-react";
import type { ProjectChanges, SessionTelemetry, SessionUpdateParams } from "@lasercode/protocol";

import { StatusRing } from "@/components/status";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useWorkbench } from "@/components/workbench/workbench-context";
import { cn } from "@/lib/utils";
import { useLaserStable, useLaserState, useSessionMeta } from "@/runtime";

import { ContextSection } from "@/components/telemetry/context-section.js";
import { FilesSection, type FilesStatus } from "@/components/telemetry/files-section.js";
import { scopeBarText } from "@/components/telemetry/format.js";
import { HistorySection } from "@/components/telemetry/history-section.js";
import { ModelSection } from "@/components/telemetry/model-section.js";
import { ScopeBar } from "@/components/telemetry/section.js";
import { SpendSection } from "@/components/telemetry/spend-section.js";
import { WorkSection } from "@/components/telemetry/work-section.js";
import { useShell } from "./shell-context.js";

export interface TelemetryPanelProps {
  variant: "panel" | "sheet";
}

export { HistorySection };

function useSessionTelemetry(): SessionTelemetry | undefined {
  const { client } = useLaserStable();
  const path = useLaserState((s) => s.current);
  const [telemetry, setTelemetry] = useState<SessionTelemetry | undefined>();
  useEffect(() => {
    if (!path) {
      setTelemetry(undefined);
      return;
    }
    let cancelled = false;
    setTelemetry(undefined);
    void client.request("pi/session/telemetry", { path }).then(
      (result) => {
        if (!cancelled) setTelemetry(result);
      },
      () => {
        if (!cancelled) setTelemetry(undefined);
      },
    );
    const unsubscribe = client.subscribe((method, params) => {
      if (method !== "session/update") return;
      const update = params as SessionUpdateParams;
      if (update.sessionPath !== path || !update.telemetry) return;
      setTelemetry(update.telemetry);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, path]);
  return telemetry;
}

function useSessionChanges(
  path: string | undefined,
  cwd: string | undefined,
  revision: string | undefined,
): { status: FilesStatus; changes?: ProjectChanges; message?: string } {
  const { client } = useLaserStable();
  const [state, setState] = useState<{ status: FilesStatus; changes?: ProjectChanges; message?: string }>({
    status: "idle",
  });
  useEffect(() => {
    if (!path || !cwd) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void client.request("pi/project/changes", { cwd, path, scope: "session" }).then(
      (result) => {
        if (!cancelled) setState({ status: "ready", changes: result });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, path, cwd, revision]);
  return state;
}

/**
 * The session signals a supervisor watches: context, spend, model, work,
 * files and history. Read-only except compact / fork / jump.
 */
export function TelemetryPanel({ variant }: TelemetryPanelProps) {
  const meta = useSessionMeta();
  const shell = useShell();
  const telemetry = useSessionTelemetry();
  const workbench = useWorkbench();
  const { actions } = useLaserStable();
  const files = useSessionChanges(meta.path, meta.session?.cwd, telemetry?.revision);

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
        {meta.session && (
          <span className="truncate font-mono text-xs text-ink-3" title={meta.path}>
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
            <ScopeBar text={scopeBarText(telemetry?.history)} />
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
