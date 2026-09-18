import { useCallback, useEffect, useRef, useState } from "react";

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
  const [saving, setSaving] = useState(false);
  draftsRef.current = drafts;

  const settle = useCallback((allow: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = undefined;
    setPending(undefined);
    setSaving(false);
    current?.resolve(allow);
  }, []);

  useSettingsScopeNavigationGuard(drafts.length > 0
    ? async () => new Promise<boolean>((resolve) => {
        pendingRef.current?.resolve(false);
        const next = { drafts: [...draftsRef.current], resolve };
        pendingRef.current = next;
        setPending(next);
      })
    : undefined);

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
      const abandoned = [...draftsRef.current];
      if (abandoned.length > 0) void Promise.allSettled(abandoned.map((draft) => draft.discard()));
      settle(false);
    });
  }, [settle]);

  useEffect(() => () => pendingRef.current?.resolve(false), []);

  const discard = async () => {
    if (!pending) return;
    await Promise.allSettled(pending.drafts.map((draft) => draft.discard()));
    settle(true);
  };

  const save = async () => {
    if (!pending || pending.drafts.some((draft) => !draft.save)) return;
    setSaving(true);
    for (const draft of pending.drafts) {
      try {
        if (!(await draft.save!())) {
          settle(false);
          return;
        }
      } catch {
        settle(false);
        return;
      }
    }
    settle(true);
  };

  return (
    <Dialog open={Boolean(pending)} onOpenChange={(open) => { if (!open) settle(false); }}>
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
          <Button variant="ghost" disabled={saving} onClick={() => settle(false)}>Keep editing</Button>
          <Button variant="outline" disabled={saving} onClick={() => void discard()}>Discard and switch</Button>
          {pending?.drafts.every((draft) => draft.save) ? (
            <Button disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save and switch"}</Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
