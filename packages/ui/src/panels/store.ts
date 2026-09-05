/**
 * The panel store (docs/ux-panels.md). Pure: no React, no DOM.
 *
 * One entry per panel id per session. An upsert replaces in place (R6) and an
 * identical one is a no-op (R9). Each entry keeps a short ring of liveness
 * samples so the store — not the producer — derives throughput
 * ("+12 KB/s") and elapsed ticks. A closed panel stays for a moment with its
 * reason (R7) before `prune` drops it.
 *
 * Tested in test/panels/store.test.ts.
 */
import {
  attentionOf,
  liveBytesOf,
  type Attention,
  type Panel,
  type PanelKind,
} from "@lasercode/protocol";

export interface Snapshot {
  /** Epoch ms. */
  at: number;
  bytes: number;
}

/** Liveness samples kept per panel. Enough for a smooth rate, small enough to be free. */
export const RING_CAPACITY = 8;
/** A stream that has not grown for this long reads as stalled: its rate decays to zero. */
export const STALE_MS = 2500;
/** How long a closed panel stays visible saying why it ended (R7). */
export const CLOSED_TTL_MS = 6000;

export interface PanelEntry {
  /** `panelKey(path, id)`. */
  key: string;
  path: string;
  panel: Panel;
  firstSeenAt: number;
  updatedAt: number;
  /** A person has looked at it since it last finished. */
  seen: boolean;
  ring: readonly Snapshot[];
  /** Set by its producer's close; the entry is pruned CLOSED_TTL_MS later. */
  closed?: { at: number; reason: string };
  /** Derived from `pi/ui/*` (widgets, dialogs) rather than declared on the bus. */
  fallback: boolean;
}

export interface PanelsState {
  entries: Readonly<Record<string, PanelEntry>>;
  /** Creation order, which is the dock order — islands never reshuffle. */
  order: readonly string[];
}

export const emptyPanels: PanelsState = { entries: {}, order: [] };

export const panelKey = (path: string, id: string): string => `${path}\u0000${id}`;

export function splitKey(key: string): { path: string; id: string } {
  const i = key.indexOf("\u0000");
  return i === -1 ? { path: "", id: key } : { path: key.slice(0, i), id: key.slice(i + 1) };
}

// ---------------------------------------------------------------------------
// Ring
// ---------------------------------------------------------------------------

/** Append a sample, keeping the newest `capacity`. A sample at the same instant replaces the last. */
export function pushSnapshot(ring: readonly Snapshot[], sample: Snapshot, capacity = RING_CAPACITY): Snapshot[] {
  const last = ring.at(-1);
  const base = last && last.at === sample.at ? ring.slice(0, -1) : ring.slice();
  base.push(sample);
  return base.length > capacity ? base.slice(base.length - capacity) : base;
}

/**
 * Bytes per second over the ring. Undefined with fewer than two samples.
 * When the newest sample is older than STALE_MS the window is extended to
 * `now` with no growth, so a stalled stream decays to 0 instead of reporting
 * the rate it had when it last moved.
 */
export function velocityOf(ring: readonly Snapshot[], now: number): number | undefined {
  const first = ring[0];
  const newest = ring[ring.length - 1];
  if (!first || !newest) return undefined;
  const stale = now - newest.at > STALE_MS;
  // One fresh sample says nothing about rate; one stale sample says "stopped".
  if (ring.length < 2 && !stale) return undefined;
  const last = stale ? { at: now, bytes: newest.bytes } : newest;
  const dt = last.at - first.at;
  if (dt <= 0) return undefined;
  return Math.max(0, ((last.bytes - first.bytes) * 1000) / dt);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

const TERMINAL_RUN = new Set(["done", "failed", "cancelled"]);

/** True when this update is the kind of change a person has not "seen" yet. */
function resetsSeen(previous: Panel, next: Panel): boolean {
  if (previous.kind === "run" && next.kind === "run") {
    return previous.lifecycle !== next.lifecycle && TERMINAL_RUN.has(next.lifecycle);
  }
  if (previous.kind === "plan" && next.kind === "plan") {
    const done = (p: typeof next) => p.steps.filter((s) => s.state === "done" || s.state === "failed").length;
    return done(previous) !== done(next);
  }
  return false;
}

export interface UpsertOptions {
  fallback?: boolean;
}

export function upsertPanel(
  state: PanelsState,
  path: string,
  panel: Panel,
  now: number,
  options: UpsertOptions = {},
): PanelsState {
  const key = panelKey(path, panel.id);
  const existing = state.entries[key];
  const bytes = liveBytesOf(panel);
  if (existing && !existing.closed && samePanel(existing.panel, panel)) return state;
  // A size that went down is a new stream under an old id (a re-run, a
  // rotation): the old samples would read as a negative rate, so start over.
  const previousRing = existing?.ring ?? [];
  const lastBytes = previousRing.at(-1)?.bytes;
  const ring =
    bytes === undefined
      ? previousRing
      : pushSnapshot(lastBytes !== undefined && bytes < lastBytes ? [] : previousRing, { at: now, bytes });
  const entry: PanelEntry = existing
    ? {
        ...existing,
        panel,
        updatedAt: now,
        ring,
        seen: existing.closed ? false : resetsSeen(existing.panel, panel) ? false : existing.seen,
        fallback: options.fallback ?? existing.fallback,
      }
    : {
        key,
        path,
        panel,
        firstSeenAt: now,
        updatedAt: now,
        seen: false,
        ring,
        fallback: options.fallback ?? false,
      };
  // A re-emit after a close reopens it: nothing vanishes and nothing stacks.
  if (existing?.closed) delete (entry as { closed?: unknown }).closed;
  return {
    entries: { ...state.entries, [key]: entry },
    order: existing ? state.order : [...state.order, key],
  };
}

export function closePanel(state: PanelsState, path: string, id: string, reason: string, now: number): PanelsState {
  const key = panelKey(path, id);
  const existing = state.entries[key];
  if (!existing || existing.closed) return state;
  return { ...state, entries: { ...state.entries, [key]: { ...existing, closed: { at: now, reason } } } };
}

/** Drop closed entries whose notice has been shown long enough. */
export function prunePanels(state: PanelsState, now: number, ttl = CLOSED_TTL_MS): PanelsState {
  const gone = state.order.filter((key) => {
    const closed = state.entries[key]?.closed;
    return closed !== undefined && now - closed.at >= ttl;
  });
  if (gone.length === 0) return state;
  return removeKeys(state, new Set(gone));
}

/** Forget a panel immediately (a person dismissed it, or the session view closed). */
export function removePanel(state: PanelsState, key: string): PanelsState {
  return state.entries[key] ? removeKeys(state, new Set([key])) : state;
}

/** Forget every panel of a session (its view closed). */
export function clearPath(state: PanelsState, path: string): PanelsState {
  const gone = new Set(state.order.filter((key) => state.entries[key]?.path === path));
  return gone.size === 0 ? state : removeKeys(state, gone);
}

/**
 * Replace the declared panels of one session with the host's list (after a
 * reconnect). Fallback panels are untouched; declared ones the host no longer
 * holds are closed with a reason rather than vanishing (R7).
 */
export function reconcilePath(state: PanelsState, path: string, panels: readonly Panel[], now: number): PanelsState {
  let next = state;
  const present = new Set(panels.map((p) => panelKey(path, p.id)));
  for (const key of state.order) {
    const entry = state.entries[key];
    if (!entry || entry.path !== path || entry.fallback || entry.closed || present.has(key)) continue;
    next = closePanel(next, path, entry.panel.id, "ended while you were away", now);
  }
  for (const panel of panels) next = upsertPanel(next, path, panel, now);
  return next;
}

export function markSeen(state: PanelsState, key: string): PanelsState {
  const entry = state.entries[key];
  if (!entry || entry.seen) return state;
  return { ...state, entries: { ...state.entries, [key]: { ...entry, seen: true } } };
}

function removeKeys(state: PanelsState, keys: ReadonlySet<string>): PanelsState {
  const entries: Record<string, PanelEntry> = {};
  for (const [key, entry] of Object.entries(state.entries)) if (!keys.has(key)) entries[key] = entry;
  return { entries, order: state.order.filter((key) => !keys.has(key)) };
}

function samePanel(a: Panel, b: Panel): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function entriesForPath(state: PanelsState, path: string | undefined): PanelEntry[] {
  if (!path) return [];
  const out: PanelEntry[] = [];
  for (const key of state.order) {
    const entry = state.entries[key];
    if (entry && entry.path === path) out.push(entry);
  }
  return out;
}

export function entriesOfKind<K extends PanelKind>(entries: readonly PanelEntry[], kind: K): PanelEntry[] {
  return entries.filter((e) => e.panel.kind === kind);
}

/** Decision panels still open, across the whole store (a plan's approval may live in a child). */
export function openDecisionIds(state: PanelsState): Set<string> {
  const ids = new Set<string>();
  for (const key of state.order) {
    const entry = state.entries[key];
    if (entry && !entry.closed && entry.panel.kind === "decision") ids.add(entry.panel.id);
  }
  return ids;
}

export function attentionOfEntry(entry: PanelEntry, decisions?: ReadonlySet<string>): Attention {
  if (entry.closed) return "idle";
  return attentionOf(entry.panel, { seen: entry.seen, ...(decisions ? { openDecisionIds: decisions } : {}) });
}

export interface FleetSummary {
  /** Runs queued or running, across every session. */
  running: number;
  /** Panels whose attention is "waiting for you", across every session. */
  needsYou: number;
}

/** The fleet pill's numbers: "3 running · 1 needs you". Absent when both are zero. */
export function fleetSummary(state: PanelsState): FleetSummary {
  let running = 0;
  let needsYou = 0;
  const decisions = openDecisionIds(state);
  for (const key of state.order) {
    const entry = state.entries[key];
    if (!entry || entry.closed) continue;
    if (entry.panel.kind === "run" && (entry.panel.lifecycle === "running" || entry.panel.lifecycle === "queued")) running++;
    if (attentionOfEntry(entry, decisions) === "waiting_for_input") needsYou++;
  }
  return { running, needsYou };
}

/** Elapsed ms for the panel's own clock: a run's start→end, else since first seen while live. */
export function elapsedOf(entry: PanelEntry, now: number): number | undefined {
  const { panel } = entry;
  if (panel.kind === "run") {
    const start = panel.startedAt ? Date.parse(panel.startedAt) : entry.firstSeenAt;
    if (Number.isNaN(start)) return undefined;
    const end = panel.endedAt ? Date.parse(panel.endedAt) : TERMINAL_RUN.has(panel.lifecycle) ? entry.updatedAt : now;
    return Math.max(0, (Number.isNaN(end) ? now : end) - start);
  }
  if (panel.kind === "stream") return panel.follow ? Math.max(0, now - entry.firstSeenAt) : undefined;
  return undefined;
}
