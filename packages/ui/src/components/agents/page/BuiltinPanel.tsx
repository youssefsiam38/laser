"use client";
/**
 * The three shipped agents. Their identity and product integrations stay
 * built in; their system instructions and the profile they run on belong to
 * the person (M22-T9, `docs/model-profiles.md` "Assignments").
 */
import { AGENT_INSTRUCTIONS_MAX, instructionTemplateIssue, type AgentDefinition, type AgentsSnapshot, type BuiltinAgentName, type ModelProfile } from "@lasercode/protocol";
import { RotateCw, Save, Undo2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { agentDisplayName, useAgentsActions } from "@/agents";
import { AgentCard, type AgentCardFact } from "@/components/assistant-ui/elements/agent-card";
import { useModelProfiles } from "@/components/assistant-ui/elements/model-profiles";
import { Button } from "@/components/ui/button";
import { useCommittedTargetLifetime } from "@/components/settings/useCommittedTargetLifetime";

import { AgentMarkIcon } from "./AgentList.js";
import { BuiltinProfileDialog } from "./dialogs.js";
import { Hint, IssueNotice, Section } from "./fields.js";
import { InstructionTemplateEditor } from "./InstructionTemplateEditor.js";
import { builtinBlurb } from "./model.js";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface BuiltinPanelProps {
  name: BuiltinAgentName;
  snapshot: AgentsSnapshot;
  /** Explicit project backing the Settings target; absent for Global. */
  routeCwd: string | undefined;
  writable?: boolean;
}

export function BuiltinPanel({ name, snapshot, routeCwd, writable = true }: BuiltinPanelProps) {
  const definition = snapshot.agents.find((agent) => agent.name === name);
  if (!writable) return (
    <div className="mx-auto flex w-full max-w-180 flex-col gap-4 px-4 py-5 md:px-6">
      <AgentCard name={agentDisplayName(name)} eyebrow="Built in" icon={<AgentMarkIcon mark={name} />} description={definition?.description ?? "Built-in agent"} facts={[]} />
      {definition?.instructions ? <p className="whitespace-pre-wrap text-sm leading-6 text-ink-2">{definition.instructions}</p> : null}
      <Hint>Built-in agents cannot be deleted; their system instructions and the profile they run on are yours to choose.</Hint>
    </div>
  );
  return (
    <div aria-readonly={!writable || undefined} inert={!writable || undefined} className={`mx-auto flex w-full max-w-180 flex-col gap-4 px-4 py-5 md:px-6 ${writable ? "" : "[&_button]:hidden"}`}>
      {name === "beam" ? (
        <BeamCard snapshot={snapshot} routeCwd={routeCwd} />
      ) : name === "namer" ? (
        <NamerCard snapshot={snapshot} routeCwd={routeCwd} />
      ) : (
        <ChatCard snapshot={snapshot} routeCwd={routeCwd} />
      )}
      {definition ? (
        <BuiltinInstructionsEditor
          name={name}
          definition={definition}
          customized={snapshot.builtinInstructions[name] !== null}
        />
      ) : null}
      <Hint>Built-in agents cannot be deleted; their system instructions and model are yours to choose.</Hint>
    </div>
  );
}

function BuiltinInstructionsEditor({ name, definition, customized }: { name: BuiltinAgentName; definition: AgentDefinition; customized: boolean }) {
  const agents = useAgentsActions();
  const current = definition.instructions;
  const [draft, setDraft] = useState(current);
  const [busy, setBusy] = useState<"save" | "restore">();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setDraft(current);
    setError(undefined);
  }, [current, name]);
  const dirty = draft !== current;
  const invalid = draft.trim().length === 0;
  const templateIssue = instructionTemplateIssue(draft, name);

  const save = async () => {
    setBusy("save");
    setError(undefined);
    try {
      await agents.setBuiltinInstructions(name, draft);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(undefined);
    }
  };

  const restore = async () => {
    setBusy("restore");
    setError(undefined);
    try {
      await agents.setBuiltinInstructions(name, null);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Section
      id="instructions"
      title="System instructions"
      description={
        name === "namer"
          ? "How Namer approaches session titles. The short output format stays enforced for each request."
          : `How ${agentDisplayName(name)} answers and works. New conversations use the saved instructions.`
      }
      notices={<IssueNotice messages={error ? [error] : invalid ? ["Write instructions, or restore the built-in instructions."] : templateIssue ? [templateIssue] : []} />}
    >
      <InstructionTemplateEditor
        target={name}
        context={{
          agentName: name === "namer" ? agentDisplayName(name) : name,
          agentDescription: definition.description,
          profileName: null,
          thinkingLevel: definition.thinkingLevel,
          provenance: "Current agent setting",
        }}
        ariaLabel={`${agentDisplayName(name)} system instructions`}
        invalid={Boolean(invalid || error || templateIssue)}
        value={draft}
        maxLength={AGENT_INSTRUCTIONS_MAX}
        onChange={(instructions) => {
          setDraft(instructions);
          setError(undefined);
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Hint className="typed tnum">
          {draft.length}/{AGENT_INSTRUCTIONS_MAX}
        </Hint>
        <div className="flex flex-wrap justify-end gap-2">
          {customized ? (
            <Button type="button" variant="ghost" size="sm" disabled={busy !== undefined} onClick={() => void restore()}>
              {busy === "restore" ? <RotateCw className="motion-safe:animate-busy" /> : <Undo2 />}
              {busy === "restore" ? "Restoring…" : "Restore built-in instructions"}
            </Button>
          ) : null}
          <Button type="button" size="sm" disabled={!dirty || invalid || Boolean(templateIssue) || busy !== undefined} aria-busy={busy === "save" || undefined} onClick={() => void save()}>
            {busy === "save" ? <RotateCw className="motion-safe:animate-busy" /> : <Save />}
            {busy === "save" ? "Saving…" : "Save instructions"}
          </Button>
        </div>
      </div>
    </Section>
  );
}

/**
 * The shared "which profile does this built-in run on?" control. One dialog,
 * one button, one wording rule for all three, so the choice is the same choice
 * wherever it is made (M22-T9).
 */
function useBuiltinProfile(name: BuiltinAgentName): {
  open: boolean;
  busy: boolean;
  /** Open the dialog from the card's button. */
  show: () => void;
  /** The dialog's own open/close, refused while a save is in flight. */
  onOpenChange: (open: boolean) => void;
  pick: (profileId: string) => void;
  clear: () => void;
} {
  const agents = useAgentsActions();
  const lifetime = useCommittedTargetLifetime(`builtin-profile:${name}`);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // The save settles either way: a failure toasts where the person can read
  // it, and the dialog closes so the card — which only moves on success —
  // shows what actually happened.
  const apply = useCallback(
    (profileId: string | null) => {
      const lease = lifetime.capture();
      if (!lease) return;
      setBusy(true);
      void agents
        .setBuiltinProfile(name, profileId)
        .then(() => {
          if (lifetime.isCurrent(lease)) setOpen(false);
        })
        .finally(() => {
          if (lifetime.isCurrent(lease)) setBusy(false);
        });
    },
    [agents, lifetime, name],
  );
  return {
    open,
    busy,
    show: () => setOpen(true),
    onOpenChange: (next) => {
      if (!busy) setOpen(next);
    },
    pick: (profileId) => apply(profileId),
    clear: () => apply(null),
  };
}

/** The button every built-in card carries, worded by whether a profile is chosen. */
function ChangeProfileButton({ profileId, routeCwd, onOpen }: { profileId: string | null; routeCwd: string | undefined; onOpen(): void }) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={!routeCwd}
      title={routeCwd ? undefined : "Choose a project scope to load your profiles"}
      onClick={onOpen}
    >
      {profileId ? "Change profile" : "Choose a profile"}
    </Button>
  );
}

/** The profile fact, with the resting state said plainly rather than apologetically. */
function profileFact(profileId: string | null, profiles: readonly ModelProfile[]): AgentCardFact {
  if (profileId === null) {
    return { label: "profile", value: "Follows the profile new conversations use" };
  }
  const known = profiles.find((profile) => profile.id === profileId);
  return known
    ? { label: "profile", value: known.name, typed: true }
    : { label: "profile", value: "A profile that is not there", tone: "attention" };
}

/** One card per built-in: the same profile choice, three different subjects. */
function BuiltinProfileCard({
  name,
  snapshot,
  routeCwd,
  extraFacts = [],
}: {
  name: BuiltinAgentName;
  snapshot: AgentsSnapshot;
  routeCwd: string | undefined;
  extraFacts?: AgentCardFact[];
}) {
  const control = useBuiltinProfile(name);
  const { profiles, loading, error } = useModelProfiles(routeCwd);
  const profileId = snapshot.builtinProfiles[name];
  return (
    <>
      <AgentCard
        data-agent={name}
        name={agentDisplayName(name)}
        eyebrow="Built in"
        icon={<AgentMarkIcon mark={name} />}
        description={builtinBlurb(name)}
        facts={[profileFact(profileId, profiles), ...extraFacts]}
        actions={<ChangeProfileButton profileId={profileId} routeCwd={routeCwd} onOpen={control.show} />}
      />
      <BuiltinProfileDialog
        name={name}
        open={control.open}
        profiles={profiles}
        loading={loading}
        error={error}
        current={profileId}
        busy={control.busy}
        onOpenChange={control.onOpenChange}
        onPick={control.pick}
        onClear={control.clear}
      />
    </>
  );
}

function BeamCard({ snapshot, routeCwd }: { snapshot: AgentsSnapshot; routeCwd: string | undefined }) {
  return <BuiltinProfileCard name="beam" snapshot={snapshot} routeCwd={routeCwd} />;
}

function ChatCard({ snapshot, routeCwd }: { snapshot: AgentsSnapshot; routeCwd: string | undefined }) {
  return (
    <BuiltinProfileCard
      name="chat"
      snapshot={snapshot}
      routeCwd={routeCwd}
      extraFacts={[{ label: "where", value: "The Chat tab of the sessions list" }]}
    />
  );
}

function NamerCard({ snapshot, routeCwd }: { snapshot: AgentsSnapshot; routeCwd: string | undefined }) {
  return (
    <BuiltinProfileCard
      name="namer"
      snapshot={snapshot}
      routeCwd={routeCwd}
      extraFacts={[{ label: "when", value: "Once per conversation, on its first message" }]}
    />
  );
}
