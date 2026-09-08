import { Sparkles } from "lucide-react";
import { useRef } from "react";

import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

import { beamStore, useBeam } from "./beam-store.js";
import { BEAM_NAME } from "./beam-model.js";

export const BEAM_BUBBLE_ID = "beam-bubble";

export interface BeamSparkProps {
  /** Which way the tooltip opens: `right` in the rail, `top` in the sheet footer. */
  side: "right" | "top";
  size?: "icon" | "icon-sm";
  /** Runs when the spark opens the bubble (the sessions sheet closes itself). */
  onOpen?: () => void;
}

/**
 * Beam's one entry point (docs/agents.md "Beam"): the green spark beside
 * Settings. The rail renders it on desktop and tablet, the sessions sheet's
 * footer on a phone — the same affordance in the place that width has, never
 * a second one. Nothing else in the app opens the bubble.
 */
export function BeamSpark({ side, size = "icon-sm", onOpen }: BeamSparkProps) {
  const { open } = useBeam();
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <TooltipIconButton
      ref={ref}
      tooltip={BEAM_NAME}
      side={side}
      size={size}
      data-slot="beam-spark"
      aria-expanded={open}
      {...(open ? { "aria-controls": BEAM_BUBBLE_ID } : {})}
      className={cn(
        // The accent is the brand: the spark is the one control in the rail
        // drawn in `--live` at rest. Tinted ground on hover, deeper when
        // pressed, and held while the bubble is open.
        "relative text-live hover:bg-[color-mix(in_oklab,var(--live)_12%,transparent)] hover:text-live",
        "active:bg-[color-mix(in_oklab,var(--live)_20%,transparent)]",
        open && "bg-[color-mix(in_oklab,var(--live)_14%,transparent)]",
        // A 44px hit area on touch, past the paint (DESIGN.md "Legibility floor").
        "[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2 [@media(pointer:coarse)]:after:content-['']",
      )}
      onClick={() => {
        if (open) {
          beamStore.close();
          return;
        }
        beamStore.open(ref.current);
        onOpen?.();
      }}
    >
      <Sparkles />
    </TooltipIconButton>
  );
}
