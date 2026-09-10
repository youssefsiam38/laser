"use client";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface SessionPreparationValue {
  pending: boolean;
  /** Returns the matching release function; callers must invoke it once. */
  begin(): () => void;
}

const SessionPreparationContext = createContext<SessionPreparationValue>({
  pending: false,
  begin: () => () => {},
});

/** Serializes pre-turn session identity/model preparation with the composer. */
export function SessionPreparationProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  const begin = useCallback(() => {
    let released = false;
    setCount((current) => current + 1);
    return () => {
      if (released) return;
      released = true;
      setCount((current) => Math.max(0, current - 1));
    };
  }, []);
  const value = useMemo(() => ({ pending: count > 0, begin }), [begin, count]);
  return <SessionPreparationContext.Provider value={value}>{children}</SessionPreparationContext.Provider>;
}

export function useSessionPreparation(): SessionPreparationValue {
  return useContext(SessionPreparationContext);
}
