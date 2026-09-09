"use client";
/**
 * The fleet (docs/ux-fleet.md): the open session's tree of work, in a
 * permanent column beside the monitor.
 *
 * One component, two frames. `panel` is the desktop column, a real column like
 * sessions and the monitor — not an overlay, not something that steals the
 * conversation. `sheet` is the sub-desktop fallback, exactly as the monitor
 * falls back, so nothing is only reachable on a wide screen.
 *
 * What it shows is one session's tree (M13-T51): the agents the open session
 * started, their agents, and the background commands any of them left running
 * — including the root's own. A child session as the open session shows its
 * root's tree with the child marked, because a child is part of its root's
 * tree, not a tree of its own. Work under another top-level session is not
 * here at all: that session has its own fleet, and the person navigates to it.
 *
 * Two things live here that live nowhere else:
 *
 *   - **A child whose parent you closed.** It is still working, and a
 *     background command outlives the turn that started it. Neither is in the
 *     transcript, so without this column they would be invisible while
 *     spending money.
 *   - **Work whose session was deleted.** Its root is gone, so no session can
 *     show it and nothing can navigate to it. It is one line at the bottom of
 *     every fleet, named and counted, until it ends or is stopped from there.
 */
import { Radio, PanelRightClose, Square, FolderX, MessageSquare, MessagesSquare, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { SubagentList, SubagentStrays } from "@/components/assistant-ui/elements/subagent-list";
import { TerminalBlock } from "@/components/assistant-ui/elements/terminal-block";
import { requestRemoveWorktree } from "@/agents/worktree";
import { requestEndAgent } from "@/components/agents/end-agent";
import { Button } from "@/components/ui/button";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { clearFinishedFleet, clearFleetReveal, useFleetClearedBefore, useFleetReveal } from "@/fleet/fleet-state";
import { useFleet, type FleetView } from "@/fleet/hooks";
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
  // The mark is one per viewer (D-154), so it applies to the tree being shown
  // and to work from deleted sessions alike; Clear here clears what is here.
  const clearedBefore = useFleetClearedBefore();
  const putAway = useCallback(
    (groups: readonly FleetGroup[]): FleetGroup[] => {
      if (clearedBefore === undefined) return [...groups];
      // Keep a branch when anything in it is still going, or when anything in it
      // ended after the mark — a parent that finished before Clear can still have
      // a child that finished after it, and hiding the parent would hide that.
      // An item with no `endedAt` is kept: not knowing when something ended is
      // not a reason to put it away.
      const keep = (item: FleetItem): boolean =>
        branchIsActive(item) || item.endedAt === undefined || item.endedAt > clearedBefore || item.children.some(keep);
      const out: FleetGroup[] = [];
      for (const group of groups) {
        const items = group.items.filter(keep);
        if (items.length > 0) out.push({ ...group, items });
      }
      return out;
    },
    [clearedBefore],
  );
  const tree = useMemo<FleetGroup | undefined>(() => (fleet.tree ? putAway([fleet.tree])[0] : undefined), [fleet.tree, putAway]);
  const elsewhere = useMemo<FleetGroup[]>(() => putAway(fleet.elsewhere), [fleet.elsewhere, putAway]);
  const anyFinished = (groups: readonly FleetGroup[]): boolean => groups.some((group) => group.items.some((item) => !branchIsActive(item)));
  const hasFinished = useMemo(() => (tree ? anyFinished([tree]) : false), [tree]);
  const hasFinishedElsewhere = useMemo(() => anyFinished(elsewhere), [elsewhere]);
  // Only what this panel shows lights its dot: the tree, and the strays under it.
  const going = fleet.running > 0 || elsewhere.some((group) => group.running > 0);

  return (
    <aside
      aria-label="Fleet"
      data-slot="fleet-panel"
      className={cn("flex h-full min-h-0 flex-col bg-surface", variant === "panel" && "w-80 shrink-0 hairline-l")}
    >
      <header className={cn("flex h-12 shrink-0 items-center gap-2 px-4 hairline-b", variant === "sheet" && "pe-12")}>
        <span className="relative flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-live">
          <Radio className="size-4" aria-hidden="true" />
          {going ? (
            <span
              aria-label="Work is in progress"
              className="absolute -end-0.5 -top-0.5 size-2 rounded-full border border-surface bg-live motion-safe:animate-attention"
            />
          ) : null}
        </span>
        <h2 className="eyebrow">Fleet</h2>
        <span data-slot="fleet-summary" className="min-w-0 truncate text-xs leading-xs text-ink-3">
          {summaryLine(fleet)}
        </span>
        {variant === "panel" && onClose && (
          <TooltipIconButton tooltip="Hide the fleet" shortcut="\" className="ms-auto" onClick={onClose}>
            <PanelRightClose />
          </TooltipIconButton>
        )}
      </header>

      <div className="@container flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
        <div className="min-h-0 flex-1">
          {fleet.current === undefined ? (
            <FleetNoSession />
          ) : tree ? (
            <SubagentList
              groups={[tree]}
              expandedKey={expanded}
              currentKey={`agent:${fleet.current}`}
              onToggle={toggle}
              renderDetail={renderDetail}
              onClearFinished={hasFinished ? () => clearFinishedFleet() : undefined}
            />
          ) : (
            <FleetEmpty />
          )}
        </div>
        {elsewhere.length > 0 && (
          <SubagentStrays
            groups={elsewhere}
            expandedKey={expanded}
            onToggle={toggle}
            renderDetail={renderDetail}
            onClearFinished={hasFinishedElsewhere ? () => clearFinishedFleet() : undefined}
          />
        )}
      </div>
    </aside>
  );
}

/** The header's one line: the open session's counts, and only those (M13-T51). */
function summaryLine(fleet: FleetView): string {
  if (fleet.current === undefined) return "no session open";
  if (fleet.tree === undefined) return "nothing here yet";
  const parts: string[] = [];
  if (fleet.running > 0) parts.push(`${fleet.running} going`);
  if (fleet.needsYou > 0) parts.push(`${fleet.needsYou} ${fleet.needsYou === 1 ? "needs" : "need"} you`);
  return parts.length > 0 ? parts.join(" · ") : "all finished";
}

/**
 * The empty state of an open session with no work, drawn on purpose. It says
 * what would fill it and that other sessions keep their own, so a person who
 * started an agent somewhere else knows this column is not broken.
 */
function FleetEmpty() {
  return (
    <div data-slot="fleet-empty" className="flex h-full min-h-48 flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-xl bg-surface-2 text-ink-3">
        <Radio className="size-5" aria-hidden="true" />
      </span>
      <p className="text-sm leading-sm font-medium text-ink">Nothing is running here</p>
      <p className="max-w-56 text-xs leading-xs text-ink-2">
        Agents this session starts, their agents, and commands any of them leave running appear here. Another session’s work is in that session’s fleet.
      </p>
    </div>
  );
}

/**
 * No session is open: a fresh window, or only Beam’s bubble. The fleet has
 * nothing to be the tree of, and saying "nothing is running" would be a claim
 * about the whole project that this column no longer makes.
 */
function FleetNoSession() {
  return (
    <div data-slot="fleet-no-session" className="flex h-full min-h-48 flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-xl bg-surface-2 text-ink-3">
        <MessageSquare className="size-5" aria-hidden="true" />
      </span>
      <p className="text-sm leading-sm font-medium text-ink">No session is open</p>
      <p className="max-w-56 text-xs leading-xs text-ink-2">
        The fleet is the open session’s: the agents it starts and the commands they leave running. Open a session from the sidebar to see its work.
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
 *
 * The row for the chat being read offers no "Open chat" either: a control
 * that goes where you already are is a control that does nothing, and R4
 * puts the reason where the control would have been.
 */
function DetailActions({
  item,
  onStop,
  stopping,
  onRemoveWorktree,
}: {
  item: FleetItem;
  onStop?: (() => void) | undefined;
  stopping?: boolean;
  /** Present only for a finished agent whose worktree is still on disk. */
  onRemoveWorktree?: (() => void) | undefined;
}) {
  const { actions } = useLaserStable();
  const reachable = useLaserState((s) => s.sessions.length === 0 || s.sessions.some((session) => session.path === item.sessionPath));
  const here = useLaserState((s) => s.current === item.sessionPath);
  const task = item.kind === "task";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {here ? (
        <span data-slot="fleet-here" className="text-xs leading-xs text-ink-3">
          {task ? "Its session is the chat you are reading." : "This is the chat you are reading."}
        </span>
      ) : reachable && (
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
      {onRemoveWorktree && (
        <Button
          size="xs"
          variant="outline"
          data-slot="fleet-remove-worktree"
          title="Its parent owns this worktree; remove it yourself if the parent never did"
          onClick={onRemoveWorktree}
        >
          <FolderX />
          Remove worktree…
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
  // The parent owns merging and removing this worktree (D-157). A parent that
  // never got to it leaves the directory for ever, so a person can clear it
  // from here — but only once the run is over, and never while it is the
  // agent's own working directory.
  const label = run?.subagentName ?? item.title;
  const removable = run?.worktree && !run.worktree.removedAt && target === undefined ? run : undefined;
  const removeWorktree = removable ? () => requestRemoveWorktree(removable.sessionPath, label) : undefined;
  return (
    <div className="min-w-0">
      <dl className="flex flex-col gap-2">
        {item.subtitle && (
          <Field label="Task">
            <span className="line-clamp-4 whitespace-pre-wrap break-words">{item.subtitle}</span>
          </Field>
        )}
        {item.model && <Field label="Model">{item.model}</Field>}
        {run?.worktree ? (
          <Field label="Worktree">
            <span className="typed break-all">{run.worktree.branch}</span>
            {run.worktree.removedAt ? (
              // Its parent, or a person, has taken it away: the branch is
              // history, and offering a path that is gone would be a lie.
              <span className="mt-0.5 block text-ink-3">Removed. Its conversation is still here.</span>
            ) : (
              <span className="mt-0.5 block break-all text-ink-3">{run.worktree.path}</span>
            )}
          </Field>
        ) : run?.cwd ? (
          // Started without a worktree: the parent judged this agent read-only,
          // so the directory is the fact, and there is no branch to invent.
          <Field label="Working in">
            <span className="typed break-all">{run.cwd}</span>
            <span className="mt-0.5 block text-ink-3">Shares its parent’s checkout.</span>
          </Field>
        ) : null}
        {item.elapsedMs !== undefined && <Field label="Elapsed">{formatElapsed(item.elapsedMs)}</Field>}
        {run?.status === "needs_input" && run.question && (
          // Live, paused on a question (M13-T45): the question is the one
          // thing the person can act on, so it is here in full, with its
          // choices, and the chat is where it is answered.
          <Field label="Asking">
            <span data-slot="fleet-question" className="whitespace-pre-wrap break-words text-ink">{run.question.title}</span>
            {run.question.detail && <span className="mt-0.5 block whitespace-pre-wrap break-words text-ink-2">{run.question.detail}</span>}
            {run.question.options && <span className="mt-0.5 block text-ink-3">Choices: {run.question.options.join(" · ")}</span>}
            <span className="mt-0.5 block text-ink-3">Answer it in its chat, or its parent can.</span>
          </Field>
        )}
        {item.terminalReason && <Field label="Ended">{item.terminalReason}</Field>}
        {run?.result?.message && (
          <Field label="Result">
            <span className="line-clamp-6 whitespace-pre-wrap break-words">{run.result.message}</span>
          </Field>
        )}
      </dl>
      <DetailActions item={item} onStop={stop} onRemoveWorktree={removeWorktree} />
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

  // The command and how it ended are the terminal block's own header — it is
  // the same element the transcript's `bash` row draws, so a command reads the
  // same in both places (M13-T60). The block follows a live command's output
  // and says when it is showing a tail; `failed` without an exit code is a
  // command that could not run or was killed, which is the block's loud state.
  const task = item.task;
  const exitCode = typeof task?.exitCode === "number" ? task.exitCode : undefined;
  const broken = task?.status === "failed" && exitCode === undefined;

  return (
    <div className="min-w-0">
      <dl className="flex flex-col gap-2">
        {item.elapsedMs !== undefined && <Field label="Elapsed">{formatElapsed(item.elapsedMs)}</Field>}
        {item.terminalReason && <Field label="Ended">{item.terminalReason}</Field>}
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
        ) : (
          <TerminalBlock
            command={task?.command ?? item.title}
            output={output.text}
            exitCode={exitCode}
            running={!item.terminal}
            isError={broken}
            follow
            truncatedHead={output.fromByte > 0}
            ansi
          />
        )}
      </div>

      <DetailActions item={item} onStop={item.stop?.kind === "task" ? stop : undefined} stopping={stopping} />
    </div>
  );
}
