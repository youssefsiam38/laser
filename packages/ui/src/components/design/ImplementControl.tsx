"use client";
/**
 * "Implement…" — the hand-off, said before it is done (M21-T13).
 *
 * The control never sends: it puts `/design implement @KEY` in the composer,
 * or copies the key, so the person sends it when they are ready. A design
 * whose screens are all sketches cannot be handed off, and this says why
 * instead of offering an action that would be refused.
 */
import { Copy, Hammer, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SKETCH_GATE_REFUSAL } from "@/design/sketch";

/** What "Implement…" does, said before it is done. */
export const IMPLEMENT_SENTENCE =
  "Hand-off pulls this exact revision — its screens, the index entries it uses, its fixtures and unresolved comments — into the conversation as the implementation context. The command goes into the composer, so you send it when you are ready.";

export interface ImplementControlProps {
  workKey: string;
  sketchOnly: boolean;
  onCopy: () => void;
  onSend: () => void;
}

export function ImplementControl({ workKey, sketchOnly, onCopy, onSend }: ImplementControlProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" aria-haspopup="dialog">
          <Hammer />
          Implement…
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-2 p-3">
        {sketchOnly ? (
          <p data-slot="implement-refusal" className="text-xs leading-xs text-ink-2">
            {SKETCH_GATE_REFUSAL}
          </p>
        ) : (
          <>
            <p className="text-xs leading-xs text-ink-2">{IMPLEMENT_SENTENCE}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="xs" onClick={onSend}>
                <Send />
                Send /design implement @{workKey}
              </Button>
              <Button size="xs" variant="outline" onClick={onCopy}>
                <Copy />
                Copy {workKey}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
