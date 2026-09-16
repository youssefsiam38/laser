"use client";

import { Pause, Pencil, Play, Target, Trash2 } from "lucide-react";
import { useState } from "react";
import { PRODUCT_DISPLAY_NAME } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Hint } from "@/components/ui/hint";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useCapability, useLaserStable, useLaserState } from "@/runtime";

/** Persistent session objective, directly below the run/panel row. */
export function GoalBar() {
  // The goal, not the session: reading the whole view re-rendered this bar (and
  // its dialogs) on every streamed batch, for a value that changes when the
  // goal does (M16-T32).
  const goal = useLaserState(s => (s.current ? s.open[s.current]?.goal : undefined));
  const { actions } = useLaserStable();
  const [editing, setEditing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [objective, setObjective] = useState("");
  const write = useCapability("session/goal/action");

  if (!goal) return null;
  const resumable = goal.status !== "active" && goal.status !== "complete";

  return (
    <>
      <section aria-label="Session goal" className="shrink-0 px-3 py-2 hairline-b">
        <div className="mx-auto flex max-w-(--measure-thread) items-start gap-3 rounded-xl border border-[color-mix(in_oklab,var(--live)_32%,var(--line))] bg-[color-mix(in_oklab,var(--live)_5%,var(--surface))] px-3 py-2.5">
          <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-[color-mix(in_oklab,var(--live)_14%,var(--surface))] text-live">
            <Target className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="eyebrow text-live">Goal</span>
              <Badge variant={goal.status === "active" ? "live" : goal.status === "complete" ? "ok" : goal.status === "blocked" ? "danger" : "attention"} className="capitalize">
                {goal.status.replace("_", " ")}
              </Badge>
              <Hint className="text-xs tabular-nums text-ink-3" hint="Times the goal automatically asked the agent to continue. Not tool calls or a separate evaluation.">
                {goal.iteration} automatic continuation{goal.iteration === 1 ? "" : "s"}
              </Hint>
            </div>
            <p className="mt-1 whitespace-pre-wrap wrap-break-word text-sm font-medium leading-5 text-ink">{goal.objective}</p>
            {goal.latestReason && <p className="mt-1 text-xs leading-5 text-ink-2">{goal.latestReason}</p>}
          </div>
          {write.state === "available" ? <div className="flex shrink-0 items-center gap-0.5">
            <TooltipIconButton
              tooltip={goal.status === "active" ? "Pause goal" : "Resume goal"}
              onClick={() => void actions.goal(goal.status === "active" ? { action: "pause" } : { action: "resume" })}
              disabled={!resumable && goal.status !== "active"}
            >
              {goal.status === "active" ? <Pause /> : <Play />}
            </TooltipIconButton>
            <TooltipIconButton tooltip="Edit goal" onClick={() => { setObjective(goal.objective); setEditing(true); }}>
              <Pencil />
            </TooltipIconButton>
            <TooltipIconButton tooltip="Clear goal" onClick={() => setClearing(true)}>
              <Trash2 />
            </TooltipIconButton>
          </div> : null}
        </div>
      </section>

      {write.state === "available" ? <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit session goal</DialogTitle>
            <DialogDescription>The updated objective stays attached to this session and keeps its current progress.</DialogDescription>
          </DialogHeader>
          <Textarea value={objective} onChange={(event) => setObjective(event.target.value)} rows={6} maxLength={4000} autoFocus />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            <Button disabled={!objective.trim()} onClick={() => { void actions.goal({ action: "edit", objective: objective.trim() }); setEditing(false); }}>Save goal</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog> : null}

      {write.state === "available" ? <Dialog open={clearing} onOpenChange={setClearing}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Clear this goal?</DialogTitle>
            <DialogDescription>{PRODUCT_DISPLAY_NAME} will stop carrying the objective into future turns in this session. The transcript remains unchanged.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" autoFocus onClick={() => setClearing(false)}>Keep goal</Button>
            <Button variant="destructive" onClick={() => { void actions.goal({ action: "clear" }); setClearing(false); }}>Clear goal</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog> : null}
    </>
  );
}
