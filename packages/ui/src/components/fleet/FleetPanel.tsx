"use client";
/**
 * The fleet (docs/ux-fleet.md): every piece of agent work, in a permanent
 * column beside the monitor.
 *
 * One component, two frames. `panel` is the desktop column, a real column like
 * sessions and the monitor — not an overlay, not something that steals the
 * conversation. `sheet` is the sub-desktop fallback, exactly as the monitor
 * falls back, so nothing is only reachable on a wide screen.
 *
 * Two things live here that live nowhere else:
 *
 *   - **Orphaned work.** A child agent whose parent session you closed is
 *     still working, and a background command outlives the turn that started
 *     it. Neither is in the session list, so without this column they would be
 *     invisible while spending money.
 *   - **Everything at once.** The transcript shows the work of the turn you
 *     are reading; this shows the work of every session at once, which is a
 *     different question and deserves a different place to ask it.
 */
import { Radio, PanelRightClose, Square, MessageSquare, MessagesSquare, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AnsiText } from "@/components/assistant-ui/elements/ansi-text";
import { SubagentList } from "@/components/assistant-ui/elements/subagent-list";
import { requestEndAgent } from "@/components/agents/end-agent";
import { Button } from "@/components/ui/button";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { clearFinishedFleet, clearFleetReveal, useFleetClearedBefore, useFleetReveal } from "@/fleet/fleet-state";
import { useFleet } from "@/fleet/hooks";
import { useTaskOutput } from "@/fleet/output";
import { branchIsActive, type FleetGroup, type FleetItem } from "@/fleet/model";
import { formatBytes, formatElapsed } from "@/format";
import { cn } from "@/lib/utils";
import { useLaserStable, useLaserState } from "@/runtime";

export interface FleetPanelProps {
  variant: "panel" | "sheet";
  /** The column's own close control; the sheet has the sheet's. */
  onClose?: (() => void) | undefined;
}

export function FleetPanel({ variant, onClose }: FleetPanelProps) {
  const fleet = useFleet();
  const revealed = useFleetReveal();
  const [expanded, setExpanded] = useState<string | undefined>(undefined);

  // Something asked for a particular row: that row is the one you meant, so it
  // is the one open. Spent immediately, so asking twice works twice.
  useEffect(() => {
    if (revealed === undefined) return;
    setExpanded(revealed);
    clearFleetReveal();
  }, [revealed]);

  const toggle = useCallback((key: string) => setExpanded((current) => (current === key ? undefined : key)), []);
  const renderDetail = useCallback((item: FleetItem) => <FleetDetail item={item} />, []);

  // Work the person has already put away. Nothing is deleted — the runs and
  // tasks are the host's records and their sessions are still in the sidebar —
  // so this hides only branches that were already finished when Clear was
  // pressed. Anything still going, and anything that finishes later, stays.
  const clearedBefore = useFleetClearedBefore();
  const groups = useMemo<readonly FleetGroup[]>(() => {
    if (clearedBefore === undefined) return fleet.groups;
    // Keep a branch when anything in it is still going, or when anything in it
    // ended after the mark — a parent that finished before Clear can still have
    // a child that finished after it, and hiding the parent would hide that.
    // An item with no `endedAt` is kept: not knowing when something ended is
    // not a reason to put it away.
    const keep = (item: FleetItem): boolean =>
      branchIsActive(item) || item.endedAt === undefined || item.endedAt > clearedBefore || item.children.some(keep);
    const out: FleetGroup[] = [];
    for (const group of fleet.groups) {
      const items = group.items.filter(keep);
      if (items.length > 0) out.push({ ...group, items });
    }
    return out;
  }, [fleet.groups, clearedBefore]);
  const hasFinished = useMemo(() => groups.some((group) => group.items.some((item) => !branchIsActive(item))), [groups]);

  return (
    <aside
      aria-label="Fleet"
      data-slot="fleet-panel"
      className={cn("flex h-full min-h-0 flex-col bg-surface", variant === "panel" && "w-80 shrink-0 hairline-l")}
    >
      <header className={cn("flex h-12 shrink-0 items-center gap-2 px-4 hairline-b", variant === "sheet" && "pe-12")}>
        <span className="relative flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-live">
          <Radio className="size-4" aria-hidden="true" />
          {fleet.running > 0 ? (
            <span
              aria-label="Work is in progress"
              className="absolute -end-0.5 -top-0.5 size-2 rounded-full border border-surface bg-live motion-safe:animate-attention"
            />
          ) : null}
        </span>
        <h2 className="eyebrow">Fleet</h2>
        <span className="min-w-0 truncate text-xs leading-xs text-ink-3">{summaryLine(fleet)}</span>
        {variant === "panel" && onClose && (
          <TooltipIconButton tooltip="Hide the fleet" shortcut="\" className="ms-auto" onClick={onClose}>
            <PanelRightClose />
          </TooltipIconButton>
        )}
      </header>

      <div className="@container min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
        {fleet.empty || groups.length === 0 ? (
          <FleetEmpty />
        ) : (
          <SubagentList
            groups={groups}
            expandedKey={expanded}
            onToggle={toggle}
            renderDetail={renderDetail}
            onClearFinished={hasFinished ? () => clearFinishedFleet() : undefined}
          />
        )}
      </div>
    </aside>
  );
}

function summaryLine(fleet: { running: number; needsYou: number; empty: boolean }): string {
  if (fleet.empty) return "nothing yet";
  const parts: string[] = [];
  if (fleet.running > 0) parts.push(`${fleet.running} going`);
  if (fleet.needsYou > 0) parts.push(`${fleet.needsYou} ${fleet.needsYou === 1 ? "needs" : "need"} you`);
  return parts.length > 0 ? parts.join(" · ") : "all finished";
}

/**
 * The empty state, drawn on purpose. It says what would fill it and how, so a
 * person who has never started an agent knows this column is not broken.
 */
function FleetEmpty() {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-xl bg-surface-2 text-ink-3">
        <Radio className="size-5" aria-hidden="true" />
      </span>
      <p className="text-sm leading-sm font-medium text-ink">Nothing is running</p>
      <p className="max-w-56 text-xs leading-xs text-ink-2">
        Agents you start, and commands they leave running in the background, appear here — from every project, whether or not their session is open.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The open row
// ---------------------------------------------------------------------------

function FleetDetail({ item }: { item: FleetItem }) {
  return item.kind === "task" ? <TaskDetail item={item} /> : <AgentDetail item={item} />;
}

/**
 * The row's controls: where the work lives, and how to end it.
 *
 * An agent and a background command are not the same kind of thing, and the
 * copy has to say so. A child agent has a chat of its own; a command has no
 * conversation at all, only the session whose agent started it, so calling
 * that "Open chat" promises a transcript that does not exist.
 *
 * The control is drawn only when its destination is actually reachable. A
 * session that has been deleted underneath a still-listed run would give a
 * button that navigates nowhere, which is the exact defect this column
 * inherited from the panels it replaced (M13-T25). An empty catalog is not
 * evidence of absence — it is a catalog that has not arrived — so the check
 * only hides the control once there is a catalog to be missing from.
 */
function DetailActions({ item, onStop, stopping }: { item: FleetItem; onStop?: (() => void) | undefined; stopping?: boolean }) {
  const { actions } = useLaserStable();
  const reachable = useLaserState((s) => s.sessions.length === 0 || s.sessions.some((session) => session.path === item.sessionPath));
  const task = item.kind === "task";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {reachable && (
        <Button
          size="xs"
          variant="outline"
          data-slot={task ? "fleet-open-session" : "fleet-open-chat"}
          title={task ? "The session whose agent ran this command" : undefined}
          onClick={() => void actions.openSession(item.sessionPath)}
        >
          {task ? <MessagesSquare /> : <MessageSquare />}
          {task ? "Open its session" : "Open chat"}
        </Button>
      )}
      {onStop && (
        <Button size="xs" variant="outline" disabled={stopping} onClick={onStop}>
          <Square />
          {task ? "Stop" : "End agent…"}
        </Button>
      )}
    </div>
  );
}

/**
 * One fact about a piece of work. Stacked, not two columns: a 320px column
 * leaves a label column no room to spare, and the values here are paths,
 * commands and branch names — the things that read worst in 140px.
 *
 * `@container`-based, so the same field pairs into two columns in the sheet
 * on a tablet, where there is width for it.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 @sm:flex-row @sm:gap-3">
      <dt className="eyebrow shrink-0 @sm:w-20">{label}</dt>
      <dd className="min-w-0 flex-1 text-xs leading-xs text-ink-2">{children}</dd>
    </div>
  );
}

function AgentDetail({ item }: { item: FleetItem }) {
  const run = item.run;
  // Ending an agent is the one confirmation in the app (`EndAgentDialog`), so
  // this asks it rather than inventing a second way to stop a run.
  const target = item.stop?.kind === "agent" ? item.stop.runId : undefined;
  const stop = target === undefined ? undefined : () => requestEndAgent(target);
  return (
    <div className="min-w-0">
      <dl className="flex flex-col gap-2">
        {item.subtitle && (
          <Field label="Task">
            <span className="line-clamp-4 whitespace-pre-wrap break-words">{item.subtitle}</span>
          </Field>
        )}
        {item.model && <Field label="Model">{item.model}</Field>}
        {run?.worktree && (
          <Field label="Worktree">
            <span className="typed break-all">{run.worktree.branch}</span>
          </Field>
        )}
        {item.elapsedMs !== undefined && <Field label="Elapsed">{formatElapsed(item.elapsedMs)}</Field>}
        {item.terminalReason && <Field label="Ended">{item.terminalReason}</Field>}
        {run?.result?.message && (
          <Field label="Result">
            <span className="line-clamp-6 whitespace-pre-wrap break-words">{run.result.message}</span>
          </Field>
        )}
      </dl>
      <DetailActions item={item} onStop={stop} />
    </div>
  );
}

function TaskDetail({ item }: { item: FleetItem }) {
  const { actions } = useLaserStable();
  const [reload, setReload] = useState(0);
  const [stopping, setStopping] = useState(false);
  const output = useTaskOutput(item.sessionPath, item.task?.id, { bytes: item.outputBytes, reloadToken: reload });

  const stop = useCallback(() => {
    const target = item.stop;
    if (!target || target.kind !== "task") return;
    setStopping(true);
    void actions.tasks
      .stop(target.path, target.id)
      .catch((error: unknown) => actions.toast("error", error instanceof Error ? error.message : String(error)))
      .finally(() => setStopping(false));
  }, [actions, item.stop]);

  return (
    <div className="min-w-0">
      <dl className="flex flex-col gap-2">
        <Field label="Command">
          <span className="typed line-clamp-4 whitespace-pre-wrap break-words">{item.task?.command ?? item.title}</span>
        </Field>
        {item.elapsedMs !== undefined && <Field label="Elapsed">{formatElapsed(item.elapsedMs)}</Field>}
        {item.terminalReason && <Field label="Ended">{item.terminalReason}</Field>}
        {typeof item.task?.exitCode === "number" && <Field label="Exit code">{item.task.exitCode}</Field>}
        {item.outputBytes !== undefined && <Field label="Output">{formatBytes(item.outputBytes)}</Field>}
      </dl>

      <div className="mt-3 min-w-0">
        {output.error ? (
          <div className="rounded-lg border border-line bg-surface-2 p-3">
            <p className="text-xs leading-xs text-ink-2">{output.error}</p>
            <Button size="xs" variant="outline" className="mt-2" onClick={() => setReload((n) => n + 1)}>
              <RotateCw />
              Try again
            </Button>
          </div>
        ) : output.loading && output.text === "" ? (
          <p className="text-xs leading-xs text-ink-3">Reading the output…</p>
        ) : output.text === "" ? (
          <p className="text-xs leading-xs text-ink-3">{item.terminal ? "It printed nothing." : "Nothing printed yet."}</p>
        ) : (
          <TaskOutputBody text={output.text} truncated={output.fromByte > 0} follow={!item.terminal} />
        )}
      </div>

      <DetailActions item={item} onStop={item.stop?.kind === "task" ? stop : undefined} stopping={stopping} />
    </div>
  );
}

/**
 * The tail of a task's output. Its own scroller, so a long log never widens
 * the column and never scrolls the page; a live task sticks to the bottom, and
 * a finished one stays where the reader left it.
 */
function TaskOutputBody({ text, truncated, follow }: { text: string; truncated: boolean; follow: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [follow, text]);
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-line bg-terminal">
      {truncated && <p className="px-2.5 pt-2 text-xs leading-xs text-ink-3">Showing the end of the output.</p>}
      <pre
        ref={ref}
        data-slot="task-output"
        className="max-h-56 overflow-auto overscroll-contain whitespace-pre-wrap break-words p-2.5 font-mono text-xs leading-relaxed text-terminal-ink"
      >
        <AnsiText text={text} />
      </pre>
    </div>
  );
}
