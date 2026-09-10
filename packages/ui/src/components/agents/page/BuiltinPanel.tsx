"use client";
/**
 * The three shipped agents. Their identity and product integrations stay
 * built in; their system instructions and model belong to the person. Namer's
 * card also shows the state of its qualification and the candidates it tried.
 */
import { AGENT_INSTRUCTIONS_MAX, instructionTemplateIssue, type AgentModelChoice, type AgentsSnapshot, type BuiltinAgentName, type NamerCandidate, type NamerState } from "@lasercode/protocol";
import { Check, RotateCw, Save, Undo2, X, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { agentDisplayName, useAgentsActions } from "@/agents";
import { AgentCard, type AgentCardFact } from "@/components/assistant-ui/elements/agent-card";
import { DataTable, type DataTableColumn } from "@/components/assistant-ui/elements/data-table";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { ProviderLogo } from "@/components/assistant-ui/elements/logos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { AgentMarkIcon } from "./AgentList.js";
import { BuiltinModelDialog } from "./dialogs.js";
import { Hint, IssueNotice, Section } from "./fields.js";
import { InstructionTemplateEditor } from "./InstructionTemplateEditor.js";
import { builtinBlurb, formatLatency, modelChoiceId, namerSummary } from "./model.js";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface BuiltinPanelProps {
  name: BuiltinAgentName;
  snapshot: AgentsSnapshot;
  /** Where host work is routed: the project, or the Beam workspace when none is open. */
  routeCwd: string | undefined;
}

export function BuiltinPanel({ name, snapshot, routeCwd }: BuiltinPanelProps) {
  const definition = snapshot.agents.find((agent) => agent.name === name);
  return (
    <div className="mx-auto flex w-full max-w-180 flex-col gap-4 px-4 py-5 md:px-6">
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
          current={definition.instructions}
          customized={snapshot.builtinInstructions[name] !== null}
        />
      ) : null}
      <Hint>Built-in agents cannot be deleted; their system instructions and model are yours to choose.</Hint>
    </div>
  );
}

function BuiltinInstructionsEditor({ name, current, customized }: { name: BuiltinAgentName; current: string; customized: boolean }) {
  const agents = useAgentsActions();
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
          ? "How Namer approaches titles and activity labels. The short output format stays enforced for each request."
          : `How ${agentDisplayName(name)} answers and works. New conversations use the saved instructions.`
      }
      notices={<IssueNotice messages={error ? [error] : invalid ? ["Write instructions, or restore the built-in instructions."] : templateIssue ? [templateIssue] : []} />}
    >
      <InstructionTemplateEditor
        target={name}
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
 * The shared "which model does this built-in run on?" control. One dialog, one
 * button, one wording rule for all three, so the choice is the same choice
 * wherever it is made.
 */
function useBuiltinModel(name: BuiltinAgentName): {
  open: boolean;
  busy: boolean;
  /** Open the dialog from the card's button. */
  show: () => void;
  /** The dialog's own open/close, refused while a save is in flight. */
  onOpenChange: (open: boolean) => void;
  pick: (choice: AgentModelChoice) => void;
  clear: () => void;
} {
  const agents = useAgentsActions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // The save settles either way: a failure toasts where the person can read
  // it, and the dialog closes so the card — which only moves on success —
  // shows what actually happened.
  const apply = useCallback(
    (model: AgentModelChoice | null) => {
      setBusy(true);
      void agents
        .setBuiltinModel(name, model)
        .then(() => setOpen(false))
        .finally(() => setBusy(false));
    },
    [agents, name],
  );
  return {
    open,
    busy,
    show: () => setOpen(true),
    onOpenChange: (next) => {
      if (!busy) setOpen(next);
    },
    pick: (choice) => apply(choice),
    clear: () => apply(null),
  };
}

/** The button every built-in card carries, worded by whether a model is chosen. */
function ChangeModelButton({ model, onOpen }: { model: AgentModelChoice | null; onOpen(): void }) {
  return (
    <Button type="button" variant="secondary" size="sm" onClick={onOpen}>
      {model ? "Change model" : "Choose a model"}
    </Button>
  );
}

/** The model fact, with the resting state said plainly rather than apologetically. */
function modelFact(model: AgentModelChoice | null, resting: string, tone?: AgentCardFact["tone"]): AgentCardFact {
  return model ? { label: "model", value: modelChoiceId(model), typed: true } : { label: "model", value: resting, ...(tone ? { tone } : {}) };
}

function BeamCard({ snapshot, routeCwd }: { snapshot: AgentsSnapshot; routeCwd: string | undefined }) {
  const control = useBuiltinModel("beam");
  const model = snapshot.beam.model;
  const resting = snapshot.beam.suggested ? `Not chosen yet · suggested ${modelChoiceId(snapshot.beam.suggested)}` : "Not chosen yet";
  return (
    <>
      <AgentCard
        data-agent="beam"
        name={agentDisplayName("beam")}
        eyebrow="Built in"
        icon={<AgentMarkIcon mark="beam" />}
        description={builtinBlurb("beam")}
        facts={[modelFact(model, resting, "attention")]}
        actions={<ChangeModelButton model={model} onOpen={control.show} />}
      />
      <BuiltinModelDialog
        name="beam"
        open={control.open}
        cwd={routeCwd ?? snapshot.workspaces.beam}
        current={model}
        busy={control.busy}
        onOpenChange={control.onOpenChange}
        onPick={control.pick}
        onClear={control.clear}
      />
    </>
  );
}

function ChatCard({ snapshot, routeCwd }: { snapshot: AgentsSnapshot; routeCwd: string | undefined }) {
  const control = useBuiltinModel("chat");
  const model = snapshot.chat?.model ?? null;
  return (
    <>
      <AgentCard
        data-agent="chat"
        name={agentDisplayName("chat")}
        eyebrow="Built in"
        icon={<AgentMarkIcon mark="chat" />}
        description={builtinBlurb("chat")}
        facts={[modelFact(model, "Follows the default model"), { label: "where", value: "The Chat tab of the sessions list" }]}
        actions={<ChangeModelButton model={model} onOpen={control.show} />}
      />
      <BuiltinModelDialog
        name="chat"
        open={control.open}
        cwd={routeCwd ?? snapshot.workspaces.chat}
        current={model}
        busy={control.busy}
        onOpenChange={control.onOpenChange}
        onPick={control.pick}
        onClear={control.clear}
      />
    </>
  );
}

const CANDIDATE_COLUMNS: readonly DataTableColumn<NamerCandidate>[] = [
  {
    key: "model",
    label: "Model",
    mono: true,
    render: (row) => (
      <span className="flex min-w-0 items-center gap-1.5">
        <ProviderLogo provider={row.model.provider} className="size-3.5 shrink-0" />
        <span className="truncate" title={modelChoiceId(row.model)}>
          {modelChoiceId(row.model)}
        </span>
      </span>
    ),
  },
  { key: "latency", label: "Latency", align: "end", mono: true, width: "6rem", render: (row) => formatLatency(row.latencyMs) },
  {
    key: "valid",
    label: "Valid",
    width: "5rem",
    render: (row) =>
      row.valid ? (
        <span className="flex items-center gap-1 text-ok">
          <Check aria-hidden="true" className="size-3.5" />
          Yes
        </span>
      ) : (
        <span className="flex items-center gap-1 text-ink-3" title={row.error}>
          <X aria-hidden="true" className="size-3.5" />
          No
        </span>
      ),
  },
];

function NamerCard({ snapshot, routeCwd }: { snapshot: AgentsSnapshot; routeCwd: string | undefined }) {
  const agents = useAgentsActions();
  const control = useBuiltinModel("namer");
  // The snapshot is the truth; a run in flight is held here so the card can
  // say "Qualifying…" the instant the button is pressed and show the result
  // before the broadcast lands.
  const [local, setLocal] = useState<NamerState>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => setLocal(undefined), [snapshot.revision]);
  const state: NamerState = running ? { ...(local ?? snapshot.namer), status: "qualifying" } : (local ?? snapshot.namer);
  const summary = namerSummary(state);
  const cwd = routeCwd ?? snapshot.workspaces.beam;

  const qualify = async () => {
    setRunning(true);
    setError(undefined);
    try {
      setLocal(await agents.qualifyNamer(cwd));
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setRunning(false);
    }
  };

  const tone: AgentCardFact["tone"] = summary.status === "ready" ? "ok" : summary.status === "unavailable" || summary.status === "unqualified" ? "attention" : undefined;
  return (
    <>
      <AgentCard
        data-agent="namer"
        data-namer-status={state.status}
        name={agentDisplayName("namer")}
        eyebrow="Built in"
        icon={<AgentMarkIcon mark="namer" />}
        description={builtinBlurb("namer")}
        badges={
          state.status === "qualifying" ? (
            <Badge variant="live">
              <RotateCw className="motion-safe:animate-busy" />
              Qualifying
            </Badge>
          ) : null
        }
        facts={[
          { label: "model", value: summary.title, typed: summary.status === "ready", tone, title: summary.detail },
          ...(summary.detail ? [{ label: "detail", value: summary.detail }] : []),
          ...(state.qualifiedAt ? [{ label: "checked", value: new Date(state.qualifiedAt).toLocaleString(), typed: true }] : []),
        ]}
        actions={
          <>
            <ChangeModelButton model={state.model} onOpen={control.show} />
            <Button type="button" variant="ghost" size="sm" disabled={running} aria-busy={running || undefined} onClick={() => void qualify()}>
              {running ? <RotateCw className="motion-safe:animate-busy" /> : <Zap />}
              {running ? "Qualifying…" : state.status === "unqualified" ? "Run qualification" : "Run qualification again"}
            </Button>
          </>
        }
      >
        {error !== undefined ? <ErrorState title="Couldn’t qualify a model" detail={error} onRetry={() => void qualify()} /> : null}
        {state.candidates.length > 0 ? (
          <DataTable
            caption="Models tried for Namer"
            columns={CANDIDATE_COLUMNS}
            rows={state.candidates}
            rowKey={(row) => modelChoiceId(row.model)}
            rowClassName={(row) => (state.model && row.model.provider === state.model.provider && row.model.id === state.model.id ? "bg-[color-mix(in_oklab,var(--ok)_8%,transparent)]" : undefined)}
          />
        ) : null}
      </AgentCard>
      <BuiltinModelDialog
        name="namer"
        open={control.open}
        cwd={cwd}
        current={state.model}
        busy={control.busy}
        onOpenChange={control.onOpenChange}
        onPick={control.pick}
        onClear={control.clear}
      />
    </>
  );
}
