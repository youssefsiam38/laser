/**
 * What a capture must say, derived from the record rather than from itself
 * (M21-T19, review F2).
 *
 * A capture proves a decision only if it is a capture **of that decision's
 * link**. Checking a capture against its own fields answers a weaker question:
 * a capture of another repository, another ref, another path, another base or
 * another attempt is perfectly self-consistent and proves nothing about the
 * link it happens to hang off.
 *
 * So the expected facts are derived here, once, from what is **persisted** —
 * the repository link and, when it names one, the attempt record the host
 * wrote from git when that attempt closed. Never from git now: a decision made
 * in March must read the same way in June, after retention has pruned the
 * checkpoint it came from, and a fact that depends on what git still holds is
 * exactly the fact D-361 exists to replace. Never from a request either: a
 * caller cannot hand in the expectation its own proof is checked against.
 *
 * One derivation, three readers: the Native evaluator, the decision gates and
 * the delivery door all ask this module what the capture has to say.
 */
import type {
  ExecutionLink,
  RepositoryCaptureBasis,
  RepositoryChangeRef,
  RepositoryLink,
  RepositoryStateRef,
} from "@lasercode/protocol";

/** Enough of the store to derive expectations. Reads only. */
export interface RequiredFactsStore {
  executionLink(projectId: string, linkId: string): ExecutionLink | undefined;
}

/** The shape of a link this derivation needs. A persisted link is one; so is a validated delivery payload. */
export interface RequiredFactsLink {
  repositoryId: string;
  target: { state: RepositoryStateRef } | { change: RepositoryChangeRef };
  /** The attempt the link records, when it records one. */
  executionLinkId?: string | undefined;
}

/** What a capture of that link must say about itself. */
export interface ExpectedRequiredFacts {
  repositoryId: string;
  target: { state: RepositoryStateRef } | { change: RepositoryChangeRef };
  /** The bases this link shape allows. Anything else is a capture of something else. */
  bases: RepositoryCaptureBasis[];
  /**
   * The commit the required difference must have been taken from, when the
   * record knows it: the attempt's own recorded base for a state that came out
   * of an attempt, the change's own base for an accepted delivery.
   *
   * Absent for `commit_parent_to_commit`, whose base is the commit's parent
   * and is therefore a fact about git rather than about the record.
   */
  baseCommitObjectId?: string;
  /** The scope a `complete_bounded_state` capture must name: the link's own path. */
  scopePath?: string;
  executionLinkId?: string;
  taskEntityId?: string;
  /**
   * Set when the record the expectation needs is not there — an attempt id
   * that is not this project's, or one that recorded nothing about this
   * repository. Nothing is assumed in its place: a capture checked against an
   * unresolved expectation is never complete, and a gate says this sentence.
   */
  unresolved?: string;
}

/** Which bases a link of this shape may honestly have been captured on. */
function basesFor(link: RequiredFactsLink): RepositoryCaptureBasis[] {
  if ("change" in link.target) return ["accepted_change"];
  // A state is captured from the attempt it came out of, from its own parent
  // when it has one, or — when nothing changed at all — as the whole of one
  // bounded scope.
  return ["attempt_base_to_state", "commit_parent_to_commit", "complete_bounded_state"];
}

/**
 * The facts the capture of one link must carry, read out of the store.
 *
 * `unresolved` rather than a throw: two of the three callers are predicates
 * inside an evaluation, and an evaluation answers "not proven" — it does not
 * fail a whole verification run because a record is missing. The gate that
 * wants a sentence reads the field.
 */
export function expectedRequiredFacts(store: RequiredFactsStore, projectId: string, link: RequiredFactsLink): ExpectedRequiredFacts {
  const bases = basesFor(link);
  const base: ExpectedRequiredFacts = {
    repositoryId: link.repositoryId,
    target: link.target,
    bases,
    ...("change" in link.target ? { baseCommitObjectId: link.target.change.base.commitObjectId } : {}),
    ...(scopeOf(link) !== undefined ? { scopePath: scopeOf(link) as string } : {}),
    ...(link.executionLinkId ? { executionLinkId: link.executionLinkId } : {}),
  };
  if (!link.executionLinkId) return base;

  const attempt = store.executionLink(projectId, link.executionLinkId);
  if (!attempt) {
    return { ...base, unresolved: "the attempt it names is not one this project has" };
  }
  const facts: ExpectedRequiredFacts = { ...base, taskEntityId: attempt.entityId };
  if ("change" in link.target) return facts;

  const record = attempt.repositories?.find((row) => row.repositoryId === link.repositoryId);
  if (!record) {
    return { ...facts, unresolved: "that attempt recorded nothing about this repository" };
  }
  return { ...facts, baseCommitObjectId: record.base.commitObjectId };
}

/** The bounded scope a link names, when it names one. */
function scopeOf(link: RequiredFactsLink): string | undefined {
  return "change" in link.target ? link.target.change.head.path : link.target.state.path;
}

/**
 * Are two states the same exact state, field for field?
 *
 * Every fence the shape carries, including the ones that are usually absent:
 * a blob id or a content digest on one side and not on the other is two
 * different claims about the same commit, and "mostly the same" is not a
 * property proof has.
 */
export function sameState(a: RepositoryStateRef, b: RepositoryStateRef): boolean {
  return (
    a.commitObjectId === b.commitObjectId &&
    a.vcs === b.vcs &&
    a.objectFormat === b.objectFormat &&
    a.checkpointId === b.checkpointId &&
    a.path === b.path &&
    a.blobObjectId === b.blobObjectId &&
    a.contentDigest === b.contentDigest
  );
}

/** Are two changes the same exact change, both ends and the digest that fences them? */
export function sameChange(a: RepositoryChangeRef, b: RepositoryChangeRef): boolean {
  return sameState(a.base, b.base) && sameState(a.head, b.head) && a.diffDigest === b.diffDigest;
}
