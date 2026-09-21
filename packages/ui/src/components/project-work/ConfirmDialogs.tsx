"use client";
/**
 * Archive and Delete (D-355, "Actions common to every kind").
 *
 * Archive is the default and is reversible: the state is kept, every link is
 * kept, and one press puts it back. Delete is permanent, lists exactly what it
 * will orphan — the host answers that preview before it writes anything — and
 * asks the person to type the key.
 *
 * **Enter confirms neither.** The typed field does not submit on Enter, and
 * the confirming button is never the focused control when the dialog opens.
 */
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ClientRequests } from "@lasercode/protocol";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useLaserStable } from "@/runtime";
import { selectWork, type ProjectWorkStore } from "@/project-work";

import { KeyTag, TypeBadge } from "./KindBadge.js";
import { WorkRefusal } from "./states.js";

type Detail = ClientRequests["project/work/get"]["result"];
type Orphan = ClientRequests["project/work/delete"]["result"]["orphans"][number];

export function ArchiveDialog({
  store,
  detail,
  open,
  onOpenChange,
}: {
  store: ProjectWorkStore | undefined;
  detail: Detail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { actions } = useLaserStable();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const archived = detail.entity.archivedAt !== undefined;

  const run = async (): Promise<void> => {
    if (!store) return;
    setBusy(true);
    const outcome = await store.archive({ entityId: detail.entity.entityId, expectedRevisionId: detail.entity.currentRevisionId }, !archived);
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.failure.message);
      return;
    }
    actions.toast("info", archived ? `${detail.entity.key} is back` : `${detail.entity.key} archived`);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        // The cancelling control takes focus, never the one that acts.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{archived ? `Restore ${detail.entity.key}?` : `Archive ${detail.entity.key}?`}</DialogTitle>
          <DialogDescription>
            {archived
              ? "It goes back to the state it was in before it was archived, with every link it had."
              : "Archiving takes it out of the backlog and keeps everything: its revisions, its links and its history. You can put it back at any time."}
          </DialogDescription>
        </DialogHeader>
        <p className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-surface p-2.5">
          <TypeBadge kind={detail.entity.kind} />
          <KeyTag workKey={detail.entity.key} />
          <span className="min-w-0 truncate text-sm leading-5 text-ink">{detail.entity.title}</span>
        </p>
        {error ? <WorkRefusal message={error} /> : null}
        <DialogFooter>
          <Button ref={cancelRef} variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={archived ? "default" : "secondary"} disabled={busy || !store} onClick={() => void run()}>
            {archived ? <ArchiveRestore /> : <Archive />}
            {archived ? "Restore it" : "Archive it"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteDialog({
  store,
  detail,
  open,
  onOpenChange,
}: {
  store: ProjectWorkStore | undefined;
  detail: Detail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { actions } = useLaserStable();
  const [typed, setTyped] = useState("");
  const [orphans, setOrphans] = useState<Orphan[] | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const key = detail.entity.key;

  // The preview is the host's: `delete` without `confirm` writes nothing and
  // answers with exactly what this would orphan.
  useEffect(() => {
    if (!open || !store) return;
    setTyped("");
    setError(undefined);
    let cancelled = false;
    void store
      .remove({ entityId: detail.entity.entityId, expectedRevisionId: detail.entity.currentRevisionId })
      .then((outcome) => {
        if (cancelled) return;
        if (outcome.ok) setOrphans(outcome.value.orphans);
        else setError(outcome.failure.message);
      });
    return () => {
      cancelled = true;
    };
  }, [detail.entity.currentRevisionId, detail.entity.entityId, open, store]);

  const run = async (): Promise<void> => {
    if (!store || typed.trim() !== key) return;
    setBusy(true);
    const outcome = await store.remove({ entityId: detail.entity.entityId, expectedRevisionId: detail.entity.currentRevisionId }, { confirm: true });
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.failure.message);
      return;
    }
    actions.toast("info", `${key} deleted`);
    onOpenChange(false);
    selectWork(undefined);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Delete {key} permanently?</DialogTitle>
          <DialogDescription>
            This cannot be undone. Every revision, comment and approval on it goes with it. Archiving keeps all of that and takes it out of the
            backlog instead.
          </DialogDescription>
        </DialogHeader>

        {orphans === undefined && !error ? (
          <p className="text-sm leading-5 text-ink-2">Checking what this would leave behind…</p>
        ) : orphans && orphans.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-sm leading-5 text-ink-2">These lose their link to it:</p>
            <ul role="list" className="flex flex-col gap-1">
              {orphans.map((orphan) => (
                <li key={`${orphan.key}-${orphan.relation}`} className="flex items-center gap-2">
                  <TypeBadge kind={orphan.kind} />
                  <KeyTag workKey={orphan.key} />
                  <span className="text-xs leading-xs text-ink-3">{orphan.relation}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : orphans ? (
          <p className="text-sm leading-5 text-ink-2">Nothing else links to it.</p>
        ) : null}

        {error ? <WorkRefusal message={error} /> : null}

        <label className="flex flex-col gap-1.5">
          <span className="text-sm leading-5 text-ink-2">
            Type <span className="typed text-ink">{key}</span> to confirm.
          </span>
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            // Enter never confirms a destructive act: the field swallows it.
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            placeholder={key}
            aria-label={`Type ${key} to confirm deletion`}
            autoComplete="off"
          />
        </label>

        <DialogFooter>
          <Button ref={cancelRef} variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy || typed.trim() !== key || !store} onClick={() => void run()}>
            <Trash2 />
            Delete {key}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
