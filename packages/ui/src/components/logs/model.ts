/**
 * Pure logic behind the logs page: which rows a filter admits (the same
 * predicate the host applies, so a live row appended over the socket lands
 * exactly where a re-query would put it), and how a row is labelled.
 */
import type { LogEntry, LogLevel, LogQuery, LogSection } from "@lasercode/protocol";

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
  { id: "subagents", label: "Subagents", hint: "Delegated work and coordination events" },
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

// ---------------------------------------------------------------------------
// Timing (the trace waterfall)
// ---------------------------------------------------------------------------

export interface LogSpan {
  /** The log row that ends the span (the response, the tool end), or starts it while running. */
  id: string;
  entryId: number;
  name: string;
  depth: number;
  startMs: number;
  durationMs: number;
  status: "running" | "completed" | "failed";
  detail: string;
}

const START_KINDS = new Set(["provider_request", "tool_start"]);
const END_KINDS = new Set(["provider_response", "tool_end"]);

/**
 * Pair timed rows into spans on one axis. A `provider_request` pairs with
 * the `provider_response` sharing its `correlationId` (a `tool_start` with
 * its `tool_end`); a start without an end is still running; a row carrying
 * `durationMs` alone is its own span ending at its timestamp. Tool spans nest
 * one level under the provider request they ran inside, by time.
 */
export function spansFromEntries(entries: readonly LogEntry[], now = Date.now()): { spans: LogSpan[]; totalMs: number } {
  const time = (iso: string): number => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? 0 : t;
  };
  const ends = new Map<string, LogEntry>();
  for (const e of entries) if (e.correlationId && END_KINDS.has(e.kind)) ends.set(e.correlationId, e);

  interface RawSpan {
    id: string;
    entryId: number;
    name: string;
    status: LogSpan["status"];
    detail: string;
    start: number;
    end: number;
  }
  const raw: RawSpan[] = [];
  const consumed = new Set<number>();
  for (const e of entries) {
    if (START_KINDS.has(e.kind)) {
      const end = e.correlationId ? ends.get(e.correlationId) : undefined;
      if (end) consumed.add(end.id);
      const start = time(e.at);
      const finish = end ? (end.durationMs !== undefined ? start + end.durationMs : time(end.at)) : now;
      const failed = end ? end.level === "error" || (end.status !== undefined && end.status >= 400) : false;
      raw.push({
        id: String((end ?? e).id),
        entryId: (end ?? e).id,
        name: e.kind === "provider_request" ? "provider" : e.summary.replace(/\s+/g, " ").slice(0, 48),
        status: end ? (failed ? "failed" : "completed") : "running",
        detail: e.summary,
        start,
        end: Math.max(start, finish),
      });
      continue;
    }
    if (consumed.has(e.id) || e.durationMs === undefined) continue;
    const end = time(e.at);
    raw.push({
      id: String(e.id),
      entryId: e.id,
      name: e.summary.replace(/\s+/g, " ").slice(0, 48),
      status: e.level === "error" || (e.status !== undefined && e.status >= 400) ? "failed" : "completed",
      detail: e.summary,
      start: end - e.durationMs,
      end,
    });
  }
  if (raw.length === 0) return { spans: [], totalMs: 0 };
  raw.sort((a, b) => a.start - b.start || a.end - b.end);
  const origin = raw[0]!.start;
  const last = Math.max(...raw.map((r) => r.end));
  // A span that starts inside another (and ends no later) is its child.
  const spans: LogSpan[] = raw.map((r) => {
    const parent = raw.find((p) => p !== r && p.start <= r.start && p.end >= r.end && p.name === "provider");
    return {
      id: r.id,
      entryId: r.entryId,
      name: r.name,
      depth: parent && parent.name !== r.name ? 1 : 0,
      startMs: r.start - origin,
      durationMs: r.end - r.start,
      status: r.status,
      detail: r.detail,
    };
  });
  return { spans, totalMs: Math.max(1, last - origin) };
}
