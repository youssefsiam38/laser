import { createContext, useContext, useEffect, useState } from "react";
import { textMatches } from "./search-text.js";

/** Transient find state only: never changes the person's disclosure preference. */
export const SearchMessageContext = createContext(false);
export const useSearchReveal = () => useContext(SearchMessageContext);
export const FindSelectionContext = createContext<string | undefined>(undefined);
/**
 * What find is looking for right now, so a row holding only an excerpt can
 * offer to look for it in the rest of that body (RP-5b). Transient, like every
 * other find state here.
 */
export const FindQueryContext = createContext<string>("");
export const useFindQuery = (): string => useContext(FindQueryContext);

/**
 * The one transient reveal policy for tools, aggregates and reasoning.
 * Header-only matches preserve the person's fold; a body match mounts the
 * body. Manual choices are keyed to the current query and never reach the
 * remembered preference. Body projection stays lazy while Find is closed.
 */
export function useSearchRevealDisclosure({
  baseOpen,
  visibleSearchText,
  bodySearchText,
}: {
  baseOpen: boolean;
  visibleSearchText?: string | undefined;
  bodySearchText?: (() => readonly string[]) | undefined;
}): { revealing: boolean; open: boolean; fold: (open: boolean) => void } {
  const revealing = useSearchReveal();
  const query = useFindQuery().trim();
  const visibleMatch = query !== "" && visibleSearchText !== undefined && textMatches(visibleSearchText, query).length > 0;
  const bodyMatch = revealing && query !== "" && (bodySearchText?.().some((text) => textMatches(text, query).length > 0) ?? false);
  const headerOnlyMatch = revealing && visibleMatch && bodySearchText !== undefined && !bodyMatch;
  const [transientOverride, setTransientOverride] = useState<{ query: string; open: boolean } | null>(null);
  useEffect(() => {
    if (!revealing) setTransientOverride(null);
  }, [revealing]);
  const revealedOpen = transientOverride?.query === query ? transientOverride.open : undefined;
  return {
    revealing,
    open: revealing ? (revealedOpen ?? (headerOnlyMatch ? baseOpen : true)) : baseOpen,
    fold: (open) => setTransientOverride({ query, open }),
  };
}
export type SearchSource = "user" | "assistant" | "reasoning" | "tool";
export function openConversationFind(query?: string, source?: SearchSource) {
  window.dispatchEvent(new CustomEvent("conversation-find", { detail: { query, source } }));
}
