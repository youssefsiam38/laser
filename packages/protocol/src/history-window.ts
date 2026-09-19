import type { HistoryLiveSnapshot, HistoryWindow, HistoryWindowRequest } from "./messages.js";
import { goalPromptId } from "./goal-presentation.js";
import { ErrorCodes } from "./jsonrpc.js";
import { ProtocolError } from "./schemas.js";
import { elideOversizedEntries } from "./body-range.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const changed = (): never => { throw new ProtocolError(ErrorCodes.InvalidParams, "This history changed. Reload the conversation and try again."); };

/** A durable page is deliberately recognizable without carrying a path or process identity. */
export const DURABLE_HISTORY_EPOCH = "durable-v1";
export const HISTORY_PAGE_ENTRY_LIMIT = 200;
export const HISTORY_PAGE_BYTE_LIMIT = 1024 * 1024;

/** The body-free row retained by the host's read-only session index. */
export interface HistoryWindowNode {
  id: string | undefined;
  parentId: string | null;
  isMessage: boolean;
  isUser: boolean;
  /** A tool result is never the first row of a page: it belongs to the call before it. */
  isToolResult?: boolean;
  isGoalState: boolean;
  /** What a goal-state record changes; identical neighbours carry the same value. */
  goalSignature?: string | undefined;
  goalPromptId?: string | undefined;
}

export type HistoryWindowSelection =
  | { kind: "replace" }
  /** Internal delta boundary: selected rows are strictly after this branch entry. */
  | { kind: "delta"; after: string | null };

export interface HistoryWindowScope {
  /** The session's own id (not its path): cursors are bound to identity, not storage. */
  sessionId: string;
  epoch: string;
  seq: number;
  /** RP-9. Required: a window without its revision is not a valid answer. */
  revision: string;
  environmentKey: string;
  live?: HistoryLiveSnapshot;
  authority?: "live" | "durable";
  /** One discriminant owns both internal selection and the exported mode. */
  selection?: HistoryWindowSelection;
}

export interface HistoryWindowPlan {
  entryIndices: number[];
  contextIndices: number[];
  leafId: string | null;
  window: Omit<HistoryWindow, "context">;
}

/**
 * The fields goal history reads to tell one goal moment from the next (see the
 * UI's goalRecords). FNV-1a keeps the host's body-free index small.
 */
function goalSignature(data: unknown): string {
  const goal = record(data).goal;
  if (goal === null) return "null";
  const value = record(goal);
  const text = JSON.stringify([value.id, value.text, value.startedAt, value.status, record(value.waiting).reason, value.safetyPauseCause]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}.${hash.toString(36)}`;
}

/**
 * Goal context before a page: the first and last record of each run of
 * identical goal moments. Goal history reads status changes from the first
 * and the latest iteration from the last, so the runs between add nothing but
 * bytes — a long goal writes thousands of them.
 */
function goalContext(nodes: readonly HistoryWindowNode[], prefix: readonly number[]): number[] {
  const goals = prefix.filter(index => nodes[index]!.isGoalState);
  return goals.filter((index, at) => {
    const signature = nodes[index]!.goalSignature;
    return at === 0 || at === goals.length - 1
      || nodes[goals[at - 1]!]!.goalSignature !== signature
      || nodes[goals[at + 1]!]!.goalSignature !== signature;
  });
}

export function historyWindowNode(entry: unknown): HistoryWindowNode {
  const value = record(entry);
  const type = String(value.type);
  const isMessage = type === "message" || type === "custom_message";
  const role = type === "message" ? record(value.message).role : undefined;
  const isGoalState = type === "custom" && value.customType === "goal-state";
  const isUser = role === "user";
  let promptId: string | undefined;
  if (isUser) {
    const content = record(value.message).content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map(part => record(part).type === "text" ? String(record(part).text ?? "") : "").join("\n")
        : "";
    promptId = goalPromptId(text);
  }
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    parentId: typeof value.parentId === "string" ? value.parentId : null,
    isMessage,
    isUser,
    ...(role === "toolResult" ? { isToolResult: true } : {}),
    isGoalState,
    ...(isGoalState ? { goalSignature: goalSignature(value.data) } : {}),
    ...(promptId ? { goalPromptId: promptId } : {}),
  };
}

const encodeCursor = (cursor: HistoryCursor): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const decodeCursor = (value: string): Record<string, unknown> => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return changed();
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return changed();
  }
};

/** Cursor generation. A cursor from an older shape is refused, never reinterpreted. */
const CURSOR_VERSION = 2;

/**
 * Page cursors are opaque and carry nothing the caller does not already hold:
 * the session's own id and two entry ids. No filesystem path, no serving
 * epoch, no mtime — the public contract says nothing about how history is
 * stored (RP-9). Lineage, not exact state, is what a cursor binds to, so a
 * page request still works while the conversation is streaming.
 */
interface HistoryCursor {
  v: number;
  /** The session's own id, so a cursor cannot wander to another conversation. */
  s: string;
  /** The leaf the cursor was issued against; it must still be on the branch. */
  l: string | null;
  /** The entry this page ends before. */
  b: string;
}

/**
 * Plan a window over identity-only rows. This is the shared display projection:
 * the worker materialises from its in-memory entries and the host reads only
 * these selected JSONL lines by offset.
 */
export function historyWindowPlan(
  nodes: readonly HistoryWindowNode[],
  leafId: string | null,
  request: HistoryWindowRequest,
  scope: HistoryWindowScope,
  /** Allow the page to start inside a turn, for a turn no page can hold whole. */
  splitTurns = false,
): HistoryWindowPlan {
  const byId = new Map<string, number>();
  nodes.forEach((node, index) => { if (node.id !== undefined) byId.set(node.id, index); });
  const reversed: number[] = [];
  const visited = new Set<string>();
  let id: string | null = leafId;
  while (typeof id === "string") {
    if (visited.has(id)) changed();
    visited.add(id);
    const index = byId.get(id);
    if (index === undefined) return changed();
    reversed.push(index);
    id = nodes[index]!.parentId;
  }
  const branch = reversed.reverse();
  let end = branch.length;
  let start = 0;
  const all = "all" in request;

  if ("before" in request) {
    const cursor = decodeCursor(request.before);
    if (cursor.v !== CURSOR_VERSION || cursor.s !== scope.sessionId ||
        typeof cursor.l !== "string" || !visited.has(cursor.l)) changed();
    end = branch.findIndex(index => nodes[index]!.id === cursor.b);
    if (end < 0) changed();
  } else if ("beforeEntry" in request) {
    // The entry is an exclusive producer-owned boundary. Unlike `from`, this
    // request is bounded and can recover a retained old viewport anchor
    // without asking for its potentially enormous suffix to the leaf.
    end = branch.findIndex(index => nodes[index]!.id === request.beforeEntry);
    if (end < 0) changed();
  }

  if (scope.selection?.kind === "delta") {
    const { after } = scope.selection;
    if (after === null) start = 0;
    else {
      const boundary = branch.findIndex(index => nodes[index]!.id === after);
      if (boundary < 0) changed();
      start = boundary + 1;
    }
  } else if ("from" in request) {
    start = branch.findIndex(index => nodes[index]!.id === request.from);
    if (start < 0) changed();
  } else if (!all) {
    const limit = "tail" in request ? request.tail : "before" in request || "beforeEntry" in request ? request.limit ?? 40 : 40;
    let messages = 0;
    start = end;
    while (start > 0 && messages < limit) if (nodes[branch[--start]!]!.isMessage) messages++;
    // A tool result cannot be separated from its call, or an assistant action
    // from its prompt. A single unusually long turn may exceed the row target.
    // A turn too large for any page (a long agent run) splits between an
    // assistant action and the next, never between a call and its result.
    if (splitTurns) while (start > 0 && start < end && nodes[branch[start]!]!.isToolResult) start--;
    else while (start > 0 && !nodes[branch[start]!]!.isUser) start--;
    // Attribution and other turn-local custom markers precede the prompt.
    while (start > 0 && !nodes[branch[start - 1]!]!.isMessage) start--;
  }

  const entryIndices = all && scope.selection?.kind !== "delta"
    ? nodes.map((_, index) => index)
    : branch.slice(start, end);
  const prefix = branch.slice(0, start);
  const anchor = entryIndices.length > 0 ? nodes[entryIndices[0]!]!.id : undefined;
  // Delta consumers retain the cached page and its context; retransmitting old
  // context would duplicate bodies and make an empty current delta nonempty.
  const contextIndices = scope.selection?.kind === "delta" ? [] : goalContext(nodes, prefix);
  const priorGoalIds = new Set<string>();
  for (const index of prefix) {
    const goal = nodes[index]!.goalPromptId;
    if (goal) priorGoalIds.add(goal);
  }
  const mode = scope.selection?.kind;
  return {
    entryIndices,
    contextIndices,
    leafId,
    window: {
      epoch: scope.epoch,
      seq: scope.seq,
      revision: scope.revision,
      environmentKey: scope.environmentKey,
      ...(start > 0 && typeof anchor === "string"
        ? { before: encodeCursor({ v: CURSOR_VERSION, s: scope.sessionId, l: leafId, b: anchor } satisfies HistoryCursor) }
        : {}),
      ...(typeof anchor === "string" ? { anchor } : {}),
      userOffset: prefix.filter(index => nodes[index]!.isUser).length,
      complete: all || (start === 0 && end === branch.length),
      branchesUnloaded: !all && branch.length !== nodes.length,
      hasHistory: nodes.some(node => node.isMessage || node.isGoalState),
      priorGoalIds: [...priorGoalIds],
      ...(scope.live ? { live: scope.live } : {}),
      ...(scope.authority ? { authority: scope.authority } : {}),
      ...(mode ? { mode } : {}),
    },
  };
}

/**
 * Keep an exact request shape while fitting tail/before pages at complete-turn
 * boundaries, splitting inside a turn only when no complete turn fits. `all`
 * and `from` are indivisible: callers must refuse them when their exact
 * projection is too large. The search is logarithmic, never one
 * full branch replan per possible message count.
 */
export function fitHistoryWindowPlan(
  nodes: readonly HistoryWindowNode[],
  leafId: string | null,
  request: HistoryWindowRequest,
  scope: HistoryWindowScope,
  fits: (plan: HistoryWindowPlan) => boolean,
): HistoryWindowPlan | undefined {
  const initial = historyWindowPlan(nodes, leafId, request, scope);
  if (fits(initial)) return initial;
  if ("all" in request || "from" in request || scope.selection?.kind === "delta") return undefined;

  const maximum = Math.min("tail" in request ? request.tail : request.limit ?? 40, HISTORY_PAGE_ENTRY_LIMIT);
  let low = 1;
  let high = maximum - 1;
  let best: HistoryWindowPlan | undefined;
  while (low <= high) {
    const limit = low + Math.floor((high - low) / 2);
    const candidate = historyWindowPlan(
      nodes,
      leafId,
      "before" in request ? { before: request.before, limit }
        : "beforeEntry" in request ? { beforeEntry: request.beforeEntry, limit }
          : { tail: limit },
      scope,
    );
    if (fits(candidate)) {
      best = candidate;
      low = limit + 1;
    } else {
      high = limit - 1;
    }
  }
  if (best) return best;

  // Not even the newest complete turn fits: page inside it rather than leave
  // the conversation unreadable. Older pages continue from the cursor.
  low = 1;
  high = maximum;
  while (low <= high) {
    const limit = low + Math.floor((high - low) / 2);
    const candidate = historyWindowPlan(
      nodes,
      leafId,
      "before" in request ? { before: request.before, limit }
        : "beforeEntry" in request ? { beforeEntry: request.beforeEntry, limit }
          : { tail: limit },
      scope,
      true,
    );
    if (fits(candidate)) {
      best = candidate;
      low = limit + 1;
    } else {
      high = limit - 1;
    }
  }
  return best;
}

/** Materialize one already planned page from an in-memory snapshot. */
export function materializeHistoryWindow(
  snapshot: { entries: unknown[]; leafId: string | null },
  plan: HistoryWindowPlan,
): { entries: unknown[]; leafId: string | null; window: HistoryWindow } {
  return {
    entries: plan.entryIndices.map(index => snapshot.entries[index]),
    leafId: plan.leafId,
    window: { ...plan.window, context: plan.contextIndices.map(index => snapshot.entries[index]) },
  };
}

/** Window opaque entries along their real parent chain; never slice the disk's append order. */
export function historyWindow(
  snapshot: { entries: unknown[]; leafId: string | null },
  request: HistoryWindowRequest,
  scope: HistoryWindowScope,
): { entries: unknown[]; leafId: string | null; window: HistoryWindow } {
  return materializeHistoryWindow(snapshot, historyWindowPlan(snapshot.entries.map(historyWindowNode), snapshot.leafId, request, scope));
}

/** Exact UTF-8 JSON size of the two materialized body arrays. */
export function historyContentSerializedBytes(entries: readonly unknown[], context: readonly unknown[]): number {
  const encoder = new TextEncoder();
  return encoder.encode(JSON.stringify(entries)).byteLength + encoder.encode(JSON.stringify(context)).byteLength;
}

/** Whether one in-memory page meets both authority-independent wire ceilings. */
export function historyWindowFits(
  snapshot: { entries: unknown[] },
  plan: HistoryWindowPlan,
): boolean {
  // The row limit bounds what a page shows; goal context is bounded by bytes.
  if (plan.entryIndices.length > HISTORY_PAGE_ENTRY_LIMIT) return false;
  const entries = plan.entryIndices.map(index => snapshot.entries[index]);
  const context = plan.contextIndices.map(index => snapshot.entries[index]);
  return historyContentSerializedBytes(entries, context) <= HISTORY_PAGE_BYTE_LIMIT;
}

/**
 * Plan, bound and materialize a live page with the same limits as durable
 * reads.
 *
 * `bodies`, when given, carries the digest the producer signs elided bodies
 * with and, optionally, RP-5b's per-body limit: a record carrying a larger
 * body — or one too large for any page at all, whatever kind of record it is
 * (M16-T88) — is left out of the page and listed in `window.elided` with its
 * identity and body metadata, so a conversation with one enormous turn is
 * still readable a page at a time. No record is ever rewritten.
 *
 * With a digest in hand this **cannot** refuse a bounded page for size: a
 * record that cannot travel is elided, so a single-record page always fits.
 * `all` and `from` stay indivisible — they are exact projections their caller
 * asked for by name, and shrinking one would answer a different question.
 */
export function boundedHistoryWindow(
  snapshot: { entries: unknown[]; leafId: string | null },
  request: HistoryWindowRequest,
  scope: HistoryWindowScope,
  bodies?: { limit?: number; digest: (text: string) => string },
): { entries: unknown[]; leafId: string | null; window: HistoryWindow } | undefined {
  const nodes = snapshot.entries.map(historyWindowNode);
  const elide = (indices: readonly number[]): { entries: unknown[]; elided: unknown[] } =>
    elideOversizedEntries(indices.map(index => snapshot.entries[index]), bodies!.limit, bodies!.digest);
  const fits = (candidate: HistoryWindowPlan): boolean => {
    if (!bodies) return historyWindowFits(snapshot, candidate);
    const page = elide(candidate.entryIndices);
    const context = elide(candidate.contextIndices);
    if (page.entries.length + page.elided.length > HISTORY_PAGE_ENTRY_LIMIT) return false;
    return historyContentSerializedBytes(page.entries, context.entries)
      + historyContentSerializedBytes(page.elided, context.elided) <= HISTORY_PAGE_BYTE_LIMIT;
  };
  const plan = fitHistoryWindowPlan(nodes, snapshot.leafId, request, scope, fits);
  if (!plan) {
    // The terminating floor (M16-T88). An indivisible request is refused as
    // before; a bounded one cannot be, because elision bounds every record it
    // is handed. If the smallest page's own records still do not fit, elision
    // failed to bound something and that is a defect here — not a reason to
    // make the older half of somebody's conversation unreachable for ever.
    if (bodies && !("all" in request) && !("from" in request) && scope.selection?.kind !== "delta") {
      const smallest = historyWindowPlan(
        nodes,
        snapshot.leafId,
        "before" in request ? { before: request.before, limit: 1 }
          : "beforeEntry" in request ? { beforeEntry: request.beforeEntry, limit: 1 }
            : { tail: 1 },
        scope,
        true,
      );
      const page = elide(smallest.entryIndices);
      const records = historyContentSerializedBytes(page.entries, []) + historyContentSerializedBytes(page.elided, []);
      if (records > HISTORY_PAGE_BYTE_LIMIT) {
        throw new Error(`A single-record history page is ${records} bytes after elision: elision did not bound this record.`);
      }
      // The records fit; only the goal context before them does not. That is
      // not "one record is too large", and it is the caller's to report.
    }
    return undefined;
  }
  const materialized = materializeHistoryWindow(snapshot, plan);
  return bodies ? withElidedBodies(materialized, bodies.limit, bodies.digest) : materialized;
}

/** Apply RP-5b's per-body limit to an already materialized page. */
export function withElidedBodies(
  page: { entries: unknown[]; leafId: string | null; window: HistoryWindow },
  bodyLimit: number | undefined,
  digest: (text: string) => string,
): { entries: unknown[]; leafId: string | null; window: HistoryWindow } {
  const selected = elideOversizedEntries(page.entries, bodyLimit, digest);
  const context = elideOversizedEntries(page.window.context, bodyLimit, digest);
  const elided = [...selected.elided, ...context.elided];
  return {
    entries: selected.entries,
    leafId: page.leafId,
    window: { ...page.window, context: context.entries, ...(elided.length > 0 ? { elided } : {}) },
  };
}
