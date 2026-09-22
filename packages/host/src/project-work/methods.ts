/**
 * The project-work method handlers (M21-T3).
 *
 * This is the host's own authority for the project lifecycle: every one of the
 * leap's sixteen methods is answered here, from the canonical store, and **no
 * worker is started for any of them** — reads and writes alike (leap,
 * "Protocol and authority"; D-331). The router holds a delegating switch and
 * nothing else, so the rules below live in one file rather than being spread
 * through the routing table.
 *
 * What this layer adds on top of {@link ProjectWorkStore}:
 *
 * - **Who is calling, decided by the host.** A client connection is always a
 *   `person`; only the worker bridge (M21-T17) may present an `agent`. A
 *   client can suggest a label and name the session it is writing from, and
 *   nothing else about its own identity: that is what makes "only a person
 *   approves" (D-332) enforceable rather than advisory, because the actor kind
 *   the store checks can never come from a request body.
 * - **Project resolution.** Every method takes the opaque `projectId`;
 *   `project/work/list` also accepts a `cwd`, which the host maps to the
 *   project root (a worktree resolves to its parent project) and then to that
 *   project's stable id. Nothing else accepts a path.
 * - **Trust.** A project whose folder a person declined cannot be *changed*
 *   from here. Reads are still answered: the store reads no project file, and
 *   refusing them would hide work the person already wrote.
 * - **Errors a person can act on.** A stale write is a typed conflict carrying
 *   the current revision; a full budget is a typed refusal carrying the
 *   recovery action; everything else is an invalid-params error whose message
 *   is a sentence.
 * - **An audit row for the decisions that matter.** Approve, delete and
 *   archive name the actor, the project and the exact revisions — never a
 *   body (leap, "Security, privacy and resource rules").
 */
import { basename } from "node:path";
import {
  applyResearchOperation,
  ErrorCodes,
  type ProjectWorkGetParams,
  type ProjectWorkGetResult,
  type ProjectWorkLinkParams,
  type ProjectWorkLinkResult,
  type ProjectTaskLinkExecutionParams,
  type ProjectWorkWriteResult,
  type RepositoryLink,
  type RepositoryLinkAvailability,
  type AttemptRepositoryRecord,
  PROJECT_WORK_ATTENTION_ITEMS_MAX,
  PROJECT_WORK_CONFLICT_CODE,
  PROJECT_WORK_QUOTA_CODE,
  ProtocolError,
  type ActorClass,
  type ClientRequests,
  type ProjectWorkAttentionNotification,
  type ProjectWorkBlobReadParams,
  type ProjectWorkBlobReadResult,
  type ProjectWorkConflict,
  type ProjectWorkListParams,
  type ProjectWorkListResult,
  type ProjectWorkMethod,
  type ProjectWorkOrigin,
  type ProjectWorkQuotaRefusal,
  parseProjectWorkBridgeParams,
  ResearchOperationRefused,
  type ProjectWorkBridgeParams,
  type ProjectWorkBridgeResult,
  type ProjectWorkWrongProject,
  type ProjectTaskLinkExecutionResult,
  PROJECT_WORK_READ_METHODS,
  type VerificationBridgeResult,
  type VerificationDeviation,
  type VerificationEnvelope,
  type ProjectWorkInteropMethod,
} from "@lasercode/protocol";
import { projectRootOf } from "../paths.js";
import { canonical } from "../trust.js";
import type { LogInput } from "../logstore.js";
import { checkpointSessionKey, diffBetween, type HostRepository } from "../source-control/read.js";
import {
  attemptRepositoryFacts,
  currentStates,
  identifyRepositories,
  linkAvailability,
  repositoryFor,
  type IdentifiedRepository,
} from "./delivery.js";
import {
  blobReadable,
  buildCapture,
  evidenceUnreviewable,
  readCaptureBlob,
  requiredComplete,
  storeCapture,
  type StoredCapture,
} from "./captures.js";
import { expectedRequiredFacts } from "./required-facts.js";
import { convergeTask, evaluate, gatherAuthorities, planFrom, readerOf, storeReport } from "./verification/index.js";
import {
  ProjectWorkConflictError,
  ProjectWorkNotFoundError,
  ProjectWorkQuotaError,
  ProjectWorkRefusedError,
  ProjectWorkUnavailableError,
} from "./errors.js";
import { ProjectWorkExport } from "./export/index.js";
import { ProjectWorkImport } from "./import/index.js";
import { ProjectWorkPublish } from "./publish/index.js";
import { ProjectWorkGate } from "./gate.js";
import type { ProjectWorkStore } from "./store.js";

/**
 * One request this authority answers, with the params its method declares.
 *
 * Two families: the spine's sixteen (M21-T3) and the six import/export/publish
 * methods (M21-T21). They share this door because they share everything that
 * matters — the actor the host decided, the project resolution, the trust
 * gate, the error vocabulary and the audit — and the six delegate their own
 * work to `project-work/{import,export,publish}`.
 */
export type ProjectWorkSpineRequest = {
  [M in ProjectWorkMethod]: { method: M; params: ClientRequests[M]["params"] };
}[ProjectWorkMethod];

export type ProjectWorkInteropRequest = {
  [M in ProjectWorkInteropMethod]: { method: M; params: ClientRequests[M]["params"] };
}[ProjectWorkInteropMethod];

export type ProjectWorkRequest = ProjectWorkSpineRequest | ProjectWorkInteropRequest;

export type ProjectWorkResult = ClientRequests[ProjectWorkMethod | ProjectWorkInteropMethod]["result"];

/**
 * Where the call came from.
 *
 * `client` is a connection the host's boundary authenticated — the app, a
 * page, or a paired device. `worker` is the typed bridge a model tool calls
 * through (M21-T17); it is the only source that may act as an agent.
 */
export type ProjectWorkSource = "client" | "worker";

export interface ProjectWorkCaller {
  /** The actor the boundary proved (RP-13). Never taken from a request body. */
  actor: { class: ActorClass; id: string };
  source: ProjectWorkSource;
  /** Provenance the worker bridge supplies for an agent's call (M21-T17). */
  agent?: { label: string; sessionId?: string; runId?: string } | undefined;
  /**
   * The checkout this call is being made from (M21-T18).
   *
   * The worker bridge sets it to the directory the attempt runs in — which is
   * a worktree of its own for an agent run. It is what git is read *in*, and
   * never what decides which project may be changed: that is resolved from the
   * directory this host spawned the worker for (D-356.c) and nothing else.
   */
  cwd?: string | undefined;
}

/** What a project's folder is trusted with. Mirrors the project registry. */
export type ProjectWorkTrust = "trusted" | "declined" | "not_required" | "unknown";

export interface ProjectWorkMethodsOptions {
  store: ProjectWorkStore;
  /**
   * Trust for the folder a project is open at. A `declined` project refuses
   * every mutation; absent, nothing is trust-gated (narrow tests).
   */
  trustOf?: ((projectRoot: string) => ProjectWorkTrust) | undefined;
  /** Where approve/delete/archive rows are written. Absent = no audit sink. */
  logs?: { record(input: LogInput): unknown } | undefined;
}

/** The label a person sees for their own writes when the client sends none. */
const PERSON_LABEL = "You";
/** The label a worker bridge call carries when it names no agent. */
const AGENT_LABEL = "Agent";

export class ProjectWorkMethods {
  private readonly store: ProjectWorkStore;
  private readonly trustOf: ((projectRoot: string) => ProjectWorkTrust) | undefined;
  private readonly logs: { record(input: LogInput): unknown } | undefined;
  private imports: ProjectWorkImport | undefined;
  private exports: ProjectWorkExport | undefined;
  private publishes: ProjectWorkPublish | undefined;

  constructor(options: ProjectWorkMethodsOptions) {
    this.store = options.store;
    this.trustOf = options.trustOf;
    this.logs = options.logs;
  }

  /**
   * Answer one request.
   *
   * Params have already been validated against the method's strict schema by
   * the wire parser, so everything here is about authority and state, not
   * shape. Every store refusal leaves through {@link toProtocolError}, so a
   * caller sees one vocabulary of errors whichever method it called.
   */
  async handle(request: ProjectWorkRequest, caller: ProjectWorkCaller): Promise<ProjectWorkResult> {
    try {
      return await this.route(request, caller);
    } catch (error) {
      throw toProtocolError(error);
    }
  }

  /**
   * Answer one call from a worker's model tools (M21-T17).
   *
   * This is the only door a model has to project work, and it is a narrower
   * one than a client's:
   *
   * - **The project is the host's answer, not the caller's.** It is resolved
   *   from the directory this host spawned that worker for (a worktree maps
   *   to its parent), so a tool cannot write into a project by naming it.
   *   A mutation aimed elsewhere is refused with the owning project named and
   *   the offer to open a session there (leap, "Cross-session mentions and
   *   context"); a **read** of another project is allowed, which is what makes
   *   a cross-project mention useful and a projectless chat able to read.
   * - **Trust and scope still apply**, through the same `requireWritable` a
   *   client goes through: a declined folder refuses every mutation whoever
   *   asked.
   * - **A research write is applied by the rule, not by the caller.** The
   *   operation is re-run here against this host's own current body, and the
   *   body the applier returns is what is stored — so a tool that skipped the
   *   worker's pre-check changes nothing (D-351.a, D-356.d).
   * - **An attempt records its shape.** `project/task/link-execution` with an
   *   `attempt` envelope also writes one supporting evidence record naming the
   *   workspace shape and the checkout, which is how an attempt stays readable
   *   after its session is gone (D-356.e).
   */
  async handleBridge(
    rawParams: unknown,
    caller: { actor: { class: ActorClass; id: string }; cwd: string },
  ): Promise<ProjectWorkBridgeResult> {
    let params: ProjectWorkBridgeParams;
    try {
      params = parseProjectWorkBridgeParams(rawParams);
    } catch (error) {
      throw new ProtocolError(
        ErrorCodes.InvalidParams,
        `That project work request is not one this app can answer: ${error instanceof Error ? error.message.slice(0, 500) : "it is malformed"}.`,
      );
    }
    const projectId = this.projectOf(caller.cwd);
    const bridgeCaller: ProjectWorkCaller = {
      actor: caller.actor,
      source: "worker",
      agent: params.agent,
      // Git is read where the attempt runs. An agent run in a worktree of its
      // own checkpoints itself, so its own directory is the one whose refs and
      // commits describe what it did.
      cwd: params.attempt?.checkout ?? caller.cwd,
    };
    const request = this.attemptSession(this.fenceProject(params.request, projectId), params);
    try {
      if (params.verify) return await this.verifyStep(params, request, projectId, bridgeCaller);
      if (params.research) return await this.researchWrite(params, request, projectId, bridgeCaller);
      const result = await this.handle(request, bridgeCaller);
      if (request.method === "project/task/link-execution" && params.attempt) {
        await this.recordAttemptShape(
          request.params.projectId,
          request.params.entityId,
          result as ProjectTaskLinkExecutionResult,
          params,
          bridgeCaller,
        );
      }
      return { method: request.method, result, projectId };
    } catch (error) {
      throw toProtocolError(error);
    }
  }

  /**
   * Let an attempt say which session its checkpoints belong to (M21-T18).
   *
   * The worker knows the session file; the host derives the checkpoint ref
   * namespace from it and keeps only the derived key. The path never reaches a
   * model, a client or a log — it is used here and dropped.
   */
  private attemptSession(request: ProjectWorkSpineRequest, params: ProjectWorkBridgeParams): ProjectWorkSpineRequest {
    const sessionPath = params.attempt?.sessionPath;
    if (request.method !== "project/task/link-execution" || !sessionPath) return request;
    if (request.params.execution.sessionPath !== undefined) return request;
    return {
      method: request.method,
      params: { ...request.params, execution: { ...request.params.execution, sessionPath } },
    };
  }

  /** What is waiting on a person in this project right now, for a notifier. */
  attention(projectId: string): ProjectWorkAttentionNotification {
    const snapshot = this.store.attention(projectId, PROJECT_WORK_ATTENTION_ITEMS_MAX);
    return {
      projectId,
      seq: this.store.seq(projectId),
      needsYou: snapshot.needsYou,
      items: snapshot.items,
      ...(snapshot.truncated ? { truncated: true } : {}),
    };
  }

  // ------------------------------------------------------------------ routing

  private async route(request: ProjectWorkRequest, caller: ProjectWorkCaller): Promise<ProjectWorkResult> {
    switch (request.method) {
      case "project/work/list":
        return this.list(request.params);
      case "project/work/get":
        return this.get(request.params, caller);
      case "project/work/search": {
        const params = request.params;
        if (params.projectId !== undefined) this.requireProject(params.projectId);
        return this.store.search({
          ...(params.projectId !== undefined ? { projectId: params.projectId } : {}),
          query: params.query,
          ...(params.kinds ? { kinds: params.kinds } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        });
      }
      case "project/work/blob/read":
        return this.readBlob(request.params);

      case "project/work/create": {
        const params = request.params;
        const origin = this.originFor(params.origin, caller);
        this.requireWritable(params.projectId);
        const result = this.store.create({
          projectId: params.projectId,
          kind: params.kind,
          title: params.title,
          body: params.body,
          ...(params.note !== undefined ? { note: params.note } : {}),
          origin,
          idempotencyKey: params.idempotencyKey,
        });
        return this.gate(caller, origin).recordBasedOn(result, params.projectId, params.idempotencyKey);
      }
      case "project/work/revise": {
        const params = request.params;
        const origin = this.originFor(params.origin, caller);
        this.requireWritable(params.projectId);
        const result = this.store.revise({
          projectId: params.projectId,
          entityId: params.entityId,
          expectedRevisionId: params.expectedRevisionId,
          ...(params.title !== undefined ? { title: params.title } : {}),
          body: params.body,
          ...(params.note !== undefined ? { note: params.note } : {}),
          origin,
          idempotencyKey: params.idempotencyKey,
        });
        return this.gate(caller, origin).recordBasedOn(result, params.projectId, params.idempotencyKey);
      }
      case "project/work/archive": {
        const params = request.params;
        const origin = this.originFor(params.origin, caller);
        this.requireWritable(params.projectId);
        const result = this.store.archive({
          projectId: params.projectId,
          entityId: params.entityId,
          expectedRevisionId: params.expectedRevisionId,
          archived: params.archived,
          origin,
          idempotencyKey: params.idempotencyKey,
        });
        this.audit(params.archived ? "project_work_archived" : "project_work_unarchived", {
          origin,
          caller,
          projectId: params.projectId,
          summary: `${params.archived ? "archived" : "restored"} ${result.entity.key}`,
          detail: {
            key: result.entity.key,
            entityId: result.entity.entityId,
            revisionId: params.expectedRevisionId,
            digest: result.entity.currentDigest,
            seq: result.seq,
            replayed: result.replayed === true,
          },
        });
        return result;
      }
      case "project/work/delete": {
        const params = request.params;
        const origin = this.originFor(params.origin, caller);
        this.requireWritable(params.projectId);
        // Without the typed confirmation this is the preview, and it writes
        // nothing: the person sees exactly what the delete would orphan first.
        if (params.confirm !== true) {
          return {
            deleted: false,
            orphans: this.store.deletePreview(params.projectId, params.entityId),
            seq: this.store.seq(params.projectId),
          };
        }
        const entity = this.store.refFor(params.projectId, params.entityId);
        const result = this.store.delete({
          projectId: params.projectId,
          entityId: params.entityId,
          expectedRevisionId: params.expectedRevisionId,
          origin,
          idempotencyKey: params.idempotencyKey,
        });
        this.audit("project_work_deleted", {
          origin,
          caller,
          projectId: params.projectId,
          summary: `deleted ${entity.key}`,
          detail: {
            key: entity.key,
            entityId: params.entityId,
            revisionId: params.expectedRevisionId,
            digest: entity.digest,
            orphanedLinks: result.orphans.map((orphan) => `${orphan.relation} ${orphan.key}`),
            seq: result.seq,
            replayed: result.replayed === true,
          },
        });
        return result;
      }

      case "project/work/comment": {
        const params = request.params;
        const origin = this.originFor(params.origin, caller);
        this.requireWritable(params.projectId);
        return this.store.comment({
          projectId: params.projectId,
          entityId: params.entityId,
          expectedRevisionId: params.expectedRevisionId,
          revisionId: params.revisionId,
          anchor: params.anchor,
          text: params.text,
          ...(params.blocking !== undefined ? { blocking: params.blocking } : {}),
          ...(params.parentCommentId !== undefined ? { parentCommentId: params.parentCommentId } : {}),
          origin,
          idempotencyKey: params.idempotencyKey,
        });
      }
      case "project/work/review": {
        const params = request.params;
        const origin = this.originFor(params.origin, caller);
        this.requireWritable(params.projectId);
        return this.store.review({
          projectId: params.projectId,
          entityId: params.entityId,
          expectedRevisionId: params.expectedRevisionId,
          action: params.action,
          ...(params.supersededByEntityId !== undefined ? { supersededByEntityId: params.supersededByEntityId } : {}),
          ...(params.note !== undefined ? { note: params.note } : {}),
          origin,
          idempotencyKey: params.idempotencyKey,
        });
      }
      case "project/work/approve": {
        const params = request.params;
        const origin = this.originFor(params.origin, caller);
        this.requireWritable(params.projectId);
        // A decision that rests on a repository change keeps that change
        // reviewable, before the decision exists (leap, "Repository
        // provenance"). A full durable budget refuses the gate here — with
        // nothing approved — rather than accepting a digest and losing the
        // evidence to the next pruning.
        // And the approval binds the exact proofs that preparation checked, in
        // the transaction that writes it: a capture corrected in between
        // refuses the approval rather than becoming, after the fact, what the
        // person approved on (D-363).
        const proof =
          params.decision === "approved"
            ? await this.gate(caller, origin).keepEvidenceReviewable(
                params.projectId,
                [params.entityId, ...params.covers.map((revision) => revision.entityId)],
                "This approval",
              )
            : undefined;
        const result = this.store.approve({
          projectId: params.projectId,
          entityId: params.entityId,
          expectedRevisionId: params.expectedRevisionId,
          gate: params.gate,
          decision: params.decision,
          covers: params.covers,
          ...(params.mode !== undefined ? { mode: params.mode } : {}),
          ...(params.skipReason !== undefined ? { skipReason: params.skipReason } : {}),
          ...(params.note !== undefined ? { note: params.note } : {}),
          ...(proof ? { proof } : {}),
          origin,
          idempotencyKey: params.idempotencyKey,
        });
        this.audit("project_work_approved", {
          origin,
          caller,
          projectId: params.projectId,
          summary: `${params.gate} gate ${params.decision} on ${result.entity.key}`,
          detail: {
            key: result.entity.key,
            entityId: result.entity.entityId,
            gate: params.gate,
            decision: params.decision,
            revisionId: params.expectedRevisionId,
            // Exactly what the decision covers, by identity and digest. No
            // title, no body, no note.
            covers: result.approval.covers.map((covered) => `${covered.key}@${covered.revisionId}#${covered.digest}`),
            seq: result.seq,
            replayed: result.replayed === true,
          },
        });
        return result;
      }
      case "project/work/resolve-comment": {
        const params = request.params;
        const origin = this.originFor(params.origin, caller);
        this.requireWritable(params.projectId);
        return this.store.resolveComment({
          projectId: params.projectId,
          entityId: params.entityId,
          expectedRevisionId: params.expectedRevisionId,
          commentId: params.commentId,
          resolution: params.resolution,
          origin,
          idempotencyKey: params.idempotencyKey,
        });
      }

      case "project/work/link": {
        const params = request.params;
        const origin = this.originFor(params.origin, caller);
        this.requireWritable(params.projectId);
        const gate = this.gate(caller, origin);
        if (params.link.type === "delivery") return gate.acceptDelivery(params);
        // A state a verification names is validated against git and captured
        // before it is stored, whoever asked and whether or not they asked for
        // it to be native evidence (D-361): a link that names a commit nobody
        // ever had, or one whose checkpoint has been pruned, would otherwise
        // sit in the record looking exactly like proof.
        const verified =
          params.link.type === "evidence" && params.link.verifiedAt
            ? await gate.prepareVerifiedAt({
                projectId: params.projectId,
                entityId: params.link.entityId,
                revisionId: params.link.revisionId,
                repositoryId: params.link.verifiedAt.repositoryId,
                state: params.link.verifiedAt.state,
                ...(params.link.verifiedAt.acceptance ? { acceptance: params.link.verifiedAt.acceptance } : {}),
                ...(params.link.verifiedAt.attempt ? { attempt: params.link.verifiedAt.attempt } : {}),
              })
            : undefined;
        return this.store.link({
          projectId: params.projectId,
          expectedRevisionId: params.expectedRevisionId,
          link: params.link,
          ...(verified ? { verified } : {}),
          origin,
          idempotencyKey: params.idempotencyKey,
        });
      }
      case "project/work/unlink": {
        const params = request.params;
        const origin = this.originFor(params.origin, caller);
        this.requireWritable(params.projectId);
        return this.store.unlink({
          projectId: params.projectId,
          entityId: params.entityId,
          expectedRevisionId: params.expectedRevisionId,
          linkId: params.linkId,
          origin,
          idempotencyKey: params.idempotencyKey,
        });
      }
      case "project/task/action": {
        const params = request.params;
        const origin = this.originFor(params.origin, caller);
        this.requireWritable(params.projectId);
        // Done rests on evidence, and evidence that cannot be read is not
        // evidence: everything this Task's delivery links name is captured
        // before the Task can be completed.
        const proof =
          params.action === "complete"
            ? await this.gate(caller, origin).keepEvidenceReviewable(params.projectId, [params.entityId], "Marking this task done")
            : undefined;
        return this.store.taskAction({
          projectId: params.projectId,
          entityId: params.entityId,
          expectedRevisionId: params.expectedRevisionId,
          action: params.action,
          ...(params.evidenceId !== undefined ? { evidenceId: params.evidenceId } : {}),
          ...(params.note !== undefined ? { note: params.note } : {}),
          ...(proof ? { proof } : {}),
          origin,
          idempotencyKey: params.idempotencyKey,
        });
      }
      case "project/task/link-execution": {
        const params = request.params;
        const origin = this.originFor(params.origin, caller);
        this.requireWritable(params.projectId);
        const { sessionPath: _sessionPath, ...execution } = params.execution;
        void _sessionPath;
        const facts = await this.gate(caller, origin).attemptFacts(params);
        const result = this.store.linkExecution({
          projectId: params.projectId,
          entityId: params.entityId,
          expectedRevisionId: params.expectedRevisionId,
          execution,
          ...(facts.repositories ? { repositories: facts.repositories } : {}),
          ...(facts.checkpointKey ? { checkpointKey: facts.checkpointKey } : {}),
          origin,
          idempotencyKey: params.idempotencyKey,
        });
        const repositories = result.link.repositories;
        return repositories && repositories.length > 0 ? { ...result, attemptRepositories: repositories } : result;
      }

      // Import, export and publication (M21-T21). The rules live in
      // `project-work/{import,export,publish}`; these cases decide the same
      // three things every other case does — may this caller change this
      // project, who is it, and is the decision worth an audit row — and
      // delegate everything else.
      case "project/work/import/preview": {
        const params = request.params;
        this.requireWritable(params.projectId);
        return this.importer().preview(params);
      }
      case "project/work/import/apply": {
        const params = request.params;
        const origin = this.originFor(params.origin, caller);
        this.requireWritable(params.projectId);
        const result = this.importer().apply(params, origin);
        this.audit("project_work_imported", {
          origin,
          caller,
          projectId: params.projectId,
          summary: `imported ${String(result.created + result.revised)} item(s) from ${result.root}`,
          detail: {
            adapter: result.adapter,
            root: result.root,
            created: result.created,
            revised: result.revised,
            skipped: result.skipped,
            relations: result.relations,
            // Identity and provenance only: a key, the revision it wrote and
            // the digest of the source file. Never a title or a body.
            items: result.applied
              .filter((item) => item.key !== undefined)
              .map((item) => `${item.key!}@${item.revisionId ?? ""}←${item.source.path}#${item.source.digest}`),
          },
        });
        return { ...result, seq: this.store.seq(params.projectId) };
      }
      case "project/work/export/preview": {
        const params = request.params;
        this.requireWritable(params.projectId);
        return this.exporter().preview(params);
      }
      case "project/work/export/apply": {
        const params = request.params;
        const origin = this.originFor(params.origin, caller);
        this.requireWritable(params.projectId);
        const result = this.exporter().apply(params);
        // An export leaves the app's own storage, so it is an audited decision
        // (leap, "Security, privacy and resource rules").
        this.audit("project_work_exported", {
          origin,
          caller,
          projectId: params.projectId,
          summary: `exported ${String(result.entities)} item(s) to ${result.root}`,
          detail: {
            root: result.root,
            mode: result.mode,
            entities: result.entities,
            attachments: result.attachments,
            files: result.files.length,
            removed: result.removed.length,
            totalBytes: result.totalBytes,
            manifestDigest: result.manifestDigest,
          },
        });
        return { ...result, seq: this.store.seq(params.projectId) };
      }
      case "project/work/publish/preview": {
        const params = request.params;
        this.requireWritable(params.projectId);
        return this.publisher().preview(params);
      }
      case "project/work/publish/apply": {
        const params = request.params;
        const origin = this.originFor(params.origin, caller);
        this.requireWritable(params.projectId);
        const result = this.publisher().apply(params, origin);
        this.audit("project_work_published", {
          origin,
          caller,
          projectId: params.projectId,
          summary: `published ${String(result.published.length)} item(s) at ${result.commitObjectId.slice(0, 12)}`,
          detail: {
            root: result.root,
            repositoryId: result.repositoryId,
            commitObjectId: result.commitObjectId,
            objectFormat: result.objectFormat,
            ...(params.checkpointId !== undefined ? { checkpointId: params.checkpointId } : {}),
            published: result.published.map((item) => `${item.key}@${item.publishedPath}`),
          },
        });
        return { ...result, seq: this.store.seq(params.projectId) };
      }
    }
  }

  // ------------------------------------------------------- repository facts

  /**
   * Repository provenance for one call (M21-T18, M21-T19, review F4).
   *
   * Everything that reads git, keeps a capture or refuses a decision for want
   * of one lives in {@link ProjectWorkGate}; this authority routes to it and
   * keeps the rules about who may call what. The gate is built per call
   * because the checkout and the actor are per call.
   */
  private gate(caller: ProjectWorkCaller, origin?: ProjectWorkOrigin): ProjectWorkGate {
    return new ProjectWorkGate({
      store: this.store,
      caller: {
        ...(caller.cwd !== undefined ? { cwd: caller.cwd } : {}),
        origin: origin ?? this.originFor(undefined, caller),
      },
    });
  }

  private async get(params: ProjectWorkGetParams, caller: ProjectWorkCaller): Promise<ProjectWorkGetResult> {
    this.requireProject(params.projectId);
    return this.gate(caller).get(params);
  }

  // --------------------------------------------- import, export, publish

  /**
   * The three interop modules, built on first use and kept.
   *
   * They hold no state beyond the store, so one instance each is enough; they
   * are lazy so a host that never imports or exports never touches a project's
   * files at all.
   */
  private importer(): ProjectWorkImport {
    this.imports ??= new ProjectWorkImport(this.store);
    return this.imports;
  }

  private exporter(): ProjectWorkExport {
    this.exports ??= new ProjectWorkExport(this.store);
    return this.exports;
  }

  private publisher(): ProjectWorkPublish {
    this.publishes ??= new ProjectWorkPublish(this.store);
    return this.publishes;
  }

  // -------------------------------------------------------------------- reads

  private list(params: ProjectWorkListParams): ProjectWorkListResult {
    const projectId = this.resolveProject(params);
    return this.store.list({
      projectId,
      ...(params.kinds ? { kinds: params.kinds } : {}),
      ...(params.states ? { states: params.states } : {}),
      ...(params.needsYou !== undefined ? { needsYou: params.needsYou } : {}),
      ...(params.hasLinks !== undefined ? { hasLinks: params.hasLinks } : {}),
      ...(params.includeArchived !== undefined ? { includeArchived: params.includeArchived } : {}),
      ...(params.updatedSince !== undefined ? { updatedSince: params.updatedSince } : {}),
      ...(params.sinceSeq !== undefined ? { sinceSeq: params.sinceSeq } : {}),
      ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    });
  }

  /**
   * A ranged page of one blob, base64 over the wire (M21-T4).
   *
   * Released derived content keeps its row, its size and the reason it went:
   * the answer is labelled, never empty bytes pretending to be the content.
   * Bytes that no longer match the digest they are addressed by are a refusal,
   * not a plausible page.
   */
  private readBlob(params: ProjectWorkBlobReadParams): ProjectWorkBlobReadResult {
    this.requireProject(params.projectId);
    const range = this.store.readBlob({
      projectId: params.projectId,
      blobId: params.blobId,
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    });
    if (!range) throw new ProjectWorkNotFoundError("That attachment is not in this project — it may have been deleted.");
    if (range.corrupt === true) {
      throw new ProtocolError(
        ErrorCodes.Internal,
        "That attachment is stored damaged and cannot be read. Delete the item that carries it, or restore this project's work from a backup.",
      );
    }
    return {
      blobId: range.blobId,
      mediaType: range.mediaType,
      digest: range.digest,
      totalBytes: range.totalBytes,
      offset: range.offset,
      bytes: range.bytes,
      ...(range.nextOffset !== undefined ? { nextOffset: range.nextOffset } : {}),
      ...(range.data ? { data: range.data.toString("base64") } : {}),
      ...(range.released ? { released: range.released } : {}),
    };
  }

  // -------------------------------------------------------------- authority

  /**
   * The project this call is about.
   *
   * `project/work/list` may name a folder instead of an id, because the first
   * read a session makes has no id yet. The folder is canonicalised and mapped
   * to its project root — a worktree under `<project>/.worktrees/` resolves to
   * its parent, which is what makes a worktree session see the same Specs and
   * Tasks — and the store mints the id if this is the first time the folder is
   * seen. Minting is the only write a read ever does, and it creates nothing
   * but an identity: the page that comes back is empty.
   */
  private resolveProject(params: ProjectWorkListParams): string {
    if (params.projectId !== undefined) {
      this.requireProject(params.projectId);
      return params.projectId;
    }
    if (params.cwd === undefined) {
      throw new ProjectWorkRefusedError("Name the project by id, or the folder it is open at.");
    }
    const root = projectRootOf(canonical(params.cwd));
    const projectId = this.store.projectIdFor(root);
    if (!projectId) throw new ProjectWorkNotFoundError("That folder is not a project this app keeps work for.");
    return projectId;
  }

  // --------------------------------------------------------- worker bridge

  /**
   * The project a worker belongs to: its own directory, canonicalised and
   * mapped to its project root. Minted on first sight, exactly as a first
   * `project/work/list { cwd }` mints it, and nothing else about the call is
   * allowed to decide it.
   */
  private projectOf(cwd: string): string {
    const root = projectRootOf(canonical(cwd));
    const projectId = this.store.projectIdFor(root);
    if (!projectId) throw new ProjectWorkNotFoundError("That folder is not a project this app keeps work for.");
    return projectId;
  }

  /**
   * Pin the call to the worker's own project.
   *
   * A read may name another project — the leap allows any session to read any
   * project the environment permits. A write may not: it is refused with the
   * owning project named, and the offer Laser makes instead.
   */
  private fenceProject(request: ProjectWorkSpineRequest, projectId: string): ProjectWorkSpineRequest {
    if (request.method === "project/work/list") {
      // A worker never names a folder: the host already knows which one it is.
      const { cwd: _cwd, ...rest } = request.params;
      void _cwd;
      return { method: request.method, params: { ...rest, projectId: rest.projectId ?? projectId } };
    }
    const named = (request.params as { projectId?: string }).projectId;
    if (named === undefined || named === projectId) return request;
    if ((PROJECT_WORK_READ_METHODS as readonly string[]).includes(request.method)) return request;
    throw this.wrongProject(named);
  }

  /** The refusal a mutation aimed at another project gets. */
  private wrongProject(projectId: string): ProtocolError {
    const paths = this.store.hasProject(projectId) ? this.store.projectPaths(projectId) : [];
    const name = paths[0] ? basename(paths[0]) : "another project";
    return new ProtocolError(
      ErrorCodes.InvalidParams,
      `That work belongs to ${name}, and this session is working in a different project, so it cannot be changed from here. Open a session in ${name} to work on it — reading it from here is fine.`,
      {
        refused: "wrong_project",
        owningProjectId: projectId,
        owningProjectName: name,
        offer: "open_session",
      } satisfies ProjectWorkWrongProject,
    );
  }

  /**
   * A research write, applied by the rule.
   *
   * The excerpt check is the worker's — the fetched text lives in its cache
   * and never crosses this link (`docs/leap/m21-research-plan.md`) — and
   * every other rule in the contract runs here: the confidence rule, the
   * citation an `answered` question needs, the next step an `unanswerable`
   * one needs, findings never being edited, and the derived status. The body
   * in the params is ignored entirely.
   */
  private async researchWrite(
    params: ProjectWorkBridgeParams,
    request: ProjectWorkRequest,
    projectId: string,
    caller: ProjectWorkCaller,
  ): Promise<ProjectWorkBridgeResult> {
    if (request.method !== "project/work/revise") {
      throw new ProtocolError(ErrorCodes.InvalidParams, "A research operation is applied by revising the research it belongs to.");
    }
    this.requireWritable(projectId);
    const current = this.store.get({ projectId, entityId: request.params.entityId, body: { mode: "full" } });
    const body = current.body?.body;
    if (!body || body.kind !== "research") {
      throw new ProtocolError(ErrorCodes.InvalidParams, "That is not a research artifact, so a research write cannot be applied to it.");
    }
    let applied;
    try {
      applied = applyResearchOperation(body.research, params.research!);
    } catch (error) {
      if (error instanceof ResearchOperationRefused) {
        throw new ProtocolError(ErrorCodes.InvalidParams, error.message, { refused: error.code, next: error.next, committed: false });
      }
      throw error;
    }
    const result = await this.handle(
      { method: "project/work/revise", params: { ...request.params, body: { kind: "research", research: applied.body } } },
      caller,
    );
    return {
      method: "project/work/revise",
      result,
      projectId,
      researchResult: {
        ...(applied.attention ? { attention: applied.attention } : {}),
        staleRefs: applied.staleRefs,
      },
    };
  }

  /**
   * One step of a verification run (M21-T19).
   *
   * Two steps, and the host owns both ends of each:
   *
   * - **plan** derives every criterion from this store, at the exact revisions
   *   the Task's own links name, and hands back the commands the Task
   *   declared. A verifier cannot add a criterion, remove one, or change which
   *   revision it was taken from.
   * - **report** takes the command runs — exit codes and bounded output, the
   *   one thing only the process that ran them can know — evaluates every
   *   criterion here, stores the canonical report as `verification` evidence
   *   at the exact revision, and moves the Task to `needs_review` only when
   *   everything it could decide came out satisfied and nothing blocks.
   *
   * The carrier request is the real call each step is: a read for the plan, a
   * link for the report. Its result is answered as usual, and the verification
   * answer rides beside it, the way a research write's does.
   */
  private async verifyStep(
    params: ProjectWorkBridgeParams,
    request: ProjectWorkRequest,
    projectId: string,
    caller: ProjectWorkCaller,
  ): Promise<ProjectWorkBridgeResult> {
    const verify = params.verify!;
    if (verify.action === "plan") {
      if (request.method !== "project/work/get") {
        throw new ProtocolError(ErrorCodes.InvalidParams, "A verification plan is read with the task it is for.");
      }
      const result = await this.handle(request, caller);
      const entityId = (result as ProjectWorkGetResult).entity.entityId;
      const gathered = gatherAuthorities(readerOf(this.store), projectId, entityId);
      return { method: request.method, result, projectId, verifyResult: { plan: planFrom(gathered) } };
    }
    if (request.method !== "project/work/link") {
      throw new ProtocolError(ErrorCodes.InvalidParams, "A verification report is stored as evidence on the task it is about.");
    }
    return this.verifyReport(request.params, verify, projectId, caller);
  }

  /**
   * Evaluate and store one run's report.
   *
   * The caller's link payload supplies the fence and the idempotency key and
   * nothing else: the record's kind, role, summary, detail and outcome are
   * assembled here from the host's own evaluation, so an agent can report what
   * a command did and never what it meant.
   */
  private async verifyReport(
    linkParams: ProjectWorkLinkParams,
    verify: Extract<VerificationEnvelope, { action: "report" }>,
    projectId: string,
    caller: ProjectWorkCaller,
  ): Promise<ProjectWorkBridgeResult> {
    this.requireWritable(projectId);
    const payload = linkParams.link;
    if (payload.type !== "evidence") {
      throw new ProtocolError(ErrorCodes.InvalidParams, "A verification report is stored as evidence on the task it is about.");
    }
    const entityId = payload.entityId;
    const gathered = gatherAuthorities(readerOf(this.store), projectId, entityId);
    const plan = planFrom(gathered);
    const repositoryLinks = [
      ...this.store.repositoryLinksOf(projectId, entityId),
      ...(gathered.design ? this.store.repositoryLinksOf(projectId, gathered.design.detail.entity.entityId) : []),
    ];
    const evidence = [
      ...gathered.task.evidence,
      ...(gathered.design ? gathered.design.detail.evidence : []),
    ];
    const completeness = new Map<string, boolean>();
    // The proof a decision was bound to, which is what every reader of that
    // decision has to read (D-363, review O2): the acceptance's own blob, or
    // — for an acceptance written before that binding existed — the link's
    // own original association, the row written inside the link's insert.
    // Never the pointer of the day.
    const boundProof = (link: RepositoryLink): string | undefined =>
      link.acceptance?.captureBlobId ?? this.store.originalCaptureAssociation(projectId, link.linkId)?.blobId;
    const repositoryNames = new Map(this.store.repositories(projectId).map((row) => [row.repositoryId, row.name]));
    const evaluation = evaluate({
      plan,
      gathered,
      commands: verify.commands,
      repositoryLinks,
      evidence,
      // Which repositories a person has to have reviewed, for a visual
      // criterion: the ones this Task's own attempt recorded a state in
      // (D-367). A repository the attempt could not read is not one anybody
      // can be asked to open a preview of — the acceptance door refuses it —
      // so it is not counted against the person here either.
      attempts: gathered.task.executionLinks.map((link) => ({
        ...link,
        ...(link.repositories ? { repositories: link.repositories.filter((row) => row.unavailable !== true) } : {}),
      })),
      repositoryName: (repositoryId) => repositoryNames.get(repositoryId),
      // Convergence reads what was stored when the person accepted, never git:
      // the contract protects this evidence against the day retention prunes
      // the checkpoint it came from (D-361).
      captureReadable: (link) => blobReadable(this.store, projectId, boundProof(link)),
      // And, for native evidence, whether the capture the acceptance was
      // taken against holds every source it rests on — read out of the stored
      // blob, never out of git (M21-T19), and checked against what the record
      // says that capture must be rather than against itself (review F2).
      //
      // The capture read here is the one the **decision bound**, not the
      // link's current pointer (D-363): a partial acceptance never becomes
      // native evidence because somebody later corrected what the link points
      // at. An acceptance written before that binding existed is read against
      // the link's own original association — the row written inside the
      // link's insert, which this store can attribute to it independently —
      // and never against a migration baseline, which is only what the
      // migration happened to see and says nothing about what that acceptance
      // consumed. With neither, the honest answer is that this is not proved
      // here, and the criterion asks for the review again. The readable check
      // above reads that same blob, so the two cannot answer about different
      // bytes (review O2).
      //
      // Answered once per link: several visual criteria commonly rest on the
      // same acceptance, and a capture is up to four megabytes.
      captureComplete: (link) => {
        const known = completeness.get(link.linkId);
        if (known !== undefined) return known;
        const bound = boundProof(link);
        const capture = bound === undefined ? undefined : readCaptureBlob(this.store, projectId, bound);
        const answer = capture !== undefined && requiredComplete(capture, expectedRequiredFacts(this.store, projectId, link));
        completeness.set(link.linkId, answer);
        return answer;
      },
      ...(verify.stopped ? { stopped: true } : {}),
    });
    // A deviation is a proposal a person accepts; a run never records one as
    // accepted, whatever it sends.
    const deviations: VerificationDeviation[] = (verify.deviations ?? []).map((deviation) => ({
      ...deviation,
      state: "proposed",
    }));
    const origin = this.originFor(linkParams.origin, caller);
    const stored = storeReport({
      store: this.store,
      projectId,
      entityId,
      expectedRevisionId: plan.task.revisionId,
      plan,
      evaluation,
      commands: verify.commands,
      deviations,
      runId: verify.runId,
      startedAt: verify.startedAt,
      endedAt: verify.endedAt,
      ...(verify.stopped ? { stopped: verify.stopped } : {}),
      origin,
      idempotencyKey: linkParams.idempotencyKey,
    });
    const moved = convergeTask({
      store: this.store,
      projectId,
      entityId,
      expectedRevisionId: plan.task.revisionId,
      evidenceId: stored.evidence.evidenceId,
      report: stored.report,
      origin,
      idempotencyKey: linkParams.idempotencyKey,
    });
    const state = moved?.state ?? this.store.get({ projectId, entityId, body: { mode: "none" } }).entity.state;
    const verifyResult: VerificationBridgeResult = {
      report: stored.report,
      evidenceId: stored.evidence.evidenceId,
      blobId: stored.blobId,
      taskState: state,
      ...(moved ? { transition: { from: moved.from, to: moved.to } } : {}),
    };
    return {
      method: "project/work/link",
      result: { link: { type: "evidence", evidence: stored.evidence }, seq: stored.seq },
      projectId,
      verifyResult,
    };
  }

  /**
   * What an attempt ran in, as one supporting evidence record.
   *
   * The execution link carries identity, profile, branch and base commit; the
   * shape of the workspace and the checkout it used have nowhere to live on
   * it, and they are what makes an attempt readable a year later. The record
   * is assembled here, so nothing a model wrote reaches it, and the checkout
   * stays in the store: no tool answer ever carries it.
   */
  private async recordAttemptShape(
    projectId: string,
    entityId: string,
    result: ProjectTaskLinkExecutionResult,
    params: ProjectWorkBridgeParams,
    caller: ProjectWorkCaller,
  ): Promise<void> {
    const attempt = params.attempt;
    if (!attempt) return;
    const link = result.link;
    const shape = attempt.workspace === "worktree" ? "a worktree of its own" : "the project's own checkout";
    try {
      await this.handle(
        {
          method: "project/work/link",
          params: {
            projectId,
            expectedRevisionId: result.entity.currentRevisionId,
            link: {
              type: "evidence",
              entityId,
              revisionId: result.entity.currentRevisionId,
              kind: "source_location",
              role: "supporting",
              summary: `Attempt ${String(link.attempt)} ran in ${shape}${link.branch ? ` on ${link.branch}` : ""}.`,
              detail: attempt.checkout,
              outcome: "inconclusive",
            },
            idempotencyKey: `attempt-shape-${link.linkId}`,
          },
        },
        caller,
      );
    } catch {
      // The attempt is linked; its shape is a note beside it. A failure to
      // write the note must not undo the link the attempt depends on.
    }
  }

  /** A project id this store has never minted names nothing a caller may read. */
  private requireProject(projectId: string): void {
    if (!this.store.hasProject(projectId)) {
      throw new ProjectWorkNotFoundError("That project is not one this app has project work for.");
    }
  }

  /**
   * May this call change the project?
   *
   * Trust is a property of the folder, and a person who declined it declined
   * everything the app would do with that project — writing its lifecycle
   * included. Reads stay open: the store reads no project file, and hiding
   * work a person already wrote would be a worse answer than a refusal here.
   */
  private requireWritable(projectId: string): void {
    this.requireProject(projectId);
    const resolve = this.trustOf;
    if (!resolve) return;
    for (const path of this.store.projectPaths(projectId)) {
      if (resolve(path) === "declined") {
        throw new ProtocolError(
          ErrorCodes.ProjectUntrusted,
          "This project's folder is not trusted, so its project work cannot be changed here. Trust the project in Projects to make changes.",
        );
      }
      // Only the current path decides; the rest are history.
      break;
    }
  }

  /**
   * Who the store records as having done this.
   *
   * The **kind** is the host's, never the caller's: a client connection is a
   * person and a worker-bridge call is an agent. A client may still say which
   * person label to show and which session it is writing from, because those
   * are provenance rather than authority (D-329). This is the single place
   * that decides it, so "only a person approves" holds for every method.
   */
  private originFor(requested: ProjectWorkOrigin | undefined, caller: ProjectWorkCaller): ProjectWorkOrigin {
    const fromWorker = caller.source === "worker";
    const label = requested?.actor.label ?? caller.agent?.label ?? (fromWorker ? AGENT_LABEL : PERSON_LABEL);
    const sessionId = requested?.sessionId ?? caller.agent?.sessionId;
    const runId = requested?.runId ?? caller.agent?.runId;
    return {
      actor: { kind: fromWorker ? "agent" : "person", label },
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(runId !== undefined ? { runId } : {}),
    };
  }

  /**
   * One audit row for a decision that matters: approve, delete, archive.
   *
   * It names the actor, the project and the exact revisions, and it carries no
   * body content, no title and no note — the fields are assembled here rather
   * than passed through, so nothing from a body can reach the log by accident
   * (leap, "Security, privacy and resource rules").
   */
  private audit(
    kind: string,
    input: {
      origin: ProjectWorkOrigin;
      caller: ProjectWorkCaller;
      projectId: string;
      summary: string;
      detail: Record<string, unknown>;
    },
  ): void {
    this.logs?.record({
      section: "host",
      kind,
      summary: `project work: ${input.summary}`,
      detail: {
        projectId: input.projectId,
        actor: { kind: input.origin.actor.kind, label: input.origin.actor.label },
        actorClass: input.caller.actor.class,
        actorId: input.caller.actor.id,
        source: input.caller.source,
        ...(input.origin.sessionId !== undefined ? { sessionId: input.origin.sessionId } : {}),
        ...input.detail,
      },
    });
  }
}

/**
 * The part of a quota refusal that is about a **count** rather than bytes
 * (storage review M-3).
 *
 * A refusal over bytes carries `usedBytes`/`limitBytes` and nothing else: the
 * measure is the default and there is no count to report. A refusal over
 * records or items carries its own pair instead, because a number of rows
 * reported in a field named after bytes is how a client ends up telling a
 * person their project is 200,000 bytes full (D-365).
 */
function countRefusal(error: ProjectWorkQuotaError): Partial<ProjectWorkQuotaRefusal> {
  if (error.measure === "bytes") return {};
  const counts: Partial<ProjectWorkQuotaRefusal> = { measure: error.measure };
  if (error.usedCount !== undefined) counts.usedCount = error.usedCount;
  if (error.limitCount !== undefined) counts.limitCount = error.limitCount;
  return counts;
}

/**
 * The store's refusals, as the JSON-RPC errors the leap's callers expect.
 *
 * A conflict carries what is current *now* plus what the caller believed, so a
 * client can show the difference and offer both choices without another read.
 * A quota refusal carries the recovery action. Everything else is a message a
 * person can act on, under the code that says whose fault it is.
 */
export function toProtocolError(error: unknown): unknown {
  if (error instanceof ProjectWorkConflictError) {
    return new ProtocolError(PROJECT_WORK_CONFLICT_CODE, error.message, {
      conflict: "revision",
      current: error.current,
      expectedRevisionId: error.expectedRevisionId,
    } satisfies ProjectWorkConflict);
  }
  if (error instanceof ProjectWorkQuotaError) {
    return new ProtocolError(PROJECT_WORK_QUOTA_CODE, error.message, {
      refused: "quota",
      scope: error.scope,
      recovery: error.recovery,
      usedBytes: error.usedBytes,
      limitBytes: error.limitBytes,
      ...countRefusal(error),
    } satisfies ProjectWorkQuotaRefusal);
  }
  if (error instanceof ProjectWorkRefusedError) {
    // A refusal is a sentence first; the data is what the sentence names, for
    // a client that wants to offer the fix without reading the graph again.
    return error.data
      ? new ProtocolError(ErrorCodes.InvalidParams, error.message, error.data)
      : new ProtocolError(ErrorCodes.InvalidParams, error.message);
  }
  if (error instanceof ProjectWorkNotFoundError) {
    return new ProtocolError(ErrorCodes.InvalidParams, error.message);
  }
  if (error instanceof ProjectWorkUnavailableError) {
    return new ProtocolError(ErrorCodes.Unsupported, error.message);
  }
  return error;
}
