import { createContext, useContext } from "react";

/** Transient find state only: never changes the person's disclosure preference. */
export const SearchMessageContext = createContext(false);
export const useSearchReveal = () => useContext(SearchMessageContext);
export const FindSelectionContext = createContext<string | undefined>(undefined);
export type SearchSource = "user" | "assistant" | "reasoning" | "tool";
export function openConversationFind(query?: string, source?: SearchSource) {
  window.dispatchEvent(new CustomEvent("conversation-find", { detail: { query, source } }));
}
