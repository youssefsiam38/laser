"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import type { ModelRef, ThinkingLevel } from "@lasercode/protocol";
import { useLaserState, useLaserView } from "../../runtime/LaserProvider.js";
import { firstTurnFromRunConfig, mergeRunConfigCustom, withFirstTurn, type TentativeFirstTurn } from "../../runtime/first-turn.js";

interface SessionPreparationValue {
  pending: boolean;
  /** Returns the matching release function; callers must invoke it once. */
  begin(): () => void;
  /** The choice owned by this assistant-ui composer runtime. */
  firstTurn: TentativeFirstTurn | undefined;
  chooseAgent(agentName: string): void;
  chooseModel(model: ModelRef): void;
  chooseThinking(thinkingLevel: ThinkingLevel): void;
}

const SessionPreparationContext = createContext<SessionPreparationValue>({
  pending: false,
  begin: () => () => {},
  firstTurn: undefined,
  chooseAgent: () => {},
  chooseModel: () => {},
  chooseThinking: () => {},
});

/**
 * Serializes persistent model preparation and owns tentative first-turn choices.
 *
 * The choice lives on this composer's `runConfig.custom.firstTurn` and nowhere
 * else (FB-01, D-185). It ends in one of two places: here, once canonical
 * history starts (the worker took the first prompt); or at the leave boundary,
 * `useDiscardFirstTurnOnLeave` in the per-thread runtime hook, when the person
 * moves to another session. A refused first prompt is neither — the choice, the
 * text and the attachments all stay so the send can be corrected and retried.
 */
export function SessionPreparationProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  const aui = useAui();
  const view = useLaserView();
  const defaultAgent = useLaserState((state) => state.agents.snapshot?.defaultAgent);
  const runConfig = useAuiState((state) => state.composer.runConfig);
  const firstTurn = firstTurnFromRunConfig(runConfig);
  const persistedAgent = view?.state.agent?.agentName ?? defaultAgent;

  const begin = useCallback(() => {
    let released = false;
    setCount((value) => value + 1);
    return () => {
      if (released) return;
      released = true;
      setCount((value) => Math.max(0, value - 1));
    };
  }, []);

  const commit = useCallback((value: TentativeFirstTurn) => {
    aui.composer.setRunConfig(withFirstTurn(aui.composer.getState().runConfig, value));
  }, [aui]);

  const chooseAgent = useCallback((agentName: string) => {
    // Agent selection is the newest model intent. Null means follow this
    // definition (and the project default when its model is null), never a
    // stale explicit model from the pristine session.
    commit({ agentName, model: null, ...(firstTurn?.thinkingLevel ? { thinkingLevel: firstTurn.thinkingLevel } : {}) });
  }, [commit, firstTurn]);

  const chooseModel = useCallback((model: ModelRef) => {
    const agentName = firstTurn?.agentName ?? persistedAgent;
    if (!agentName) return;
    commit({ agentName, model, ...(firstTurn?.thinkingLevel ? { thinkingLevel: firstTurn.thinkingLevel } : {}) });
  }, [commit, firstTurn, persistedAgent]);

  const chooseThinking = useCallback((thinkingLevel: ThinkingLevel) => {
    const agentName = firstTurn?.agentName ?? persistedAgent;
    if (!agentName) return;
    const next = { agentName, thinkingLevel };
    // Presence matters: null is the explicit "follow agent" intent. A thinking
    // change must not turn it back into the absent legacy behavior.
    if (firstTurn && Object.hasOwn(firstTurn, "model")) {
      commit(firstTurn.model === null
        ? { ...next, model: null }
        : { ...next, model: firstTurn.model! });
      return;
    }
    commit(next);
  }, [commit, firstTurn, persistedAgent]);

  useEffect(() => {
    if (!view || !firstTurn) return;
    // Optimistic bubbles appear before the worker answers. Clear only from
    // canonical persisted history so a refused first-turn send remains retryable.
    const started = view.state.messageCount > 0 || view.entries.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const item = entry as { type?: unknown };
      return item.type === "message" || item.type === "custom_message";
    });
    if (!started) return;
    const current = aui.composer.getState().runConfig;
    aui.composer.setRunConfig(mergeRunConfigCustom(current, { firstTurn: undefined }));
  }, [aui, firstTurn, view]);

  const value = useMemo(() => ({
    pending: count > 0,
    begin,
    firstTurn,
    chooseAgent,
    chooseModel,
    chooseThinking,
  }), [begin, chooseAgent, chooseModel, chooseThinking, count, firstTurn]);
  return <SessionPreparationContext.Provider value={value}>{children}</SessionPreparationContext.Provider>;
}

export function useSessionPreparation(): SessionPreparationValue {
  return useContext(SessionPreparationContext);
}
