import { ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { Sparkles } from "lucide-react";
import type { CSSProperties } from "react";

import { useAgentsSnapshot } from "@/agents";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";

import { BEAM_DEFAULT_MODEL_NOTE, BEAM_NAME, BEAM_SUGGESTIONS, BEAM_TAGLINE } from "./beam-model.js";

/**
 * The bubble before its first message: a quiet, centred hint that Beam is the
 * person's assistant for the app. The mark, the name, one sentence, and chips
 * that fill the composer (`ThreadPrimitive.Suggestion` with `send={false}`:
 * the person reads what they are about to ask, then sends).
 *
 * Centred on purpose, unlike the project empty state: this is a card in the
 * corner, not a transcript column, and its greeting is a mark, not a path.
 * Composed from the same `ThreadPrimitive.Suggestion` the `empty-state`
 * element uses (docs/ux-elements.md "Empty state"); its hairline rows are the
 * project form and stay there.
 */
export function BeamEmptyState() {
  const snapshot = useAgentsSnapshot();
  const { dispatch } = useLaserStable();
  const disabled = useAuiState((s) => s.thread.isDisabled);
  const beam = snapshot?.beam;
  const needsModel = beam !== undefined && beam.model === null && beam.needsChoice;

  return (
    <div data-slot="beam-empty-state" className="my-auto flex w-full flex-col items-center gap-6 px-2 py-10 text-center">
      <span
        aria-hidden="true"
        className={cn(
          "flex size-12 items-center justify-center rounded-full text-live",
          "bg-[color-mix(in_oklab,var(--live)_12%,transparent)]",
          "animate-in fade-in-0 zoom-in-75 fill-mode-both duration-(--motion-slow) ease-morph motion-reduce:animate-none",
        )}
      >
        <Sparkles className="size-5" />
      </span>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-xl font-semibold tracking-title text-ink">{BEAM_NAME}</h2>
        <p className="max-w-72 text-sm leading-sm text-ink-2">{BEAM_TAGLINE}</p>
      </div>
      <ul aria-label="Suggested questions" className="flex flex-wrap justify-center gap-2">
        {BEAM_SUGGESTIONS.map((prompt, index) => (
          <li key={prompt}>
            <ThreadPrimitive.Suggestion
              prompt={prompt}
              send={false}
              disabled={disabled}
              data-slot="beam-suggestion"
              style={{ animationDelay: `calc(var(--motion-fast) * ${index + 1})` } as CSSProperties}
              className={cn(
                "inline-flex h-8 items-center rounded-full border border-line bg-surface px-3 text-sm text-ink-2",
                "transition-[background-color,color,border-color] duration-(--motion-instant)",
                "hover:border-[color-mix(in_oklab,var(--live)_40%,var(--line))] hover:bg-surface-2 hover:text-ink",
                "active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))]",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live outline-none",
                "disabled:cursor-not-allowed disabled:opacity-50",
                "animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both duration-(--motion-slow) motion-reduce:animate-none",
              )}
            >
              {prompt}
            </ThreadPrimitive.Suggestion>
          </li>
        ))}
      </ul>
      {needsModel && (
        <p data-slot="beam-model-note" className="flex flex-wrap items-center justify-center gap-x-1 text-xs leading-xs text-ink-3">
          {BEAM_DEFAULT_MODEL_NOTE}
          <Button
            variant="link"
            size="xs"
            className="text-xs"
            onClick={() => dispatch({ type: "agents/choose-beam-model", suggested: beam.suggested })}
          >
            Choose a model
          </Button>
        </p>
      )}
    </div>
  );
}
