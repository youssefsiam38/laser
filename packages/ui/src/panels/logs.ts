/**
 * The host's own log sections, as `stream` panels (M4-T6 × docs/ux-panels.md).
 *
 * The logs page is where you *search* the record; a stream panel is where you
 * *watch* one section while you keep working. Both read the same rows, and the
 * panel is the same island every extension gets — the provider log and a
 * package's `setWidget` output are literally the same component, which is the
 * whole point of the contract.
 *
 * The buffer is client-local and bounded: rows arrive on `pi/logs/append` while
 * the app is open, and a panel that has been watching for an hour holds the
 * last `MAX_LINES`, not the hour. Nothing here queries the host — the logs page
 * owns paging and search, and duplicating that inside an island would be a
 * second, worse logs page.
 *
 * The ref is `inline:logs:<section>` so the panel store answers reads locally,
 * the same way it does for a `setWidget` panel.
 */
import { WIRE_NAMESPACE } from "@piorbit/protocol";
import type { LogEntry, LogSection, StreamPanel } from "@piorbit/protocol";

import { clockTime } from "../format.js";

export const LOG_REF_PREFIX = "inline:logs:";
export const LOG_PANEL_ID_PREFIX = "ui:logs:";
/** Lines kept per section. A busy minute is a few hundred; an island shows a tail. */
export const MAX_LINES = 2000;

export const isLogPanelId = (id: string): boolean => id.startsWith(LOG_PANEL_ID_PREFIX);
export const logPanelId = (section: LogSection): string => `${LOG_PANEL_ID_PREFIX}${section}`;
export const logRef = (section: LogSection): string => `${LOG_REF_PREFIX}${section}`;
export const sectionOfLogRef = (ref: string): LogSection | undefined =>
  ref.startsWith(LOG_REF_PREFIX) ? (ref.slice(LOG_REF_PREFIX.length) as LogSection) : undefined;

/** How a section names itself in a panel header. */
const TITLES: Record<LogSection, string> = {
  provider: "Provider log",
  tools: "Tool calls",
  session: "Session log",
  subagents: "Subagent events",
  host: "Host and worker output",
};

/**
 * One line per row: when, how loud, and what happened. Deliberately the same
 * facts the logs page's row shows, so switching between the two does not feel
 * like reading two different records.
 */
export function logLine(entry: LogEntry): string {
  const level = entry.level === "info" ? "" : ` ${entry.level.toUpperCase()}`;
  const metric =
    entry.status !== undefined
      ? ` (${entry.status})`
      : entry.durationMs !== undefined
        ? ` (${entry.durationMs < 1000 ? `${entry.durationMs}ms` : `${(entry.durationMs / 1000).toFixed(1)}s`})`
        : "";
  return `${clockTime(entry.at)}${level} ${entry.kind}${metric} · ${entry.summary}`;
}

// ---------------------------------------------------------------------------
// The buffer
// ---------------------------------------------------------------------------

const lines = new Map<LogSection, string[]>();
const listeners = new Set<() => void>();

/** Fold a batch of appended rows in. Returns the sections that changed. */
export function recordLogRows(entries: readonly LogEntry[]): LogSection[] {
  const touched = new Set<LogSection>();
  for (const entry of entries) {
    const bucket = lines.get(entry.section) ?? [];
    bucket.push(logLine(entry));
    if (bucket.length > MAX_LINES) bucket.splice(0, bucket.length - MAX_LINES);
    lines.set(entry.section, bucket);
    touched.add(entry.section);
  }
  if (touched.size > 0) for (const l of listeners) l();
  return [...touched];
}

/** The content behind `inline:logs:<section>`, or undefined for another ref. */
export function logContent(ref: string): string | undefined {
  const section = sectionOfLogRef(ref);
  if (section === undefined) return undefined;
  return (lines.get(section) ?? []).join("\n");
}

export function watchedLogSections(): LogSection[] {
  return [...lines.keys()];
}

export function subscribeLogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam, and what a disconnect resets. */
export function resetLogBuffer(): void {
  lines.clear();
  for (const l of listeners) l();
}

/**
 * The panel for one section. `follow` is always true: a log is being written
 * for as long as the host is up, and a stream that says otherwise would be
 * lying about why its number is not moving.
 *
 * `host` carries worker stderr, which is the one section that really does
 * contain escape codes, so it is the one declared `ansi`.
 */
export function logStreamPanel(section: LogSection): StreamPanel {
  const text = logContent(logRef(section)) ?? "";
  return {
    kind: "stream",
    id: logPanelId(section),
    source: WIRE_NAMESPACE,
    title: TITLES[section],
    intent: "follow",
    encoding: section === "host" ? "ansi" : "text",
    ref: logRef(section),
    bytes: utf8Length(text),
    follow: true,
  };
}

function utf8Length(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}
