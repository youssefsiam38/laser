"use client";

import {
  PRODUCT_DISPLAY_NAME,
  type AgentDefinitionInput,
  type AgentSkillRef,
} from "@lasercode/protocol";
import { useMemo } from "react";

import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { CheckRow, Hint } from "./fields.js";
import { InstructionTemplateSourceView } from "./InstructionTemplateEditor.js";
import {
  groupSkills,
  missingSkills,
  skillKey,
  SKILL_SCOPE_LABEL,
} from "./model.js";
import { useEngineInstructions, useSkillsListing } from "./use-page-data.js";

export function EngineInstructions({
  draft,
  cwd,
  onCustomize,
}: {
  draft: AgentDefinitionInput;
  cwd: string | undefined;
  onCustomize(text: string): void;
}) {
  const engine = useEngineInstructions(cwd, cwd !== undefined);
  return (
    <div data-slot="engine-instructions" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Badge variant="outline">Using {PRODUCT_DISPLAY_NAME}'s default instructions</Badge>
        <Hint>Customize to make this prompt your own.</Hint>
      </div>
      {cwd === undefined ? (
        <Hint>Choose a project scope to read {PRODUCT_DISPLAY_NAME}'s default instructions.</Hint>
      ) : engine.error !== undefined ? (
        <ErrorState
          title={`Couldn’t read ${PRODUCT_DISPLAY_NAME}'s default instructions`}
          detail={engine.error}
          onRetry={engine.reload}
        />
      ) : engine.data === undefined ? (
        <GenerationLoader label={`Loading ${PRODUCT_DISPLAY_NAME}'s default instructions`} layout="inline" />
      ) : (
        <InstructionTemplateSourceView
          target="agent"
          value={engine.data}
          ariaLabel={`${PRODUCT_DISPLAY_NAME}'s default instructions highlighted source`}
          context={{
            agentName: draft.name,
            agentDescription: draft.description,
            model: draft.model,
            thinkingLevel: draft.thinkingLevel,
            provenance: "Current agent setting",
          }}
          className="max-h-80 min-h-0 text-xs text-ink-2"
        />
      )}
      <div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={engine.data === undefined}
          onClick={() => onCustomize(engine.data ?? "")}
        >
          Customize
        </Button>
      </div>
    </div>
  );
}

export function SkillsField({
  cwd,
  value,
  flaggedNames,
  flaggedIndices,
  onChange,
}: {
  cwd: string | undefined;
  value: readonly AgentSkillRef[];
  flaggedNames: ReadonlySet<string>;
  flaggedIndices: ReadonlySet<number>;
  onChange(next: AgentSkillRef[]): void;
}) {
  const listing = useSkillsListing(cwd, cwd !== undefined);
  const groups = useMemo(() => groupSkills(listing.data), [listing.data]);
  const missing = useMemo(() => missingSkills(value, listing.data), [value, listing.data]);
  const chosenKeys = useMemo(() => new Set(value.map(skillKey)), [value]);
  const flaggedKeys = useMemo(() => {
    const keys = new Set<string>();
    value.forEach((skill, index) => {
      if (flaggedNames.has(skill.name) || flaggedIndices.has(index)) keys.add(skillKey(skill));
    });
    return keys;
  }, [value, flaggedNames, flaggedIndices]);
  const toggle = (skill: AgentSkillRef, on: boolean) => onChange(on
    ? [...value.filter((candidate) => skillKey(candidate) !== skillKey(skill)), { name: skill.name, path: skill.path, scope: skill.scope }]
    : value.filter((candidate) => skillKey(candidate) !== skillKey(skill)));

  if (cwd === undefined) return <Hint>Choose a project scope to see which skills it offers.</Hint>;
  if (listing.error !== undefined) {
    return <ErrorState title="Couldn’t list the skills" detail={listing.error} onRetry={listing.reload} />;
  }
  if (listing.data === undefined) return <GenerationLoader label="Looking for skills" layout="inline" />;

  return (
    <div data-slot="skills-picker" className="flex flex-col gap-3">
      {missing.length > 0 ? (
        <ul aria-label="Skills that could not be found" className="flex flex-col gap-1">
          {missing.map((skill) => (
            <li
              key={skillKey(skill)}
              data-slot="skill-missing"
              data-skill={skill.name}
              className="flex items-center gap-2 rounded-md bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] px-2 py-1.5"
            >
              <span className="min-w-0 flex-1">
                <span className="text-sm text-ink">{skill.name}</span>
                <span className="typed block truncate text-ink-3" title={skill.path}>{skill.path}</span>
                <span className="block text-xs text-attention">Not found any more. Choose it again or remove it.</span>
              </span>
              <Button type="button" variant="ghost" size="xs" onClick={() => toggle(skill, false)}>Remove</Button>
            </li>
          ))}
        </ul>
      ) : null}
      {groups.length === 0 ? (
        <Hint>No skills found in this project or globally. Add a skill folder and it appears here.</Hint>
      ) : groups.map((group) => (
        <div key={group.scope} role="group" aria-label={SKILL_SCOPE_LABEL[group.scope]} className="flex flex-col gap-0.5">
          <span className="eyebrow px-2">{SKILL_SCOPE_LABEL[group.scope]}</span>
          {group.skills.map((skill) => (
            <CheckRow
              key={skillKey(skill)}
              name={`skill:${skill.path}`}
              data-skill={skill.name}
              checked={chosenKeys.has(skillKey(skill))}
              flagged={flaggedKeys.has(skillKey(skill))}
              label={skill.name}
              detail={skill.path}
              onChange={(event) => toggle(skill, event.target.checked)}
            />
          ))}
        </div>
      ))}
      {listing.data.roots.every((root) => !root.exists) ? <Hint>None of the skill folders exist yet.</Hint> : null}
    </div>
  );
}
