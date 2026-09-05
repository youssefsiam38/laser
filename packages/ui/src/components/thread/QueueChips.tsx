import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { CornerDownRight, ListEnd } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isSteerQueueItemId, usePiorbitStable } from "@/runtime";

/**
 * Pi's mid-run queue mirrored above the composer. Steer = solid `--live`
 * outline (delivered at the next turn boundary), follow-up = dashed
 * (delivered after the run). Pi exposes no per-item operations, so the one
 * action clears everything and restores the text into the composer.
 */
export function QueueChips() {
  const aui = useAui();
  const { actions } = usePiorbitStable();
  const count = useAuiState((s) => s.composer.queue.length);
  if (count === 0) return null;

  const clear = () => {
    actions
      .clearQueue()
      .then((text) => {
        if (!text) return;
        const composer = aui.composer;
        const current = composer.getState().text;
        composer.setText(current ? `${current}\n${text}` : text);
      })
      .catch(() => {
        /* the provider already toasted the failure */
      });
  };

  return (
    <div data-slot="queue-chips" className="flex flex-col gap-1.5 px-1">
      <div className="flex h-6 items-center justify-between">
        <span className="eyebrow">
          Queued · <span className="tnum">{count}</span>
        </span>
        <Button variant="ghost" size="xs" onClick={clear} className="-me-2">
          Clear queue
        </Button>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        <ComposerPrimitive.Queue>
          {({ queueItem }) => {
            const steer = isSteerQueueItemId(queueItem.id);
            return (
              <li
                data-lane={steer ? "steer" : "follow-up"}
                className={cn(
                  "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border bg-surface pe-2.5 ps-2 text-sm text-ink",
                  steer ? "border-live" : "border-dashed border-ink-3/70",
                )}
              >
                {steer ? (
                  <CornerDownRight aria-hidden="true" className="size-3.5 shrink-0 text-live" />
                ) : (
                  <ListEnd aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
                )}
                <span className="min-w-0 flex-1 truncate">{queueItem.prompt}</span>
                <span className="eyebrow shrink-0">{steer ? "steer" : "later"}</span>
              </li>
            );
          }}
        </ComposerPrimitive.Queue>
      </ul>
    </div>
  );
}
