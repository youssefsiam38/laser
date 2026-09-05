"use client";
/**
 * Onboarding — first run: no projects yet (docs/ux-elements.md "Thread").
 * Installed from `elements-onboarding` and restyled to DESIGN.md tokens.
 *
 * Divergences from the registry copy:
 *   - Steps carry an optional `action`, so the last one is the first real
 *     move (Add a project) rather than a "Start" that goes nowhere.
 *   - The progress dots are buttons: a step can be revisited.
 *   - The `example` line is set in the typed face when it is a command or a
 *     path (`exampleMono`).
 */
import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { field, mono, paper } from "./surfaces.js";

export interface OnboardingStep {
  title: string;
  body: string;
  example?: string | undefined;
  exampleMono?: boolean | undefined;
  /** Replaces "Next" on this step. */
  action?: { label: string; onClick: () => void; icon?: ReactNode } | undefined;
}

export interface OnboardingProps extends Omit<ComponentProps<"div">, "children"> {
  steps: readonly OnboardingStep[];
  index: number;
  onIndexChange?: ((index: number) => void) | undefined;
  onSkip?: (() => void) | undefined;
  skipLabel?: string | undefined;
}

export function Onboarding({ steps, index, onIndexChange, onSkip, skipLabel = "Not now", className, ...props }: OnboardingProps) {
  const current = Math.max(0, Math.min(steps.length - 1, Number.isFinite(index) ? Math.floor(index) : 0));
  const step = steps[current];
  if (!step) return null;
  const last = current >= steps.length - 1;

  return (
    <div
      data-slot="onboarding"
      role="region"
      aria-label="Getting started"
      className={cn(paper, "flex w-full max-w-md flex-col gap-4 rounded-2xl p-5 shadow-float", className)}
      {...props}
    >
      <div key={current} className="flex flex-col gap-2 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-(--motion-slow)">
        <span className={cn(mono, "text-ink-3")}>
          {current + 1} of {steps.length}
        </span>
        <h2 className="text-lg font-semibold text-ink">{step.title}</h2>
        <p className="text-sm leading-sm text-ink-2 break-words">{step.body}</p>
        {step.example && (
          <span className={cn(field, "rounded-lg px-3 py-2 text-sm leading-sm text-ink-2 break-words", step.exampleMono && "font-mono text-xs leading-xs")}>
            {step.example}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="flex gap-1.5" role="tablist" aria-label="Steps">
          {steps.map((s, i) => (
            <button
              key={s.title}
              type="button"
              role="tab"
              aria-selected={i === current}
              aria-label={`Step ${i + 1}: ${s.title}`}
              onClick={() => onIndexChange?.(i)}
              className={cn(
                "h-1.5 rounded-full outline-none transition-[width,background-color] duration-(--motion-slow) motion-reduce:transition-none",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
                i === current ? "w-5 bg-ink-2" : "w-1.5 bg-line hover:bg-ink-3",
              )}
            />
          ))}
        </span>
        <Button variant="ghost" size="sm" onClick={onSkip} className="ms-auto">
          {skipLabel}
        </Button>
        {step.action ? (
          <Button size="sm" onClick={step.action.onClick}>
            {step.action.icon}
            {step.action.label}
          </Button>
        ) : (
          <Button size="sm" onClick={() => onIndexChange?.(Math.min(steps.length - 1, current + 1))} disabled={last}>
            Next
          </Button>
        )}
      </div>
    </div>
  );
}
