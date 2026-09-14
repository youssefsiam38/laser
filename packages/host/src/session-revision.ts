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
import { ErrorCodes, ProtocolError, environmentKeyOf, environmentTagOf, isEnvironmentKey, isSessionRevision, sessionRevisionOf, type ClientRequests, type RevisionBase, type RevisionState } from "@lasercode/protocol";
import { nodeRevisionHasher } from "@lasercode/protocol/revision-node";
import type { SessionIndex, SessionIndexCache, SessionIndexFailure } from "./session-index.js";

export interface SessionRevisionsOptions {
  index: SessionIndexCache;
  /** The single trusted identity input; the public key and revision tag are derived together. */
  environmentId: string;
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

export interface ResolvedRevisionBase {
  base: RevisionBase;
  /** Present only when the current file proves this exact state. */
  state?: RevisionState;
}

export class SessionRevisions {
  private readonly tag: string;
  private readonly key: string;

  constructor(private readonly options: SessionRevisionsOptions) {
    this.tag = environmentTagOf(nodeRevisionHasher, options.environmentId);
    this.key = environmentKeyOf(nodeRevisionHasher, options.environmentId);
  }

  /** The durable revision of a stored conversation, with no worker involved. */
  async read(path: string, baseRevision?: string): Promise<RevisionAnswer> {
    const result = await this.options.index.read(path);
    if (!result.ok) {
      return routable(result.failure.reason)
        ? { kind: "route-live", reason: result.failure }
        : { kind: "refuse", error: refusal(result.failure) };
    }
    const { index } = result;
    const revision = this.revisionOf(index);
    const base = baseRevision === undefined ? undefined : this.resolveBase(index, baseRevision).base;
    return { kind: "answer", result: { revision, environmentKey: this.key, authority: "durable", ...(base ? { base } : {}) } };
  }

  /**
   * Accept a live answer only when it is shaped for, and cryptographically
   * tagged to, this host's environment. An unconfigured or mismatched worker
   * is unavailable; letting it poison a device cache would be worse.
   */
  validateLive(value: unknown): ClientRequests["session/revision"]["result"] {
    const result = value as Partial<ClientRequests["session/revision"]["result"]> | null;
    const base = result?.base;
    if (!result || result.authority !== "live" ||
        (base !== undefined && base !== "current" && base !== "prefix" && base !== "stale")) this.liveMismatch();
    this.validateBinding(result.revision, result.environmentKey);
    return { revision: result.revision!, environmentKey: result.environmentKey!, authority: "live", ...(base ? { base } : {}) };
  }

  /** Validate a worker-produced history window without teaching Router token parsing. */
  validateWindow<T>(value: T): T {
    const window = (value as { window?: { revision?: unknown; environmentKey?: unknown; authority?: unknown; mode?: unknown } } | null)?.window;
    if (!window || window.authority !== "live" || (window.mode !== "replace" && window.mode !== "delta")) this.liveMismatch();
    this.validateBinding(window.revision, window.environmentKey);
    return value;
  }

  /** Session load revisions are optional only when canonicalisation itself was unavailable. */
  validateLoad<T>(value: T): T {
    const result = value as { revision?: unknown; environmentKey?: unknown } | null;
    if (result?.revision !== undefined || result?.environmentKey !== undefined) {
      this.validateBinding(result.revision, result.environmentKey);
    }
    return value;
  }

  private validateBinding(revision: unknown, environmentKey: unknown): void {
    if (!isEnvironmentKey(environmentKey) || environmentKey !== this.key || !isSessionRevision(revision) ||
        !revision.startsWith(`r1.${this.tag}.`)) this.liveMismatch();
  }

  private liveMismatch(): never {
    throw new ProtocolError(
      ErrorCodes.RevisionUnavailable,
      "This conversation's live revision does not belong to this host. Restart the app and try again.",
    );
  }

  /** The same bound revision used by both the revision and projection routes. */
  revisionOf(index: SessionIndex): string {
    return sessionRevisionOf(nodeRevisionHasher, this.tag, index.state);
  }

  get environmentKey(): string {
    return this.key;
  }

  /** Return the exact checkpoint behind a proved delta, never merely equality. */
  resolveBase(index: SessionIndex, baseRevision: string): ResolvedRevisionBase {
    if (this.revisionOf(index) === baseRevision) return { base: "current", state: index.state };
    const branch = branchIds(index);
    for (const candidate of [...index.checkpoints].reverse()) {
      if (candidate.count > index.state.count) continue;
      if (sessionRevisionOf(nodeRevisionHasher, this.tag, candidate) !== baseRevision) continue;
      if ((candidate.barrierCount ?? 0) !== (index.state.barrierCount ?? 0)) return { base: "stale" };
      return candidate.leafId === null
        ? (index.leafId === null ? { base: "prefix", state: candidate } : { base: "stale" })
        : (branch.has(candidate.leafId) ? { base: "prefix", state: candidate } : { base: "stale" });
    }
    return { base: "stale" };
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
  return reason === "unsupported-version" || reason === "too-large" || reason === "changed" ||
    reason === "not-a-session" || reason === "unreadable";
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
