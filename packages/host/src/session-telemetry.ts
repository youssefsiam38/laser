/**
 * Durable whole-session telemetry. The worker answers when the session is
 * live; this answers from the stored conversation without starting one.
 *
 * The fold is the same function the worker runs, built during the session
 * index scan so a warm 27 MB session is not re-read.
 */
import { closeSync, fstatSync, openSync, readSync, type Stats } from "node:fs";
import {
  ErrorCodes,
  ProtocolError,
  TelemetryFold,
  sessionTelemetryOf,
  turnEntryIndices,
  type ClientRequests,
  type SessionTelemetry,
  type TelemetryChildSource,
  type TelemetryLiveOverlay,
  type TelemetrySection,
} from "@lasercode/protocol";
import type { AgentRunRegistry } from "./agents/runs.js";
import type { FileIdentity, IndexedEntry, SessionIndex, SessionIndexCache, SessionIndexFailure } from "./session-index.js";
import type { SessionRevisions } from "./session-revision.js";

export type TelemetryResult = ClientRequests["pi/session/telemetry"]["result"];

export type TelemetryAnswer =
  | { kind: "answer"; result: TelemetryResult }
  | { kind: "route-live"; reason: SessionIndexFailure }
  | { kind: "refuse"; error: ProtocolError };

export interface SessionTelemetryOptions {
  index: SessionIndexCache;
  revisions: SessionRevisions;
  runs?: AgentRunRegistry | undefined;
  /** Test seam: one callback per child session whose fold is merged. */
  onChildFold?: ((path: string) => void) | undefined;
}

export class SessionTelemetryReader {
  constructor(private readonly options: SessionTelemetryOptions) {}

  async read(path: string, params: ClientRequests["pi/session/telemetry"]["params"]): Promise<TelemetryAnswer> {
    if (params.environmentKey !== undefined && params.environmentKey !== this.options.revisions.environmentKey) {
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
    if (params.revision !== undefined && params.revision !== revision) {
      return { kind: "refuse", error: staleRevision() };
    }

    const fence = {
      revision,
      environmentKey: this.options.revisions.environmentKey,
      authority: "durable" as const,
    };
    const include = params.include;
    const scope = params.scope ?? "session";

    if (scope === "turn") {
      const turnId = params.turnId;
      if (!turnId) return { kind: "refuse", error: new ProtocolError(ErrorCodes.InvalidParams, "A turn-scoped telemetry read names the turn.") };
      const values = readAllRecords(path, index);
      if (values.kind !== "ok") {
        this.options.index.invalidate(path);
        return { kind: "refuse", error: values.kind === "changed" ? changed() : unavailable() };
      }
      const slice = turnEntryIndices(values.values, index.leafId, turnId);
      if (!slice) {
        return { kind: "refuse", error: new ProtocolError(ErrorCodes.InvalidParams, "That turn is not part of this conversation any more.") };
      }
      const fold = TelemetryFold.create();
      for (const entryIndex of slice) fold.push(values.values[entryIndex]);
      return {
        kind: "answer",
        result: sessionTelemetryOf(fold.state, fence, {
          ...(include ? { include } : {}),
          scope: "turn",
          turnId,
        }),
      };
    }

    const children = await this.childSources(path);
    return {
      kind: "answer",
      result: sessionTelemetryOf(index.telemetry, fence, {
        ...(include ? { include } : {}),
        scope: "session",
        ...(children.length > 0 ? { children } : {}),
      }),
    };
  }

  private async childSources(rootPath: string): Promise<TelemetryChildSource[]> {
    const runs = this.options.runs?.list(rootPath) ?? [];
    const seen = new Set<string>();
    const children: TelemetryChildSource[] = [];
    for (const run of runs) {
      if (run.sessionPath === rootPath || seen.has(run.sessionPath)) continue;
      seen.add(run.sessionPath);
      const model = run.model ? `${run.model.provider}/${run.model.id}` : undefined;
      const indexed = await this.options.index.read(run.sessionPath);
      if (!indexed.ok) {
        children.push(model ? { model } : {});
        continue;
      }
      this.options.onChildFold?.(run.sessionPath);
      children.push({ ...(model ? { model } : {}), fold: indexed.index.telemetry });
    }
    return children;
  }
}

/** Shared with the live worker so a test can compare both authorities. */
export function telemetryFromEntries(
  entries: readonly unknown[],
  fence: { revision: string; environmentKey: string; authority: "live" | "durable" },
  options: {
    include?: readonly TelemetrySection[];
    children?: readonly TelemetryChildSource[];
    overlay?: TelemetryLiveOverlay;
  } = {},
): SessionTelemetry {
  const fold = TelemetryFold.create();
  fold.ingest(entries);
  return sessionTelemetryOf(fold.state, fence, options);
}

type RecordRead = { kind: "ok"; values: unknown[] } | { kind: "changed" } | { kind: "unreadable" };

function readAllRecords(path: string, index: SessionIndex): RecordRead {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { kind: "unreadable" };
  }
  try {
    if (!sameIdentity(index.identity, fstatSync(fd))) return { kind: "changed" };
    const values: unknown[] = [];
    for (const row of index.entries) {
      const value = readRow(fd, row);
      if (value === undefined) return { kind: "changed" };
      values.push(value);
    }
    if (!sameIdentity(index.identity, fstatSync(fd))) return { kind: "changed" };
    return { kind: "ok", values };
  } catch {
    return { kind: "unreadable" };
  } finally {
    closeSync(fd);
  }
}

function readRow(fd: number, row: IndexedEntry): unknown | undefined {
  const buffer = Buffer.alloc(row.length);
  if (readSync(fd, buffer, 0, row.length, row.offset) !== row.length) return undefined;
  const text = buffer.toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sameIdentity(expected: FileIdentity, actual: Stats): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino && expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs && expected.ctimeMs === actual.ctimeMs;
}

function staleRevision(): ProtocolError {
  return new ProtocolError(
    ErrorCodes.RevisionUnavailable,
    "This conversation moved on since that reading. Open it again to see the rest.",
  );
}

function foreignEnvironment(): ProtocolError {
  return new ProtocolError(ErrorCodes.InvalidParams, "That conversation belongs to a different connection.");
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

