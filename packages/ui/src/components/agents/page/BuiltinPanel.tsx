"use client";
/**
 * The three shipped agents, read-only. Each card says what the agent does;
 * Beam's shows its model with a way to change it, Namer's shows the state of
 * its qualification and the candidates it tried.
 */
import type { AgentModelChoice, AgentsSnapshot, BuiltinAgentName, NamerCandidate, NamerState } from "@lasercode/protocol";
import { Check, RotateCw, X, Zap } from "lucide-react";
import { useEffect, useState } from "react";

import { agentDisplayName, useAgentsActions } from "@/agents";
import { AgentCard, type AgentCardFact } from "@/components/assistant-ui/elements/agent-card";
import { DataTable, type DataTableColumn } from "@/components/assistant-ui/elements/data-table";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { ProviderLogo } from "@/components/assistant-ui/elements/logos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { AgentMarkIcon } from "./AgentList.js";
import { BeamModelDialog } from "./dialogs.js";
import { Hint } from "./fields.js";
import { builtinBlurb, formatLatency, modelChoiceId, namerSummary } from "./model.js";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface BuiltinPanelProps {
  name: BuiltinAgentName;
  snapshot: AgentsSnapshot;
  /** Where host work is routed: the project, or the Beam workspace when none is open. */
  routeCwd: string | undefined;
}

export function BuiltinPanel({ name, snapshot, routeCwd }: BuiltinPanelProps) {
  return (
    <div className="mx-auto flex w-full max-w-180 flex-col gap-4 px-4 py-5 md:px-6">
      {name === "beam" ? <BeamCard snapshot={snapshot} routeCwd={routeCwd} /> : name === "namer" ? <NamerCard snapshot={snapshot} routeCwd={routeCwd} /> : <ChatCard />}
      <Hint>Built-in agents cannot be edited or deleted; each is part of the app.</Hint>
    </div>
  );
}

function BeamCard({ snapshot, routeCwd }: { snapshot: AgentsSnapshot; routeCwd: string | undefined }) {
  const agents = useAgentsActions();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const model = snapshot.beam.model;
  const facts: AgentCardFact[] = [
    model
      ? { label: "model", value: modelChoiceId(model), typed: true }
      : { label: "model", value: snapshot.beam.suggested ? `Not chosen yet · suggested ${modelChoiceId(snapshot.beam.suggested)}` : "Not chosen yet", tone: "attention" },
  ];
  const pick = async (choice: AgentModelChoice) => {
    setBusy(true);
    try {
      await agents.setBeamModel(choice);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <AgentCard
        data-agent="beam"
        name={agentDisplayName("beam")}
        eyebrow="Built in"
        icon={<AgentMarkIcon mark="beam" />}
        description={builtinBlurb("beam")}
        facts={facts}
        actions={
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
            {model ? "Change model" : "Choose a model"}
          </Button>
        }
      />
      <BeamModelDialog open={open} cwd={routeCwd ?? snapshot.workspaces.beam} current={model} busy={busy} onOpenChange={setOpen} onPick={(choice) => void pick(choice)} />
    </>
  );
}

function ChatCard() {
  return (
    <AgentCard
      data-agent="chat"
      name={agentDisplayName("chat")}
      eyebrow="Built in"
      icon={<AgentMarkIcon mark="chat" />}
      description={builtinBlurb("chat")}
      facts={[{ label: "model", value: "Follows the default model" }, { label: "where", value: "The Chat tab of the sessions list" }]}
    />
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
          <Button type="button" variant="secondary" size="sm" disabled={running} aria-busy={running || undefined} onClick={() => void qualify()}>
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
  );
}
