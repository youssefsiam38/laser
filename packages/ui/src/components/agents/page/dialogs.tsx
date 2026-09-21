"use client";
/**
 * The page's questions: delete an agent, leave unsaved changes. Each names
 * what it is about and what it affects; none is a bare "Are you sure?".
 */
import { RotateCw, Trash2 } from "lucide-react";

import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function DeleteAgentDialog({
  name,
  open,
  busy = false,
  error,
  onOpenChange,
  onConfirm,
}: {
  name: string;
  open: boolean;
  busy?: boolean | undefined;
  error?: string | undefined;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent data-slot="delete-agent-dialog">
        <DialogHeader>
          <DialogTitle>Delete {name}?</DialogTitle>
          <DialogDescription>
            Sessions that used it keep their history. Agents allowed to start it will not be able to any more, and their settings will say so.
          </DialogDescription>
        </DialogHeader>
        {error ? <ErrorState title="Couldn’t delete this agent" detail={error} /> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button type="button" variant="destructive" disabled={busy} aria-busy={busy || undefined} onClick={onConfirm}>
            {busy ? <RotateCw className="motion-safe:animate-busy" /> : <Trash2 />}
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
