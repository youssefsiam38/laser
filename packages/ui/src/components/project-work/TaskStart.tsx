"use client";
/**
 * Start… — joining a Task to the conversation an attempt happens in
 * (M21-T16; leap, "Execution and convergence": *"Starting a Task creates an
 * execution link before any prompt is sent"*).
 *
 * This dialog does the part that is real today: it records the link through
 * `project/task/link-execution`, for a session **in this project**. The link
 * moves nothing — a Task's state is never changed by it (M21-T15) — and the
 * conflicts the host answers with are shown straight away, because two active
 * Tasks writing in the same place have to be seen *before* another write
 * starts.
 *
 * A session from another project may discuss a Task but cannot execute it in
 * the wrong project, so only this project's conversations are offered.
 */
import { MessagesSquare } from "lucide-react";
import { useMemo, useState } from "react";
import type { ClientRequests, TaskConflict } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { relativeTime, shortCwd } from "@/format";
import { cn } from "@/lib/utils";
import { useLaserStable, useLaserState } from "@/runtime";
import { type ProjectWorkStore } from "@/project-work";
import { conflictSentence } from "@/project-work/task-model";

import { KeyTag } from "./KindBadge.js";
import { WorkRefusal } from "./states.js";

type Detail = ClientRequests["project/work/get"]["result"];

export function TaskStartDialog({
  store,
  detail,
  open,
  onOpenChange,
  attempt,
}: {
  store: ProjectWorkStore | undefined;
  detail: Detail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  attempt: number;
}) {
  const { actions } = useLaserStable();
  const sessions = useLaserState((state) => state.sessions);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [conflicts, setConflicts] = useState<TaskConflict[] | undefined>(undefined);

  /**
   * This project's conversations, newest first. The project is the one the
   * workspace is open on, and a Task's owning project decides the worker and
   * the checkout — so a session anywhere else is not offered at all.
   */
  const linked = new Set(detail.executionLinks.map((link) => link.targetId));
  const eligible = useMemo(() => {
    const roots = store?.paths() ?? [];
    return sessions
      .filter((session) => roots.some((root) => session.cwd === root || session.cwd.startsWith(`${root}/`)))
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  }, [sessions, store]);

  const link = async (session: { id: string; path: string }): Promise<void> => {
    if (!store) return;
    setBusy(session.id);
    setError(undefined);
    const outcome = await store.linkExecution(
      { entityId: detail.entity.entityId, expectedRevisionId: detail.entity.currentRevisionId },
      { kind: "session", targetId: session.id, attempt, startedAt: new Date().toISOString() },
    );
    setBusy(undefined);
    if (!outcome.ok) {
      setError(outcome.failure.message);
      return;
    }
    const answered = outcome.value.conflicts ?? [];
    if (answered.length > 0) {
      setConflicts(answered);
      return;
    }
    actions.toast("info", `${detail.entity.key} · attempt ${attempt} is recorded against this conversation`);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setError(undefined);
          setConflicts(undefined);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Work on {detail.entity.key} in…</DialogTitle>
          <DialogDescription>
            Pick the conversation this attempt happens in. The link is recorded before any work starts, and it never moves the task on its
            own: what a task is waiting for, and what makes it done, stay exactly as they are.
          </DialogDescription>
        </DialogHeader>

        {conflicts && conflicts.length > 0 ? (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-2.5">
            <p className="text-sm leading-5 text-ink">This task writes where other active tasks write.</p>
            <ul role="list" className="flex flex-col gap-1">
              {conflicts.map((conflict) => (
                <li key={conflict.entityId} className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm leading-5 text-ink-2">
                  <KeyTag workKey={conflict.key} />
                  {conflictSentence(conflict)}
                  {conflict.accepted ? <Badge variant="ok">risk accepted</Badge> : null}
                </li>
              ))}
            </ul>
            <p className="text-xs leading-xs text-ink-2">
              The link is recorded. Serialize them, isolate them, or accept the shared-checkout risk on the task itself.
            </p>
          </div>
        ) : null}

        {error ? <WorkRefusal message={error} /> : null}

        {eligible.length === 0 ? (
          <p className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">
            This project has no conversations yet.{" "}
            <span className="text-ink-3">Open a conversation in this project and it will be offered here.</span>
          </p>
        ) : (
          <ul role="list" className="-mx-1 flex max-h-72 flex-col overflow-y-auto px-1">
            {eligible.map((session) => (
              <li key={session.path}>
                <button
                  type="button"
                  disabled={busy !== undefined || !store}
                  onClick={() => void link(session)}
                  className={cn(
                    "flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-start outline-none",
                    "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
                    "hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
                    "disabled:opacity-70 pointer-coarse:min-h-11",
                  )}
                >
                  <MessagesSquare aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="min-w-0 truncate text-sm leading-5 text-ink">
                      {session.name || session.firstMessage || "Untitled conversation"}
                    </span>
                    <span className="min-w-0 truncate text-xs leading-xs text-ink-3">
                      {shortCwd(session.cwd)} · {relativeTime(session.modifiedAt)}
                    </span>
                  </span>
                  {linked.has(session.id) ? <Badge variant="outline">already linked</Badge> : null}
                  {busy === session.id ? <Badge variant="live">linking</Badge> : null}
                </button>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
