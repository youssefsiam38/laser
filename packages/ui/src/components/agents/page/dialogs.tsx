"use client";
/**
 * The page's three questions: delete an agent, leave unsaved changes, pick a
 * built-in's profile. Each names what it is about and what it affects; none is
 * a bare "Are you sure?".
 */
import type { BuiltinAgentName, ModelProfile } from "@lasercode/protocol";
import { RotateCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { ProfilePicker } from "@/components/assistant-ui/elements/model-profiles";
import { ModelPickerDialogPortal } from "@/components/assistant-ui/elements/model-selector";
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

/**
 * One built-in's profile, chosen from the same picker every agent uses. Beam,
 * Chat and Namer share this dialog: the choice is the same choice, and only
 * the words around it change. `onClear` returns the agent to the profile new
 * conversations use, so a person is never stuck with what they picked.
 */
export function BuiltinProfileDialog({
  name,
  open,
  profiles,
  loading = false,
  error,
  current,
  busy = false,
  onOpenChange,
  onPick,
  onClear,
}: {
  name: BuiltinAgentName;
  open: boolean;
  profiles: readonly ModelProfile[];
  loading?: boolean | undefined;
  error?: string | undefined;
  current: string | null;
  busy?: boolean | undefined;
  onOpenChange(open: boolean): void;
  onPick(profileId: string): void;
  /** Back to the profile new conversations use. */
  onClear?: (() => void) | undefined;
}) {
  const [choice, setChoice] = useState<string | null>(current);
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (open) setChoice(current);
  }, [open, current]);
  const copy = BUILTIN_PROFILE_COPY[name];
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent data-slot="builtin-profile-dialog" data-agent={name}>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        {error !== undefined ? (
          <ErrorState title="Couldn’t load your profiles" detail={error} />
        ) : (
          <ProfilePicker
            profiles={profiles}
            value={choice}
            loading={loading}
            placeholder="Choose a profile"
            aria-label={`Profile for ${name}`}
            container={portalContainer}
            onValueChange={setChoice}
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
            {busy ? "Saving…" : "Use this profile"}
          </Button>
        </DialogFooter>
        <ModelPickerDialogPortal ref={setPortalContainer} />
      </DialogContent>
    </Dialog>
  );
}

/** What each built-in's profile dialog says. One voice, three subjects. */
const BUILTIN_PROFILE_COPY: Readonly<Record<BuiltinAgentName, { title: string; description: string; clear: string }>> = {
  beam: {
    title: "Beam’s profile",
    description:
      "Beam answers questions about your sessions, agents, settings and logs. A quick profile keeps it feeling instant; the strongest models are rarely worth the wait here.",
    clear: "Follow the profile new conversations use",
  },
  chat: {
    title: "Chat’s profile",
    description:
      "Chat is for conversations that belong to no project: questions, drafts, explanations. Pick the profile that answers them, or leave it following the one new conversations use.",
    clear: "Follow the profile new conversations use",
  },
  namer: {
    title: "Namer’s profile",
    description:
      "Namer titles conversations. It runs once on a small task when a conversation begins, so a fast profile is usually right.",
    clear: "Follow the profile new conversations use",
  },
};
