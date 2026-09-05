"use client";
/**
 * Message queue — the steer and follow-up chips above the composer
 * (docs/ux-elements.md "Messages", DESIGN.md "Composer", M1-T5). Installed
 * from `elements-message-queue` and restyled to DESIGN.md tokens.
 *
 * Divergences from the registry copy:
 *   - Two lanes, not one: a steer (delivered at the next turn boundary) is a
 *     solid `--live` outline, a follow-up (after the run) is dashed.
 *   - No per-item remove. Pi exposes no per-item operation on its queue, so
 *     the one action clears everything and hands the text back to the
 *     composer (`ComposerQueue` below). A control that cannot work is not
 *     drawn (docs/ux-panels.md R2).
 *   - The "running" row is gone: the status line directly above the composer
 *     already says the session is working (D-20 §5).
 */
import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { CornerDownRight, ListEnd } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isSteerQueueItemId, useLaserStable } from "@/runtime";

export type QueueLane = "steer" | "follow-up";

export interface QueuedMessage {
  id: string;
  text: string;
  lane: QueueLane;
}

export interface MessageQueueProps extends Omit<ComponentProps<"div">, "children"> {
  /** Items to draw; when `children` is given they are drawn by the caller instead. */
  items?: readonly QueuedMessage[] | undefined;
  children?: ReactNode;
  count: number;
  onClear?: (() => void) | undefined;
}

export function MessageQueue({ items, children, count, onClear, className, ...props }: MessageQueueProps) {
  if (count === 0) return null;
  return (
    <div data-slot="message-queue" className={cn("flex flex-col gap-1.5 px-1", className)} {...props}>
      <div className="flex h-6 items-center justify-between">
        <span className="eyebrow">
          Queued · <span className="tnum">{count}</span>
        </span>
        {onClear && (
          <Button variant="ghost" size="xs" onClick={onClear} className="-me-2">
            Clear queue
          </Button>
        )}
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {children ?? items?.map((item) => <QueuedChip key={item.id} text={item.text} lane={item.lane} />)}
      </ul>
    </div>
  );
}

export function QueuedChip({ text, lane }: { text: string; lane: QueueLane }) {
  const steer = lane === "steer";
  return (
    <li
      data-slot="queued-chip"
      data-lane={lane}
      className={cn(
        "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border bg-surface pe-2.5 ps-2 text-sm text-ink",
        steer ? "border-live" : "border-dashed border-[color-mix(in_oklab,var(--ink-3)_70%,transparent)]",
      )}
    >
      {steer ? (
        <CornerDownRight aria-hidden="true" className="size-3.5 shrink-0 text-live" />
      ) : (
        <ListEnd aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
      )}
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <span className="eyebrow shrink-0">{steer ? "steer" : "later"}</span>
    </li>
  );
}

/**
 * Pi's mid-run queue, mirrored from the composer runtime. Clearing calls
 * `pi/session/clear_queue` and restores the text into the composer.
 */
export function ComposerQueue() {
  const aui = useAui();
  const { actions } = useLaserStable();
  const count = useAuiState((s) => s.composer.queue.length);

  const clear = () => {
    actions
      .clearQueue()
      .then((text) => {
        if (!text) return;
        const current = aui.composer.getState().text;
        aui.composer.setText(current ? `${current}\n${text}` : text);
      })
      .catch(() => {
        /* the provider already toasted the failure */
      });
  };

  return (
    <MessageQueue count={count} onClear={clear}>
      <ComposerPrimitive.Queue>
        {({ queueItem }) => (
          <QueuedChip text={queueItem.prompt} lane={isSteerQueueItemId(queueItem.id) ? "steer" : "follow-up"} />
        )}
      </ComposerPrimitive.Queue>
    </MessageQueue>
  );
}
