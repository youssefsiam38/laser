import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { deviceStore } from "@/runtime/device-storage";
import { useSettingsScopeNavigationGuard } from "@/components/workbench/workbench-context";

export interface ScopeDraft {
  id: string;
  label: string;
  discard: () => void | Promise<void>;
  save?: (() => boolean | Promise<boolean>) | undefined;
}

interface PendingNavigation {
  drafts: ScopeDraft[];
  resolve: (allow: boolean) => void;
}

/** One aggregate Settings navigation guard for every dirty child owned by a tab. */
export function ScopeDraftGuard({ drafts }: { drafts: ScopeDraft[] }) {
  const draftsRef = useRef(drafts);
  const pendingRef = useRef<PendingNavigation | undefined>(undefined);
  const [pending, setPending] = useState<PendingNavigation | undefined>(undefined);
  const [savingRequest, setSavingRequest] = useState<PendingNavigation | undefined>(undefined);

  // A concurrent render that never commits must not replace the snapshot a
  // navigation request captures from the owning Settings screen.
  useLayoutEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  const settle = useCallback((request: PendingNavigation, allow: boolean) => {
    if (pendingRef.current !== request) return false;
    pendingRef.current = undefined;
    setPending((current) => current === request ? undefined : current);
    setSavingRequest((current) => current === request ? undefined : current);
    request.resolve(allow);
    return true;
  }, []);

  const guard = useCallback(async () => new Promise<boolean>((resolve) => {
    const previous = pendingRef.current;
    if (previous) settle(previous, false);
    const next = { drafts: [...draftsRef.current], resolve };
    pendingRef.current = next;
    setSavingRequest(undefined);
    setPending(next);
  }), [settle]);

  useSettingsScopeNavigationGuard(drafts.length > 0 ? guard : undefined);

  useEffect(() => {
    let environment = deviceStore.status().environmentKey;
    return deviceStore.subscribe((event) => {
      const next = event.kind === "activated" ? event.environmentKey : undefined;
      if (!environment) {
        environment = next;
        return;
      }
      if (next === environment) return;
      environment = next;
      const request = pendingRef.current;
      if (request) settle(request, false);
      const abandoned = [...draftsRef.current];
      if (abandoned.length > 0) void Promise.allSettled(abandoned.map((draft) => draft.discard()));
    });
  }, [settle]);

  useEffect(() => () => {
    const request = pendingRef.current;
    if (!request) return;
    pendingRef.current = undefined;
    request.resolve(false);
  }, []);

  const discard = async (request: PendingNavigation) => {
    if (pendingRef.current !== request) return;
    await Promise.allSettled(request.drafts.map((draft) => draft.discard()));
    settle(request, true);
  };

  const save = async (request: PendingNavigation) => {
    if (pendingRef.current !== request || request.drafts.some((draft) => !draft.save)) return;
    setSavingRequest(request);
    for (const draft of request.drafts) {
      if (pendingRef.current !== request) return;
      try {
        const saved = await draft.save!();
        if (pendingRef.current !== request) return;
        if (!saved) {
          settle(request, false);
          return;
        }
      } catch {
        if (pendingRef.current === request) settle(request, false);
        return;
      }
    }
    settle(request, true);
  };

  const saving = savingRequest === pending;

  return (
    <Dialog open={Boolean(pending)} onOpenChange={(open) => { if (!open && pending) settle(pending, false); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Keep these unsaved changes?</DialogTitle>
          <DialogDescription>
            {pending?.drafts.length === 1
              ? `${pending.drafts[0]?.label ?? "This draft"} belongs to the current Settings target.`
              : `${pending?.drafts.length ?? 0} drafts belong to the current Settings target.`}
          </DialogDescription>
        </DialogHeader>
        {pending && pending.drafts.length > 1 ? (
          <ul className="space-y-1 text-xs text-ink-2">
            {pending.drafts.map((draft) => <li key={draft.id}>• {draft.label}</li>)}
          </ul>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={() => { if (pending) settle(pending, false); }}>Keep editing</Button>
          <Button variant="outline" disabled={saving} onClick={() => { if (pending) void discard(pending); }}>Discard and switch</Button>
          {pending?.drafts.every((draft) => draft.save) ? (
            <Button disabled={saving} onClick={() => { if (pending) void save(pending); }}>{saving ? "Saving…" : "Save and switch"}</Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
