/**
 * The project-work method inventory (M21-T1, leap "Protocol and authority").
 *
 * Sixteen methods and two notifications, all engine-neutral, all answered by
 * the host: reads are served without starting a worker, and writes go to the
 * host's own authority (D-331). This file owns their params, their results,
 * their zod schemas and their per-method byte limits, so `messages.ts`,
 * `schemas.ts` and `method-policy.ts` only register what is defined here.
 *
 * Two invariants every mutation carries:
 *
 * - **`expectedRevisionId`** — optimistic concurrency. A stale write is
 *   refused with the current revision and a merge/retry choice, and never
 *   overwrites another session's work.
 * - **`idempotencyKey`** — the same key replays the first result rather than
 *   writing twice, so a retried tool call or a reconnecting client cannot
 *   create two revisions.
 */
import { z } from "zod";
import { ErrorCodes } from "./jsonrpc.js";
import {
  APPROVAL_DECISIONS,
  APPROVAL_GATES,
  APPROVAL_MODES,
  ARTIFACT_REVIEW_STATES,
  COMMENT_STATES,
  EVIDENCE_KINDS,
  EVIDENCE_ROLES,
  EXECUTION_LINK_KINDS,
  PROJECT_TASK_ACTIONS,
  PROJECT_TASK_STATES,
  PROJECT_WORK_EDGE_RELATIONS,
  PROJECT_WORK_KINDS,
  PROJECT_WORK_NOTE_MAX,
  PROJECT_WORK_TEXT_MAX,
  REPOSITORY_LINK_RELATIONS,
  approvedRevisionSchema,
  executionLinkSchema,
  projectIdSchema,
  projectWorkAnchorSchema,
  projectWorkApprovalSchema,
  projectWorkCommentSchema,
  projectWorkDecisionSchema,
  projectWorkEdgeSchema,
  projectWorkEntitySchema,
  projectWorkEvidenceSchema,
  projectWorkIdSchema,
  projectWorkKeySchema,
  projectWorkKindSchema,
  projectWorkOriginSchema,
  projectWorkRefSchema,
  projectWorkRevisionIdSchema,
  projectWorkRevisionSchema,
  projectWorkStateSchema,
  repositoryChangeRefSchema,
  repositoryStateRefSchema,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalMode,
  type ApprovedRevision,
  type CommentState,
  type EvidenceKind,
  type EvidenceRole,
  type ExecutionLink,
  type ExecutionLinkKind,
  type ProjectTaskAction,
  type ProjectTaskState,
  type ProjectWorkAnchor,
  type ProjectWorkApproval,
  type ProjectWorkComment,
  type ProjectWorkDecision,
  type ProjectWorkEdge,
  type ProjectWorkEdgeRelation,
  type ProjectWorkEntity,
  type ProjectWorkEvidence,
  type ProjectWorkKind,
  type ProjectWorkOrigin,
  type ProjectWorkRef,
  type ProjectWorkRevision,
  type ProjectWorkState,
  type RepositoryChangeRef,
  type RepositoryLink,
  type RepositoryLinkRelation,
  type RepositoryStateRef,
} from "./project-work.js";
import { projectWorkBodySchema, type ProjectWorkBody } from "./project-work-bodies.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** One page of a list. The workspace asks for 50; nothing may ask for more. */
export const PROJECT_WORK_LIST_LIMIT_DEFAULT = 50;
export const PROJECT_WORK_LIST_LIMIT_MAX = 200;
/** Search results in one answer. Keys match exactly and rank first (D-355). */
export const PROJECT_WORK_SEARCH_LIMIT_DEFAULT = 20;
export const PROJECT_WORK_SEARCH_LIMIT_MAX = 100;
/** One ranged page of a canonical body, in UTF-8 bytes. */
export const PROJECT_WORK_BODY_PAGE_MAX_BYTES = 256 * 1024;
/** One ranged page of a blob, in bytes before base64. */
export const PROJECT_WORK_BLOB_PAGE_MAX_BYTES = 512 * 1024;
/** The largest canonical body one revision may carry. */
export const PROJECT_WORK_BODY_MAX_BYTES = 4 * 1024 * 1024;
/** The largest single blob the store accepts (a sketch, a capture, an image). */
export const PROJECT_WORK_BLOB_MAX_BYTES = 16 * 1024 * 1024;
/** How many related records `project/work/get` inlines before it truncates. */
export const PROJECT_WORK_RELATED_MAX = 100;
/** Attention items one notification carries. The count is always exact. */
export const PROJECT_WORK_ATTENTION_ITEMS_MAX = 50;

/**
 * A revision conflict, as a JSON-RPC error code.
 *
 * The number lives in `ErrorCodes` (M21-T3) so the whole wire vocabulary is in
 * one table; this alias is what the project-work code reads, and it is the
 * same number it always was.
 */
export const PROJECT_WORK_CONFLICT_CODE: number = ErrorCodes.ProjectWorkConflict;

/** A durable write refused at a budget cap, as a JSON-RPC error code. */
export const PROJECT_WORK_QUOTA_CODE: number = ErrorCodes.ProjectWorkQuota;

/** The data a conflict carries: what is current, never what was overwritten. */
export interface ProjectWorkConflict {
  conflict: "revision";
  current: ProjectWorkRef;
  /** What the caller believed was current. */
  expectedRevisionId: string;
}

/** The data a refused durable write carries at a quota cap. */
export interface ProjectWorkQuotaRefusal {
  refused: "quota";
  scope: "project" | "global";
  /** What the person can do about it, in one sentence. */
  recovery: string;
  usedBytes: number;
  limitBytes: number;
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

const idempotencyKey = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/, "an idempotency key the caller minted");
const cursor = z.string().min(1).max(256);

/** One row of the Work backlog. Bounded: a row never carries a body. */
export interface ProjectWorkListItem {
  ref: ProjectWorkRef;
  kind: ProjectWorkKind;
  key: string;
  title: string;
  state: ProjectWorkState;
  updatedAt: string;
  createdAt: string;
  revisionCount: number;
  /** True when this row is in the "needs you" queue. */
  needsAttention: boolean;
  blockingComments: number;
  /** Present when the row is stale, naming the upstream that moved. */
  staleBecauseKey?: string;
  archived: boolean;
  /** How many links of each sort the entity has, for the has-link filter. */
  linkCounts: { edges: number; repository: number; execution: number };
  /** Tasks only: the dependency keys still unmet, for the board's refusals. */
  unmetDependencies?: string[];
}

/** Counts for the top-bar control (`18 items · 4 need you`). */
export interface ProjectWorkCounts {
  total: number;
  needsAttention: number;
  byKind: Record<ProjectWorkKind, number>;
}

/** A ranged page of the canonical JSON body of one revision. */
export interface ProjectWorkBodyPage {
  /** The canonical JSON encoding this page is a slice of. */
  encoding: "application/json";
  totalBytes: number;
  offset: number;
  bytes: number;
  nextOffset?: number;
  /** UTF-8 text, cut only on character boundaries. */
  text: string;
  /**
   * Present when the whole body was returned and parsed: the typed body, so a
   * caller that asked for everything does not parse it twice.
   */
  body?: ProjectWorkBody;
  /** Set when derived or released content is not available; never empty bytes. */
  released?: { reason: "quota" | "retention" | "migration"; detail: string };
}

export interface ProjectWorkSearchMatch {
  /** Which projected field matched. Never a path, a digest or a blob. */
  field: "key" | "title" | "body";
  /** A bounded snippet of the projected value. */
  snippet: string;
}

export interface ProjectWorkSearchResult {
  ref: ProjectWorkRef;
  kind: ProjectWorkKind;
  key: string;
  title: string;
  state: ProjectWorkState;
  /** Higher ranks first. An exact key match always outranks a text match. */
  score: number;
  exactKey: boolean;
  matches: ProjectWorkSearchMatch[];
}

/** What a projection was built from, so nothing is read without its revision. */
export interface ProjectionFence {
  entityId: string;
  revisionId: string;
  digest: string;
  /** The project event sequence the projection reflects. */
  seq: number;
}

// ---------------------------------------------------------------------------
// Params and results
// ---------------------------------------------------------------------------

export interface ProjectWorkListParams {
  /** The opaque project id. Omitted only when `cwd` names the directory. */
  projectId?: string;
  /**
   * A directory inside the project, as an alternative to `projectId`.
   *
   * The host resolves the project root of the canonical path (a worktree maps
   * to its parent project) and answers with that project's stable id, which is
   * what every other method takes. It exists so the first read of a session's
   * project does not need a round trip to learn an id (M21-T3).
   */
  cwd?: string;
  kinds?: ProjectWorkKind[];
  states?: ProjectWorkState[];
  needsYou?: boolean;
  hasLinks?: boolean;
  includeArchived?: boolean;
  updatedSince?: string;
  /** Reconcile: everything that changed after this project sequence number. */
  sinceSeq?: number;
  cursor?: string;
  limit?: number;
}

export interface ProjectWorkListResult {
  projectId: string;
  /** The project's current event sequence number. */
  seq: number;
  items: ProjectWorkListItem[];
  counts: ProjectWorkCounts;
  nextCursor?: string;
  /** Entity ids removed since `sinceSeq`, so a cache can drop them. */
  removed?: string[];
  /**
   * True when `sinceSeq` was older than the retained event window: the client
   * must replace its cache with this page rather than merge into it.
   */
  reset?: boolean;
}

export type ProjectWorkBodyMode = "full" | "none" | "range";

export interface ProjectWorkGetParams {
  projectId: string;
  entityId?: string;
  key?: string;
  /** A historical revision. Omitted reads the entity's current pointer. */
  revisionId?: string;
  body?: { mode: ProjectWorkBodyMode; offset?: number; limit?: number };
  include?: { comments?: boolean; approvals?: boolean; evidence?: boolean; links?: boolean; history?: boolean };
}

export interface ProjectWorkGetResult {
  ref: ProjectWorkRef;
  entity: ProjectWorkEntity;
  revision: ProjectWorkRevision;
  fence: ProjectionFence;
  body?: ProjectWorkBodyPage;
  edges: ProjectWorkEdge[];
  repositoryLinks: RepositoryLink[];
  executionLinks: ExecutionLink[];
  comments: ProjectWorkComment[];
  approvals: ProjectWorkApproval[];
  evidence: ProjectWorkEvidence[];
  decisions: ProjectWorkDecision[];
  /** Revision history, newest first, when asked for. Metadata only. */
  history?: ProjectWorkRevision[];
  /** Which related lists were cut at `PROJECT_WORK_RELATED_MAX`. */
  truncated: string[];
}

export interface ProjectWorkSearchParams {
  /** Omitted searches every project the caller may read. */
  projectId?: string;
  query: string;
  kinds?: ProjectWorkKind[];
  limit?: number;
}

export interface ProjectWorkSearchResults {
  results: ProjectWorkSearchResult[];
  truncated: boolean;
}

export interface ProjectWorkBlobReadParams {
  projectId: string;
  blobId: string;
  offset?: number;
  limit?: number;
}

export interface ProjectWorkBlobReadResult {
  blobId: string;
  mediaType: string;
  digest: string;
  totalBytes: number;
  offset: number;
  bytes: number;
  nextOffset?: number;
  /** base64 of exactly `bytes` bytes. Absent when the content was released. */
  data?: string;
  released?: { reason: "quota" | "retention" | "migration"; detail: string };
}

export interface ProjectWorkCreateParams {
  projectId: string;
  kind: ProjectWorkKind;
  title: string;
  body: ProjectWorkBody;
  idempotencyKey: string;
  origin?: ProjectWorkOrigin;
  note?: string;
}

export interface ProjectWorkWriteResult {
  ref: ProjectWorkRef;
  entity: ProjectWorkEntity;
  revision: ProjectWorkRevision;
  seq: number;
  /** True when this answer replayed an earlier call with the same key. */
  replayed?: boolean;
}

export interface ProjectWorkReviseParams {
  projectId: string;
  entityId: string;
  expectedRevisionId: string;
  title?: string;
  body: ProjectWorkBody;
  idempotencyKey: string;
  origin?: ProjectWorkOrigin;
  note?: string;
}

export interface ProjectWorkArchiveParams {
  projectId: string;
  entityId: string;
  expectedRevisionId: string;
  archived: boolean;
  idempotencyKey: string;
  origin?: ProjectWorkOrigin;
}

export interface ProjectWorkArchiveResult {
  entity: ProjectWorkEntity;
  seq: number;
  replayed?: boolean;
}

export interface ProjectWorkDeleteParams {
  projectId: string;
  entityId: string;
  expectedRevisionId: string;
  /** Permanent. Without it the host answers with the preview and writes nothing. */
  confirm?: boolean;
  idempotencyKey: string;
  origin?: ProjectWorkOrigin;
}

export interface ProjectWorkDeleteResult {
  deleted: boolean;
  /** What deleting this would orphan, by key. Shown in the typed confirmation. */
  orphans: Array<{ key: string; kind: ProjectWorkKind; relation: string }>;
  seq: number;
  replayed?: boolean;
}

export interface ProjectWorkCommentParams {
  projectId: string;
  entityId: string;
  /** The entity revision the commenter was looking at. Fences the write. */
  expectedRevisionId: string;
  /** The revision the comment anchors to. May be an older one. */
  revisionId: string;
  anchor: ProjectWorkAnchor;
  text: string;
  blocking?: boolean;
  parentCommentId?: string;
  idempotencyKey: string;
  origin?: ProjectWorkOrigin;
}

export interface ProjectWorkCommentResult {
  comment: ProjectWorkComment;
  entity: ProjectWorkEntity;
  seq: number;
  replayed?: boolean;
}

/** The review actions that are not approvals. An agent may take all of these. */
export const PROJECT_WORK_REVIEW_ACTIONS = ["request_review", "return_to_draft", "restore", "supersede"] as const;
export type ProjectWorkReviewAction = (typeof PROJECT_WORK_REVIEW_ACTIONS)[number];

export interface ProjectWorkReviewParams {
  projectId: string;
  entityId: string;
  expectedRevisionId: string;
  action: ProjectWorkReviewAction;
  /** For `supersede`: the entity that replaces this one. */
  supersededByEntityId?: string;
  note?: string;
  idempotencyKey: string;
  origin?: ProjectWorkOrigin;
}

export interface ProjectWorkReviewResult {
  entity: ProjectWorkEntity;
  seq: number;
  replayed?: boolean;
}

export interface ProjectWorkApproveParams {
  projectId: string;
  entityId: string;
  expectedRevisionId: string;
  gate: ApprovalGate;
  decision: ApprovalDecision;
  /** Every exact revision the decision covers, with digests (D-332). */
  covers: ApprovedRevision[];
  mode?: ApprovalMode;
  skipReason?: string;
  note?: string;
  idempotencyKey: string;
  origin?: ProjectWorkOrigin;
}

export interface ProjectWorkApproveResult {
  approval: ProjectWorkApproval;
  entity: ProjectWorkEntity;
  seq: number;
  replayed?: boolean;
}

export interface ProjectWorkResolveCommentParams {
  projectId: string;
  entityId: string;
  expectedRevisionId: string;
  commentId: string;
  /** An agent may only mark a comment addressed; a person resolves or reopens. */
  resolution: Exclude<CommentState, "open"> | "reopened";
  idempotencyKey: string;
  origin?: ProjectWorkOrigin;
}

export interface ProjectWorkResolveCommentResult {
  comment: ProjectWorkComment;
  entity: ProjectWorkEntity;
  seq: number;
  replayed?: boolean;
}

/**
 * What `project/work/link` can add.
 *
 * Evidence and decisions travel through the same method on purpose: the leap's
 * inventory is closed, and both are records joined to an exact revision, which
 * is what a link is. `unlink` removes any of them by `linkId`.
 */
export type ProjectWorkLinkInput =
  | {
      type: "edge";
      relation: ProjectWorkEdgeRelation;
      subject: { entityId: string; revisionId: string };
      object: { entityId: string; revisionId: string };
      note?: string;
    }
  | {
      type: "repository";
      relation: RepositoryLinkRelation;
      subjectEntityId: string;
      subjectRevisionId: string;
      repositoryId: string;
      target: { state: RepositoryStateRef } | { change: RepositoryChangeRef };
      publishedPath?: string;
      supersedesLinkId?: string;
      captureBlobId?: string;
    }
  | {
      type: "evidence";
      entityId: string;
      revisionId: string;
      kind: EvidenceKind;
      role: EvidenceRole;
      summary: string;
      detail?: string;
      blobId?: string;
      outcome: "passed" | "failed" | "inconclusive";
      repositoryLinkId?: string;
    }
  | {
      type: "decision";
      entityId: string;
      revisionId: string;
      title: string;
      rationale: string;
      consequences: string[];
      supersedesDecisionId?: string;
    };

export type ProjectWorkLinkRecord =
  | { type: "edge"; edge: ProjectWorkEdge }
  | { type: "repository"; repository: RepositoryLink }
  | { type: "evidence"; evidence: ProjectWorkEvidence }
  | { type: "decision"; decision: ProjectWorkDecision };

export interface ProjectWorkLinkParams {
  projectId: string;
  /** The current revision of the entity the link is being added to. */
  expectedRevisionId: string;
  link: ProjectWorkLinkInput;
  idempotencyKey: string;
  origin?: ProjectWorkOrigin;
}

export interface ProjectWorkLinkResult {
  link: ProjectWorkLinkRecord;
  seq: number;
  replayed?: boolean;
}

export interface ProjectWorkUnlinkParams {
  projectId: string;
  entityId: string;
  expectedRevisionId: string;
  linkId: string;
  idempotencyKey: string;
  origin?: ProjectWorkOrigin;
}

export interface ProjectWorkUnlinkResult {
  removed: boolean;
  seq: number;
  replayed?: boolean;
}

export interface ProjectTaskActionParams {
  projectId: string;
  entityId: string;
  expectedRevisionId: string;
  action: ProjectTaskAction;
  /** The acceptance evidence a completion rests on. */
  evidenceId?: string;
  note?: string;
  idempotencyKey: string;
  origin?: ProjectWorkOrigin;
}

export interface ProjectTaskActionResult {
  entity: ProjectWorkEntity;
  transition: { from: ProjectTaskState; to: ProjectTaskState };
  seq: number;
  replayed?: boolean;
}

export interface ProjectTaskLinkExecutionParams {
  projectId: string;
  entityId: string;
  expectedRevisionId: string;
  execution: {
    kind: ExecutionLinkKind;
    targetId: string;
    attempt?: number;
    profileId?: string;
    branch?: string;
    repositoryId?: string;
    baseCommitObjectId?: string;
    startedAt?: string;
    endedAt?: string;
    outcome?: "completed" | "blocked" | "cancelled" | "failed";
  };
  idempotencyKey: string;
  origin?: ProjectWorkOrigin;
}

export interface ProjectTaskLinkExecutionResult {
  link: ExecutionLink;
  entity: ProjectWorkEntity;
  seq: number;
  replayed?: boolean;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const PROJECT_WORK_CHANGE_KINDS = [
  "created",
  "revised",
  "state",
  "archived",
  "deleted",
  "comment",
  "approval",
  "link",
  "unlink",
  "execution",
  "stale",
] as const;
export type ProjectWorkChangeKind = (typeof PROJECT_WORK_CHANGE_KINDS)[number];

/** One project event. Carries identity and a summary, never a body. */
export interface ProjectWorkChange {
  change: ProjectWorkChangeKind;
  entityId: string;
  entityKind: ProjectWorkKind;
  key: string;
  title: string;
  state: ProjectWorkState;
  revisionId?: string;
  digest?: string;
  at: string;
  /** Who made it happen, for "Recent". Provenance, never ownership. */
  actorLabel?: string;
  sessionId?: string;
}

export interface ProjectWorkUpdatedNotification {
  projectId: string;
  seq: number;
  change: ProjectWorkChange;
}

export const PROJECT_WORK_ATTENTION_REASONS = [
  "gate",
  "blocking_comment",
  "handed_to_person",
  "blocked_task",
  "index_review",
  "stale",
] as const;
export type ProjectWorkAttentionReason = (typeof PROJECT_WORK_ATTENTION_REASONS)[number];

export interface ProjectWorkAttentionItem {
  entityId: string;
  kind: ProjectWorkKind;
  key: string;
  title: string;
  reason: ProjectWorkAttentionReason;
  at: string;
}

export interface ProjectWorkAttentionNotification {
  projectId: string;
  seq: number;
  /** The exact number of things waiting on a person, for the tab badge. */
  needsYou: number;
  items: ProjectWorkAttentionItem[];
  /** True when `items` was cut at the ceiling; `needsYou` is still exact. */
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Param schemas
// ---------------------------------------------------------------------------

const kinds = z.array(projectWorkKindSchema).max(PROJECT_WORK_KINDS.length);
const states = z.array(projectWorkStateSchema).max(ARTIFACT_REVIEW_STATES.length + PROJECT_TASK_STATES.length);

const linkInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("edge"),
      relation: z.enum(PROJECT_WORK_EDGE_RELATIONS),
      subject: z.object({ entityId: projectWorkIdSchema, revisionId: projectWorkRevisionIdSchema }).strict(),
      object: z.object({ entityId: projectWorkIdSchema, revisionId: projectWorkRevisionIdSchema }).strict(),
      note: z.string().max(PROJECT_WORK_NOTE_MAX).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("repository"),
      relation: z.enum(REPOSITORY_LINK_RELATIONS),
      subjectEntityId: projectWorkIdSchema,
      subjectRevisionId: projectWorkRevisionIdSchema,
      repositoryId: projectWorkIdSchema,
      target: z.union([
        z.object({ state: repositoryStateRefSchema }).strict(),
        z.object({ change: repositoryChangeRefSchema }).strict(),
      ]),
      publishedPath: z.string().min(1).max(1024).optional(),
      supersedesLinkId: projectWorkIdSchema.optional(),
      captureBlobId: projectWorkIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("evidence"),
      entityId: projectWorkIdSchema,
      revisionId: projectWorkRevisionIdSchema,
      kind: z.enum(EVIDENCE_KINDS),
      role: z.enum(EVIDENCE_ROLES),
      summary: z.string().min(1).max(PROJECT_WORK_TEXT_MAX),
      detail: z.string().max(PROJECT_WORK_TEXT_MAX).optional(),
      blobId: projectWorkIdSchema.optional(),
      outcome: z.enum(["passed", "failed", "inconclusive"]),
      repositoryLinkId: projectWorkIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("decision"),
      entityId: projectWorkIdSchema,
      revisionId: projectWorkRevisionIdSchema,
      title: z.string().min(1).max(200),
      rationale: z.string().min(1).max(PROJECT_WORK_TEXT_MAX),
      consequences: z.array(z.string().max(PROJECT_WORK_TEXT_MAX)).max(32),
      supersedesDecisionId: projectWorkIdSchema.optional(),
    })
    .strict(),
]);

/**
 * One schema per method, spread into `clientParamsSchemas`. Every one is
 * `.strict()`: a field this table does not know is a refusal at the boundary,
 * not a silently ignored intent.
 */
export const projectWorkParamsSchemas = {
  "project/work/list": z
    .object({
      projectId: projectIdSchema.optional(),
      cwd: z.string().min(1).max(4096).optional(),
      kinds: kinds.optional(),
      states: states.optional(),
      needsYou: z.boolean().optional(),
      hasLinks: z.boolean().optional(),
      includeArchived: z.boolean().optional(),
      updatedSince: z.string().min(1).max(64).optional(),
      sinceSeq: z.number().int().nonnegative().optional(),
      cursor: cursor.optional(),
      limit: z.number().int().min(1).max(PROJECT_WORK_LIST_LIMIT_MAX).optional(),
    })
    .strict()
    .refine((params) => params.projectId !== undefined || params.cwd !== undefined, {
      message: "name the project by id, or the folder it is open at",
      path: ["projectId"],
    }),
  "project/work/get": z
    .object({
      projectId: projectIdSchema,
      entityId: projectWorkIdSchema.optional(),
      key: projectWorkKeySchema.optional(),
      revisionId: projectWorkRevisionIdSchema.optional(),
      body: z
        .object({
          mode: z.enum(["full", "none", "range"]),
          offset: z.number().int().nonnegative().optional(),
          limit: z.number().int().min(1).max(PROJECT_WORK_BODY_PAGE_MAX_BYTES).optional(),
        })
        .strict()
        .optional(),
      include: z
        .object({
          comments: z.boolean().optional(),
          approvals: z.boolean().optional(),
          evidence: z.boolean().optional(),
          links: z.boolean().optional(),
          history: z.boolean().optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .refine((params) => params.entityId !== undefined || params.key !== undefined, {
      message: "name the entity by id or by key",
      path: ["entityId"],
    }),
  "project/work/search": z
    .object({
      projectId: projectIdSchema.optional(),
      query: z.string().trim().min(1).max(200),
      kinds: kinds.optional(),
      limit: z.number().int().min(1).max(PROJECT_WORK_SEARCH_LIMIT_MAX).optional(),
    })
    .strict(),
  "project/work/blob/read": z
    .object({
      projectId: projectIdSchema,
      blobId: projectWorkIdSchema,
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(PROJECT_WORK_BLOB_PAGE_MAX_BYTES).optional(),
    })
    .strict(),

  "project/work/create": z
    .object({
      projectId: projectIdSchema,
      kind: projectWorkKindSchema,
      title: z.string().min(1).max(200),
      body: projectWorkBodySchema,
      idempotencyKey,
      origin: projectWorkOriginSchema.optional(),
      note: z.string().max(PROJECT_WORK_NOTE_MAX).optional(),
    })
    .strict()
    .refine((params) => params.body.kind === params.kind, {
      message: "the body must be the body of the kind being created",
      path: ["body"],
    }),
  "project/work/revise": z
    .object({
      projectId: projectIdSchema,
      entityId: projectWorkIdSchema,
      expectedRevisionId: projectWorkRevisionIdSchema,
      title: z.string().min(1).max(200).optional(),
      body: projectWorkBodySchema,
      idempotencyKey,
      origin: projectWorkOriginSchema.optional(),
      note: z.string().max(PROJECT_WORK_NOTE_MAX).optional(),
    })
    .strict(),
  "project/work/archive": z
    .object({
      projectId: projectIdSchema,
      entityId: projectWorkIdSchema,
      expectedRevisionId: projectWorkRevisionIdSchema,
      archived: z.boolean(),
      idempotencyKey,
      origin: projectWorkOriginSchema.optional(),
    })
    .strict(),
  "project/work/delete": z
    .object({
      projectId: projectIdSchema,
      entityId: projectWorkIdSchema,
      expectedRevisionId: projectWorkRevisionIdSchema,
      confirm: z.literal(true).optional(),
      idempotencyKey,
      origin: projectWorkOriginSchema.optional(),
    })
    .strict(),

  "project/work/comment": z
    .object({
      projectId: projectIdSchema,
      entityId: projectWorkIdSchema,
      expectedRevisionId: projectWorkRevisionIdSchema,
      revisionId: projectWorkRevisionIdSchema,
      anchor: projectWorkAnchorSchema,
      text: z.string().min(1).max(PROJECT_WORK_TEXT_MAX),
      blocking: z.boolean().optional(),
      parentCommentId: projectWorkIdSchema.optional(),
      idempotencyKey,
      origin: projectWorkOriginSchema.optional(),
    })
    .strict(),
  "project/work/review": z
    .object({
      projectId: projectIdSchema,
      entityId: projectWorkIdSchema,
      expectedRevisionId: projectWorkRevisionIdSchema,
      action: z.enum(PROJECT_WORK_REVIEW_ACTIONS),
      supersededByEntityId: projectWorkIdSchema.optional(),
      note: z.string().max(PROJECT_WORK_NOTE_MAX).optional(),
      idempotencyKey,
      origin: projectWorkOriginSchema.optional(),
    })
    .strict()
    .refine((params) => params.action !== "supersede" || params.supersededByEntityId !== undefined, {
      message: "name the entity that supersedes this one",
      path: ["supersededByEntityId"],
    }),
  "project/work/approve": z
    .object({
      projectId: projectIdSchema,
      entityId: projectWorkIdSchema,
      expectedRevisionId: projectWorkRevisionIdSchema,
      gate: z.enum(APPROVAL_GATES),
      decision: z.enum(APPROVAL_DECISIONS),
      covers: z.array(approvedRevisionSchema).min(1).max(64),
      mode: z.enum(APPROVAL_MODES).optional(),
      skipReason: z.string().max(PROJECT_WORK_NOTE_MAX).optional(),
      note: z.string().max(PROJECT_WORK_NOTE_MAX).optional(),
      idempotencyKey,
      origin: projectWorkOriginSchema.optional(),
    })
    .strict(),
  "project/work/resolve-comment": z
    .object({
      projectId: projectIdSchema,
      entityId: projectWorkIdSchema,
      expectedRevisionId: projectWorkRevisionIdSchema,
      commentId: projectWorkIdSchema,
      resolution: z.enum(["addressed", "resolved", "reopened"]),
      idempotencyKey,
      origin: projectWorkOriginSchema.optional(),
    })
    .strict(),

  "project/work/link": z
    .object({
      projectId: projectIdSchema,
      expectedRevisionId: projectWorkRevisionIdSchema,
      link: linkInputSchema,
      idempotencyKey,
      origin: projectWorkOriginSchema.optional(),
    })
    .strict(),
  "project/work/unlink": z
    .object({
      projectId: projectIdSchema,
      entityId: projectWorkIdSchema,
      expectedRevisionId: projectWorkRevisionIdSchema,
      linkId: projectWorkIdSchema,
      idempotencyKey,
      origin: projectWorkOriginSchema.optional(),
    })
    .strict(),
  "project/task/action": z
    .object({
      projectId: projectIdSchema,
      entityId: projectWorkIdSchema,
      expectedRevisionId: projectWorkRevisionIdSchema,
      action: z.enum(PROJECT_TASK_ACTIONS),
      evidenceId: projectWorkIdSchema.optional(),
      note: z.string().max(PROJECT_WORK_NOTE_MAX).optional(),
      idempotencyKey,
      origin: projectWorkOriginSchema.optional(),
    })
    .strict(),
  "project/task/link-execution": z
    .object({
      projectId: projectIdSchema,
      entityId: projectWorkIdSchema,
      expectedRevisionId: projectWorkRevisionIdSchema,
      execution: z
        .object({
          kind: z.enum(EXECUTION_LINK_KINDS),
          targetId: z.string().min(1).max(200),
          attempt: z.number().int().min(1).max(10_000).optional(),
          profileId: z.string().min(1).max(120).optional(),
          branch: z.string().min(1).max(255).optional(),
          repositoryId: projectWorkIdSchema.optional(),
          baseCommitObjectId: z.string().regex(/^[0-9a-f]{7,64}$/, "a git object id").optional(),
          startedAt: z.string().min(1).max(64).optional(),
          endedAt: z.string().min(1).max(64).optional(),
          outcome: z.enum(["completed", "blocked", "cancelled", "failed"]).optional(),
        })
        .strict(),
      idempotencyKey,
      origin: projectWorkOriginSchema.optional(),
    })
    .strict(),
} as const;

export type ProjectWorkMethod = keyof typeof projectWorkParamsSchemas;

export const PROJECT_WORK_METHODS = Object.keys(projectWorkParamsSchemas) as ProjectWorkMethod[];

/** Every method a mutation, for the policy table and the host's audit. */
export const PROJECT_WORK_WRITE_METHODS: readonly ProjectWorkMethod[] = [
  "project/work/create",
  "project/work/revise",
  "project/work/archive",
  "project/work/delete",
  "project/work/comment",
  "project/work/review",
  "project/work/approve",
  "project/work/resolve-comment",
  "project/work/link",
  "project/work/unlink",
  "project/task/action",
  "project/task/link-execution",
];

export const PROJECT_WORK_READ_METHODS: readonly ProjectWorkMethod[] = [
  "project/work/list",
  "project/work/get",
  "project/work/search",
  "project/work/blob/read",
];

/**
 * The byte ceiling for one request of each method, in UTF-8 bytes.
 *
 * A create or revise carries a whole body, so it is the body ceiling plus an
 * envelope; everything else is small by construction. The host refuses above
 * the row rather than parsing a frame it will not keep.
 */
export const PROJECT_WORK_METHOD_LIMITS: Readonly<Record<ProjectWorkMethod, number>> = {
  "project/work/list": 8 * 1024,
  "project/work/get": 8 * 1024,
  "project/work/search": 8 * 1024,
  "project/work/blob/read": 8 * 1024,
  "project/work/create": PROJECT_WORK_BODY_MAX_BYTES + 64 * 1024,
  "project/work/revise": PROJECT_WORK_BODY_MAX_BYTES + 64 * 1024,
  "project/work/archive": 8 * 1024,
  "project/work/delete": 8 * 1024,
  "project/work/comment": 64 * 1024,
  "project/work/review": 16 * 1024,
  "project/work/approve": 64 * 1024,
  "project/work/resolve-comment": 8 * 1024,
  "project/work/link": 64 * 1024,
  "project/work/unlink": 8 * 1024,
  "project/task/action": 16 * 1024,
  "project/task/link-execution": 16 * 1024,
};

/** The two notifications, for the scope and pressure tables. */
export const PROJECT_WORK_NOTIFICATIONS = ["project/work/updated", "project/work/attention"] as const;
export type ProjectWorkNotification = (typeof PROJECT_WORK_NOTIFICATIONS)[number];

// ---------------------------------------------------------------------------
// Result schemas (used by round-trip samples and by clients that validate)
// ---------------------------------------------------------------------------

export const projectWorkListItemSchema = z
  .object({
    ref: projectWorkRefSchema,
    kind: projectWorkKindSchema,
    key: projectWorkKeySchema,
    title: z.string().min(1).max(200),
    state: projectWorkStateSchema,
    updatedAt: z.string().min(1).max(64),
    createdAt: z.string().min(1).max(64),
    revisionCount: z.number().int().min(1),
    needsAttention: z.boolean(),
    blockingComments: z.number().int().nonnegative(),
    staleBecauseKey: projectWorkKeySchema.optional(),
    archived: z.boolean(),
    linkCounts: z
      .object({
        edges: z.number().int().nonnegative(),
        repository: z.number().int().nonnegative(),
        execution: z.number().int().nonnegative(),
      })
      .strict(),
    unmetDependencies: z.array(projectWorkKeySchema).max(200).optional(),
  })
  .strict();

export const projectWorkUpdatedSchema = z
  .object({
    projectId: projectIdSchema,
    seq: z.number().int().nonnegative(),
    change: z
      .object({
        change: z.enum(PROJECT_WORK_CHANGE_KINDS),
        entityId: projectWorkIdSchema,
        entityKind: projectWorkKindSchema,
        key: projectWorkKeySchema,
        title: z.string().max(200),
        state: projectWorkStateSchema,
        revisionId: projectWorkRevisionIdSchema.optional(),
        digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        at: z.string().min(1).max(64),
        actorLabel: z.string().max(200).optional(),
        sessionId: z.string().min(1).max(64).optional(),
      })
      .strict(),
  })
  .strict();

export const projectWorkAttentionSchema = z
  .object({
    projectId: projectIdSchema,
    seq: z.number().int().nonnegative(),
    needsYou: z.number().int().nonnegative(),
    items: z
      .array(
        z
          .object({
            entityId: projectWorkIdSchema,
            kind: projectWorkKindSchema,
            key: projectWorkKeySchema,
            title: z.string().max(200),
            reason: z.enum(PROJECT_WORK_ATTENTION_REASONS),
            at: z.string().min(1).max(64),
          })
          .strict(),
      )
      .max(PROJECT_WORK_ATTENTION_ITEMS_MAX),
    truncated: z.boolean().optional(),
  })
  .strict();

/** Entity, revision and supporting-record schemas, re-exported for result validation. */
export const projectWorkResultSchemas = {
  entity: projectWorkEntitySchema,
  revision: projectWorkRevisionSchema,
  comment: projectWorkCommentSchema,
  approval: projectWorkApprovalSchema,
  decision: projectWorkDecisionSchema,
  evidence: projectWorkEvidenceSchema,
  edge: projectWorkEdgeSchema,
  execution: executionLinkSchema,
  listItem: projectWorkListItemSchema,
  updated: projectWorkUpdatedSchema,
  attention: projectWorkAttentionSchema,
} as const;
