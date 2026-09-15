/**
 * Worker-free reads of one body of one stored entry (RP-5b).
 *
 * A surface holds a bounded excerpt of a large reply, tool result or image and
 * reads the rest here, a slice at a time. This reader owns exactly that: it
 * plans over the identity rows RP-12's index already keeps, opens the stored
 * conversation once, reads the one record it was asked about, and answers a
 * code-point-aligned slice of one named body.
 *
 * It never starts a worker, never writes, never repairs and never says
 * anything about how a conversation is stored: no path, no line, no offset
 * into a file leaves this module. A caller that asks at a revision this host
 * is not serving is refused rather than quietly answered from another state.
 */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, type Stats } from "node:fs";
import {
  ErrorCodes,
  ProtocolError,
  bodyRangeSlice,
  historyWindowNode,
  type BodyComponent,
  type BodyComponentKind,
  type ClientRequests,
} from "@lasercode/protocol";
import type { FileIdentity, IndexedEntry, SessionIndex, SessionIndexCache, SessionIndexFailure } from "./session-index.js";
import type { SessionRevisions } from "./session-revision.js";

export type BodyRangeResult = ClientRequests["session/entry_range"]["result"];

export type BodyRangeAnswer =
  | { kind: "answer"; result: BodyRangeResult }
  | { kind: "route-live"; reason: SessionIndexFailure }
  | { kind: "refuse"; error: ProtocolError };

export interface SessionBodyRangeOptions {
  index: SessionIndexCache;
  revisions: SessionRevisions;
  /** Test seam: one callback per stored record actually read. */
  onRead?: ((entry: IndexedEntry) => void) | undefined;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class SessionBodyRange {
  constructor(private readonly options: SessionBodyRangeOptions) {}

  async read(path: string, params: ClientRequests["session/entry_range"]["params"]): Promise<BodyRangeAnswer> {
    if (params.environmentKey !== this.options.revisions.environmentKey) {
      return { kind: "refuse", error: foreignEnvironment() };
    }
    const indexed = await this.options.index.read(path);
    if (!indexed.ok) {
      return indexed.failure.reason === "unsupported-version"
        ? { kind: "route-live", reason: indexed.failure }
        : { kind: "refuse", error: refusal(indexed.failure) };
    }
    const index = indexed.index;
    const revision = this.options.revisions.revisionOf(index);
    // The caller asked about one exact state. Serving another one's bytes
    // under its offsets would be a silent lie, so it is refused instead.
    if (revision !== params.revision) return { kind: "refuse", error: staleRevision() };

    const rowIndex = index.entries.findIndex((entry) => entry.id === params.entryId);
    if (rowIndex < 0) return { kind: "refuse", error: unknownEntry() };
    const row = index.entries[rowIndex]!;
    this.options.onRead?.(row);
    const value = readRecord(path, index, row);
    if (value.kind === "changed") {
      this.options.index.invalidate(path);
      return { kind: "refuse", error: changed() };
    }
    if (value.kind === "unreadable") return { kind: "refuse", error: unavailable() };
    return sliceAnswer(value.value, params, revision, "durable");
  }
}

/**
 * The shared shape of an answer, so the live worker route and this one cannot
 * disagree about totals, digests, boundaries or refusals.
 */
export function sliceAnswer(
  entry: unknown,
  params: ClientRequests["session/entry_range"]["params"],
  revision: string,
  authority: "live" | "durable",
): BodyRangeAnswer {
  const sliced = bodyRangeSlice(entry, params, revision, authority, sha256Hex);
  if (sliced.ok) return { kind: "answer", result: sliced.result };
  return {
    kind: "refuse",
    error: sliced.refusal.reason === "bad-range" ? badRange() : unknownComponent(params.component, sliced.refusal.available),
  };
}

type Record_ = { kind: "ok"; value: unknown } | { kind: "changed" } | { kind: "unreadable" };

function readRecord(path: string, index: SessionIndex, row: IndexedEntry): Record_ {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { kind: "unreadable" };
  }
  try {
    if (!sameIdentity(index.identity, fstatSync(fd))) return { kind: "changed" };
    const buffer = Buffer.alloc(row.length);
    if (readSync(fd, buffer, 0, row.length, row.offset) !== row.length) return { kind: "changed" };
    const text = buffer.toString("utf8");
    if (!text.trimStart().startsWith("{")) return { kind: "changed" };
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { kind: "changed" };
    }
    if (historyWindowNode(value).id !== row.id) return { kind: "changed" };
    if (!sameIdentity(index.identity, fstatSync(fd))) return { kind: "changed" };
    return { kind: "ok", value };
  } catch {
    return { kind: "unreadable" };
  } finally {
    closeSync(fd);
  }
}

function sameIdentity(expected: FileIdentity, actual: Stats): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino && expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs && expected.ctimeMs === actual.ctimeMs;
}

function staleRevision(): ProtocolError {
  return new ProtocolError(
    ErrorCodes.RevisionUnavailable,
    "This conversation moved on since that message was read. Open it again to see the rest.",
  );
}

function foreignEnvironment(): ProtocolError {
  return new ProtocolError(ErrorCodes.InvalidParams, "That conversation belongs to a different connection.");
}

function unknownEntry(): ProtocolError {
  return new ProtocolError(ErrorCodes.InvalidParams, "That message is not part of this conversation any more.");
}

function unknownComponent(component: BodyComponent, available: readonly BodyComponentKind[]): ProtocolError {
  // Names only: what this record *does* carry, never any of its content.
  return new ProtocolError(
    ErrorCodes.InvalidParams,
    `That message has no ${component.kind.replaceAll("_", " ")} to read.`,
    { available: [...available] },
  );
}

function badRange(): ProtocolError {
  return new ProtocolError(ErrorCodes.InvalidParams, "That is not a readable part of this message. Open it again from the start.");
}

function changed(): ProtocolError {
  return new ProtocolError(ErrorCodes.InvalidParams, "This history changed. Reload the conversation and try again.");
}

function unavailable(): ProtocolError {
  return new ProtocolError(
    ErrorCodes.RevisionUnavailable,
    "This conversation could not be read as it is stored right now. Open it again, and restart the app if it keeps happening.",
  );
}

function refusal(failure: SessionIndexFailure): ProtocolError {
  if (failure.reason === "missing" || failure.reason === "not-a-session") {
    return new ProtocolError(ErrorCodes.SessionNotFound, "This conversation is no longer stored here.");
  }
  return unavailable();
}
