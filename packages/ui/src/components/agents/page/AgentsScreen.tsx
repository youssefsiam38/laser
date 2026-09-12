"use client";
/**
 * The Agents page (docs/ux-elements.md "Agent card", M13-T5): create, edit,
 * select, validate and delete reusable agents; the built-ins at the bottom;
 * the harness limits last.
 *
 * Desktop: a 288px list column and the editor beside it. Phone: the list
 * first, then the editor as a full-height view with a back control — no
 * sheet inside the workbench. A deep link (`target`, from
 * `workbench.open("agents", { agent, field })`) opens that agent scrolled to
 * that field with its notice focused.
 */
import type { AgentDefinition } from "@lasercode/protocol";
import { ChevronLeft, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { agentByName, agentDisplayName, isBuiltinAgent, isWorkspaceCwd, useAgentWarnings, useAgentsActions, useAgentsSnapshot, useAgentsStatus, warningsFor } from "@/agents";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useWorkbench, type AgentsTarget } from "@/components/workbench";
import { useIsMobile } from "@/hooks";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";

import { AgentEditor, type EditorFocus } from "./AgentEditor.js";
import { AgentList } from "./AgentList.js";
import { BuiltinPanel } from "./BuiltinPanel.js";
import { HarnessPanel } from "./HarnessPanel.js";
import { AgentsOverview } from "./Overview.js";
import { DiscardChangesDialog } from "./dialogs.js";
import { isFirstRun, sameSelection, type AgentsSelection } from "./model.js";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface AgentsScreenProps {
  /** The project the page is about; undefined when none is open. */
  cwd: string | undefined;
  target?: AgentsTarget | undefined;
}

export function AgentsScreen({ cwd, target }: AgentsScreenProps) {
  const snapshot = useAgentsSnapshot();
  const status = useAgentsStatus();
  const warnings = useAgentWarnings();
  const agents = useAgentsActions();
  const { actions } = useLaserStable();
  const workbench = useWorkbench();
  const mobile = useIsMobile();

  const [selection, setSelection] = useState<AgentsSelection>(null);
  const [focus, setFocus] = useState<EditorFocus>();
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<{ selection: AgentsSelection; field?: string | undefined }>();
  const [newCount, setNewCount] = useState(0);
  const seq = useRef(0);

  // The snapshot arrives with the connection; a page opened before that, or
  // after a failure, asks once more.
  useEffect(() => {
    if (!status.loaded && !status.loading) void agents.refresh();
  }, [agents, status.loaded, status.loading]);

  const apply = useCallback((next: AgentsSelection, field?: string) => {
    setSelection((current) => {
      if (next?.kind === "new" && current?.kind !== "new") setNewCount((n) => n + 1);
      return next;
    });
    setFocus(field ? { field, seq: ++seq.current } : undefined);
  }, []);

  /** Change what the editor shows, asking first when the editor has unsaved edits. */
  const select = useCallback(
    (next: AgentsSelection, field?: string) => {
      if (sameSelection(next, selection)) {
        if (field) setFocus({ field, seq: ++seq.current });
        return;
      }
      if (dirty) {
        setPending({ selection: next, field });
        return;
      }
      apply(next, field);
    },
    [apply, dirty, selection],
  );

  // Deep link: the affected agent, scrolled to the field.
  useEffect(() => {
    if (!target) return;
    select({ kind: "agent", name: target.agent }, target.field);
    // Only a new target should re-open; `select` changes with dirtiness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  // Phone: Escape from the editor returns to the list. A dialog or popover
  // that used Escape for itself has already marked the event.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!mobile || !selection || event.key !== "Escape" || event.defaultPrevented) return;
    const inLayer = (event.target as HTMLElement | null)?.closest("[role='dialog'],[data-radix-popper-content-wrapper]");
    if (inLayer) return;
    event.preventDefault();
    select(null);
  };

  const projectCwd = cwd && !isWorkspaceCwd(cwd, snapshot) ? cwd : undefined;
  const routeCwd = cwd ?? snapshot?.workspaces.beam;
  const selectedAgent = useMemo(() => (selection?.kind === "agent" ? agentByName(snapshot, selection.name) : undefined), [snapshot, selection]);
  const selectedWarnings = useMemo(() => (selectedAgent ? warningsFor(snapshot, selectedAgent.name) : []), [snapshot, selectedAgent]);

  const onSaved = useCallback(
    (saved: AgentDefinition) => {
      setDirty(false);
      setSelection({ kind: "agent", name: saved.name });
      actions.toast("info", `${agentDisplayName(saved.name)} saved.`);
    },
    [actions],
  );
  const onDeleted = useCallback(() => {
    const name = selection?.kind === "agent" ? selection.name : undefined;
    setDirty(false);
    setSelection(null);
    if (name) actions.toast("info", `${agentDisplayName(name)} deleted.`);
  }, [actions, selection]);
  const startChat = useCallback(
    async (name: string) => {
      if (!projectCwd) return;
      try {
        await actions.newSession(projectCwd, { agentName: name });
        workbench.close();
      } catch (error) {
        actions.toast("error", messageOf(error));
      }
    },
    [actions, projectCwd, workbench],
  );

  if (!snapshot) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-slot="agents-screen" data-state={status.error ? "error" : "loading"}>
        <Header count={undefined} warnings={0} mobile={mobile} editing={false} onNew={() => undefined} onBack={() => undefined} disabled />
        {status.error ? (
          <div className="p-4">
            <ErrorState title="Couldn’t load your agents" detail={status.error} onRetry={() => void agents.refresh()} />
          </div>
        ) : (
          <PageSkeleton mobile={mobile} />
        )}
      </div>
    );
  }

  const editing = selection !== null;
  const showList = !mobile || !editing;
  const showEditor = !mobile || editing;
  const editorKey = selection === null ? "overview" : selection.kind === "new" ? `new:${newCount}` : selection.kind === "harness" ? "harness" : `agent:${selection.name}`;
  const customCount = snapshot.agents.filter((agent) => !isBuiltinAgent(agent)).length;

  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="agents-screen" data-state="ready" onKeyDown={onKeyDown}>
      <Header
        count={customCount}
        warnings={warnings.length}
        mobile={mobile}
        editing={editing}
        title={selection?.kind === "agent" ? agentDisplayName(selection.name) : selection?.kind === "new" ? "New agent" : selection?.kind === "harness" ? "Harness" : undefined}
        onNew={() => select({ kind: "new" })}
        onBack={() => select(null)}
      />
      <div className="flex min-h-0 flex-1">
        {showList ? (
          <ScrollArea className={cn("min-h-0 shrink-0", mobile ? "w-full" : "w-72 hairline-e")}>
            <AgentList
              snapshot={snapshot}
              warnings={warnings}
              selection={selection}
              onSelect={(next) => select(next)}
              lead={mobile && isFirstRun(snapshot) ? <AgentsOverview compact snapshot={snapshot} warnings={warnings} onNew={() => select({ kind: "new" })} onOpen={(next, field) => select(next, field)} /> : undefined}
            />
          </ScrollArea>
        ) : null}
        {showEditor ? (
          <div
            key={editorKey}
            data-slot="agents-editor-column"
            className={cn(
              "min-h-0 min-w-0 flex-1 overflow-y-auto",
              mobile && "animate-in fade-in-0 slide-in-from-right-2 fill-mode-both duration-(--motion-slow) motion-reduce:animate-none",
            )}
          >
            {selection === null ? (
              <AgentsOverview snapshot={snapshot} warnings={warnings} onNew={() => select({ kind: "new" })} onOpen={(next, field) => select(next, field)} />
            ) : selection.kind === "harness" ? (
              <HarnessPanel snapshot={snapshot} />
            ) : selection.kind === "new" ? (
              <AgentEditor
                agent={undefined}
                snapshot={snapshot}
                routeCwd={routeCwd}
                projectCwd={projectCwd}
                warnings={[]}
                focus={focus}
                onDirtyChange={setDirty}
                onSaved={onSaved}
                onDeleted={onDeleted}
                onStartChat={(name) => void startChat(name)}
              />
            ) : selectedAgent === undefined ? (
              <div className="p-4">
                <ErrorState title={`There is no agent named "${selection.name}" any more`} detail="It may have been deleted from another view." onRetry={() => select(null)} retryLabel="Back to the list" />
              </div>
            ) : isBuiltinAgent(selectedAgent) ? (
              <BuiltinPanel name={selectedAgent.name as "beam" | "chat" | "namer"} snapshot={snapshot} routeCwd={routeCwd} />
            ) : (
              <AgentEditor
                agent={selectedAgent}
                snapshot={snapshot}
                routeCwd={routeCwd}
                projectCwd={projectCwd}
                warnings={selectedWarnings}
                focus={focus}
                onDirtyChange={setDirty}
                onSaved={onSaved}
                onDeleted={onDeleted}
                onStartChat={(name) => void startChat(name)}
              />
            )}
          </div>
        ) : null}
      </div>

      <DiscardChangesDialog
        open={pending !== undefined}
        onKeep={() => setPending(undefined)}
        onDiscard={() => {
          if (pending) apply(pending.selection, pending.field);
          setDirty(false);
          setPending(undefined);
        }}
      />
    </div>
  );
}

function Header({
  count,
  warnings,
  mobile,
  editing,
  title,
  disabled = false,
  onNew,
  onBack,
}: {
  count: number | undefined;
  warnings: number;
  mobile: boolean;
  editing: boolean;
  title?: string | undefined;
  disabled?: boolean;
  onNew(): void;
  onBack(): void;
}) {
  const summary =
    count === undefined ? undefined : `${count} agent${count === 1 ? "" : "s"}${warnings > 0 ? ` · ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`;
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 px-3 hairline-b">
      {mobile && editing ? (
        <>
          <TooltipIconButton tooltip="Back to agents" side="bottom" onClick={onBack} data-slot="agents-back">
            <ChevronLeft />
          </TooltipIconButton>
          <h2 className="min-w-0 truncate text-sm font-semibold text-ink">{title ?? "Agents"}</h2>
        </>
      ) : (
        <>
          <h2 className="text-sm font-semibold text-ink">Agents</h2>
          {summary ? <span className="typed truncate text-ink-3">{summary}</span> : null}
        </>
      )}
      {!(mobile && editing) ? (
        <Button type="button" size="sm" variant="secondary" className="ms-auto" disabled={disabled} onClick={onNew} data-slot="agents-new">
          <Plus />
          New agent
        </Button>
      ) : null}
    </div>
  );
}

function PageSkeleton({ mobile }: { mobile: boolean }) {
  return (
    <div className="flex min-h-0 flex-1" aria-busy="true" aria-label="Loading agents" role="status">
      <div className={cn("flex shrink-0 flex-col gap-2 px-3 py-4", mobile ? "w-full" : "w-72 hairline-e")}>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
      {!mobile ? (
        <div className="mx-auto flex w-full max-w-180 flex-col gap-4 px-6 py-5">
          <Skeleton className="h-36 w-full rounded-xl" />
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : null}
    </div>
  );
}
