/**
 * Pure logic behind the logs page: which rows a filter admits (the same
 * predicate the host applies, so a live row appended over the socket lands
 * exactly where a re-query would put it), and how a row is labelled.
 */
import type { LogEntry, LogLevel, LogQuery, LogSection } from "@piorbit/protocol";

export interface LogFilters {
  section: LogSection | "all";
  search: string;
  levels: LogLevel[] | null;
  cwd?: string | undefined;
  sessionPath?: string | undefined;
}

export const LOG_SECTIONS: Array<{ id: LogSection | "all"; label: string; hint: string }> = [
  { id: "all", label: "All", hint: "Everything the host recorded, newest last" },
  { id: "provider", label: "Provider", hint: "One row per request and one per response, with the full request payload" },
  { id: "tools", label: "Tools", hint: "Tool executions with arguments, results and duration" },
  { id: "session", label: "Session", hint: "Agent lifecycle, compaction, retries, extension errors" },
  { id: "subagents", label: "Subagents", hint: "Events forwarded by pi-subagents" },
  { id: "host", label: "Host", hint: "Worker lifecycle and worker stderr" },
];

export const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

export function toQuery(filters: LogFilters, extra: Partial<LogQuery> = {}): LogQuery {
  return {
    ...(filters.section === "all" ? {} : { sections: [filters.section] }),
    ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
    ...(filters.levels ? { levels: filters.levels } : {}),
    ...(filters.cwd ? { cwd: filters.cwd } : {}),
    ...(filters.sessionPath ? { sessionPath: filters.sessionPath } : {}),
    ...extra,
  };
}

/**
 * The client-side twin of the store's WHERE clause, for rows that arrive by
 * notification. `search` matches summary, kind and the detail preview, which is
 * what the store indexes.
 */
export function matchesFilters(entry: LogEntry, filters: LogFilters): boolean {
  if (filters.section !== "all" && entry.section !== filters.section) return false;
  if (filters.levels && !filters.levels.includes(entry.level)) return false;
  if (filters.cwd && entry.cwd !== filters.cwd) return false;
  if (filters.sessionPath && entry.sessionPath !== filters.sessionPath) return false;
  const needle = filters.search.trim().toLowerCase();
  if (needle === "") return true;
  const haystack = `${entry.summary}\n${entry.kind}\n${entry.detailRef?.preview ?? ""}`.toLowerCase();
  return haystack.includes(needle);
}

/** Merge a batch of appended rows into a page, keeping it ordered and unique. */
export function appendRows(existing: LogEntry[], incoming: LogEntry[], cap: number): LogEntry[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((entry) => entry.id));
  const fresh = incoming.filter((entry) => !seen.has(entry.id));
  if (fresh.length === 0) return existing;
  const merged = [...existing, ...fresh].sort((a, b) => a.id - b.id);
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

export const SECTION_TONE: Record<LogSection, string> = {
  provider: "var(--live)",
  tools: "var(--ink-2)",
  session: "var(--ok)",
  subagents: "var(--attention)",
  host: "var(--ink-3)",
};

/** A row's headline number: status for a response, duration for anything timed. */
export function rowMetric(entry: LogEntry): string | undefined {
  if (entry.status !== undefined) return `${entry.status}`;
  if (entry.durationMs !== undefined) return entry.durationMs < 1000 ? `${entry.durationMs}ms` : `${(entry.durationMs / 1000).toFixed(1)}s`;
  return undefined;
}
