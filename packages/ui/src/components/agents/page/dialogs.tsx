"use client";
/**
 * The page's three questions: delete an agent, leave unsaved changes, pick a
 * built-in's model. Each names what it is about and what it affects; none is a
 * bare "Are you sure?".
 */
import type { AgentModelChoice, BuiltinAgentName } from "@lasercode/protocol";
import { RotateCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { ModelPickerDialogPortal, ProviderModelPicker } from "@/components/assistant-ui/elements/model-selector";
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

/**
 * One built-in's model, chosen from the same provider-first picker every agent
 * uses. Beam, Chat and Namer share this dialog: the choice is the same choice,
 * and only the words around it change. `onClear` returns the agent to the
 * default model, so a person is never stuck with what they picked.
 */
export function BuiltinModelDialog({
  name,
  open,
  cwd,
  current,
  busy = false,
  onOpenChange,
  onPick,
  onClear,
}: {
  name: BuiltinAgentName;
  open: boolean;
  /** The directory the catalog is routed through. */
  cwd: string | undefined;
  current: AgentModelChoice | null;
  busy?: boolean | undefined;
  onOpenChange(open: boolean): void;
  onPick(model: AgentModelChoice): void;
  /** Back to the default model (for Namer, to the next qualification). */
  onClear?: (() => void) | undefined;
}) {
  const catalog = useModelCatalog(cwd, open);
  const [choice, setChoice] = useState<AgentModelChoice | null>(current);
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (open) setChoice(current);
  }, [open, current]);
  const picked = choice ? modelChoiceId(choice) : NO_MODEL_CHOSEN;
  const copy = BUILTIN_MODEL_COPY[name];
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent data-slot="builtin-model-dialog" data-agent={name}>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        {catalog.error !== undefined ? (
          <ErrorState title="Couldn’t load the model list" detail={catalog.error} onRetry={catalog.reload} />
        ) : (
          <ProviderModelPicker
            models={catalog.data ?? []}
            value={picked}
            loading={catalog.loading}
            placeholder="Choose a model"
            container={portalContainer}
            onValueChange={(next) => {
              const parsed = parseModelChoice(next);
              if (parsed) setChoice(parsed);
            }}
          />
        )}
        <DialogFooter>
          {onClear && current ? (
            <Button type="button" variant="ghost" className="w-full sm:me-auto sm:w-auto" disabled={busy} onClick={onClear}>
              {copy.clear}
            </Button>
          ) : null}
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={busy || choice === null} aria-busy={busy || undefined} onClick={() => choice && onPick(choice)}>
            {busy ? <RotateCw className="motion-safe:animate-busy" /> : null}
            {busy ? "Saving…" : "Use this model"}
          </Button>
        </DialogFooter>
        <ModelPickerDialogPortal ref={setPortalContainer} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Nothing chosen", as a value the picker can hold.
 *
 * The picker is uncontrolled while its `value` is empty, and an uncontrolled
 * one selects the first model in the list — so a dialog opened with no model
 * would show one it is not going to save, beside a disabled button. Every real
 * option is `provider/id`, so a sentinel without a slash matches nothing and
 * the placeholder stands.
 */
const NO_MODEL_CHOSEN = "no-model-chosen";

/** What each built-in's model dialog says. One voice, three subjects. */
const BUILTIN_MODEL_COPY: Readonly<Record<BuiltinAgentName, { title: string; description: string; clear: string }>> = {
  beam: {
    title: "Beam’s model",
    description:
      "Beam answers questions about your sessions, agents, settings and logs. A quick, capable model keeps it feeling instant; the most powerful one is rarely worth the wait here.",
    clear: "Follow the default model",
  },
  chat: {
    title: "Chat’s model",
    description:
      "Chat is for conversations that belong to no project: questions, drafts, explanations. Pick the model that answers them, or leave it following the model new sessions use.",
    clear: "Follow the default model",
  },
  namer: {
    title: "Namer’s model",
    description:
      "Namer titles sessions and labels running work. It runs often on a tiny task, so the fastest inexpensive model is usually right. Qualification suggests one; this choice overrides it until you clear it.",
    clear: "Back to qualification",
  },
};
