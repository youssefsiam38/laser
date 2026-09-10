"use client";
/**
 * Top-level agent choice for an unstarted project session (M13-T86).
 *
 * assistant-ui has no separate agent picker. This deliberately composes the
 * adopted props-driven `model-picker` element: both controls are searchable
 * single-choice catalogues, so they share its combobox, listbox, focus and
 * empty/error behavior rather than growing a second hand-rolled picker.
 *
 * Built-in agents never enter the options. Beam and Chat keep their dedicated
 * channels, and Namer is not a session agent. Once the first prompt exists the
 * whole control unmounts; changing a started session's identity is not an
 * operation the app exposes.
 */
import { useAui } from "@assistant-ui/react";
import { Bot } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { agentDisplayName, isBuiltinAgent, useAgentsSnapshot, useAgentsStatus } from "@/agents";
import { cn } from "@/lib/utils";
import { isUnstartedSession, useLaserStable, useLaserView } from "@/runtime";
import { useSessionPreparation } from "@/components/thread/session-preparation";
import { workspaceKindOf } from "@/components/shell/session-groups";

import { readDraft, writeDraft } from "./draft-restore.js";
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
  const view = useLaserView();
  const snapshot = useAgentsSnapshot();
  const status = useAgentsStatus();
  const aui = useAui();
  const { begin, pending: preparingSession } = useSessionPreparation();
  const pendingFinish = useRef<(() => void) | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [draftTransfer, setDraftTransfer] = useState<{
    from: string | undefined;
    target: string;
    text: string;
    clearSource(): void;
    finishPreparation(): void;
  }>();

  useEffect(() => () => pendingFinish.current?.(), []);
  const beginPreparation = () => {
    const release = begin();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      release();
      if (pendingFinish.current === finish) pendingFinish.current = undefined;
    };
    pendingFinish.current = finish;
    return finish;
  };

  const sessionKind = view?.state.agent?.kind ?? workspaceKindOf(view?.state.cwd, snapshot?.workspaces ?? {});
  const canChoose = view
    ? (sessionKind === "root" || (sessionKind == null && snapshot !== null)) && isUnstartedSession(view)
    : allowProjectLanding && currentProject !== undefined;
  const cwd = view?.state.cwd ?? currentProject;
  const selected = view?.state.agent?.agentName ?? snapshot?.defaultAgent;

  const options = useMemo<ModelOption[]>(
    () => (snapshot?.agents ?? [])
      .filter((agent) => !isBuiltinAgent(agent))
      .map((agent) => ({
        id: agent.name,
        name: agentDisplayName(agent.name),
        description: agent.description,
        icon: <Bot aria-hidden="true" />,
        keywords: [agent.name, agent.description],
      })),
    [snapshot],
  );

  // Choosing another agent changes the empty session identity. Move ordinary
  // text into the selected session after that identity switch has committed;
  // if an existing target draft is present, preserve both. Attachments remain
  // bound to the source composer, so refuse rather than silently strand them.
  useEffect(() => {
    if (!draftTransfer) return;
    if (view?.path !== draftTransfer.target) {
      if (!draftTransfer.from) {
        const saved = readDraft(draftTransfer.target)?.text;
        writeDraft(draftTransfer.target, saved && saved !== draftTransfer.text ? `${draftTransfer.text}\n\n${saved}` : draftTransfer.text);
      }
      draftTransfer.finishPreparation();
      setDraftTransfer(undefined);
      return;
    }
    const current = aui.composer.getState().text;
    if (!current) aui.composer.setText(draftTransfer.text);
    else if (current !== draftTransfer.text) aui.composer.setText(`${draftTransfer.text}\n\n${current}`);
    draftTransfer.clearSource();
    if (draftTransfer.from) writeDraft(draftTransfer.from, undefined);
    draftTransfer.finishPreparation();
    setDraftTransfer(undefined);
  }, [aui, draftTransfer, selected, view]);

  if (!canChoose || !cwd) return null;

  const pick = (agentName: string) => {
    if (agentName === selected || saving || preparingSession) return;
    const composer = aui.composer.getState();
    if (composer.attachments.length > 0) {
      actions.toast("warning", "Remove attachments before changing the agent. Your draft is unchanged.");
      return;
    }
    const finishPreparation = beginPreparation();
    const runtime = aui.threads.__internal_getAssistantRuntime?.();
    if (!runtime) { finishPreparation(); return; }
    const source = runtime.threads.getById(runtime.threads.getState().mainThreadId).composer;
    const from = view?.path;
    setSaving(true);
    void actions.newSession(cwd, { agentName }).then((target) => {
      if (composer.text) {
        setDraftTransfer({
          from, target, text: composer.text, finishPreparation,
          clearSource: () => {
            if (source.getState().text === composer.text) source.setText("");
          },
        });
      } else finishPreparation();
    }).catch((error: unknown) => {
      setDraftTransfer(undefined);
      finishPreparation();
      actions.toast("error", error instanceof Error ? error.message : String(error));
    }).finally(() => setSaving(false));
  };

  return (
    <ModelSelectorRoot models={options} {...(selected ? { value: selected } : {})} onValueChange={pick}>
      <ModelSelectorTrigger
        variant="ghost"
        size="sm"
        disabled={saving || preparingSession || status.loading || snapshot === null}
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
