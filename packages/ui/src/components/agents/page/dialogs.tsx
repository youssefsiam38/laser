"use client";
/**
 * The page's three questions: delete an agent, leave unsaved changes, pick
 * Beam's model. Each names what it is about and what it affects; none is a
 * bare "Are you sure?".
 */
import type { AgentModelChoice } from "@lasercode/protocol";
import { RotateCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { ProviderModelPicker } from "@/components/assistant-ui/elements/model-selector";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { modelChoiceId, parseModelChoice } from "./model.js";
import { useModelCatalog } from "./use-page-data.js";

export function DeleteAgentDialog({
  name,
  open,
  busy = false,
  onOpenChange,
  onConfirm,
}: {
  name: string;
  open: boolean;
  busy?: boolean | undefined;
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

export function DiscardChangesDialog({ open, onKeep, onDiscard }: { open: boolean; onKeep(): void; onDiscard(): void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onKeep()}>
      <DialogContent data-slot="discard-changes-dialog">
        <DialogHeader>
          <DialogTitle>Discard changes?</DialogTitle>
          <DialogDescription>This agent has edits that are not saved. Leaving now loses them.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onKeep} autoFocus>
            Keep editing
          </Button>
          <Button type="button" variant="destructive" onClick={onDiscard}>
            Discard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Beam's model, chosen from the same provider-first picker every agent uses. */
export function BeamModelDialog({
  open,
  cwd,
  current,
  busy = false,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  /** The directory the catalog is routed through. */
  cwd: string | undefined;
  current: AgentModelChoice | null;
  busy?: boolean | undefined;
  onOpenChange(open: boolean): void;
  onPick(model: AgentModelChoice): void;
}) {
  const catalog = useModelCatalog(cwd, open);
  const [choice, setChoice] = useState<AgentModelChoice | null>(current);
  useEffect(() => {
    if (open) setChoice(current);
  }, [open, current]);
  const picked = choice ? modelChoiceId(choice) : undefined;
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent data-slot="beam-model-dialog">
        <DialogHeader>
          <DialogTitle>Beam's model</DialogTitle>
          <DialogDescription>
            Beam answers questions about your sessions, agents, settings and logs. A quick, capable model keeps it feeling instant; the most powerful one is rarely worth the wait here.
          </DialogDescription>
        </DialogHeader>
        {catalog.error !== undefined ? (
          <ErrorState title="Couldn’t load the model list" detail={catalog.error} onRetry={catalog.reload} />
        ) : (
          <ProviderModelPicker
            models={catalog.data ?? []}
            {...(picked !== undefined ? { value: picked } : {})}
            loading={catalog.loading}
            placeholder="Choose a model"
            onValueChange={(next) => {
              const parsed = parseModelChoice(next);
              if (parsed) setChoice(parsed);
            }}
          />
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={busy || choice === null} aria-busy={busy || undefined} onClick={() => choice && onPick(choice)}>
            {busy ? <RotateCw className="motion-safe:animate-busy" /> : null}
            {busy ? "Saving…" : "Use this model"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
