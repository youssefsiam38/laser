"use client";
/**
 * Regenerate with (`elements-regenerate-menu`): fork before the prompt that
 * produced this reply and run it again with a different model or thinking
 * level. The reply on screen stays in the original session; the re-run lands
 * in the fork, which becomes the open session.
 *
 * Divergences from the registry copy: a real `DropdownMenu` (keyboard,
 * collision-aware) rather than an inline list toggled by a button; two groups
 * (models, thinking) instead of one flat list; the menu names the fork.
 */
import type { ModelRef, ThinkingLevel } from "@lasercode/protocol";
import { RefreshCw } from "lucide-react";
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
          aria-label="Fork and re-run with another model or thinking level"
          title="Fork and re-run with…"
          className={cn("text-ink-3", className)}
          disabled={disabled}
        >
          <RefreshCw />
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
            <p className="text-xs leading-4 text-ink-2">Re-runs this prompt in a fork. This reply stays here.</p>
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
