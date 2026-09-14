/**
 * The live half of the durable revision contract (RP-9).
 *
 * The same fold the host runs over a stored conversation, run here over the
 * engine's own entries, so a session that is open and the same session read
 * from disk after the worker is gone produce the *same* value. That equality
 * is the whole point: without it a cached view would be invalidated by a
 * restart rather than by a change.
 *
 * Two things this must get right:
 *
 * - The engine's array is append-only, so the fold is kept between calls and
 *   only new entries are hashed. A prefix that is no longer the one we folded
 *   (a fork re-keyed the session, a compaction rewrote it) restarts the fold
 *   rather than extending a chain that no longer describes the file.
 * - A live leaf can sit behind the last entry (a navigation that has appended
 *   nothing). Such a state exists only in this process, so the revisions this
 *   worker actually issued are remembered, bounded, and offered as candidates
 *   when a client asks what its cached revision is worth.
 */
import {
  RevisionFold,
  classifyBaseRevision,
  environmentKeyOf,
  environmentTagOf,
  sessionRevisionOf,
  type RevisionBase,
  type RevisionState,
  type SessionRevisionHeader,
} from "@lasercode/protocol";
import { nodeRevisionHasher } from "@lasercode/protocol/revision-node";

/** How far back a client's cached revision can still be proved a prefix. */
const CHECKPOINTS_MAX = 512;
/** States this process issued that the durable leaf rule cannot reconstruct. */
const ISSUED_MAX = 64;

const entryId = (entry: unknown): string | undefined => {
  const id = (entry as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : undefined;
};

export interface SessionRevisionResult {
  revision: string;
  environmentKey: string;
  state: RevisionState;
}

/** One conversation's fold, checkpoints and issued states. */
export class SessionRevisionTracker {
  private readonly hash = nodeRevisionHasher;
  private readonly tag: string;
  private readonly key: string;
  private headerToken: string | undefined;
  private fold: RevisionFold | undefined;
  private foldedCount = 0;
  private foldedLastId: string | undefined;
  private readonly checkpoints: RevisionState[] = [];
  private readonly issued: RevisionState[] = [];

  constructor(environmentId: string) {
    this.tag = environmentTagOf(nodeRevisionHasher, environmentId);
    this.key = environmentKeyOf(nodeRevisionHasher, environmentId);
  }

  get environmentKey(): string {
    return this.key;
  }

  /** The revision for exactly these entries and this leaf. Throws only if a record cannot be canonicalised. */
  compute(header: SessionRevisionHeader, entries: readonly unknown[], leafId: string | null): SessionRevisionResult {
    const token = JSON.stringify([header.id, header.cwd, header.parentSession ?? "", header.version ?? 1]);
    const reusable =
      this.fold !== undefined &&
      this.headerToken === token &&
      entries.length >= this.foldedCount &&
      (this.foldedCount === 0 || entryId(entries[this.foldedCount - 1]) === this.foldedLastId);
    if (!reusable) this.restart(header, token);
    for (let index = this.foldedCount; index < entries.length; index++) {
      const entry = entries[index];
      this.fold!.push(entry);
      this.foldedCount = index + 1;
      this.foldedLastId = entryId(entry);
      // The state a worker-free reader would see after this entry: the file's
      // own leaf rule is "the last entry read". Keeping these lets a client's
      // older revision be proved a prefix instead of merely disbelieved.
      this.remember(this.checkpoints, { ...this.fold!.state, leafId: this.foldedLastId ?? null }, CHECKPOINTS_MAX);
    }
    const state: RevisionState = { ...this.fold!.state, leafId };
    const revision = sessionRevisionOf(this.hash, this.tag, state);
    if (leafId !== (this.foldedLastId ?? null)) this.remember(this.issued, state, ISSUED_MAX);
    return { revision, environmentKey: this.key, state };
  }

  /** What a client's cached revision is worth against these entries. */
  classify(baseRevision: string, header: SessionRevisionHeader, entries: readonly unknown[], leafId: string | null): RevisionBase {
    const { state } = this.compute(header, entries, leafId);
    const branch = branchIds(entries, leafId);
    return classifyBaseRevision({
      hash: this.hash,
      environmentTag: this.tag,
      baseRevision,
      current: state,
      candidates: [...this.issued, ...this.checkpoints],
      onBranch: (candidate) => candidate === null ? leafId === null : branch.has(candidate),
    });
  }

  private restart(header: SessionRevisionHeader, token: string): void {
    this.headerToken = token;
    this.fold = RevisionFold.create(this.hash, header);
    this.foldedCount = 0;
    this.foldedLastId = undefined;
    this.checkpoints.length = 0;
    this.issued.length = 0;
  }

  private remember(ring: RevisionState[], state: RevisionState, limit: number): void {
    ring.push(state);
    if (ring.length > limit) ring.splice(0, ring.length - limit);
  }
}

/** Every entry from the root to the leaf: the states a delta may extend. */
export function branchIds(entries: readonly unknown[], leafId: string | null): Set<string> {
  const byId = new Map<string, unknown>();
  for (const entry of entries) {
    const id = entryId(entry);
    if (id !== undefined) byId.set(id, entry);
  }
  const ids = new Set<string>();
  let id: string | null | undefined = leafId;
  while (typeof id === "string" && !ids.has(id)) {
    const entry = byId.get(id);
    if (!entry) break;
    ids.add(id);
    const parent = (entry as { parentId?: unknown }).parentId;
    id = typeof parent === "string" ? parent : null;
  }
  return ids;
}
