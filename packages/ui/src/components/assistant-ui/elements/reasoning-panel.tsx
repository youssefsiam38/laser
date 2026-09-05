"use client";
/**
 * Reasoning panel (`elements-reasoning-panel`): the expanded reasoning BODY,
 * distinct from the collapsible header in `reasoning.aui`.
 *
 * The registry copy is a whole demo collapsible over a list of titled steps.
 * Pi's reasoning is one markdown stream, not steps, and the header already
 * exists in `reasoning`, so this is de-demoed to the part the inventory
 * claims: the scrolling, hairlined body with its bottom pin and fade. The
 * steps model, `visibleSteps` and the `max-w-sm` are gone.
 */
import type { ComponentProps } from "react";

import { ReasoningContent, ReasoningText } from "./reasoning.js";

export interface ReasoningPanelProps extends ComponentProps<"div"> {
  /** Whether the body is still receiving tokens (sets `aria-busy`). */
  streaming?: boolean;
}

export function ReasoningPanel({ streaming = false, className, children, ...props }: ReasoningPanelProps) {
  return (
    <ReasoningContent data-slot="reasoning-panel" aria-busy={streaming || undefined} className={className}>
      <ReasoningText {...props}>{children}</ReasoningText>
    </ReasoningContent>
  );
}
