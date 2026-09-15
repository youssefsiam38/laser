/**
 * Which canonical records this view keeps, and which it only points at (RP-5b).
 *
 * A record whose every body fits the excerpt bound is kept exactly as it came:
 * an opaque, complete entry, the same bytes the authority produced. A record
 * carrying a larger body is **not rewritten** — it is not kept at all. What
 * stays is a {@link EntryStub}: its identity, its place in the tree, and the
 * exact size of every body it has. That is the whole difference between a
 * bounded cache and a lossy second copy of somebody else's transcript.
 *
 * The producer can do the same thing on the wire (`bodyLimit` and
 * `window.elided`), and this module folds those in identically — so a page
 * from a host that does not know about the option, or a live update that
 * arrives whole, is bounded here just the same.
 *
 * Pure: no React, no DOM, no network, no allocation proportional to a body.
 */
import { entryBodies, entryToolCalls, utf8ByteLength, type BodyComponent, type ElidedEntry } from "@lasercode/protocol";
import { BODY_EXCERPT_MAX_BYTES } from "./body-excerpt.js";

/**
 * A record this view points at instead of holding. Identity and shape only:
 * there is no body here, and nothing here is presented as an entry.
 */
export interface EntryStub {
  id: string;
  parentId: string | null;
  type: string;
  role?: string;
  /** The call a `toolResult` answers, so its row finds its tool. */
  toolCallId?: string;
  /** The calls an assistant record made, so their rows survive the elision. */
  toolCalls?: Array<{ id: string; name: string }>;
  at?: string;
  bodies: Array<{ component: BodyComponent; totalBytes: number; contentDigest?: string }>;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const timestampOf = (value: Record<string, unknown>): string | undefined => {
  const at = value.timestamp ?? record(value.message).timestamp;
  return typeof at === "string" ? at : undefined;
};

/** The stub for one oversized record. */
export function stubOf(entry: unknown, bodies = entryBodies(entry)): EntryStub | undefined {
  const value = record(entry);
  if (typeof value.id !== "string" || value.id === "") return undefined;
  const message = record(value.message);
  return {
    id: value.id,
    parentId: typeof value.parentId === "string" ? value.parentId : null,
    type: typeof value.type === "string" ? value.type : "",
    ...(typeof message.role === "string" ? { role: message.role } : {}),
    ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
    ...(entryToolCalls(entry).length > 0 ? { toolCalls: entryToolCalls(entry) } : {}),
    ...(timestampOf(value) ? { at: timestampOf(value)! } : {}),
    bodies: bodies.map((body) => ({ component: body.component, totalBytes: utf8ByteLength(body.text) })),
  };
}

/** A wire-elided record, as this view keeps it. The two shapes are the same thing. */
export function stubOfElided(elided: ElidedEntry): EntryStub {
  return {
    id: elided.id,
    parentId: elided.parentId,
    type: elided.type,
    ...(elided.role !== undefined ? { role: elided.role } : {}),
    ...(elided.toolCallId !== undefined ? { toolCallId: elided.toolCallId } : {}),
    ...(elided.toolCalls ? { toolCalls: elided.toolCalls } : {}),
    bodies: elided.bodies.map((body) => ({ component: body.component, totalBytes: body.totalBytes, contentDigest: body.contentDigest })),
  };
}

export interface Retained {
  entries: unknown[];
  stubs: EntryStub[];
}

/**
 * Split incoming records into the ones this view keeps and the ones it points
 * at. The incoming array is read once and dropped by the caller; nothing here
 * copies a body.
 */
export function retainEntries(entries: readonly unknown[], maxBytes = BODY_EXCERPT_MAX_BYTES): Retained {
  const kept: unknown[] = [];
  const stubs: EntryStub[] = [];
  for (const entry of entries) {
    const bodies = entryBodies(entry);
    let oversized = false;
    for (const body of bodies) {
      if (utf8ByteLength(body.text) > maxBytes) { oversized = true; break; }
    }
    if (!oversized) { kept.push(entry); continue; }
    const stub = stubOf(entry, bodies);
    // A record with no identity cannot be pointed at, so it is kept as it is:
    // dropping it would lose a row nothing could ever read back.
    if (stub) stubs.push(stub); else kept.push(entry);
  }
  return { entries: kept, stubs };
}

/** Merge two retained sets by identity, newest wins, order preserved. */
export function mergeStubs(existing: readonly EntryStub[], incoming: readonly EntryStub[]): EntryStub[] {
  if (existing.length === 0) return [...incoming];
  if (incoming.length === 0) return [...existing];
  const byId = new Map<string, EntryStub>();
  for (const stub of existing) byId.set(stub.id, stub);
  for (const stub of incoming) byId.set(stub.id, stub);
  return [...byId.values()];
}

/** A row of the conversation as this view holds it: a record, or a pointer to one. */
export type RetainedRow = { kind: "entry"; id: string | undefined; value: unknown } | { kind: "stub"; id: string; value: EntryStub };

/**
 * Every row in the order the conversation has, records and stubs together.
 *
 * Records keep the order the authority sent them. A stub is placed directly
 * after its parent — the tree's own order — and a stub whose parent is not on
 * this page goes first, where the page's older end is.
 */
export function retainedRows(entries: readonly unknown[], stubs: readonly EntryStub[]): RetainedRow[] {
  if (stubs.length === 0) return entries.map((value) => ({ kind: "entry", id: idOf(value), value }));
  const pending = new Map<string, EntryStub[]>();
  const leading: EntryStub[] = [];
  const known = new Set<string>();
  for (const entry of entries) { const id = idOf(entry); if (id) known.add(id); }
  for (const stub of stubs) known.add(stub.id);
  for (const stub of stubs) {
    const parent = stub.parentId;
    if (parent && known.has(parent)) {
      const rows = pending.get(parent) ?? [];
      rows.push(stub);
      pending.set(parent, rows);
    } else leading.push(stub);
  }
  const rows: RetainedRow[] = leading.map((stub) => ({ kind: "stub", id: stub.id, value: stub }));
  const emit = (id: string | undefined): void => {
    if (!id) return;
    for (const stub of pending.get(id) ?? []) {
      rows.push({ kind: "stub", id: stub.id, value: stub });
      pending.delete(id);
      emit(stub.id);
    }
  };
  for (const entry of entries) {
    const id = idOf(entry);
    rows.push({ kind: "entry", id, value: entry });
    emit(id);
  }
  // Anything whose parent never appeared still belongs to the conversation.
  for (const rest of pending.values()) for (const stub of rest) rows.push({ kind: "stub", id: stub.id, value: stub });
  return rows;
}

/** Identity rows for the branch walk: a stub is a node like any other. */
export function retainedNodes(entries: readonly unknown[], stubs: readonly EntryStub[]): unknown[] {
  if (stubs.length === 0) return [...entries];
  return retainedRows(entries, stubs).map((row) =>
    row.kind === "entry" ? row.value : { type: row.value.type, id: row.value.id, parentId: row.value.parentId, message: { role: row.value.role } });
}

function idOf(entry: unknown): string | undefined {
  const id = record(entry).id;
  return typeof id === "string" && id !== "" ? id : undefined;
}
