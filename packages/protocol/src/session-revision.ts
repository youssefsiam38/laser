/**
 * Durable session revisions (RP-9).
 *
 * A revision is an opaque token for "the renderable state of this conversation
 * in this environment". Clients compare it for equality and never parse it.
 * It is derived from content only — no path, no mtime, no process identity —
 * so the same stored conversation produces the same revision after a worker
 * restart, a host restart, or a read served from disk instead of a live engine.
 *
 * The value is a chain, folded over the session's entries **in file order**:
 *
 *   H₀ = hash("r1|h|" + headerToken)
 *   Hₖ = hash(Hₖ₋₁ + "|e|" + canonicalJson(entryₖ))
 *   revision = "r1." + envTag + "." + hash("r1|s|" + Hₙ + "|" + n + "|" + leaf)
 *
 * File order rather than branch order is what makes the fold resumable from a
 * byte offset: an append only ever hashes the new bytes. Branch identity is
 * still exact, because `(entry set, leaf)` determines the rendered branch.
 *
 * Because each Hₖ is the state after exactly k entries, a client's earlier
 * revision can be *proved* to be a canonical prefix of the current one — not
 * merely "different" — which is what makes a delta safe (see
 * `classifyBaseRevision`). Equality alone would only be a cache probe.
 *
 * This module is pure and imports nothing: the UI bundles it through the
 * package barrel. The hash is injected (`RevisionHasher`); Node callers get one
 * from `@lasercode/protocol/revision-node`.
 */

/** Algorithm generation. Changing anything below changes this, and every revision with it. */
export const SESSION_REVISION_VERSION = "r1";
/** Environment-key generation, kept separate: the key outlives a revision format. */
export const ENVIRONMENT_KEY_VERSION = "e1";

/** base64url of SHA-256 over a UTF-8 string. */
export type RevisionHasher = (text: string) => string;

/** A value no honest canonicalisation can represent (a function, a bigint, NaN). */
export class RevisionCanonicalisationError extends Error {
  override readonly name = "RevisionCanonicalisationError";
}

/**
 * Deterministic JSON with sorted keys.
 *
 * Both producers feed this plain JSON values — the host parses a line from the
 * file, the worker holds the objects the engine parsed from the same line — so
 * equal content must produce equal bytes. `JSON.stringify` is reused for
 * strings and numbers because its escaping and shortest-number forms are
 * specified, and therefore identical on both sides.
 */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  writeCanonical(value, out);
  return out.join("");
}

function writeCanonical(value: unknown, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) throw new RevisionCanonicalisationError("a non-finite number cannot be part of a revision");
      out.push(JSON.stringify(value));
      return;
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "object":
      break;
    default:
      throw new RevisionCanonicalisationError(`a ${typeof value} cannot be part of a revision`);
  }
  const object = value as { toJSON?: unknown };
  if (typeof object.toJSON === "function") {
    writeCanonical((object.toJSON as () => unknown).call(object), out);
    return;
  }
  if (Array.isArray(value)) {
    out.push("[");
    value.forEach((item, index) => {
      if (index > 0) out.push(",");
      // `JSON.stringify` writes null for a hole or an unrepresentable member.
      if (item === undefined || typeof item === "function" || typeof item === "symbol") out.push("null");
      else writeCanonical(item, out);
    });
    out.push("]");
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  out.push("{");
  let written = 0;
  for (const key of keys) {
    const member = record[key];
    // Absent and `undefined` are the same thing on the wire, and a file can
    // only ever carry "absent": both sides must agree to drop it.
    if (member === undefined || typeof member === "function" || typeof member === "symbol") continue;
    if (written++ > 0) out.push(",");
    out.push(JSON.stringify(key), ":");
    writeCanonical(member, out);
  }
  out.push("}");
}

/** The session file's header, as both readers see it. */
export interface SessionRevisionHeader {
  id: string;
  cwd: string;
  parentSession?: string | undefined;
  version?: number | undefined;
}

/** Session identity, folded before the first entry. */
export function sessionHeaderToken(header: SessionRevisionHeader): string {
  return [header.id, header.cwd, header.parentSession ?? "", String(header.version ?? 1)].join("\u0000");
}

/** The fold after some number of entries. Small, serialisable, resumable. */
export interface RevisionFoldState {
  digest: string;
  count: number;
}

/** The fold plus the branch pointer: everything a revision is computed from. */
export interface RevisionState extends RevisionFoldState {
  leafId: string | null;
}

/** Incremental content fold. Appending costs one hash per new entry, never a re-read. */
export class RevisionFold {
  private constructor(
    private readonly hash: RevisionHasher,
    private digestValue: string,
    private countValue: number,
  ) {}

  static create(hash: RevisionHasher, header: SessionRevisionHeader): RevisionFold {
    return new RevisionFold(hash, hash(`${SESSION_REVISION_VERSION}|h|${sessionHeaderToken(header)}`), 0);
  }

  /** Continue a fold captured earlier (a cached index, a live tracker). */
  static resume(hash: RevisionHasher, state: RevisionFoldState): RevisionFold {
    return new RevisionFold(hash, state.digest, state.count);
  }

  push(entry: unknown): void {
    this.digestValue = this.hash(`${this.digestValue}|e|${canonicalJson(entry)}`);
    this.countValue += 1;
  }

  get state(): RevisionFoldState {
    return { digest: this.digestValue, count: this.countValue };
  }
}

function environmentDigest(hash: RevisionHasher, environmentId: string): string {
  return hash(`${SESSION_REVISION_VERSION}|envkey|${environmentId}`);
}

/**
 * The public, opaque environment key (132 bits): non-secret, stable for the
 * life of the environment's state directory, and irreversible. Device caches
 * key by this; the raw environment id never leaves the host and worker.
 */
export function environmentKeyOf(hash: RevisionHasher, environmentId: string): string {
  return `${ENVIRONMENT_KEY_VERSION}.${environmentDigest(hash, environmentId).slice(0, 22)}`;
}

/** The revision's environment binding: a prefix of the same digest the key publishes. */
export function environmentTagOf(hash: RevisionHasher, environmentId: string): string {
  return environmentDigest(hash, environmentId).slice(0, 8);
}

export const ENVIRONMENT_KEY_PATTERN = /^e1\.[A-Za-z0-9_-]{22}$/;
export const SESSION_REVISION_PATTERN = /^r1\.[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]{27}$/;

export function isEnvironmentKey(value: unknown): value is string {
  return typeof value === "string" && ENVIRONMENT_KEY_PATTERN.test(value);
}

export function isSessionRevision(value: unknown): value is string {
  return typeof value === "string" && SESSION_REVISION_PATTERN.test(value);
}

/** The opaque revision for one exact state. */
export function sessionRevisionOf(hash: RevisionHasher, environmentTag: string, state: RevisionState): string {
  const final = hash(`${SESSION_REVISION_VERSION}|s|${state.digest}|${state.count}|${state.leafId ?? ""}`);
  return `${SESSION_REVISION_VERSION}.${environmentTag}.${final.slice(0, 27)}`;
}

/**
 * How a client's cached revision relates to the current state.
 *
 * - `current` — the same state; nothing to send.
 * - `prefix`  — the cached state is a *proved* canonical prefix of the current
 *   branch: the same first k entries (the fold covers their canonical bytes)
 *   and a leaf that is still an ancestor of the live one. Only this may be
 *   answered with a suffix.
 * - `stale`   — anything else: an edit, a fork, a jump, a compaction rewrite, a
 *   base older than the retained candidates, or a different environment. The
 *   answer must be an atomic replacement, never a merge.
 */
export type RevisionBase = "current" | "prefix" | "stale";

export function classifyBaseRevision(options: {
  hash: RevisionHasher;
  environmentTag: string;
  baseRevision: string;
  current: RevisionState;
  /** States this producer can still prove, newest last. Bounded and purely derived. */
  candidates: Iterable<RevisionState>;
  /** Whether a leaf is on the current branch (ancestor-or-self of the live leaf). */
  onBranch: (leafId: string | null) => boolean;
}): RevisionBase {
  const { hash, environmentTag, baseRevision, current } = options;
  if (sessionRevisionOf(hash, environmentTag, current) === baseRevision) return "current";
  for (const candidate of options.candidates) {
    if (candidate.count > current.count) continue;
    if (sessionRevisionOf(hash, environmentTag, candidate) !== baseRevision) continue;
    return options.onBranch(candidate.leafId) ? "prefix" : "stale";
  }
  return "stale";
}
