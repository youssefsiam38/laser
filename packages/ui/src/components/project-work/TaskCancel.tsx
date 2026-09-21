"use client";
/**
 * Cancelling a Task, with the reason it needs (M21-T16).
 *
 * The engine refuses a cancellation that says nothing and writes the reason as
 * a durable evidence record rather than leaving it in the event window
 * (M21-T15): *"a cancellation says why, durably"*. So the reason is asked for
 * **here**, before the request — a control that always comes back refused is
 * not a control.
 *
 * Enter does not cancel anything: the reason is a textarea, and the button
 * that stops the work is never the one holding focus when this opens.
 */
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

import { KeyTag, TypeBadge } from "./KindBadge.js";
import { WorkRefusal } from "./states.js";

export function TaskCancelDialog({
  workKey,
  title,
  open,
  busy,
  error,
  onOpenChange,
  onCancelTask,
}: {
  workKey: string | undefined;
  title: string | undefined;
  open: boolean;
  busy: boolean;
  error: string | undefined;
  onOpenChange: (open: boolean) => void;
  onCancelTask: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const keepRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) setNote("");
  }, [open, workKey]);

  const reason = note.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        // The control that keeps the task takes focus, never the one that stops it.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          keepRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Why is {workKey ?? "this task"} cancelled?</DialogTitle>
          <DialogDescription>
            The reason is kept with the task, as evidence, so it still reads months from now. A cancelled task keeps its links and its
            history, and it can be reopened.
          </DialogDescription>
        </DialogHeader>
        {workKey ? (
          <p className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-surface p-2.5">
            <TypeBadge kind="task" />
            <KeyTag workKey={workKey} />
            <span className="min-w-0 truncate text-sm leading-5 text-ink">{title}</span>
          </p>
        ) : null}
        <Textarea
          aria-label="Why it is cancelled"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Superseded by TASK-9 · not needed after the redesign · …"
          className="min-h-20"
        />
        {error ? <WorkRefusal message={error} /> : null}
        <DialogFooter>
          <Button ref={keepRef} variant="ghost" onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button variant="secondary" disabled={busy || reason.length === 0} onClick={() => onCancelTask(reason)}>
            Cancel this task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
