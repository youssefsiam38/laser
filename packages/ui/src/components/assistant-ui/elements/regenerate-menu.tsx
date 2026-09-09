"use client";
/**
 * Try again with (`elements-regenerate-menu`): run the prompt that produced
 * this reply again, in this session, with a different model or thinking
 * level. The reply on screen is not lost — it stays in the file as the other
 * version of this answer, reachable from the version picker under the prompt.
 *
 * It is the second half of a pair: "Try again" in `message-actions` re-runs
 * with what the session already uses, and this chevron beside it is the same
 * action with something changed. "In a new session" lives in the overflow.
 *
 * Divergences from the registry copy: a real `DropdownMenu` (keyboard,
 * collision-aware) rather than an inline list toggled by a button; two groups
 * (models, thinking) instead of one flat list; the trigger is a chevron
 * because the plain re-run owns the refresh icon next to it.
 */
import type { ModelRef, ThinkingLevel } from "@lasercode/protocol";
import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";

import { PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  ModelSelectorRoot,
  ProviderModelMenu,
  modelOption,
  modelOptionId,
} from "./model-selector.js";
import { mono } from "./surfaces.js";

export type RegeneratePick = { model: ModelRef } | { thinking: ThinkingLevel };

export interface RegenerateMenuProps {
  /** Resolves the models available to this session; called when the menu opens. */
  loadModels: () => Promise<ModelRef[]>;
  thinkingLevels: readonly ThinkingLevel[];
  currentModel: ModelRef | null;
  currentThinking: ThinkingLevel | undefined;
  onPick: (pick: RegeneratePick) => void;
  disabled?: boolean;
  className?: string | undefined;
}

export function RegenerateMenu({ loadModels, thinkingLevels, currentModel, currentThinking, onPick, disabled = false, className }: RegenerateMenuProps) {
  const [models, setModels] = useState<ModelRef[] | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && models === undefined) {
      setError(undefined);
      void loadModels().then(
        (list) => setModels(list),
        (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)),
      );
    }
  };
  const availableModels = useMemo(() => {
    const list = models ? [...models] : currentModel ? [currentModel] : [];
    if (currentModel && !list.some((model) => modelOptionId(model) === modelOptionId(currentModel))) list.unshift(currentModel);
    return list;
  }, [currentModel, models]);
  const options = useMemo(() => availableModels.map(modelOption), [availableModels]);
  const currentKey = currentModel ? modelOptionId(currentModel) : undefined;

  return (
    <ModelSelectorRoot
      models={options}
      {...(currentKey ? { value: currentKey } : {})}
      open={open}
      onOpenChange={onOpenChange}
      onValueChange={(key) => {
        const model = availableModels.find((entry) => modelOptionId(entry) === key);
        if (model) onPick({ model });
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Try again with another model or thinking level"
          title="Try again with…"
          className={cn("text-ink-3", className)}
          disabled={disabled}
        >
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <ProviderModelMenu
        align="start"
        loading={models === undefined && error === undefined}
        error={error}
        onRetry={() => {
          setModels(undefined);
          setError(undefined);
          void loadModels().then(
            (list) => setModels(list),
            (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }}
        beforeFilters={(
          <div className="grid gap-2 border-b border-line p-2">
            <p className="text-xs leading-4 text-ink-2">Answers here again. This reply is kept as the other version.</p>
            <label className="grid grid-cols-[4.25rem_minmax(0,1fr)] items-center gap-2">
              <span className="eyebrow text-ink-3">Thinking</span>
              <select
                aria-label="Thinking level for re-run"
                value={currentThinking ?? ""}
                onChange={(event) => {
                  onPick({ thinking: event.target.value as ThinkingLevel });
                  setOpen(false);
                }}
                className={cn(mono, "h-9 rounded-lg border border-line bg-surface px-2.5 text-xs text-ink outline-none focus-visible:border-live")}
              >
                {!currentThinking ? <option value="" disabled>Choose a level</option> : null}
                {thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
            </label>
          </div>
        )}
      />
    </ModelSelectorRoot>
  );
}
