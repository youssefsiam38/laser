"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import type { ThinkingLevel } from "@lasercode/protocol";
import { useLaserState, useLaserView } from "../../runtime/LaserProvider.js";
import { firstTurnFromRunConfig, mergeRunConfigCustom, withFirstTurn, type TentativeFirstTurn } from "../../runtime/first-turn.js";

interface SessionPreparationValue {
  pending: boolean;
  /** Returns the matching release function; callers must invoke it once. */
  begin(): () => void;
  /** The choice owned by this assistant-ui composer runtime. */
  firstTurn: TentativeFirstTurn | undefined;
  chooseAgent(agentName: string): void;
  chooseThinking(thinkingLevel: ThinkingLevel): void;
}

const SessionPreparationContext = createContext<SessionPreparationValue>({
  pending: false,
  begin: () => () => {},
  firstTurn: undefined,
  chooseAgent: () => {},
  chooseThinking: () => {},
});

/** Serializes persistent model preparation and owns tentative first-turn choices. */
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
    commit({ agentName, ...(firstTurn?.thinkingLevel ? { thinkingLevel: firstTurn.thinkingLevel } : {}) });
  }, [commit, firstTurn]);

  const chooseThinking = useCallback((thinkingLevel: ThinkingLevel) => {
    const agentName = firstTurn?.agentName ?? persistedAgent;
    if (!agentName) return;
    commit({ agentName, thinkingLevel });
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
    chooseThinking,
  }), [begin, chooseAgent, chooseThinking, count, firstTurn]);
  return <SessionPreparationContext.Provider value={value}>{children}</SessionPreparationContext.Provider>;
}

export function useSessionPreparation(): SessionPreparationValue {
  return useContext(SessionPreparationContext);
}
