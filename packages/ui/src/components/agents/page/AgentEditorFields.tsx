"use client";

import type {
  AgentDefinition,
  AgentDefinitionInput,
  ModelCatalogEntry,
  ModelProfile,
  ThinkingLevel,
} from "@lasercode/protocol";
import { useEffect, useId, useState, type KeyboardEvent } from "react";

import { agentDisplayName } from "@/agents";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { ProfilePicker } from "@/components/assistant-ui/elements/model-profiles";
import { SettingsToggleRow } from "@/components/assistant-ui/elements/settings-panel";
import { Button } from "@/components/ui/button";
import { useLogicalArrowKeys } from "@/hooks/use-direction";
import { cn } from "@/lib/utils";

import { CheckRow, Hint } from "./fields.js";
import { THINKING_LABEL } from "./model.js";

/**
 * Which profile an agent runs on (M22-T9). `null` inherits the profile new
 * conversations use; a profile id nothing answers to is a warning on the
 * `profile` field, not a refusal, so the picker still shows what was named.
 */
export function ProfileField({
  value,
  profiles,
  models,
  loading,
  error,
  onRetry,
  onChange,
}: {
  value: AgentDefinitionInput["profileId"];
  profiles: readonly ModelProfile[];
  models: readonly ModelCatalogEntry[];
  loading: boolean;
  error: string | undefined;
  onRetry(): void;
  onChange(profileId: AgentDefinitionInput["profileId"]): void;
}) {
  const [choosing, setChoosing] = useState(value !== null);
  useEffect(() => {
    if (value !== null) setChoosing(true);
  }, [value]);
  const id = useId();
  const missing = value !== null && !profiles.some((profile) => profile.id === value);
  return (
    <div className="flex flex-col gap-2">
      <SettingsToggleRow
        id={id}
        label="Follow the profile new conversations use"
        detail={choosing ? "Off: this agent always runs on the profile chosen below." : "On: this agent runs on whatever new conversations run on."}
        checked={!choosing}
        onCheckedChange={(follow) => {
          setChoosing(!follow);
          if (follow) onChange(null);
        }}
      />
      {choosing ? (
        <div className="flex flex-col gap-1.5">
          <ProfilePicker
            profiles={profiles}
            catalogue={models}
            value={value}
            loading={loading}
            {...(error !== undefined ? { error } : {})}
            placeholder="Choose a profile"
            aria-label="Profile for this agent"
            onValueChange={onChange}
          />
          {error !== undefined ? (
            <ErrorState title="Couldn’t load your profiles" detail={error} onRetry={onRetry} />
          ) : missing ? (
            <Hint>
              This agent names a profile that is not there any more. It runs on the profile new conversations use until you
              choose another.
            </Hint>
          ) : value === null ? (
            <Hint>No profile chosen yet: the one new conversations use applies until you pick one.</Hint>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ThinkingField({
  value,
  levels,
  onChange,
}: {
  value: ThinkingLevel | null;
  levels: readonly ThinkingLevel[];
  onChange(level: ThinkingLevel | null): void;
}) {
  const logicalKey = useLogicalArrowKeys();
  const options: Array<{ id: string; level: ThinkingLevel | null; label: string }> = [
    { id: "default", level: null, label: "Follow the default" },
    ...levels.map((level) => ({ id: level, level, label: THINKING_LABEL[level] })),
  ];
  const current = options.findIndex((option) => option.level === value);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = logicalKey(event.key);
    const delta = key === "ArrowRight" || key === "ArrowDown"
      ? 1
      : key === "ArrowLeft" || key === "ArrowUp"
        ? -1
        : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = options[(Math.max(current, 0) + delta + options.length) % options.length];
    if (!next) return;
    onChange(next.level);
    event.currentTarget.querySelector<HTMLElement>(`[data-level="${next.id}"]`)?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Thinking level" className="flex flex-wrap gap-1" onKeyDown={move}>
      {options.map((option, index) => {
        const selected = index === (current === -1 ? 0 : current);
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            data-level={option.id}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.level)}
            className={cn(
              "inline-flex h-8 items-center rounded-md border px-2.5 text-sm leading-none select-none pointer-coarse:h-11",
              "transition-[background-color,color,border-color] duration-(--motion-instant) outline-none active:translate-y-px",
              "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
              selected
                ? "border-live bg-[color-mix(in_oklab,var(--live)_12%,transparent)] text-live"
                : "border-line text-ink-2 hover:bg-surface-2 hover:text-ink",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function AllowedAgentsField({
  value,
  options,
  self,
  flagged,
  onChange,
}: {
  value: readonly string[];
  options: readonly AgentDefinition[];
  self: string | undefined;
  flagged: ReadonlySet<string>;
  onChange(next: string[]): void;
}) {
  const unknown = value.filter((name) => !options.some((option) => option.name === name));
  const toggle = (name: string, on: boolean) => onChange(on
    ? [...value.filter((candidate) => candidate !== name), name]
    : value.filter((candidate) => candidate !== name));
  return (
    <div role="group" aria-label="Agents it may start" data-slot="allowed-agents" className="flex flex-col gap-0.5">
      {unknown.map((name) => (
        <div
          key={name}
          data-slot="allowed-agent-missing"
          className="flex items-center gap-2 rounded-md bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] px-2 py-1.5"
        >
          <span className="min-w-0 flex-1">
            <span className="typed text-ink">{name}</span>
            <span className="block text-xs text-ink-2">No agent has this name any more. Remove it, or create the agent again.</span>
          </span>
          <Button type="button" variant="ghost" size="xs" onClick={() => toggle(name, false)}>Remove</Button>
        </div>
      ))}
      {options.length === 0 ? (
        <Hint>No other agents to start yet. Create one and it appears here.</Hint>
      ) : options.map((option) => (
        <CheckRow
          key={option.name}
          name={`allowed:${option.name}`}
          checked={value.includes(option.name)}
          flagged={flagged.has(option.name)}
          label={option.name === self ? `${agentDisplayName(option.name)} · Same agent` : agentDisplayName(option.name)}
          detail={option.name === self ? "Starts another instance with these same settings." : option.description || option.name}
          onChange={(event) => toggle(option.name, event.target.checked)}
        />
      ))}
    </div>
  );
}
