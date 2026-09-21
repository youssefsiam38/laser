"use client";
/**
 * Searching this project's work (M21-T7, D-355 "Search").
 *
 * The backlog's filter matches what a row carries — its key and its title —
 * because that is all a row *has*. A Spec's document, a Research finding's
 * claim and a Task's acceptance criteria live in bodies this window has never
 * read, so finding them is the host's job: `project/work/search` projects the
 * fields it is allowed to project and answers with matches and a score.
 *
 * Two rules, both the contract's:
 *
 * - **A key matches exactly and ranks first.** Typing `RES-7` finds RES-7,
 *   above anything whose text merely contains it.
 * - **A search never hides a row the person can already see.** Results are
 *   merged into the filtered rows, never substituted for them: the host is
 *   the authority on what else matched, not on what this project holds.
 */
import { useEffect, useState } from "react";
import type { ProjectWorkListItem, ProjectWorkSearchResult } from "@lasercode/protocol";

import { applyFilter, sortWork, type WorkFilter, type WorkSort } from "./views.js";
import type { ProjectWorkStore } from "./store.js";

export interface WorkSearchState {
  /** What the host found for the current text. Empty until it answers. */
  results: readonly ProjectWorkSearchResult[];
  /** True while a query is in flight. The rows on screen stay readable. */
  busy: boolean;
  /** The host's own sentence, when the search itself could not run. */
  error: string | undefined;
}

const IDLE: WorkSearchState = { results: [], busy: false, error: undefined };

const DEBOUNCE_MS = 180;

/**
 * Ask the host about the text the person is typing, once they stop typing.
 *
 * An empty query asks nothing. A query that changes cancels the answer to the
 * previous one — a late answer to an old query must never land on a new one.
 */
export function useWorkSearch(store: ProjectWorkStore | undefined, text: string): WorkSearchState {
  const [state, setState] = useState<WorkSearchState>(IDLE);
  const query = text.trim();
  useEffect(() => {
    if (!store || query === "") {
      setState(IDLE);
      return undefined;
    }
    let live = true;
    setState((current) => ({ ...current, busy: true }));
    const timer = setTimeout(() => {
      void store.search(query, { limit: 50 }).then((outcome) => {
        if (!live) return;
        if (outcome.ok) setState({ results: outcome.value.results, busy: false, error: undefined });
        // A host that cannot search is not a broken backlog: the rows this
        // window holds are still filtered, and the refusal is said once.
        else setState({ results: [], busy: false, error: outcome.failure.message });
      });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, store]);
  return state;
}

export interface SearchedRows {
  rows: ProjectWorkListItem[];
  /** How many of the rows are only here because the host matched their body. */
  fromBody: number;
}

/**
 * The rows to draw for one filter and one set of search results.
 *
 * Exact key first, then the host's score, then the person's chosen sort. A
 * result the cache has no row for is skipped rather than invented — the row
 * carries counts and links a search result does not have.
 */
export function mergeSearchResults(
  items: readonly ProjectWorkListItem[],
  filter: WorkFilter,
  sort: WorkSort,
  results: readonly ProjectWorkSearchResult[],
): SearchedRows {
  const local = applyFilter(items, filter);
  const sorted = sortWork(local, sort, filter.text);
  if (filter.text.trim() === "" || results.length === 0) return { rows: sorted, fromBody: 0 };

  const byId = new Map(items.map((item) => [item.ref.entityId, item]));
  const seen = new Set(sorted.map((row) => row.ref.entityId));
  const extra: ProjectWorkListItem[] = [];
  for (const result of results) {
    const row = byId.get(result.ref.entityId);
    if (!row || seen.has(row.ref.entityId)) continue;
    // Every filter except the text one still applies: a search is not a way
    // around "needs you" or "without archived".
    if (applyFilter([row], { ...filter, text: "" }).length === 0) continue;
    seen.add(row.ref.entityId);
    extra.push(row);
  }

  const rank = new Map(results.map((result) => [result.ref.entityId, result]));
  const score = (row: ProjectWorkListItem): number => {
    const result = rank.get(row.ref.entityId);
    if (!result) return 0;
    return result.exactKey ? Number.MAX_SAFE_INTEGER : result.score;
  };
  const rows = [...sorted, ...extra].sort((a, b) => {
    const byScore = score(b) - score(a);
    if (byScore !== 0) return byScore;
    return 0;
  });
  return { rows, fromBody: extra.length };
}

/** Which projected field matched, in words, for the row that only matched there. */
export function matchNote(result: ProjectWorkSearchResult | undefined): string | undefined {
  if (!result) return undefined;
  const field = result.matches[0]?.field;
  if (field === "body") return "matched inside the document";
  if (field === "title") return "matched in the title";
  if (field === "key") return "matched the key";
  return undefined;
}
