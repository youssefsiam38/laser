import type { HistoryLiveSnapshot, HistoryWindow, HistoryWindowRequest } from "./messages.js";
import { goalPromptId } from "./goal-presentation.js";
import { ErrorCodes } from "./jsonrpc.js";
import { ProtocolError } from "./schemas.js";
import { ELIDED_RECORD_LIMITS, ELIDED_RECORD_MAX_BYTES, createImageReferenceCache, elideOversizedEntries, type ImageReferenceCache } from "./body-range.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const changed = (): never => { throw new ProtocolError(ErrorCodes.InvalidParams, "This history changed. Reload the conversation and try again."); };
const unknownMessage = (): never => { throw new ProtocolError(ErrorCodes.InvalidParams, "That message is not part of this conversation."); };

/** A durable page is deliberately recognizable without carrying a path or process identity. */
export const DURABLE_HISTORY_EPOCH = "durable-v1";
/**
 * The raw-entry ceiling on one page — the bound that makes a turn window safe.
 *
 * A turn is a person's unit, not a size: one prompt can drag in five hundred
 * tool rows from a long agent run. This is the ceiling those raw rows meet
 * (the reference's `maxRawTurns` in the shape our rows actually have), and a
 * page that reaches it is shrunk — fewer turns, and inside one turn if even a
 * single turn cannot fit — never refused. Two hundred rows is about six
 * screens of the densest transcript we draw and comfortably inside the byte
 * ceiling for ordinary records, so it binds fan-out without ever being the
 * thing an ordinary page notices.
 */
export const HISTORY_PAGE_ENTRY_LIMIT = 200;
export const HISTORY_PAGE_BYTE_LIMIT = 1024 * 1024;

/**
 * The newest page: the last ten user-anchored turns (M16-T90).
 *
 * Ten is the reference's own first-page size, and it is a person's answer to
 * "where was I": the last ten things they said, with everything that happened
 * in between. It is deliberately not a byte budget — the byte ceiling is a net
 * below this, not the policy.
 */
export const HISTORY_FIRST_PAGE_TURNS = 10;

/** Each "load earlier": twenty more turns, as the reference loads them. */
export const HISTORY_EARLIER_PAGE_TURNS = 20;

/**
 * The most turns one request may name. A turn carries at least one entry, so a
 * page can never hold more turns than it can hold rows; asking for more is a
 * malformed request rather than a large one.
 */
export const HISTORY_PAGE_TURN_MAX = HISTORY_PAGE_ENTRY_LIMIT;

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

/** Last child in file order, until there is none: the leaf a version heads. */
function leafOfNode(nodes: readonly HistoryWindowNode[], entryId: string): string {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.id === undefined || node.parentId === null) continue;
    const list = children.get(node.parentId);
    if (list) list.push(node.id);
    else children.set(node.parentId, [node.id]);
  }
  let current = entryId;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const next = children.get(current)?.at(-1);
    if (next === undefined) return current;
    current = next;
  }
}

/** `count` items around `namedAt`, always including that index. */
function sliceAround(indices: readonly number[], namedAt: number, count: number): number[] {
  const limit = Math.min(Math.max(count, 1), indices.length);
  if (indices.length <= limit) return [...indices];
  const before = Math.floor((limit - 1) / 2);
  let start = Math.max(0, namedAt - before);
  if (start + limit > indices.length) start = indices.length - limit;
  return indices.slice(start, start + limit);
}

/**
 * The siblings of one entry: same parent, file order, named entry included.
 * Always a replacement; never a delta, never merged with a base.
 */
function planVersionsWindow(
  nodes: readonly HistoryWindowNode[],
  byId: Map<string, number>,
  branch: readonly number[],
  leafId: string | null,
  versionsOf: string,
  scope: HistoryWindowScope,
  limit: number,
): HistoryWindowPlan {
  const namedIndex = byId.get(versionsOf);
  if (namedIndex === undefined) return unknownMessage();
  const parentId = nodes[namedIndex]!.parentId;
  const siblingIndices: number[] = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    if (node.id === undefined || node.parentId !== parentId) continue;
    siblingIndices.push(index);
  }
  const namedAt = siblingIndices.indexOf(namedIndex);
  const selected = sliceAround(siblingIndices, namedAt, Math.min(limit, HISTORY_PAGE_ENTRY_LIMIT));
  const leaves = selected.map((index) => {
    const id = nodes[index]!.id!;
    return { id, leafId: leafOfNode(nodes, id) };
  });
  return {
    entryIndices: selected,
    contextIndices: [],
    leafId,
    window: {
      epoch: scope.epoch,
      seq: scope.seq,
      revision: scope.revision,
      environmentKey: scope.environmentKey,
      anchor: versionsOf,
      userOffset: 0,
      complete: false,
      branchesUnloaded: branch.length !== nodes.length,
      hasHistory: nodes.some((node) => node.isMessage || node.isGoalState),
      priorGoalIds: [],
      versions: { total: siblingIndices.length, leaves },
      ...(scope.live ? { live: scope.live } : {}),
      ...(scope.authority ? { authority: scope.authority } : {}),
      // Always a replacement: never splice siblings onto a cached branch.
      mode: "replace",
    },
  };
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
  /**
   * Allow the page to start inside a turn, for a turn no page can hold whole.
   * Entry-unit only: a turn window already starts at a prompt (see the walk).
   */
  splitTurns = false,
  /** `{ versionsOf }` only: how many siblings to carry, named entry included. */
  versionLimit?: number,
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
  if ("versionsOf" in request) {
    return planVersionsWindow(nodes, byId, branch, leafId, request.versionsOf, scope, versionLimit ?? HISTORY_PAGE_ENTRY_LIMIT);
  }
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
    // One walk, two units. A turn window counts **user messages** — everything
    // between two of them belongs to the later turn, and the prompt that
    // anchors the oldest turn is part of the page it anchors, so a page always
    // begins at a prompt and never halfway through an exchange (M16-T90). An
    // entry window counts messages of any role and then aligns to the same
    // boundary afterwards. A compaction, a goal record or a reply is never an
    // anchor in either unit: only a user message on the rendered branch is.
    const turns = windowTurns(request);
    const counting = turns === undefined
      ? (node: HistoryWindowNode) => node.isMessage
      : (node: HistoryWindowNode) => node.isUser;
    const budget = turns ?? windowEntries(request);
    let counted = 0;
    start = end;
    while (start > 0 && counted < budget) if (counting(nodes[branch[--start]!]!)) counted++;
    if (turns === undefined) {
      // A tool result cannot be separated from its call, or an assistant action
      // from its prompt. A single unusually long turn may exceed the row target.
      // A turn too large for any page (a long agent run) splits between an
      // assistant action and the next, never between a call and its result.
      if (splitTurns) while (start > 0 && start < end && nodes[branch[start]!]!.isToolResult) start--;
      else while (start > 0 && !nodes[branch[start]!]!.isUser) start--;
    }
    // `splitTurns` is an entry-unit instruction and is deliberately not applied
    // above: a turn window's page already begins at a prompt, so there is no
    // turn boundary left to split. A turn too large for any page is paged from
    // inside itself in **rows** — `fitHistoryWindowPlan` asks for that fallback
    // in the entry unit — so the flag reaches this walk only for those plans.
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
      // The cursor, and with it the answer to "is there more": present exactly
      // when this page does not reach the root of the rendered branch. The
      // reference design asks for one **turn** beyond the page; this walk knows
      // something stricter and cheaper — whether any older **row** remains — and
      // that difference is deliberate (M16-T90). When the rows before a page
      // hold no further prompt (a goal run, an assistant-only prologue), the
      // control still offers them, the next page returns them and reports the
      // root, and paging always terminates. Do not "correct" this to count
      // turns: a prologue with no prompt in it would become unreachable.
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
 * The turns a request counts in, or undefined when it counts entries.
 *
 * A count outside the contract is refused rather than reinterpreted. The wire
 * schema owns that contract (`1..HISTORY_PAGE_TURN_MAX`), so anything else here
 * came from inside this process: answering it as "forty entries" would hide a
 * defect behind a different question.
 */
export function windowTurns(request: HistoryWindowRequest): number | undefined {
  if (!("turns" in request)) return undefined;
  const turns = request.turns;
  if (!Number.isInteger(turns) || turns < 1 || turns > HISTORY_PAGE_TURN_MAX) {
    throw new Error(`A history window asked for ${String(turns)} turns; the contract is 1 to ${HISTORY_PAGE_TURN_MAX}.`);
  }
  return turns;
}

/** The messages an entry-counted request asks for. */
function windowEntries(request: HistoryWindowRequest): number {
  return "tail" in request ? request.tail : "limit" in request ? request.limit ?? 40 : 40;
}

/**
 * A request for the newest page — the only shape a proved delta may answer.
 *
 * Turn and entry windows are the same question asked in different units, so a
 * client that pages in turns keeps the append-delta reply a client that pages
 * in entries already had.
 */
export function isLiveEdgeWindow(request: HistoryWindowRequest): boolean {
  if ("before" in request || "beforeEntry" in request || "from" in request || "all" in request || "versionsOf" in request) return false;
  return "tail" in request || "turns" in request;
}

/** The same request asked for a smaller page, in one unit or the other. */
function windowWithCount(request: HistoryWindowRequest, unit: "turns" | "entries", count: number): HistoryWindowRequest {
  if ("before" in request) return unit === "turns" ? { before: request.before, turns: count } : { before: request.before, limit: count };
  if ("beforeEntry" in request) return unit === "turns" ? { beforeEntry: request.beforeEntry, turns: count } : { beforeEntry: request.beforeEntry, limit: count };
  return unit === "turns" ? { turns: count } : { tail: count };
}

/**
 * Keep an exact request shape while fitting a page inside the wire ceilings.
 *
 * Three steps, and the last one always answers something: the request as asked;
 * then fewer of whatever it counted — turns for a turn window, messages for an
 * entry window — at complete-turn boundaries; then, only when not even one turn
 * fits, a page *inside* that turn, counted in rows. A byte or row ceiling can
 * therefore shrink a page and can never refuse one (M16-T90). `all` and `from`
 * are indivisible: callers must refuse them when their exact projection is too
 * large. `{ versionsOf }` shrinks (fewer siblings) and is never refused.
 * Every search is logarithmic, never one full branch replan per count.
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

  if ("versionsOf" in request) {
    const total = initial.window.versions?.total ?? 1;
    let low = 1;
    let high = Math.min(total, HISTORY_PAGE_ENTRY_LIMIT) - 1;
    let best: HistoryWindowPlan | undefined;
    while (low <= high) {
      const count = low + Math.floor((high - low) / 2);
      const candidate = historyWindowPlan(nodes, leafId, request, scope, false, count);
      if (fits(candidate)) {
        best = candidate;
        low = count + 1;
      } else {
        high = count - 1;
      }
    }
    return best;
  }

  const search = (unit: "turns" | "entries", maximum: number, splitTurns: boolean): HistoryWindowPlan | undefined => {
    let low = 1;
    let high = maximum;
    let best: HistoryWindowPlan | undefined;
    while (low <= high) {
      const count = low + Math.floor((high - low) / 2);
      const candidate = historyWindowPlan(nodes, leafId, windowWithCount(request, unit, count), scope, splitTurns);
      if (fits(candidate)) {
        best = candidate;
        low = count + 1;
      } else {
        high = count - 1;
      }
    }
    return best;
  };

  const turns = windowTurns(request);
  const asked = turns === undefined
    ? Math.min(windowEntries(request), HISTORY_PAGE_ENTRY_LIMIT)
    : Math.min(turns, HISTORY_PAGE_TURN_MAX);
  const fewer = search(turns === undefined ? "entries" : "turns", asked - 1, false);
  if (fewer) return fewer;

  // Not even the newest complete turn fits: page inside it rather than leave
  // the conversation unreadable. Older pages continue from the cursor, so a
  // split turn is still read whole, one page at a time.
  return search("entries", turns === undefined ? asked : HISTORY_PAGE_ENTRY_LIMIT, true);
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
 * still readable a page at a time. A record that travels is the stored record
 * with its images as references (M16-T89) and is otherwise never rewritten.
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
  // One cache for this one page: the search below projects the same rows several
  // times, and a picture must be hashed once, not once per attempt. It dies with
  // this synchronous call, so no record can change underneath it (M16-T89).
  const cache = createImageReferenceCache();
  const elide = (indices: readonly number[], recordLimit: number): { entries: unknown[]; elided: unknown[] } =>
    elideOversizedEntries(indices.map(index => snapshot.entries[index]), bodies!.limit, bodies!.digest, recordLimit, cache);
  const fitsAt = (recordLimit: number) => (candidate: HistoryWindowPlan): boolean => {
    if (!bodies) return historyWindowFits(snapshot, candidate);
    const page = elide(candidate.entryIndices, recordLimit);
    const context = elide(candidate.contextIndices, recordLimit);
    if (page.entries.length + page.elided.length > HISTORY_PAGE_ENTRY_LIMIT) return false;
    return historyContentSerializedBytes(page.entries, context.entries)
      + historyContentSerializedBytes(page.elided, context.elided) <= HISTORY_PAGE_BYTE_LIMIT;
  };
  // The first ceiling that lets this page fit. Ordinary pages settle on the
  // first one and pay a single search; only a page carrying something enormous
  // beside its neighbour goes further (M16-T88).
  let plan: HistoryWindowPlan | undefined;
  let recordLimit = ELIDED_RECORD_LIMITS[0]!;
  for (const limit of bodies ? ELIDED_RECORD_LIMITS : [ELIDED_RECORD_LIMITS[0]!]) {
    recordLimit = limit;
    plan = fitHistoryWindowPlan(nodes, snapshot.leafId, request, scope, fitsAt(limit));
    if (plan) break;
  }
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
        "versionsOf" in request ? request
          : "before" in request ? { before: request.before, limit: 1 }
            : "beforeEntry" in request ? { beforeEntry: request.beforeEntry, limit: 1 }
              : { tail: 1 },
        scope,
        true,
        "versionsOf" in request ? 1 : undefined,
      );
      const page = elide(smallest.entryIndices, ELIDED_RECORD_LIMITS.at(-1)!);
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
  return bodies ? withElidedBodies(materialized, bodies.limit, bodies.digest, recordLimit, cache) : materialized;
}

/** Apply RP-5b's per-body limit to an already materialized page. */
export function withElidedBodies(
  page: { entries: unknown[]; leafId: string | null; window: HistoryWindow },
  bodyLimit: number | undefined,
  digest: (text: string) => string,
  recordLimit = ELIDED_RECORD_MAX_BYTES,
  /** The page being served; a fresh one per call, and it dies with the call. */
  cache: ImageReferenceCache = createImageReferenceCache(),
): { entries: unknown[]; leafId: string | null; window: HistoryWindow } {
  const selected = elideOversizedEntries(page.entries, bodyLimit, digest, recordLimit, cache);
  const context = elideOversizedEntries(page.window.context, bodyLimit, digest, recordLimit, cache);
  const elided = [...selected.elided, ...context.elided];
  return {
    entries: selected.entries,
    leafId: page.leafId,
    window: { ...page.window, context: context.entries, ...(elided.length > 0 ? { elided } : {}) },
  };
}
