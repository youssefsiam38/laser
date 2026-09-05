import type { Action } from "@piorbit/protocol";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ActionButtonsProps {
  actions: readonly Action[] | undefined;
  onAct(actionId: string): void | Promise<unknown>;
  size?: "xs" | "sm";
  className?: string | undefined;
}

/**
 * The controls a panel declared (R2: only what actually works here appears,
 * because only what the producer sent appears). A `confirm` sentence turns
 * the button into a two-step: the question, then Yes / Keep.
 */
export function ActionButtons({ actions, onAct, size = "xs", className }: ActionButtonsProps) {
  const [confirming, setConfirming] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  if (!actions || actions.length === 0) return null;

  const fire = async (action: Action): Promise<void> => {
    setConfirming(undefined);
    setBusy(action.id);
    try {
      await onAct(action.id);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)} role="group" aria-label="Actions">
      {actions.map((action) =>
        confirming === action.id ? (
          <span key={action.id} className="flex items-center gap-1.5 rounded-md bg-surface-2 py-0.5 ps-2 pe-0.5 text-xs text-ink-2">
            <span className="max-w-64 truncate" title={action.confirm}>
              {action.confirm ?? `${action.label}?`}
            </span>
            <Button size={size} variant={action.destructive ? "destructive" : "default"} onClick={() => void fire(action)}>
              {action.label}
            </Button>
            <Button size={size} variant="ghost" onClick={() => setConfirming(undefined)}>
              Keep
            </Button>
          </span>
        ) : (
          <Button
            key={action.id}
            size={size}
            variant={action.destructive ? "destructive-ghost" : "outline"}
            disabled={busy !== undefined}
            aria-busy={busy === action.id || undefined}
            onClick={() => (action.confirm ? setConfirming(action.id) : void fire(action))}
          >
            {action.label}
          </Button>
        ),
      )}
    </div>
  );
}
