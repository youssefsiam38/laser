"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ThinkingLevel } from "@lasercode/protocol";
import { useLaserStable, useLaserState, useLaserView } from "../../runtime/LaserProvider.js";
import { consumeTentativeFirstTurn, discardTentativeFirstTurn, readTentativeFirstTurn, writeTentativeFirstTurn, type TentativeFirstTurn } from "../../runtime/first-turn.js";

interface SessionPreparationValue {
  pending: boolean;
  /** Returns the matching release function; callers must invoke it once. */
  begin(): () => void;
  /** The navigation-neutral choice attached to this composer's first send. */
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
  const { currentProject } = useLaserStable();
  const view = useLaserView();
  const defaultAgent = useLaserState((state) => state.agents.snapshot?.defaultAgent);
  const scope = view?.path ?? currentProject;
  const persistedAgent = view?.state.agent?.agentName ?? defaultAgent;
  const current = useRef<{ scope: string; value: TentativeFirstTurn } | undefined>(undefined);
  const [, setRevision] = useState(0);
  const owned = current.current;
  const firstTurn = owned && owned.scope === scope ? owned.value : undefined;

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
    if (!scope) return;
    const previous = current.current;
    if (previous && previous.scope !== scope) consumeTentativeFirstTurn(previous.scope, previous.value);
    current.current = { scope, value };
    writeTentativeFirstTurn(scope, value);
    setRevision((value) => value + 1);
  }, [scope]);

  const chooseAgent = useCallback((agentName: string) => {
    const owned = current.current;
    const previous = owned && owned.scope === scope ? owned.value : undefined;
    commit({ agentName, ...(previous?.thinkingLevel ? { thinkingLevel: previous.thinkingLevel } : {}) });
  }, [commit, scope]);

  const chooseThinking = useCallback((thinkingLevel: ThinkingLevel) => {
    const owned = current.current;
    const previous = owned && owned.scope === scope ? owned.value : undefined;
    const agentName = previous?.agentName ?? persistedAgent;
    if (!agentName) return;
    commit({ agentName, thinkingLevel });
  }, [commit, persistedAgent, scope]);

  useEffect(() => {
    const owned = current.current;
    if (!owned || owned.scope === scope) return;
    // Anonymous first send moves the tentative value onto its newly selected
    // session before this effect runs. Ordinary navigation leaves it behind
    // and therefore discards it.
    if (scope && readTentativeFirstTurn(owned.scope) !== owned.value && readTentativeFirstTurn(scope) === owned.value) {
      current.current = { scope, value: owned.value };
    } else {
      discardTentativeFirstTurn(owned.value);
      current.current = undefined;
    }
    setRevision((value) => value + 1);
  }, [scope]);

  useEffect(() => () => {
    const owned = current.current;
    if (owned) discardTentativeFirstTurn(owned.value);
  }, []);

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
