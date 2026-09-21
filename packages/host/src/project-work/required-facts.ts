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
   * Absent only where the record holds no base at all: a state link with no
   * attempt behind it, whose difference can only be its own parent's.
   *
   * When it is present it is checked, whatever basis the capture claims. A
   * basis does not get to exempt itself from the check by naming a different
   * pair of commits.
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

/**
 * Which bases a link of this shape may honestly have been captured on —
 * decided by what the **record** knows, never by the capture itself.
 *
 * The distinction that matters is whether the record holds a base of its own:
 *
 * - **A state the record ties to an attempt** was captured from that
 *   attempt's recorded base, or — when nothing changed between the two at all
 *   — as the whole of one bounded scope, whose `from` still names that same
 *   base. `commit_parent_to_commit` is *not* one of its options: the parent of
 *   the last commit of a five-commit attempt is a perfectly self-consistent
 *   base that quietly drops four commits' worth of the work the decision is
 *   about, and a basis must never be able to select its own exemption from the
 *   base check.
 * - **A state with no attempt behind it** has no recorded base to be checked
 *   against, so its own parent is the only honest difference it has, and a
 *   claim to have been taken from an attempt is a claim this record cannot
 *   support.
 * - **An accepted delivery** is its own `base → head`, and — when that
 *   difference is empty — the complete bounded scope that keeps a person's
 *   review of unchanged code honest. Both name the change's own base.
 */
function basesFor(link: RequiredFactsLink, attemptBacked: boolean): RepositoryCaptureBasis[] {
  if ("change" in link.target) return ["accepted_change", "complete_bounded_state"];
  if (attemptBacked) return ["attempt_base_to_state", "complete_bounded_state"];
  return ["commit_parent_to_commit", "complete_bounded_state"];
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
  const base: ExpectedRequiredFacts = {
    repositoryId: link.repositoryId,
    target: link.target,
    // Provisional: a state link that names an attempt has its bases decided
    // below, once the record it names has actually been read.
    bases: basesFor(link, false),
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
  // The record holds a base for this repository, so that base is the authority
  // this capture is checked against — and the bases it may claim are the two
  // that are taken from it.
  return { ...facts, bases: basesFor(link, true), baseCommitObjectId: record.base.commitObjectId };
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
