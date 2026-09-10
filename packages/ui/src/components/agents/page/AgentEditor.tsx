"use client";
/**
 * The agent editor: one definition, every field, validated by the host as
 * the person types and again on save. The `default` agent edits like any
 * other except for its Instructions section, which starts on the product's
 * default text and can be customised or restored.
 *
 * Issues (`AgentIssue.field`) land at their field in danger; periodic
 * warnings (`AgentWarning.field`) land at theirs in attention, and a deep
 * link (`focus`) scrolls to that section and focuses its notice.
 */
import {
  AGENT_DESCRIPTION_MAX,
  DEFAULT_AGENT_NAME,
  PRODUCT_DISPLAY_NAME,
  type AgentDefinition,
  type AgentDefinitionInput,
  type AgentIssue,
  type AgentSkillRef,
  type AgentWarning,
  type AgentsSnapshot,
  type ModelCatalogEntry,
  type ThinkingLevel,
} from "@lasercode/protocol";
import { Bot, Info, MessageSquarePlus, RotateCw, Save, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { agentDefinitionInputOf, agentDisplayName, agentIssuesByField, defaultAgentDefinitionInput, useAgentsActions } from "@/agents";
import { AgentCard, type AgentCardFact } from "@/components/assistant-ui/elements/agent-card";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { ProviderModelPicker } from "@/components/assistant-ui/elements/model-selector";
import { SettingsToggleRow } from "@/components/assistant-ui/elements/settings-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "@/motion";

import { DeleteAgentDialog } from "./dialogs.js";
import { CheckRow, Hint, IssueNotice, Section, WarningNotice } from "./fields.js";
import {
  THINKING_LABEL,
  checkRange,
  deletability,
  describeModel,
  describeSkills,
  describeStarts,
  describeThinking,
  groupSkills,
  missingSkills,
  modelChoiceId,
  parseModelChoice,
  sameDefinitionInput,
  sectionDomId,
  sectionOfField,
  shapeAgentName,
  skillKey,
  startableAgents,
  thinkingLevelsFor,
  toolLabel,
  warningsInSection,
  SKILL_SCOPE_LABEL,
  type EditorSection,
} from "./model.js";
import { useEngineInstructions, useModelCatalog, useSkillsListing, useWebSearchFeature } from "./use-page-data.js";

/** Typing pause before the host is asked to validate. */
const VALIDATE_DEBOUNCE_MS = 350;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Issues a rejected save may carry (`ProtocolError.data.issues`), if the transport kept them. */
const issuesOf = (error: unknown): AgentIssue[] | undefined => {
  const data = (error as { data?: { issues?: unknown } } | null)?.data;
  return Array.isArray(data?.issues) ? (data.issues as AgentIssue[]) : undefined;
};

export interface EditorFocus {
  field: string;
  /** Changes on every request, so the same field can be asked for twice. */
  seq: number;
}

export interface AgentEditorProps {
  /** `undefined` creates a new agent. */
  agent: AgentDefinition | undefined;
  snapshot: AgentsSnapshot;
  /** Where host reads are routed: the project, or a built-in workspace when none is open. */
  routeCwd: string | undefined;
  /** The open project, for Start chat. */
  projectCwd: string | undefined;
  warnings: readonly AgentWarning[];
  focus: EditorFocus | undefined;
  onDirtyChange(dirty: boolean): void;
  onSaved(agent: AgentDefinition): void;
  onDeleted(): void;
  onStartChat(name: string): void;
}

export function AgentEditor({ agent, snapshot, routeCwd, projectCwd, warnings, focus, onDirtyChange, onSaved, onDeleted, onStartChat }: AgentEditorProps) {
  const agents = useAgentsActions();
  const isNew = agent === undefined;
  const isDefaultAgent = agent?.name === DEFAULT_AGENT_NAME;
  const [base, setBase] = useState<AgentDefinitionInput>(() => (agent ? agentDefinitionInputOf(agent) : defaultAgentDefinitionInput(snapshot)));
  const [draft, setDraft] = useState<AgentDefinitionInput>(base);
  const [issues, setIssues] = useState<AgentIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // A save elsewhere (another view, the host) moved the stored definition:
  // follow it when nothing here is unsaved, so the form never shows stale text.
  useEffect(() => {
    if (!agent) return;
    const next = agentDefinitionInputOf(agent);
    setBase((current) => {
      if (sameDefinitionInput(current, next)) return current;
      setDraft((d) => (sameDefinitionInput(d, current) ? next : d));
      return next;
    });
  }, [agent]);

  const dirty = !sameDefinitionInput(draft, base);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const byField = useMemo(() => agentIssuesByField(issues), [issues]);
  const patch = useCallback((changes: Partial<AgentDefinitionInput>) => {
    setServerError(undefined);
    setDraft((current) => ({ ...current, ...changes }));
  }, []);

  // --- validation -----------------------------------------------------------
  const validateSeq = useRef(0);
  const validate = useCallback(
    async (input: AgentDefinitionInput): Promise<AgentIssue[] | undefined> => {
      const seq = ++validateSeq.current;
      try {
        const result = await agents.validate(input, agent?.name ?? null);
        if (seq === validateSeq.current) setIssues(result);
        return result;
      } catch {
        // The host could not be asked; the save will say so where it matters.
        return undefined;
      }
    },
    [agent?.name, agents],
  );
  useEffect(() => {
    if (!dirty) return undefined;
    const timer = setTimeout(() => void validate(draft), VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, dirty, validate]);
  const validateNow = useCallback(() => {
    if (dirty) void validate(draft);
  }, [dirty, draft, validate]);

  // --- save -----------------------------------------------------------------
  const canSave = dirty && !byField.any && !saving;
  const save = useCallback(async () => {
    if (saving) return;
    setServerError(undefined);
    const fresh = await validate(draft);
    if (fresh && fresh.length > 0) return;
    setSaving(true);
    try {
      const saved = await agents.save(draft, agent?.name ?? null);
      const next = agentDefinitionInputOf(saved);
      setBase(next);
      setDraft(next);
      setIssues([]);
      onSaved(saved);
    } catch (error) {
      const carried = issuesOf(error);
      if (carried && carried.length > 0) {
        setIssues(carried);
      } else {
        // The transport keeps only the message; ask once more so a field-level
        // refusal still lands at its field rather than as a sentence.
        const again = await validate(draft);
        if (!again || again.length === 0) setServerError(messageOf(error));
      }
    } finally {
      setSaving(false);
    }
  }, [agent?.name, agents, draft, onSaved, saving, validate]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (canSave) void save();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (canSave) void save();
    }
  };

  // --- deep link -------------------------------------------------------------
  useEffect(() => {
    if (!focus) return undefined;
    const section = sectionOfField(focus.field);
    // The section may still be laying out (a lazy screen, a fresh selection);
    // one frame later it is there.
    const frame = requestAnimationFrame(() => {
      const root = formRef.current ?? document;
      const element = root.querySelector<HTMLElement>(`#${sectionDomId(section)}`);
      if (!element) return;
      if (typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      const target =
        element.querySelector<HTMLElement>('[data-slot="agent-field-notice"]') ??
        element.querySelector<HTMLElement>('[data-slot="agent-field-issue"]') ??
        element.querySelector<HTMLElement>("input:not([type=checkbox]), textarea, [role=switch], button");
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);

  // --- data ------------------------------------------------------------------
  const catalog = useModelCatalog(routeCwd);
  const models = catalog.data ?? [];
  const webSearch = useWebSearchFeature(routeCwd);
  const startable = useMemo(() => startableAgents(snapshot), [snapshot]);
  const isDefault = agent !== undefined && snapshot.defaultAgent === agent.name;
  const deletable = agent ? deletability(agent, snapshot) : { ok: false, reason: "Save the agent first." };
  const sectionWarnings = (section: EditorSection) => warningsInSection(warnings, section);
  const ids = useId();

  // --- header card -------------------------------------------------------------
  const facts: AgentCardFact[] = [
    { label: "model", value: describeModel(draft.model, models), typed: draft.model !== null, title: draft.model ? modelChoiceId(draft.model) : undefined },
    { label: "thinking", value: describeThinking(draft.thinkingLevel) },
    { label: "starts", value: describeStarts(draft), tone: sectionWarnings("allowedAgents").length > 0 ? "attention" : undefined },
    { label: "skills", value: describeSkills(draft), tone: sectionWarnings("skills").length > 0 ? "attention" : undefined },
  ];

  const setDefault = async () => {
    if (!agent || isDefault) return;
    setSettingDefault(true);
    try {
      await agents.setDefault(agent.name);
    } finally {
      setSettingDefault(false);
    }
  };

  const remove = async () => {
    if (!agent) return;
    setDeleting(true);
    try {
      await agents.remove(agent.name);
      setConfirmDelete(false);
      onDeleted();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <form
      ref={formRef}
      data-slot="agent-editor"
      data-agent={agent?.name ?? ""}
      aria-label={isNew ? "New agent" : `${agentDisplayName(agent.name)} settings`}
      className="flex min-h-full flex-col"
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
      onBlur={validateNow}
      noValidate
    >
      <div className="mx-auto flex w-full max-w-180 flex-1 flex-col gap-6 px-4 py-5 md:px-6">
        <AgentCard
          name={isNew ? draft.name || "New agent" : agentDisplayName(agent.name)}
          eyebrow={isNew ? "New agent" : isDefaultAgent ? "The shipped agent" : "Your agent"}
          icon={<Bot />}
          description={draft.description || (isNew ? "Describe when another agent should start this one." : undefined)}
          facts={facts}
          badges={
            <>
              {isDefault ? <Badge variant="live">Default</Badge> : null}
              {warnings.length > 0 ? (
                <Badge variant="attention" data-slot="agent-warning-badge">
                  {warnings.length} warning{warnings.length === 1 ? "" : "s"}
                </Badge>
              ) : null}
            </>
          }
        />

        {/* Name */}
        <Section
          id="name"
          title="Name"
          description="Lower-case letters, digits and hyphens. Names must be unique; other agents start this one by its name."
          notices={<IssueNotice id={`${ids}-name-issue`} messages={byField.root.name ?? []} />}
        >
          <Input
            name="name"
            value={draft.name}
            placeholder="reviewer"
            autoComplete="off"
            spellCheck={false}
            autoFocus={isNew}
            aria-invalid={byField.root.name ? true : undefined}
            aria-describedby={byField.root.name ? `${ids}-name-issue` : undefined}
            className="max-w-96 font-mono"
            onChange={(event) => patch({ name: shapeAgentName(event.target.value) })}
          />
        </Section>

        {/* Description */}
        <Section
          id="description"
          title="Description"
          description="When should another agent start this one? Shown in the compact catalog agents read."
          notices={<IssueNotice messages={byField.root.description ?? []} />}
        >
          <Textarea
            name="description"
            value={draft.description}
            maxLength={AGENT_DESCRIPTION_MAX}
            placeholder="Reviews a diff for correctness and reports what should change."
            aria-invalid={byField.root.description ? true : undefined}
            className="min-h-20 max-h-40"
            onChange={(event) => patch({ description: event.target.value })}
          />
          <Hint className="typed text-end tnum">
            {draft.description.length}/{AGENT_DESCRIPTION_MAX}
          </Hint>
        </Section>

        {/* Instructions */}
        <Section
          id="instructions"
          title="Instructions"
          description="How should this agent perform its work? Loaded only for this agent."
          notices={<IssueNotice messages={[...(byField.root.instructions ?? []), ...(byField.root.engineInstructions ?? [])]} />}
        >
          {draft.engineInstructions ? (
            <EngineInstructions cwd={routeCwd} onCustomize={(text) => patch({ engineInstructions: false, instructions: text })} />
          ) : (
            <>
              <Textarea
                name="instructions"
                value={draft.instructions}
                placeholder="You review diffs. Read every changed file before you judge it…"
                aria-invalid={byField.root.instructions ? true : undefined}
                className="min-h-40 max-h-120 font-mono text-sm leading-code"
                onChange={(event) => patch({ instructions: event.target.value })}
              />
              {isDefaultAgent ? (
                <div>
                  <Button type="button" variant="link" size="sm" className="gap-1" onClick={() => patch({ engineInstructions: true })}>
                    <Undo2 />
                    Use {PRODUCT_DISPLAY_NAME}'s default instructions again
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </Section>

        {/* Model */}
        <Section
          id="model"
          title="Model"
          description="Which model runs this agent. Following the default keeps it on whatever new sessions use."
          notices={
            <>
              <WarningNotice warnings={sectionWarnings("model")} />
              <IssueNotice messages={byField.root.model ?? []} />
            </>
          }
        >
          <ModelField
            value={draft.model}
            models={models}
            loading={catalog.loading}
            error={catalog.error}
            onRetry={catalog.reload}
            onChange={(model) => patch({ model, thinkingLevel: model === null ? draft.thinkingLevel : null })}
          />
        </Section>

        {/* Thinking */}
        <Section
          id="thinkingLevel"
          title="Thinking"
          description="How much the model reasons before it answers. Only the levels the chosen model accepts are offered."
          notices={<IssueNotice messages={byField.root.thinkingLevel ?? []} />}
        >
          <ThinkingField value={draft.thinkingLevel} levels={thinkingLevelsFor(draft.model, models)} onChange={(thinkingLevel) => patch({ thinkingLevel })} />
        </Section>

        {/* Starting other agents */}
        <Section
          id="allowedAgents"
          title="Starting other agents"
          description="An agent that starts others delegates work to them; each runs in its own session and worktree and reports back."
          notices={
            <>
              <WarningNotice warnings={sectionWarnings("allowedAgents")} />
              <IssueNotice messages={[...(byField.root.supportsSubagents ?? []), ...(byField.root.allowedAgents ?? [])]} />
            </>
          }
        >
          <SettingsToggleRow
            id={`${ids}-supports`}
            label="Can start other agents"
            detail={draft.supportsSubagents ? "Choose which definitions it may start." : "Off: this agent works alone."}
            checked={draft.supportsSubagents}
            // The toggle owns both halves. Turning it on offers every agent it
            // could start, so it works without a second decision; turning it
            // off empties the list, because a definition that starts nothing
            // and names agents anyway is one the host refuses.
            onCheckedChange={(supportsSubagents) =>
              patch({
                supportsSubagents,
                allowedAgents: supportsSubagents ? (draft.allowedAgents.length > 0 ? draft.allowedAgents : startable.map((option) => option.name)) : [],
              })
            }
          />
          {draft.supportsSubagents ? (
            <AllowedAgentsField
              value={draft.allowedAgents}
              options={startable}
              self={agent?.name}
              flagged={new Set(sectionWarnings("allowedAgents").map((warning) => warning.target).filter((target): target is string => target !== undefined))}
              onChange={(allowedAgents) => patch({ allowedAgents })}
            />
          ) : null}
        </Section>

        {/* Skills */}
        <Section
          id="skills"
          title="Skills"
          description={`${PRODUCT_DISPLAY_NAME} discovers skills in your global and project folders. Scope them to limit what this agent sees.`}
          notices={
            <>
              <WarningNotice warnings={sectionWarnings("skills")} />
              <IssueNotice messages={[...(byField.root.scopedSkills ?? []), ...(byField.root.skills ?? [])]} />
            </>
          }
        >
          <SettingsToggleRow
            id={`${ids}-scoped`}
            label="Scoped skills"
            detail={draft.scopedSkills ? "Only the skills chosen below are offered." : "Off: this agent can use every skill in the project and globally."}
            checked={draft.scopedSkills}
            onCheckedChange={(scopedSkills) => patch({ scopedSkills })}
          />
          {draft.scopedSkills ? (
            <SkillsField
              cwd={routeCwd}
              value={draft.skills}
              flaggedNames={new Set(sectionWarnings("skills").map((warning) => warning.target).filter((target): target is string => target !== undefined))}
              flaggedIndices={new Set(Object.keys(byField.exact).map((field) => /^skills\[(\d+)\]$/.exec(field)?.[1]).filter((i): i is string => i !== undefined).map(Number))}
              onChange={(skills) => patch({ skills })}
            />
          ) : null}
        </Section>

        {/* Default */}
        <Section id="default" title="Default for new sessions">
          <div className="flex items-center gap-2">
            <SettingsToggleRow
              id={`${ids}-default`}
              className="min-w-0 flex-1"
              label="Default for new sessions"
              detail={isNew ? "Save the agent first, then you can make it the default." : isDefault ? "New sessions start with this agent." : "Make this the agent new sessions start with."}
              checked={isDefault}
              disabled={isNew || isDefault || settingDefault}
              onCheckedChange={(on) => {
                if (on) void setDefault();
              }}
            />
            <Popover>
              <PopoverTrigger asChild>
                <TooltipIconButton tooltip="About the default agent" size="icon-sm" className="text-ink-3">
                  <Info />
                </TooltipIconButton>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72">
                <PopoverHeader>
                  <PopoverTitle>The default agent</PopoverTitle>
                  <PopoverDescription>The default agent is the one a new session starts with. It is the default until you choose another.</PopoverDescription>
                </PopoverHeader>
              </PopoverContent>
            </Popover>
          </div>
        </Section>
      </div>

      {/* Footer */}
      <div data-slot="agent-editor-footer" className="sticky bottom-0 z-10 mt-auto bg-bg hairline-t">
        {serverError ? (
          <div className="px-4 pt-3 md:px-6">
            <ErrorState title="Couldn’t save the agent" detail={serverError} onRetry={() => void save()} retryLabel="Try again" />
          </div>
        ) : null}
        <div className="mx-auto flex w-full max-w-180 flex-wrap items-center gap-2 px-4 py-3 md:px-6">
          <Button type="submit" disabled={!canSave} aria-busy={saving || undefined} className="min-w-24">
            {saving ? <RotateCw className="motion-safe:animate-busy" /> : <Save />}
            {saving ? "Saving…" : isNew ? "Create agent" : "Save"}
          </Button>
          {dirty ? (
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setDraft(base);
                setIssues([]);
                setServerError(undefined);
              }}
            >
              Discard changes
            </Button>
          ) : null}
          <span className="ms-auto flex flex-wrap items-center gap-2">
            {!isNew ? (
              projectCwd ? (
                <Button type="button" variant="outline" onClick={() => onStartChat(agent.name)}>
                  <MessageSquarePlus />
                  Start chat
                </Button>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0} className="inline-flex rounded-lg outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live">
                      <Button type="button" variant="outline" disabled aria-describedby={`${ids}-start-why`}>
                        <MessageSquarePlus />
                        Start chat
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent id={`${ids}-start-why`}>Open a project to start a chat with this agent</TooltipContent>
                </Tooltip>
              )
            ) : null}
            {!isNew ? (
              <Button
                type="button"
                variant="destructive-ghost"
                disabled={!deletable.ok || deleting}
                aria-describedby={deletable.ok ? undefined : `${ids}-delete-why`}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 />
                Delete
              </Button>
            ) : null}
          </span>
        </div>
        {!isNew && !deletable.ok ? (
          <p id={`${ids}-delete-why`} data-slot="agent-delete-reason" className="mx-auto w-full max-w-180 px-4 pb-3 text-xs leading-5 text-ink-3 md:px-6">
            {deletable.reason}
          </p>
        ) : null}
      </div>

      {agent ? (
        <DeleteAgentDialog
          name={agentDisplayName(agent.name)}
          open={confirmDelete}
          busy={deleting}
          onOpenChange={setConfirmDelete}
          onConfirm={() => void remove()}
        />
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Product default instructions, read-only until customised
// ---------------------------------------------------------------------------

function EngineInstructions({ cwd, onCustomize }: { cwd: string | undefined; onCustomize(text: string): void }) {
  const engine = useEngineInstructions(cwd, cwd !== undefined);
  return (
    <div data-slot="engine-instructions" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Badge variant="outline">Using {PRODUCT_DISPLAY_NAME}'s default instructions</Badge>
        <Hint>Customize to make this prompt your own.</Hint>
      </div>
      {cwd === undefined ? (
        <Hint>Open a project to read {PRODUCT_DISPLAY_NAME}'s default instructions.</Hint>
      ) : engine.error !== undefined ? (
        <ErrorState title={`Couldn’t read ${PRODUCT_DISPLAY_NAME}'s default instructions`} detail={engine.error} onRetry={engine.reload} />
      ) : engine.data === undefined ? (
        <GenerationLoader label={`Loading ${PRODUCT_DISPLAY_NAME}'s default instructions`} layout="inline" />
      ) : (
        <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-xs leading-code whitespace-pre-wrap text-ink-2">{engine.data}</pre>
      )}
      <div>
        <Button type="button" variant="secondary" size="sm" disabled={engine.data === undefined} onClick={() => onCustomize(engine.data ?? "")}>
          Customize
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model and thinking
// ---------------------------------------------------------------------------

function ModelField({
  value,
  models,
  loading,
  error,
  onRetry,
  onChange,
}: {
  value: AgentDefinitionInput["model"];
  models: readonly ModelCatalogEntry[];
  loading: boolean;
  error: string | undefined;
  onRetry(): void;
  onChange(model: AgentDefinitionInput["model"]): void;
}) {
  const [choosing, setChoosing] = useState(value !== null);
  useEffect(() => {
    if (value !== null) setChoosing(true);
  }, [value]);
  const id = useId();
  const picked = value ? modelChoiceId(value) : undefined;
  return (
    <div className="flex flex-col gap-2">
      <SettingsToggleRow
        id={id}
        label="Follow the default model"
        detail={choosing ? "Off: this agent always uses the model chosen below." : "On: this agent uses the model new sessions use."}
        checked={!choosing}
        onCheckedChange={(follow) => {
          setChoosing(!follow);
          if (follow) onChange(null);
        }}
      />
      {choosing ? (
        <div className="flex flex-col gap-1.5">
          <ProviderModelPicker
            models={models}
            {...(picked !== undefined ? { value: picked } : {})}
            loading={loading}
            {...(error !== undefined ? { error } : {})}
            placeholder="Choose a model"
            onValueChange={(next) => {
              const choice = parseModelChoice(next);
              if (choice) onChange(choice);
            }}
          />
          {error !== undefined ? (
            <ErrorState title="Couldn’t load the model list" detail={error} onRetry={onRetry} />
          ) : value === null ? (
            <Hint>No model chosen yet: the default applies until you pick one.</Hint>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ThinkingField({ value, levels, onChange }: { value: ThinkingLevel | null; levels: readonly ThinkingLevel[]; onChange(level: ThinkingLevel | null): void }) {
  const options: Array<{ id: string; level: ThinkingLevel | null; label: string }> = [
    { id: "default", level: null, label: "Follow the default" },
    ...levels.map((level) => ({ id: level, level, label: THINKING_LABEL[level] })),
  ];
  const current = options.findIndex((option) => option.level === value);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = options[(Math.max(current, 0) + delta + options.length) % options.length];
    if (!next) return;
    onChange(next.level);
    (event.currentTarget.querySelector<HTMLElement>(`[data-level="${next.id}"]`))?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Thinking level" className="flex flex-wrap gap-1" onKeyDown={move}>
      {options.map((option, i) => {
        const selected = i === (current === -1 ? 0 : current);
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
              selected ? "border-live bg-[color-mix(in_oklab,var(--live)_12%,transparent)] text-live" : "border-line text-ink-2 hover:bg-surface-2 hover:text-ink",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Allowed agents
// ---------------------------------------------------------------------------

function AllowedAgentsField({
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
  const toggle = (name: string, on: boolean) => onChange(on ? [...value.filter((n) => n !== name), name] : value.filter((n) => n !== name));
  return (
    <div role="group" aria-label="Agents it may start" data-slot="allowed-agents" className="flex flex-col gap-0.5">
      {unknown.map((name) => (
        <div key={name} data-slot="allowed-agent-missing" className="flex items-center gap-2 rounded-md bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] px-2 py-1.5">
          <span className="min-w-0 flex-1">
            <span className="typed text-ink">{name}</span>
            <span className="block text-xs text-ink-2">No agent has this name any more. Remove it, or create the agent again.</span>
          </span>
          <Button type="button" variant="ghost" size="xs" onClick={() => toggle(name, false)}>
            Remove
          </Button>
        </div>
      ))}
      {options.length === 0 ? (
        <Hint>No other agents to start yet. Create one and it appears here.</Hint>
      ) : (
        options.map((option) => (
          <CheckRow
            key={option.name}
            name={`allowed:${option.name}`}
            checked={value.includes(option.name)}
            flagged={flagged.has(option.name)}
            label={option.name === self ? `${agentDisplayName(option.name)} · Same agent` : agentDisplayName(option.name)}
            detail={option.name === self ? "Starts another instance with these same settings." : option.description || option.name}
            onChange={(event) => toggle(option.name, event.target.checked)}
          />
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

function SkillsField({
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
    value.forEach((skill, i) => {
      if (flaggedNames.has(skill.name) || flaggedIndices.has(i)) keys.add(skillKey(skill));
    });
    return keys;
  }, [value, flaggedNames, flaggedIndices]);
  const toggle = (skill: AgentSkillRef, on: boolean) =>
    onChange(on ? [...value.filter((s) => skillKey(s) !== skillKey(skill)), { name: skill.name, path: skill.path, scope: skill.scope }] : value.filter((s) => skillKey(s) !== skillKey(skill)));

  if (cwd === undefined) return <Hint>Open a project to see which skills it offers.</Hint>;
  if (listing.error !== undefined) return <ErrorState title="Couldn’t list the skills" detail={listing.error} onRetry={listing.reload} />;
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
                <span className="typed block truncate text-ink-3" title={skill.path}>
                  {skill.path}
                </span>
                <span className="block text-xs text-attention">Not found any more. Choose it again or remove it.</span>
              </span>
              <Button type="button" variant="ghost" size="xs" onClick={() => toggle(skill, false)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {groups.length === 0 ? (
        <Hint>No skills found in this project or globally. Add a skill folder and it appears here.</Hint>
      ) : (
        groups.map((group) => (
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
        ))
      )}
      {listing.data.roots.every((root) => !root.exists) ? <Hint>None of the skill folders exist yet.</Hint> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------
