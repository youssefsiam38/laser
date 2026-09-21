"use client";
/**
 * Top-level agent choice for an unstarted project session (M13-T86).
 *
 * assistant-ui has no separate agent picker. This deliberately composes the
 * adopted props-driven `model-picker` element: both controls are searchable
 * single-choice catalogues, so they share its combobox, listbox, focus and
 * empty/error behavior rather than growing a second hand-rolled picker.
 *
 * A Chat conversation runs no definition at all (`docs/plain-chat.md`), so
 * this control is offered to project sessions only. Once the first prompt
 * exists the whole control unmounts; changing a started session's identity is
 * not an operation the app exposes.
 */
import { Bot } from "lucide-react";
import { useMemo } from "react";

import { agentDisplayName, customAgentsForProject, useAgentsSnapshot, useAgentsStatus } from "@/agents";
import { cn } from "@/lib/utils";
import { isUnstartedSession, useLaserStable, useLaserState } from "@/runtime";
import { useSessionPreparation } from "@/components/thread/session-preparation";
import { workspaceKindOf } from "@/components/shell/session-groups";

import { ErrorState } from "./error-state.js";
import { GenerationLoader } from "./loading-state.js";
import {
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorRoot,
  ModelSelectorSearch,
  ModelSelectorTrigger,
  ModelSelectorValue,
  type ModelOption,
} from "./model-selector.js";

export function SessionAgentSelector({ className, allowProjectLanding = true }: { className?: string | undefined; allowProjectLanding?: boolean | undefined }) {
  const { actions, currentProject } = useLaserStable();
  // The session's own state and one answer derived from it ("is this session
  // still unstarted?"), rather than the whole view: a streamed token changes
  // neither, and this control sits in the composer (M16-T32).
  const session = useLaserState(s => (s.current ? s.open[s.current]?.state : undefined));
  const unstarted = useLaserState(s => {
    const view = s.current ? s.open[s.current] : undefined;
    return view ? isUnstartedSession(view) : undefined;
  });
  const snapshot = useAgentsSnapshot();
  const status = useAgentsStatus();
  const { firstTurn, chooseAgent, pending: preparingSession } = useSessionPreparation();

  const agentKind = session?.agent?.kind ?? workspaceKindOf(session?.cwd, snapshot?.workspaces ?? {});
  const canChoose = session
    ? (agentKind === "root" || (agentKind == null && snapshot !== null)) && unstarted === true
    : allowProjectLanding && currentProject !== undefined;
  const cwd = session?.cwd ?? currentProject;
  const selected = firstTurn?.agentName ?? session?.agent?.agentName ?? snapshot?.defaultAgent;

  const options = useMemo<ModelOption[]>(
    // Only what this project's sessions can run: globals plus the project's
    // own agents, a project agent standing in for a global one of the same name.
    () => customAgentsForProject(snapshot, cwd).map((agent) => ({
      id: agent.name,
      name: agentDisplayName(agent.name),
      description: agent.scope === "project" ? `Project · ${agent.description}` : agent.description,
      icon: <Bot aria-hidden="true" />,
      keywords: [agent.name, agent.description],
    })),
    [snapshot, cwd],
  );

  if (!canChoose || !cwd) return null;

  const pick = (agentName: string) => {
    if (agentName === selected || preparingSession) return;
    chooseAgent(agentName);
  };

  return (
    <ModelSelectorRoot models={options} {...(selected ? { value: selected } : {})} onValueChange={pick}>
      <ModelSelectorTrigger
        variant="ghost"
        size="sm"
        disabled={preparingSession || status.loading || snapshot === null}
        aria-label={`Agent: ${options.find((option) => option.id === selected)?.name ?? selected ?? "loading"}`}
        title="Choose the agent for this new session"
        className={cn("min-w-0 max-w-48 shrink gap-1.5 text-ink-2", className)}
      >
        <ModelSelectorValue placeholder="Agent" className="min-w-0" />
      </ModelSelectorTrigger>
      <ModelSelectorContent side="top" align="start" searchable>
        <ModelSelectorSearch aria-label="Search agents" placeholder="Search agents" />
        <ModelSelectorList>
          {status.error ? (
            <ErrorState className="m-2" title="Couldn’t load agents" detail={status.error} onRetry={() => void actions.agents.refresh()} />
          ) : status.loading || snapshot === null ? (
            <div className="px-3 py-3"><GenerationLoader label="Loading agents" layout="inline" /></div>
          ) : (
            <>
              <ModelSelectorEmpty>No agent matches.</ModelSelectorEmpty>
              <ModelSelectorGroup heading="Agents">
                {options.map((option) => <ModelSelectorItem key={option.id} model={option} />)}
              </ModelSelectorGroup>
            </>
          )}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelectorRoot>
  );
}
