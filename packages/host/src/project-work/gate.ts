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
  storeCapture,
  type StoredCapture,
} from "./captures.js";
import { ProjectWorkRefusedError } from "./errors.js";
import type { ProjectWorkStore } from "./store.js";

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
    if (params.include?.repositoryStatus !== true || detail.repositoryLinks.length === 0) return detail;
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
    return { ...detail, repositoryStatus: status };
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
    const built = await buildCapture({
      repository,
      repositoryId: payload.repositoryId,
      change: payload.change,
      now: this.now(),
    });
    if (!built) {
      throw new ProjectWorkRefusedError(
        "That change could not be read out of the repository, so there would be nothing to review later. Try again, or pick a change that is still there.",
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
    /** Paths the decision needs the source of, when the caller knows them. */
    requiredPaths?: readonly string[] | undefined;
  }): Promise<{ captureBlobId: string; acceptance?: RepositoryLinkAcceptance }> {
    const wantsAcceptance = input.acceptance !== undefined;
    if (wantsAcceptance && this.caller.origin.actor.kind !== "person") {
      throw new ProjectWorkRefusedError(
        "Only a person accepts a checkpoint preview as native visual evidence. Report what you saw as evidence instead.",
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

    const built = await buildStateCapture({
      repository,
      repositoryId: input.repositoryId,
      state: input.state,
      now: this.now(),
      ...(input.requiredPaths ? { requiredPaths: input.requiredPaths } : {}),
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

    if (!wantsAcceptance) return { captureBlobId: stored.blobId };

    if (checkpointRef === undefined) {
      throw new ProjectWorkRefusedError(
        "Native visual evidence is a checkpoint preview you accepted, so it has to name the checkpoint it was taken from.",
      );
    }
    const subject = this.store.refFor(input.projectId, input.entityId);
    if (subject.revisionId !== input.revisionId) {
      throw new ProjectWorkRefusedError(
        `${subject.key} has moved on since that preview was made, so accepting it would say something about a revision nobody looked at. Look at the current revision and accept a preview of it.`,
      );
    }
    return {
      captureBlobId: stored.blobId,
      acceptance: {
        kind: "checkpoint_preview",
        confirmedAt: this.now(),
        checkpointRef,
        commitObjectId: input.state.commitObjectId,
        subjectDigest: subject.digest,
        acceptedBy: this.caller.origin.actor,
      },
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
   */
  async keepEvidenceReviewable(projectId: string, entityIds: readonly string[], gate: string): Promise<void> {
    const links: RepositoryLink[] = [];
    for (const entityId of new Set(entityIds)) {
      for (const link of this.store.repositoryLinksOf(projectId, entityId)) {
        if (link.relation === "implemented_by" || link.relation === "verified_at") links.push(link);
      }
    }
    if (links.length === 0) return;
    const repositories = await this.repositories(projectId);
    for (const link of links) {
      if (captureReadable(this.store, projectId, link)) continue;
      const repository = repositoryFor(repositories, link.repositoryId)?.repository;
      const availability = await linkAvailability(link, repository, false);
      if (!repository || !availability.sourceAvailable) {
        throw evidenceUnreviewable(link, availability.missing, gate);
      }
      const built =
        "change" in link.target
          ? await buildCapture({ repository, repositoryId: link.repositoryId, change: link.target.change, now: this.now() })
          : await buildStateCapture({ repository, repositoryId: link.repositoryId, state: link.target.state, now: this.now() });
      if (!built) throw evidenceUnreviewable(link, availability.missing, gate);
      const stored = storeCapture(this.store, { projectId, entityId: link.subject.entityId, capture: built, gate });
      this.store.attachCapture(projectId, link.linkId, stored.blobId);
    }
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
