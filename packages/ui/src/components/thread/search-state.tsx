import { createContext, useContext, useEffect, useState } from "react";

/** Transient find state only: never changes the person's disclosure preference. */
export const SearchMessageContext = createContext(false);
export const useSearchReveal = () => useContext(SearchMessageContext);

/**
 * A disclosure while find is revealing it. The reveal opens the row; the
 * person can still fold it with its own chevron, and that fold belongs to
 * this reveal alone — nothing is written to their remembered choice, and
 * closing find hands the row straight back to the preference it had
 * (AGENTS.md "Search disclosure is transient"). The next reveal starts open
 * again, because a match nobody can see is not a match.
 */
export function useSearchRevealDisclosure(): { revealing: boolean; open: boolean; fold: (open: boolean) => void } {
  const revealing = useSearchReveal();
  const [open, fold] = useState(true);
  useEffect(() => {
    if (!revealing) fold(true);
  }, [revealing]);
  return { revealing, open, fold };
}
export const FindSelectionContext = createContext<string | undefined>(undefined);
export type SearchSource = "user" | "assistant" | "reasoning" | "tool";
export function openConversationFind(query?: string, source?: SearchSource) {
  window.dispatchEvent(new CustomEvent("conversation-find", { detail: { query, source } }));
}
