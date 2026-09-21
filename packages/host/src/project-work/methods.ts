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
import {
  ErrorCodes,
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
} from "@lasercode/protocol";
import { projectRootOf } from "../paths.js";
import { canonical } from "../trust.js";
import type { LogInput } from "../logstore.js";
import {
  ProjectWorkConflictError,
  ProjectWorkNotFoundError,
  ProjectWorkQuotaError,
  ProjectWorkRefusedError,
  ProjectWorkUnavailableError,
} from "./errors.js";
import type { ProjectWorkStore } from "./store.js";

/** One request this authority answers, with the params its method declares. */
export type ProjectWorkRequest = {
  [M in ProjectWorkMethod]: { method: M; params: ClientRequests[M]["params"] };
}[ProjectWorkMethod];

export type ProjectWorkResult = ClientRequests[ProjectWorkMethod]["result"];

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
  handle(request: ProjectWorkRequest, caller: ProjectWorkCaller): ProjectWorkResult {
    try {
      return this.route(request, caller);
    } catch (error) {
      throw toProtocolError(error);
    }
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

  private route(request: ProjectWorkRequest, caller: ProjectWorkCaller): ProjectWorkResult {
    switch (request.method) {
      case "project/work/list":
        return this.list(request.params);
      case "project/work/get": {
        const params = request.params;
        this.requireProject(params.projectId);
        return this.store.get({
          projectId: params.projectId,
          ...(params.entityId !== undefined ? { entityId: params.entityId } : {}),
          ...(params.key !== undefined ? { key: params.key } : {}),
          ...(params.revisionId !== undefined ? { revisionId: params.revisionId } : {}),
          ...(params.body ? { body: params.body } : {}),
          ...(params.include ? { include: params.include } : {}),
        });
      }
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
        return this.store.create({
          projectId: params.projectId,
          kind: params.kind,
          title: params.title,
          body: params.body,
          ...(params.note !== undefined ? { note: params.note } : {}),
          origin,
          idempotencyKey: params.idempotencyKey,
        });
      }
      case "project/work/revise": {
        const params = request.params;
        const origin = this.originFor(params.origin, caller);
        this.requireWritable(params.projectId);
        return this.store.revise({
          projectId: params.projectId,
          entityId: params.entityId,
          expectedRevisionId: params.expectedRevisionId,
          ...(params.title !== undefined ? { title: params.title } : {}),
          body: params.body,
          ...(params.note !== undefined ? { note: params.note } : {}),
          origin,
          idempotencyKey: params.idempotencyKey,
        });
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
        return this.store.link({
          projectId: params.projectId,
          expectedRevisionId: params.expectedRevisionId,
          link: params.link,
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
        return this.store.taskAction({
          projectId: params.projectId,
          entityId: params.entityId,
          expectedRevisionId: params.expectedRevisionId,
          action: params.action,
          ...(params.evidenceId !== undefined ? { evidenceId: params.evidenceId } : {}),
          ...(params.note !== undefined ? { note: params.note } : {}),
          origin,
          idempotencyKey: params.idempotencyKey,
        });
      }
      case "project/task/link-execution": {
        const params = request.params;
        const origin = this.originFor(params.origin, caller);
        this.requireWritable(params.projectId);
        return this.store.linkExecution({
          projectId: params.projectId,
          entityId: params.entityId,
          expectedRevisionId: params.expectedRevisionId,
          execution: params.execution,
          origin,
          idempotencyKey: params.idempotencyKey,
        });
      }
    }
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
    } satisfies ProjectWorkQuotaRefusal);
  }
  if (error instanceof ProjectWorkNotFoundError || error instanceof ProjectWorkRefusedError) {
    return new ProtocolError(ErrorCodes.InvalidParams, error.message);
  }
  if (error instanceof ProjectWorkUnavailableError) {
    return new ProtocolError(ErrorCodes.Unsupported, error.message);
  }
  return error;
}
