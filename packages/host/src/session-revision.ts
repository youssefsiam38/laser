/**
 * Durable revisions, answered by the host itself (RP-9).
 *
 * "Available without opening a worker" is the whole point: a client that wants
 * to know whether its cached view is still current must not pay a 500 ms
 * process start to be told "yes". The worker that owns a live session is still
 * the authority when there is one — its leaf can sit where no reader of the
 * file could know — so this only answers for conversations nobody is driving.
 *
 * `classify` is not a string comparison dressed up as a delta. A base revision
 * matches a *checkpoint*: the fold after exactly k records. Matching it proves
 * those k records are byte-for-byte the canonical prefix of what is stored now,
 * because any rewrite inside them changes the chain. Only then is the leaf
 * checked for still being on the branch. Everything else is `stale`, and an
 * edit, fork, jump or compaction is always `stale`.
 */
import { ErrorCodes, ProtocolError, classifyBaseRevision, environmentTagOf, sessionRevisionOf, type ClientRequests, type RevisionState } from "@lasercode/protocol";
import { nodeRevisionHasher } from "@lasercode/protocol/revision-node";
import type { SessionIndex, SessionIndexCache, SessionIndexFailure } from "./session-index.js";

export interface SessionRevisionsOptions {
  index: SessionIndexCache;
  /** Trusted processes only; never published. Its derived key is what clients see. */
  environmentId: string;
  environmentKey: string;
}

/**
 * What the host could make of a stored conversation on its own.
 *
 * `route-live` is not a failure: an older session format the engine would
 * rewrite on open, a file past a hard bound, or one being rewritten while we
 * read it are all cases where the engine can answer and this cannot. Saying so
 * is honest; guessing, or pretending a worker-free read happened, would not be.
 */
export type RevisionAnswer =
  | { kind: "answer"; result: ClientRequests["session/revision"]["result"] }
  | { kind: "route-live"; reason: SessionIndexFailure }
  | { kind: "refuse"; error: ProtocolError };

export class SessionRevisions {
  private readonly tag: string;

  constructor(private readonly options: SessionRevisionsOptions) {
    this.tag = environmentTagOf(nodeRevisionHasher, options.environmentId);
  }

  /** The durable revision of a stored conversation, with no worker involved. */
  read(path: string, baseRevision?: string): RevisionAnswer {
    const result = this.options.index.read(path);
    if (!result.ok) {
      return routable(result.failure.reason)
        ? { kind: "route-live", reason: result.failure }
        : { kind: "refuse", error: refusal(result.failure) };
    }
    const { index } = result;
    const revision = sessionRevisionOf(nodeRevisionHasher, this.tag, index.state);
    const base = baseRevision === undefined ? undefined : this.classify(index, baseRevision);
    return { kind: "answer", result: { revision, environmentKey: this.options.environmentKey, authority: "durable", ...(base ? { base } : {}) } };
  }

  private classify(index: SessionIndex, baseRevision: string): "current" | "prefix" | "stale" {
    const branch = branchIds(index);
    return classifyBaseRevision({
      hash: nodeRevisionHasher,
      environmentTag: this.tag,
      baseRevision,
      current: index.state,
      // Newest first: a client's cache is usually one or two appends behind.
      candidates: [...index.checkpoints].reverse() satisfies RevisionState[],
      onBranch: (leafId) => leafId === null ? index.leafId === null : branch.has(leafId),
    });
  }

  /** Drop a cached index (the file was forked, compacted, moved or deleted). */
  invalidate(path: string): void {
    this.options.index.invalidate(path);
  }

  /** Accounted identity bytes held for reading, and for which conversations. Diagnostics only. */
  get bytes(): number {
    return this.options.index.bytes;
  }

  paths(): string[] {
    return this.options.index.paths();
  }
}

/** Root-to-leaf identities: the states a later view may legitimately extend. */
function branchIds(index: SessionIndex): Set<string> {
  const parents = new Map<string, string | null>();
  for (const entry of index.entries) if (entry.id !== undefined) parents.set(entry.id, entry.parentId);
  const ids = new Set<string>();
  let id = index.leafId;
  while (id !== null && !ids.has(id)) {
    if (!parents.has(id)) break;
    ids.add(id);
    id = parents.get(id) ?? null;
  }
  return ids;
}

/** Cases the engine can still answer: ask it rather than refusing the person. */
function routable(reason: SessionIndexFailure["reason"]): boolean {
  return reason === "unsupported-version" || reason === "too-large" || reason === "changed";
}

/**
 * Every refusal says what a person can do about it. A conversation that is
 * gone is not the same thing as one this host cannot read, and neither is ever
 * reported as a valid revision.
 */
function refusal(failure: SessionIndexFailure): ProtocolError {
  switch (failure.reason) {
    case "missing":
      return new ProtocolError(ErrorCodes.SessionNotFound, "This conversation is no longer stored here.");
    case "not-a-session":
      return new ProtocolError(ErrorCodes.SessionNotFound, "That file is not a conversation this app can read.");
    default:
      return new ProtocolError(
        ErrorCodes.RevisionUnavailable,
        "This conversation could not be read as it is stored right now. Open it again, and restart the app if it keeps happening.",
      );
  }
}
