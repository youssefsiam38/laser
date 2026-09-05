"use client";
/**
 * The frame every first-run step sits in. Follows the grammar of the
 * `onboarding` element exactly — paper card, `n of N` eyebrow, title, body,
 * dots that are buttons, "Skip" on the left of the actions — and adds the one
 * thing the element has no slot for: a body that is a form rather than a
 * sentence. The last step is the element itself (see FirstRunFlow).
 */
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { mono, paper } from "@/components/assistant-ui/elements/surfaces";

export interface SetupCardProps {
  /**
   * 0-based position among the steps that count, or `-1` for a step that does
   * not: the welcome screen is not one of "three things to set up", and an
   * eyebrow that says "1 of 5" beside a sentence that says "three steps" is
   * the card contradicting itself. `-1` hides the counter and the dots.
   */
  index: number;
  total: number;
  /** Titles for every step, for the dots' accessible names. */
  titles: readonly string[];
  title: string;
  description?: string | undefined;
  children: ReactNode;
  /** Buttons for the right side of the footer. */
  actions: ReactNode;
  /** A dot before the current one can be revisited. */
  onStepChange?: ((index: number) => void) | undefined;
  onSkip?: (() => void) | undefined;
  skipLabel?: string | undefined;
  className?: string | undefined;
}

export function SetupCard({
  index,
  total,
  titles,
  title,
  description,
  children,
  actions,
  onStepChange,
  onSkip,
  skipLabel = "Skip setup",
  className,
}: SetupCardProps) {
  return (
    <div
      data-slot="setup-card"
      role="region"
      aria-label={index < 0 ? `Setup: ${title}` : `Setup, step ${index + 1} of ${total}: ${title}`}
      className={cn(paper, "flex w-full max-w-lg flex-col gap-4 rounded-2xl p-5 shadow-float", className)}
    >
      <div key={index} className="flex flex-col gap-1.5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-(--motion-slow)">
        {index >= 0 && (
          <span className={cn(mono, "text-ink-3")}>
            {index + 1} of {total}
          </span>
        )}
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
        {description && <p className="text-sm leading-sm text-ink-2 break-words">{description}</p>}
      </div>

      <div className="flex min-h-0 flex-col gap-3">{children}</div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="flex gap-1.5" role="tablist" aria-label="Steps" hidden={index < 0}>
          {titles.map((label, i) => (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-label={`Step ${i + 1}: ${label}`}
              disabled={i > index}
              onClick={() => i < index && onStepChange?.(i)}
              className={cn(
                "h-1.5 rounded-full outline-none transition-[width,background-color] duration-(--motion-slow) motion-reduce:transition-none",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
                i === index ? "w-5 bg-ink-2" : i < index ? "w-1.5 bg-ink-3 hover:bg-ink-2" : "w-1.5 bg-line",
              )}
            />
          ))}
        </span>
        {onSkip && (
          <Button variant="ghost" size="sm" onClick={onSkip} className="ms-auto">
            {skipLabel}
          </Button>
        )}
        <div className={cn("flex items-center gap-2", !onSkip && "ms-auto")}>{actions}</div>
      </div>
    </div>
  );
}
