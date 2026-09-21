"use client";
/**
 * "Choose Beam's profile" (M22-T9).
 *
 * Beam runs on a Model Profile like every other agent
 * (`docs/model-profiles.md` "Assignments"): until one is chosen it follows the
 * profile new conversations use, which is a working state, not a broken one.
 * The dialog is opened from Beam's empty state; nothing opens it by itself,
 * because there is nothing pending — the app already filled the profiles in.
 *
 * Beam itself goes away in M23, so this is deliberately the smallest thing
 * that keeps the choice reachable and honest.
 */
import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useAgentsActions, useAgentsSnapshot } from "@/agents";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { ProfilePicker, useModelProfiles } from "@/components/assistant-ui/elements/model-profiles";
import { ModelPickerDialogPortal } from "@/components/assistant-ui/elements/model-selector";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { BEAM_PURPOSE } from "./beam-model.js";

/**
 * Whether the dialog is open. A two-line external store because the button
 * that opens it (Beam's empty state, inside the bubble) and the dialog itself
 * (the shell) are far apart in the tree.
 */
function createOpenStore() {
  let open = false;
  const listeners = new Set<() => void>();
  const publish = (next: boolean) => {
    if (next === open) return;
    open = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    getSnapshot: () => open,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: () => publish(true),
    close: () => publish(false),
  };
}

export const beamProfileDialog = createOpenStore();

export function useBeamProfileDialogOpen(): boolean {
  return useSyncExternalStore(beamProfileDialog.subscribe, beamProfileDialog.getSnapshot, () => false);
}

export function BeamProfileDialog() {
  const open = useBeamProfileDialogOpen();
  const snapshot = useAgentsSnapshot();
  const agents = useAgentsActions();
  const cwd = snapshot?.workspaces.beam;
  const current = snapshot?.builtinProfiles.beam ?? null;
  const { profiles, loading, error } = useModelProfiles(cwd, open);

  const [choice, setChoice] = useState<string | null>(current);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
  // The snapshot as it stands now, read after the save settles: the store only
  // moves on success, so this is how the dialog knows whether it took.
  const settled = useRef(current);
  settled.current = current;

  useEffect(() => {
    if (!open) return;
    setChoice(current);
    setSaveError(undefined);
  }, [current, open]);

  const use = async () => {
    if (!choice) return;
    setSaving(true);
    setSaveError(undefined);
    await agents.setBuiltinProfile("beam", choice);
    setSaving(false);
    // `setBuiltinProfile` settles either way: the snapshot only moves on
    // success, so a profile that did not take is said here, where the person
    // is looking, as well as in the toast.
    if (settled.current !== choice) {
      setSaveError("That could not be saved. Beam keeps following the profile new conversations use — try again, or choose it on the Agents page.");
      return;
    }
    beamProfileDialog.close();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !saving && beamProfileDialog.close()}>
      <DialogContent data-slot="beam-profile-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles aria-hidden="true" className="size-4 text-live" />
            Choose Beam’s profile
          </DialogTitle>
          <DialogDescription>{BEAM_PURPOSE}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <span className="eyebrow">Profile</span>
          {error !== undefined ? (
            <ErrorState title="Couldn’t load your profiles" detail={error} />
          ) : profiles.length === 0 && !loading ? (
            <p className="rounded-lg border border-line px-3 py-3 text-sm text-ink-2">
              No profiles yet. Make one in Settings → Providers and models → Model profiles, and Beam’s choice comes back here.
            </p>
          ) : (
            <ProfilePicker
              profiles={profiles}
              value={choice}
              loading={loading}
              disabled={saving}
              placeholder="Choose a profile"
              aria-label="Profile for Beam"
              className="max-w-none"
              container={portalContainer}
              onValueChange={setChoice}
            />
          )}
          {saveError && (
            <p role="alert" className="text-xs leading-xs text-danger">
              {saveError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => beamProfileDialog.close()} disabled={saving} data-slot="beam-profile-later">
            Later
          </Button>
          <Button onClick={() => void use()} disabled={!choice || saving} data-slot="beam-profile-use">
            {saving ? "Saving…" : "Use this profile"}
          </Button>
        </DialogFooter>
        <ModelPickerDialogPortal ref={setPortalContainer} />
      </DialogContent>
    </Dialog>
  );
}
