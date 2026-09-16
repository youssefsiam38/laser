import { createContext, useContext, type ReactNode } from "react";

import type { WholeTranscriptRefusal } from "@/runtime";

const READY: WholeTranscriptRefusal = Object.freeze({ paused: false, explanation: undefined });
const Context = createContext<WholeTranscriptRefusal>(READY);

/** Carries one window policy into message rows without another subscription per row. */
export function WholeTranscriptRefusalProvider({ value, children }: { value: WholeTranscriptRefusal; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Defaults to ready in isolated message specimens that have no window provider. */
export function useThreadWholeTranscriptRefusal(): WholeTranscriptRefusal {
  return useContext(Context);
}
