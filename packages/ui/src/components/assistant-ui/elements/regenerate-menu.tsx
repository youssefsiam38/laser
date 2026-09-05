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
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

import { GenerationLoader } from "./loading-state.js";
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

const modelKey = (m: ModelRef): string => `${m.provider}/${m.id}`;

export function RegenerateMenu({ loadModels, thinkingLevels, currentModel, currentThinking, onPick, disabled = false, className }: RegenerateMenuProps) {
  const [models, setModels] = useState<ModelRef[] | undefined>(undefined);
  const [open, setOpen] = useState(false);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && models === undefined) {
      void loadModels().then((list) => setModels(list));
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <TooltipIconButton tooltip="Fork and re-run with…" size="icon-xs" className={cn("text-ink-3", className)} disabled={disabled}>
          <RefreshCw />
        </TooltipIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <p className="px-2 pt-1.5 pb-1 text-xs text-ink-2">Re-runs this prompt in a fork. This reply stays here.</p>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Thinking</DropdownMenuLabel>
        <DropdownMenuRadioGroup {...(currentThinking ? { value: currentThinking } : {})} onValueChange={(v) => onPick({ thinking: v as ThinkingLevel })}>
          {thinkingLevels.map((level) => (
            <DropdownMenuRadioItem key={level} value={level}>
              <span className="capitalize">{level}</span>
              {level === currentThinking ? <span className={cn(mono, "ms-auto text-ink-3")}>current</span> : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Model</DropdownMenuLabel>
        {models === undefined ? (
          <GenerationLoader label="Loading models" layout="inline" className="px-2 py-1.5 text-ink-3" />
        ) : models.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-ink-3">No other models are signed in.</p>
        ) : (
          <DropdownMenuRadioGroup
            value={currentModel ? modelKey(currentModel) : ""}
            onValueChange={(key) => {
              const model = models.find((m) => modelKey(m) === key);
              if (model) onPick({ model });
            }}
          >
            {models.map((m) => (
              <DropdownMenuRadioItem key={modelKey(m)} value={modelKey(m)}>
                <span className="min-w-0 flex-1 truncate">{m.name ?? m.id}</span>
                <span className={cn(mono, "ms-auto shrink-0 text-ink-3")}>{currentModel && modelKey(currentModel) === modelKey(m) ? "current" : m.provider}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
