/**
 * Repository provenance at a decision: attempts, `based_on`, delivery,
 * acceptance and durability (M21-T18, M21-T19, D-345, D-361).
 *
 * This is the orchestration that stands between a request and the store: the
 * part that has to **read git**, decide whether what a caller named is really
 * there, and keep a bounded canonical record of it *before* anything is
 * accepted. It was living in `methods.ts`, which is the routing authority and
 * had grown past a thousand lines around it (review F4); it is the same code,
 * moved, with one explicit dependency — the store and the caller — rather than
 * a class it happened to be a method of.
 *
 * The rule the whole file exists for is one sentence of the leap: **a
 * repository link a decision rests on must remain reviewable.** Git is not a
 * promise — an M20 checkpoint ref is pruned by routine retention and its
 * parentless commit is then unreachable — so:
 *
 * 1. the host validates what a caller named, against git, at write time;
 * 2. it stores the bounded capture **before** the decision's transaction, and
 *    a full budget refuses the decision instead of accepting a claim;
 * 3. everything afterwards reads the **stored** record, never git. Re-reading
 *    git at review time fails exactly when retention has done its job.
 */
import {
  type AttemptRepositoryRecord,
  type ProjectTaskLinkExecutionParams,
  type ProjectWorkGetParams,
  type ProjectWorkGetResult,
  type ProjectWorkLinkParams,
  type ProjectWorkLinkResult,
  type ProjectWorkOrigin,
  type ProjectWorkWriteResult,
  type RepositoryLink,
  type RepositoryLinkAcceptance,
  type RepositoryLinkAvailability,
  type RepositoryStateRef,
} from "@lasercode/protocol";
import { checkpointSessionKey, diffBetween, listCheckpointRefs, type HostRepository } from "../source-control/read.js";
import {
  attemptRepositoryFacts,
  currentStates,
  identifyRepositories,
  linkAvailability,
  repositoryFor,
  type IdentifiedRepository,
} from "./delivery.js";
import {
  buildCapture,
  buildStateCapture,
  captureReadable,
  evidenceUnreviewable,
  readCapture,
  requiredComplete,
  selectRequired,
  storeCapture,
  type RequiredOrigin,
  type StoredCapture,
} from "./captures.js";
import { ProjectWorkRefusedError } from "./errors.js";
import { expectedRequiredFacts } from "./required-facts.js";
import { gatherAuthorities, readerOf } from "./verification/authorities.js";
import type { DecisionProofPreparation, DecisionProofRef, ProjectWorkStore } from "./store.js";

/** Who is asking, and where git is read for them. */
export interface GateCaller {
  /** The checkout this call is being made from, when it has one. */
  cwd?: string | undefined;
  /** What the store records for this caller's writes. */
  origin: ProjectWorkOrigin;
}

export interface GateContext {
  store: ProjectWorkStore;
  caller: GateCaller;
  now?: () => string;
}

/** One place git is read, one place a capture is taken, one place a gate refuses. */
export class ProjectWorkGate {
  private readonly store: ProjectWorkStore;
  private readonly caller: GateCaller;
  private readonly now: () => string;

  constructor(context: GateContext) {
    this.store = context.store;
    this.caller = context.caller;
    this.now = context.now ?? (() => new Date().toISOString());
  }

  // ------------------------------------------------------------------ reads

  /**
   * One detail read, plus — when it was asked for — what git still has.
   *
   * `repositoryStatus` is opt-in because it spawns git per repository, and
   * because the answer it gives is never needed to *read* a link: a link says
   * what it always said. It is needed to say whether that can still be looked
   * at, which is a different question and gets a different field.
   */
  async get(params: ProjectWorkGetParams): Promise<ProjectWorkGetResult> {
    const detail = this.store.get({
      projectId: params.projectId,
      ...(params.entityId !== undefined ? { entityId: params.entityId } : {}),
      ...(params.key !== undefined ? { key: params.key } : {}),
      ...(params.revisionId !== undefined ? { revisionId: params.revisionId } : {}),
      ...(params.body ? { body: params.body } : {}),
      ...(params.include ? { include: params.include } : {}),
    });
    // The capture history is a bounded store read and no git at all, so it is
    // answered on its own: asking which proof was current when must not cost a
    // git spawn per repository (D-363). One page, bounded across the whole
    // response and scoped to the links this read is about — and answered even
    // for an entity with no repository links at all, because "what did this
    // approval rest on" has an answer there too, and it is "nothing".
    const history =
      params.include?.captureHistory !== undefined
        ? this.store.captureHistoryPage(params.projectId, {
            ...params.include.captureHistory,
            linkIds: detail.repositoryLinks.map((link) => link.linkId),
            entityId: detail.entity.entityId,
          })
        : undefined;
    if (detail.repositoryLinks.length === 0 || params.include?.repositoryStatus !== true) {
      return history ? { ...detail, captureHistory: history } : detail;
    }
    const repositories = await this.repositories(params.projectId);
    const status: RepositoryLinkAvailability[] = [];
    // Serialized on purpose for now: bounded concurrency over a forty-repo
    // workspace is a performance change with its own measurements, deferred
    // to M21-T22 rather than smuggled in beside a correctness fix (review F8).
    for (const link of detail.repositoryLinks) {
      status.push(
        await linkAvailability(link, repositoryFor(repositories, link.repositoryId)?.repository, captureReadable(this.store, params.projectId, link)),
      );
    }
    return { ...detail, repositoryStatus: status, ...(history ? { captureHistory: history } : {}) };
  }

  /**
   * The checkout git is read in for this call.
   *
   * The worker bridge names the directory the attempt runs in; a client call
   * is answered from the project's own current folder. Neither one decides
   * *which* project may be changed — that is resolved before this runs.
   */
  checkout(projectId: string): string | undefined {
    return this.caller.cwd ?? this.store.projectPaths(projectId)[0];
  }

  async repositories(projectId: string): Promise<IdentifiedRepository[]> {
    const checkout = this.checkout(projectId);
    if (!checkout) return [];
    return identifyRepositories(this.store, projectId, checkout);
  }

  // --------------------------------------------------------------- attempts

  /**
   * What this attempt's repositories did, read from git (M21-T18).
   *
   * Never fatal: a checkout that is not a repository, a git that will not run
   * or a workspace that has moved leaves the attempt with its identity, its
   * profile and its outcome, and no repository record — which is honest. What
   * it must never do is guess.
   *
   * The open attempt it reads facts from is **this caller's own**: the
   * checkpoint namespace the session is reading is what tells two concurrent
   * attempts on one Task apart, and recency never stands in for identity
   * (review F2).
   */
  async attemptFacts(params: ProjectTaskLinkExecutionParams): Promise<{ repositories?: AttemptRepositoryRecord[]; checkpointKey?: string }> {
    const checkout = this.checkout(params.projectId);
    if (!checkout) return {};
    const named = params.execution.sessionPath ? checkpointSessionKey(params.execution.sessionPath) : undefined;
    const open = this.store.openAttemptFor(
      params.projectId,
      params.entityId,
      params.execution.kind,
      params.execution.targetId,
      named,
    );
    const checkpointKey = named ?? (open ? this.store.attemptCheckpointKey(params.projectId, open.linkId) : undefined);
    try {
      const repositories = await attemptRepositoryFacts(this.store, {
        projectId: params.projectId,
        checkout,
        startedAt: open?.startedAt ?? params.execution.startedAt ?? this.now(),
        ...(params.execution.endedAt ? { endedAt: params.execution.endedAt } : {}),
        ...(checkpointKey ? { sessionKey: checkpointKey } : {}),
        ...(open?.repositories ? { previous: open.repositories } : {}),
        ...(params.execution.baseCommitObjectId ?? open?.baseCommitObjectId
          ? { baseCommitObjectId: (params.execution.baseCommitObjectId ?? open?.baseCommitObjectId) as string }
          : {}),
      });
      return {
        ...(repositories.length > 0 ? { repositories } : {}),
        ...(checkpointKey ? { checkpointKey } : {}),
      };
    } catch {
      return checkpointKey ? { checkpointKey } : {};
    }
  }

  /**
   * The code state a revision was derived from (M21-T18).
   *
   * Recorded for a write made from a session with a checkout — the worker
   * bridge — as one `based_on` link per repository, at the exact commit each
   * one was on. A person editing a Spec in the workspace has no session
   * checkout and gets none: inventing the project folder's current `HEAD` as
   * "what this was derived from" would be a guess, and this record exists
   * because guesses are what it replaces.
   *
   * Research is the one kind that is left out, and for a reason rather than
   * for cost: a finding's provenance is the `SourceRef` it was read from, not
   * the code that happened to be checked out while the agent read a web page.
   *
   * A failure here never undoes the revision: provenance is a record beside
   * the work, not a condition of it.
   */
  async recordBasedOn(result: ProjectWorkWriteResult, projectId: string, idempotencyKey: string): Promise<ProjectWorkWriteResult> {
    if (this.caller.cwd === undefined || result.replayed === true || result.entity.kind === "research") return result;
    let states: Awaited<ReturnType<typeof currentStates>>;
    try {
      states = await currentStates(this.store, projectId, this.caller.cwd);
    } catch {
      return result;
    }
    const links: RepositoryLink[] = [];
    for (const row of states) {
      try {
        const written = this.store.link({
          projectId,
          expectedRevisionId: result.revision.revisionId,
          link: {
            type: "repository",
            relation: "based_on",
            subjectEntityId: result.entity.entityId,
            subjectRevisionId: result.revision.revisionId,
            repositoryId: row.repositoryId,
            target: { state: row.state },
            ...(row.branch ? { display: { branch: row.branch } } : {}),
          },
          origin: this.caller.origin,
          idempotencyKey: `${idempotencyKey}-based-on-${row.repositoryId}`,
        });
        if (written.link.type === "repository") links.push(written.link.repository);
      } catch {
        // The revision is written and current; its provenance is best effort.
      }
    }
    return links.length > 0 ? { ...result, basedOn: links } : result;
  }

  // --------------------------------------------------------------- delivery

  /**
   * Accept one exact repository change as the delivery of this work.
   *
   * The whole of the leap's `implemented_by` rule lives in these steps, in
   * this order:
   *
   * 1. **A person accepts delivery.** An agent reports evidence and proposes;
   *    it never decides that what it wrote is what was wanted (D-332).
   * 2. **The change is checked against git**, not taken on trust: the
   *    repository must be one this project knows and has open here, both ends
   *    must exist, and the diff digest must be the digest of the diff that is
   *    actually there.
   * 3. **The canonical capture is stored before the acceptance is written.** A
   *    full durable budget refuses the whole thing — there is no accepted
   *    delivery whose evidence was never kept.
   * 4. **The links are appended**, one per accepted subject revision, and a
   *    correction supersedes without removing anything.
   */
  async acceptDelivery(params: ProjectWorkLinkParams): Promise<ProjectWorkLinkResult> {
    if (params.link.type !== "delivery") throw new ProjectWorkRefusedError("That is not a delivery.");
    const payload = params.link;
    if (this.caller.origin.actor.kind !== "person") {
      throw new ProjectWorkRefusedError(
        "Only a person accepts a change as the delivery of a task. Report the evidence for it and ask for review instead.",
      );
    }
    const repository = await this.repositoryOrRefuse(params.projectId, payload.repositoryId);
    const diff = await diffBetween(repository, payload.change.base.commitObjectId, payload.change.head.commitObjectId);
    if (!diff) {
      throw new ProjectWorkRefusedError(
        "That change is not in the repository any more, so it cannot be accepted as the delivery. Pick a change that is still there — a commit, or a checkpoint that has not been pruned.",
      );
    }
    if (diff.digest !== payload.change.diffDigest) {
      throw new ProjectWorkRefusedError(
        "That change is not what it was when you looked at it. Look at the difference again, then accept it.",
      );
    }
    // What the capture will have to say, derived from the record before it is
    // taken: the same authority the evaluator and the decision gates use
    // (review F2). An attempt id the store does not hold is refused here,
    // before a single byte is read, rather than written into a provenance
    // nobody can check afterwards.
    const expected = expectedRequiredFacts(this.store, params.projectId, {
      repositoryId: payload.repositoryId,
      target: { change: payload.change },
      ...(payload.executionLinkId ? { executionLinkId: payload.executionLinkId } : {}),
    });
    if (expected.unresolved !== undefined) {
      throw new ProjectWorkRefusedError(
        `That delivery names an attempt this project cannot read it against — ${expected.unresolved}. ` +
          "Accept the change from the task's own attempt, which knows the work behind it.",
      );
    }
    // Accepting delivery is a decision, so it rests on every source it
    // touched, kept whole. An honestly partial capture is good provenance and
    // is never good enough for this (M21-T19).
    const required = await selectRequired({
      repository,
      origin: {
        basis: "accepted_change",
        base: payload.change.base.commitObjectId,
        ...(payload.executionLinkId ? { executionLinkId: payload.executionLinkId } : {}),
        ...(expected.taskEntityId ? { taskEntityId: expected.taskEntityId } : {}),
        ...(payload.change.head.path !== undefined ? { scopePath: payload.change.head.path } : {}),
      },
      at: payload.change.head.commitObjectId,
    });
    const built = await buildCapture({
      repository,
      repositoryId: payload.repositoryId,
      change: payload.change,
      now: this.now(),
      required,
    });
    if (!built) {
      throw new ProjectWorkRefusedError(
        "That change could not be read out of the repository, so there would be nothing to review later. Try again, or pick a change that is still there.",
      );
    }
    // And the capture that was taken is checked against that same expectation
    // before it is stored: a capture that does not prove this exact link is
    // not evidence of this delivery, whatever it is a faithful record of.
    if (!requiredComplete(built, expected)) {
      throw new ProjectWorkRefusedError(
        "What was read out of the repository does not prove this exact change, so accepting it would record evidence of something else. " +
          "Look at the difference again, then accept it.",
      );
    }
    const capture: StoredCapture = storeCapture(this.store, {
      projectId: params.projectId,
      entityId: payload.entityId,
      capture: built,
      gate: "Accepting this delivery",
    });
    return this.store.link({
      projectId: params.projectId,
      expectedRevisionId: params.expectedRevisionId,
      link: payload,
      capture,
      origin: this.caller.origin,
      idempotencyKey: params.idempotencyKey,
    });
  }

  // ------------------------------------------------- verified_at and native

  /**
   * Everything the host has to establish before a `verified_at` state is
   * written (D-361).
   *
   * **Every** such write is validated and captured, not only the ones that ask
   * to be native evidence. The invariant is worth more than the saving: a
   * state link that named a commit nobody ever had, or one whose checkpoint
   * git no longer holds, would sit in the record looking exactly like proof.
   *
   * On top of that, a write that *asks* for `acceptance` gets the person's
   * act checked, in full:
   *
   * - only a **person** may ask;
   * - the subject must be the entity's **current** revision, and the digest
   *   the store holds for it — a preview accepted against a revision the work
   *   has moved past proves nothing about what it says now;
   * - the `checkpointId` must be a ref git really has, **resolving to the
   *   named commit** — that a commit merely exists is not the test, because a
   *   commit id can be borrowed from anywhere in the repository;
   * - the capture is stored first, and a budget refusal accepts nothing.
   *
   * What is stored as the acceptance is the host's own finding, never the
   * caller's field.
   */
  async prepareVerifiedAt(input: {
    projectId: string;
    entityId: string;
    revisionId: string;
    repositoryId: string;
    state: RepositoryStateRef;
    acceptance?: { kind: "checkpoint_preview" } | undefined;
    /** Which attempt this state came out of, as the caller reports it. */
    attempt?: { taskEntityId: string; executionLinkId: string } | undefined;
  }): Promise<{ captureBlobId: string; acceptance?: RepositoryLinkAcceptance; executionLinkId?: string }> {
    const wantsAcceptance = input.acceptance !== undefined;
    if (wantsAcceptance && this.caller.origin.actor.kind !== "person") {
      throw new ProjectWorkRefusedError(
        "Only a person accepts a checkpoint preview as native visual evidence. Report what you saw as evidence instead.",
      );
    }
    if (wantsAcceptance && input.attempt === undefined) {
      throw new ProjectWorkRefusedError(
        "Accepting a build as native evidence says which attempt's work you looked at, and this did not name one. " +
          "Record your review from the task's own verification panel, which knows the attempt behind each checkpoint.",
      );
    }
    const repository = await this.repositoryOrRefuse(input.projectId, input.repositoryId);

    let checkpointRef: string | undefined;
    if (input.state.checkpointId !== undefined) {
      // The ref, and the commit that ref points at. Both, together: a
      // checkpoint id that names a ref git does not have, or one that points
      // somewhere else, is a fabricated provenance and is refused.
      const refs = await listCheckpointRefs(repository);
      const found = refs.find((row) => row.ref === input.state.checkpointId);
      if (!found) {
        throw new ProjectWorkRefusedError(
          "That checkpoint is not one this repository has, so it cannot stand as evidence. Pick a checkpoint that is still there and record it again.",
        );
      }
      if (found.commitObjectId !== input.state.commitObjectId) {
        throw new ProjectWorkRefusedError(
          "That checkpoint no longer points at the state you are recording. Look at the checkpoint again, then record it.",
        );
      }
      checkpointRef = found.ref;
    }
    if (wantsAcceptance && checkpointRef === undefined) {
      throw new ProjectWorkRefusedError(
        "Native visual evidence is a checkpoint preview you accepted, so it has to name the checkpoint it was taken from.",
      );
    }

    // Whoever is asking, and whether or not they asked for an acceptance:
    // everything that could refuse this write is settled here, before a single
    // byte is stored. A refused decision costs no quota and leaves no blob.
    const subject = this.store.refFor(input.projectId, input.entityId);
    if (wantsAcceptance && subject.revisionId !== input.revisionId) {
      throw new ProjectWorkRefusedError(
        `${subject.key} has moved on since that preview was made, so accepting it would say something about a revision nobody looked at. Look at the current revision and accept a preview of it.`,
      );
    }
    const required = input.attempt
      ? this.attemptOrigin({
          projectId: input.projectId,
          subjectEntityId: input.entityId,
          subjectRevisionId: input.revisionId,
          repositoryId: input.repositoryId,
          state: input.state,
          attempt: input.attempt,
        })
      : undefined;

    const built = await buildStateCapture({
      repository,
      repositoryId: input.repositoryId,
      state: input.state,
      now: this.now(),
      ...(required ? { required } : {}),
    });
    if (!built) {
      throw new ProjectWorkRefusedError(
        "That state could not be read out of the repository, so there would be nothing to review later. Record a commit or a checkpoint that is still there.",
      );
    }
    const stored = storeCapture(this.store, {
      projectId: input.projectId,
      entityId: input.entityId,
      capture: built,
      gate: wantsAcceptance ? "Accepting this preview" : "Recording this state",
    });
    const attemptId = input.attempt?.executionLinkId;

    if (!wantsAcceptance) {
      return { captureBlobId: stored.blobId, ...(attemptId ? { executionLinkId: attemptId } : {}) };
    }
    return {
      captureBlobId: stored.blobId,
      ...(attemptId ? { executionLinkId: attemptId } : {}),
      acceptance: {
        kind: "checkpoint_preview",
        confirmedAt: this.now(),
        checkpointRef: checkpointRef as string,
        commitObjectId: input.state.commitObjectId,
        subjectDigest: subject.digest,
        acceptedBy: this.caller.origin.actor,
        // The proof this acceptance was taken against, bound by content
        // address (D-363). The link's pointer may be corrected later; what a
        // person looked at cannot be, so convergence reads this and never the
        // pointer of the day.
        captureBlobId: stored.blobId,
      },
    };
  }

  /**
   * The attempt a state came out of, re-derived from the store (M21-T19).
   *
   * The caller reports an identity; every part of it is checked here, and none
   * of it is believed:
   *
   * 1. the execution link is one this project holds, and it belongs to the
   *    task it names — a link borrowed from another task, or another project,
   *    is refused rather than joined;
   * 2. the subject is that task, or an artifact the task **currently** pins at
   *    exactly the revision being recorded. The pin is read through the same
   *    `gatherAuthorities` the verification run used, so the Task ↔ Design ↔
   *    attempt join is one rule with one implementation, and the evaluator
   *    reads back what this wrote;
   * 3. the attempt really recorded **this** repository, and one of its own
   *    checkpoints is this exact ref **and** this exact commit. Not the newest
   *    one, not the ref alone: a workspace with two repositories has two
   *    records with two commits, and one acceptance names one of them.
   *
   * What comes back is the base the required set is taken from — the commit
   * that attempt started at, as the host wrote it from git when the attempt
   * was recorded.
   */
  private attemptOrigin(input: {
    projectId: string;
    subjectEntityId: string;
    subjectRevisionId: string;
    repositoryId: string;
    state: RepositoryStateRef;
    attempt: { taskEntityId: string; executionLinkId: string };
  }): RequiredOrigin {
    const link = this.store.executionLink(input.projectId, input.attempt.executionLinkId);
    if (!link || link.entityId !== input.attempt.taskEntityId) {
      throw new ProjectWorkRefusedError(
        "That attempt is not one this task has, so the work you looked at cannot be tied to it. Record your review from the task's own verification panel.",
      );
    }
    const task = this.store.get({ projectId: input.projectId, entityId: input.attempt.taskEntityId, body: { mode: "none" } });
    if (task.entity.kind !== "task") {
      throw new ProjectWorkRefusedError(
        "Attempts belong to tasks, and that is not a task, so there is no work of it to review. Record your review from the task's own verification panel.",
      );
    }
    if (input.subjectEntityId !== input.attempt.taskEntityId) {
      // A Design-backed visual criterion is accepted on the Design, so the
      // subject is allowed to be something other than the Task — but only
      // something this Task answers to, at exactly the revision it answers to.
      const gathered = gatherAuthorities(readerOf(this.store), input.projectId, input.attempt.taskEntityId);
      const pinned = [gathered.spec?.detail, gathered.design?.detail, gathered.plan?.detail].find(
        (detail) => detail?.entity.entityId === input.subjectEntityId,
      );
      if (!pinned) {
        throw new ProjectWorkRefusedError(
          `${task.entity.key} does not answer to that item, so work done for it proves nothing about that item. Record your review against ${task.entity.key} or against the design it is built from.`,
        );
      }
      if (pinned.revision.revisionId !== input.subjectRevisionId) {
        throw new ProjectWorkRefusedError(
          `${task.entity.key} is built from ${pinned.entity.key} at a different revision than the one you are recording against, so this would say something about a revision this work never answered to. ` +
            `Verify ${task.entity.key} again and record your review against what that run read.`,
        );
      }
    }
    const record = link.repositories?.find((row) => row.repositoryId === input.repositoryId);
    if (!record || record.unavailable === true) {
      throw new ProjectWorkRefusedError(
        "That attempt has no readable record of this repository, so there is no starting point to work out what it changed. Record your review at a checkpoint from an attempt that has one.",
      );
    }
    // A checkpoint is proved by the exact ref **and** the exact commit the
    // attempt recorded for this repository — not the newest one, not the ref
    // alone. A state that names no checkpoint is an ordinary commit, and it
    // has to be one this attempt actually made.
    const matched =
      input.state.checkpointId !== undefined
        ? record.checkpoints.some(
            (checkpoint) => checkpoint.ref === input.state.checkpointId && checkpoint.commitObjectId === input.state.commitObjectId,
          )
        : record.commits.includes(input.state.commitObjectId) || record.change?.head.commitObjectId === input.state.commitObjectId;
    if (!matched) {
      throw new ProjectWorkRefusedError(
        input.state.checkpointId !== undefined
          ? "That checkpoint is not one this attempt recorded in this repository, so it cannot be the work this attempt did. Record your review at a checkpoint this attempt recorded."
          : "That commit is not one this attempt recorded in this repository, so it cannot be the work this attempt did. Record this against a commit or checkpoint the attempt made.",
      );
    }
    return {
      basis: "attempt_base_to_state",
      base: record.base.commitObjectId,
      executionLinkId: link.linkId,
      taskEntityId: link.entityId,
      // The scope the request actually named, carried into the selection
      // rather than dropped here and rediscovered downstream (review F1): when
      // nothing changed, this is the bounded scope that is kept whole, and it
      // is what the record is later checked against.
      ...(input.state.path !== undefined ? { scopePath: input.state.path } : {}),
    };
  }

  /**
   * Keep what a decision rests on readable, or refuse the decision.
   *
   * For every `implemented_by` / `verified_at` link on the entities a decision
   * covers: if its capture is already stored, nothing happens; if git still
   * has what it names, the bounded capture is taken now and attached; if
   * neither, the decision is refused naming what is missing. Nothing is ever
   * approved or completed on evidence that cannot be looked at (D-345).
   *
   * A state link is captured here too, which is what makes the backfill
   * meaningful: before D-361 it was skipped whenever git still had the commit,
   * and routine checkpoint pruning then took the evidence with it.
   *
   * What comes back is **which exact proofs this preparation checked** (D-363)
   * — a blob and the association that made it current, per link. Preparation
   * is not a decision: the decision's own transaction rechecks every one of
   * them and binds them to the approval id or the completion it really wrote,
   * so a proof that moves in between refuses the decision instead of being
   * silently swapped for whatever is current by then. An empty list is an
   * answer too: this decision rested on no repository evidence, which is not
   * the same as nobody knowing what it rested on.
   */
  async keepEvidenceReviewable(projectId: string, entityIds: readonly string[], gate: string): Promise<DecisionProofPreparation> {
    const links: RepositoryLink[] = [];
    for (const entityId of new Set(entityIds)) {
      for (const link of this.store.repositoryLinksOf(projectId, entityId)) {
        if (link.relation === "implemented_by" || link.relation === "verified_at") links.push(link);
      }
    }
    const refs: DecisionProofRef[] = [];
    if (links.length === 0) return { gate, refs };
    const repositories = await this.repositories(projectId);
    for (const link of links) {
      const existing = readCapture(this.store, projectId, link);
      // A delivery is what the decision says was built, so the decision rests
      // on its whole source. A capture that is merely present — today's
      // bounded one, or one taken before this rule existed — is not enough,
      // and is corrected here from git while git can still answer (D-361,
      // M21-T19).
      const needsWhole = link.relation === "implemented_by";
      // Whole means whole *of this link*: the capture is checked against what
      // the record says it must be, never against itself (review F2).
      const expected = expectedRequiredFacts(this.store, projectId, link);
      if (existing && (!needsWhole || requiredComplete(existing, expected))) {
        refs.push(this.proofRef(projectId, link.linkId, link.captureBlobId as string, gate));
        continue;
      }
      if (!needsWhole && captureReadable(this.store, projectId, link)) {
        refs.push(this.proofRef(projectId, link.linkId, link.captureBlobId as string, gate));
        continue;
      }
      const repository = repositoryFor(repositories, link.repositoryId)?.repository;
      const availability = await linkAvailability(link, repository, false);
      if (!repository || !availability.sourceAvailable) {
        throw evidenceUnreviewable(link, availability.missing, gate);
      }
      const built =
        "change" in link.target
          ? await buildCapture({
              repository,
              repositoryId: link.repositoryId,
              change: link.target.change,
              now: this.now(),
              ...(needsWhole
                ? {
                    required: await selectRequired({
                      repository,
                      origin: {
                        basis: "accepted_change",
                        base: link.target.change.base.commitObjectId,
                        ...(link.executionLinkId ? { executionLinkId: link.executionLinkId } : {}),
                        ...(expected.taskEntityId ? { taskEntityId: expected.taskEntityId } : {}),
                        ...(link.target.change.head.path !== undefined ? { scopePath: link.target.change.head.path } : {}),
                      },
                      at: link.target.change.head.commitObjectId,
                    }),
                  }
                : {}),
            })
          : await buildStateCapture({ repository, repositoryId: link.repositoryId, state: link.target.state, now: this.now() });
      if (!built) throw evidenceUnreviewable(link, availability.missing, gate);
      const stored = storeCapture(this.store, { projectId, entityId: link.subject.entityId, capture: built, gate });
      // A correction, never an overwrite: the capture it replaces stays in the
      // store under its own content address, the association that made it
      // current is appended rather than rewritten (D-363), and the pointer
      // only moves off the exact blob this read — so a partial proof can never
      // be frozen in place by an idempotent attach, and two callers cannot
      // race one link into disagreeing with itself.
      //
      // Losing that race is reported, not assumed away: somebody else moved
      // this link's proof while this gate was being prepared, and the honest
      // answer is to look again rather than to decide on a capture this call
      // never read.
      const moved = this.store.attachCapture(projectId, link.linkId, stored.blobId, link.captureBlobId, {
        gate,
        actor: this.caller.origin.actor,
      });
      if (!moved) {
        throw new ProjectWorkRefusedError(
          `${gate} was being prepared when this record's evidence changed somewhere else, so it was not decided on what you were looking at. Try again.`,
        );
      }
      refs.push(this.proofRef(projectId, link.linkId, stored.blobId, gate));
    }
    return { gate, refs };
  }

  /**
   * The association that makes one capture this link's proof, as this
   * preparation read it (D-363).
   *
   * The pointer and the newest association have to agree, and on this exact
   * blob: if they do not, somebody moved the proof while this gate was being
   * prepared, and a decision bound to a guess about which of them is right is
   * worse than a refusal a person can act on.
   */
  private proofRef(projectId: string, linkId: string, blobId: string, gate: string): DecisionProofRef {
    const association = this.store.currentCaptureAssociation(projectId, linkId);
    if (!association || association.blobId !== blobId) {
      throw new ProjectWorkRefusedError(
        `${gate} was being prepared when this record's evidence changed somewhere else, so it was not decided on what you were looking at. Try again.`,
      );
    }
    return { linkId, blobId, associationRevisionId: association.revisionId, associationSeq: association.seq };
  }

  private async repositoryOrRefuse(projectId: string, repositoryId: string): Promise<HostRepository> {
    const repositories = await this.repositories(projectId);
    const found = repositoryFor(repositories, repositoryId);
    if (!found) {
      throw new ProjectWorkRefusedError(
        "That repository is not one this project has open here, so what it names cannot be read. Open the project at the checkout that holds it and record it there.",
      );
    }
    return found.repository;
  }
}
