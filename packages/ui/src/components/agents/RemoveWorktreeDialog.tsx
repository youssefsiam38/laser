"use client";
/**
 * "Remove {agent}'s worktree?" — the person's escape hatch (M13-T42, D-157).
 *
 * Merging and removing a child's worktree belong to its parent. A parent that
 * crashed, was cancelled, or simply stopped never gets to that, and
 * `.worktrees/` would grow without bound; this is where that cost lands. It
 * clears the directory and its branch **without deleting the session** — the
 * conversation stays exactly where it was.
 *
 * The shape is `EndAgentDialog`'s: a title that names the thing, one honest
 * sentence about what happens, and a footer where the safe verb owns the first
 * Enter. What the worktree holds is read from the host every time it opens,
 * because the decision is destructive and a stale count is worse than none. A
 * worktree that still holds unmerged work is refused by the host, and the
 * refusal is shown here with the one thing that changes it: saying so again,
 * deliberately.
 */
import { LoaderCircle } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { clearRemoveWorktreeRequest, describeWorktreeContents, useRemoveWorktreeRequest, useWorktreeStatus } from "@/agents/worktree";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLaserStable } from "@/runtime";

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function RemoveWorktreeDialog() {
  const request = useRemoveWorktreeRequest();
  return (
    <Dialog open={request !== undefined} onOpenChange={(open) => { if (!open) clearRemoveWorktreeRequest(); }}>
      {/* Keyed on the session so a second question never inherits the first's state. */}
      {request && <RemoveWorktreeBody key={request.path} path={request.path} label={request.label} />}
    </Dialog>
  );
}

function RemoveWorktreeBody({ path, label }: { path: string; label: string }) {
  const { actions } = useLaserStable();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  /** Set once the host has refused for unmerged work: the next press insists. */
  const [insisting, setInsisting] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const { loading, status, error: readError } = useWorktreeStatus(path, true, actions.agents.worktreeStatus);

  const gone = status !== undefined && (status === null || !status.exists);

  const confirm = useCallback(async () => {
    setPending(true);
    setError(undefined);
    try {
      const result = await actions.agents.removeWorktree(path, insisting);
      if (!result.removed) {
        // The host refuses to destroy unmerged work silently. Say what it
        // holds, and make the second press the deliberate one.
        setInsisting(true);
        setError(result.worktree ? describeWorktreeContents(result.worktree) : "It could not be removed.");
        setPending(false);
        return;
      }
      actions.toast("info", `Removed ${label}'s worktree`);
      clearRemoveWorktreeRequest();
    } catch (failure) {
      setError(errorText(failure));
      setPending(false);
    }
  }, [actions, insisting, label, path]);

  return (
    <DialogContent
      className="sm:max-w-md"
      showCloseButton={false}
      data-slot="remove-worktree-dialog"
      data-gone={gone || undefined}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        keepRef.current?.focus();
      }}
    >
      <DialogHeader>
        <DialogTitle>{gone ? `${label} has no worktree` : `Remove ${label}'s worktree?`}</DialogTitle>
        <DialogDescription>
          {gone
            ? "There is nothing on disk to remove. Its conversation is untouched."
            : "Its directory and its branch go. The conversation stays, and nothing else in your project is touched."}
        </DialogDescription>
      </DialogHeader>

      {!gone && (
        <div className="flex flex-col gap-2">
          {loading && <p className="text-sm leading-sm text-ink-3">Reading what it holds…</p>}
          {readError && (
            <p role="alert" className="border-s-2 border-attention ps-3 text-sm leading-sm text-ink">
              <span className="font-medium">Could not read what it holds.</span> {readError}
            </p>
          )}
          {status && (
            <p className="text-sm leading-sm text-ink-2">
              <span className="typed break-all text-ink">{status.branch}</span>
              <span className="mt-0.5 block break-all text-ink-3">{status.path}</span>
              <span className="mt-1 block">{describeWorktreeContents(status)}</span>
            </p>
          )}
          {error && (
            <p role="alert" className="border-s-2 border-danger ps-3 text-sm leading-sm text-ink">
              <span className="font-medium text-danger">Not removed.</span> {error}
              {insisting ? " Merge it first, or remove it anyway." : ""}
            </p>
          )}
        </div>
      )}

      <DialogFooter>
        <Button ref={keepRef} variant="ghost" autoFocus onClick={clearRemoveWorktreeRequest} disabled={pending} className="pointer-coarse:min-h-11">
          {gone ? "Close" : "Keep it"}
        </Button>
        {!gone && (
          <Button variant="destructive" onClick={() => void confirm()} disabled={pending} aria-busy={pending || undefined} className="pointer-coarse:min-h-11">
            {pending ? <LoaderCircle className="motion-safe:animate-sweep" aria-hidden="true" /> : null}
            {pending ? "Removing…" : insisting ? "Remove anyway" : "Remove worktree"}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
