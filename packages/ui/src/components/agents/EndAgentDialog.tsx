"use client";
/**
 * "End {subagentName}?" — the one confirmation for ending a run a person
 * started or inherited (docs/agents.md "States, and who sets them":
 * `agents/runs/stop`, initiator `user`, the reason verbatim). Mounted once in
 * the shell; anything that wants to ask calls `requestEndAgent(runId)`
 * (`end-agent.ts`): a sessions-panel row, a run tab, a node on the live map.
 *
 * The shape is GoalBar's confirm: a title that names the thing, one honest
 * sentence about what happens, and a footer where the safe verb has focus.
 * Enter never ends a run — "Keep running" is what Enter lands on, and the
 * textarea keeps Enter for itself. The reason is optional and survives a
 * failure, so a retry does not make the person type it again. A run that
 * ends on its own while the question is open says so instead of offering to
 * end something that is already over.
 */
import { isTerminalRunStatus, type AgentRun } from "@lasercode/protocol";
import { LoaderCircle } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useLaserStable, useLaserState } from "@/runtime";

import { clearEndAgentRequest, useEndAgentRequest } from "./end-agent.js";

/** Three reasons that cover most endings; each fills the field and stays editable. */
export const END_AGENT_REASONS: readonly string[] = ["No longer needed", "Wrong direction", "I'll take over"];

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function EndAgentDialog() {
  const request = useEndAgentRequest();
  const run = useLaserState((s) => (request ? s.agents.runs[request.runId] : undefined));
  return (
    <Dialog open={request !== undefined} onOpenChange={(open) => { if (!open) clearEndAgentRequest(); }}>
      {/* Keyed on the run so a second question never inherits the first one's reason or error. */}
      {request && <EndAgentBody key={request.runId} runId={request.runId} run={run} />}
    </Dialog>
  );
}

function EndAgentBody({ runId, run }: { runId: string; run: AgentRun | undefined }) {
  const { actions } = useLaserStable();
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const keepRef = useRef<HTMLButtonElement>(null);

  const name = run?.subagentName ?? "this agent";
  // The run ended while the question was open: the harness, the parent or a
  // timeout got there first. Nothing is left to end.
  const finished = run !== undefined && isTerminalRunStatus(run.status);

  const confirm = useCallback(async () => {
    setPending(true);
    setError(undefined);
    try {
      const trimmed = reason.trim();
      await actions.agents.stopRun(runId, trimmed ? trimmed : undefined);
      actions.toast("info", `Ended ${name}`);
      clearEndAgentRequest();
    } catch (failure) {
      setError(errorText(failure));
      setPending(false);
    }
  }, [actions, name, reason, runId]);

  return (
    <DialogContent
      className="sm:max-w-md"
      showCloseButton={false}
      data-slot="end-agent-dialog"
      data-finished={finished || undefined}
      // Radix focuses the first tabbable thing, which would be a reason chip;
      // the safe verb owns the first Enter instead.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        keepRef.current?.focus();
      }}
    >
      <DialogHeader>
        <DialogTitle>{finished ? `${name} already ended` : `End ${name}?`}</DialogTitle>
        <DialogDescription>
          {finished
            ? "It finished before you decided. Its conversation and its worktree changes are kept."
            : "Its work stops now. The conversation and its worktree changes are kept, and its parent is told you ended it."}
        </DialogDescription>
      </DialogHeader>

      {!finished && (
        <div className="flex flex-col gap-2">
          <span id={`end-agent-reason-${runId}`} className="eyebrow">Reason · optional</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick reasons">
            {END_AGENT_REASONS.map((quick) => {
              const chosen = reason === quick;
              return (
                <button
                  key={quick}
                  type="button"
                  data-slot="end-agent-reason"
                  aria-pressed={chosen}
                  disabled={pending}
                  onClick={() => setReason(quick)}
                  className={cn(
                    "h-7 rounded-full border px-2.5 text-xs font-medium outline-none pointer-coarse:min-h-11",
                    "transition-colors duration-(--motion-instant) active:translate-y-px disabled:opacity-45 motion-reduce:transition-none",
                    "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
                    chosen
                      ? "border-transparent bg-[color-mix(in_oklab,var(--live)_12%,transparent)] text-live"
                      : "border-line bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink",
                  )}
                >
                  {quick}
                </button>
              );
            })}
          </div>
          <Textarea
            aria-labelledby={`end-agent-reason-${runId}`}
            aria-label="Reason (optional)"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Tell its parent why, in a sentence."
            maxLength={1000}
            disabled={pending}
            className="max-h-32 min-h-16 text-sm"
          />
          {error && (
            <p role="alert" className="border-s-2 border-danger ps-3 text-sm leading-sm text-ink">
              <span className="font-medium text-danger">Could not end {name}.</span> {error}
            </p>
          )}
        </div>
      )}

      <DialogFooter>
        <Button ref={keepRef} variant="ghost" autoFocus onClick={clearEndAgentRequest} disabled={pending} className="pointer-coarse:min-h-11">
          {finished ? "Close" : "Keep running"}
        </Button>
        {!finished && (
          <Button variant="destructive" onClick={() => void confirm()} disabled={pending} aria-busy={pending || undefined} className="pointer-coarse:min-h-11">
            {pending ? <LoaderCircle className="motion-safe:animate-sweep" aria-hidden="true" /> : null}
            {pending ? "Ending…" : error ? "Try again" : "End agent"}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
