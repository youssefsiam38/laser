/**
 * The project lifecycle domain (M21-T1, `docs/project-lifecycle-leap.md`).
 *
 * A project owns durable Specs, Research, Designs, Plans and Project Tasks.
 * This module is the closed vocabulary for all of them: identities, the
 * person-facing key projection (D-355), immutable revisions, the supporting
 * records, the dependency edges, repository provenance (D-345), and the pure
 * functions that decide a transition or work out what a change made stale.
 *
 * Three rules shape every type here:
 *
 * - **No primary entity carries an owning session** (D-329). A revision, a
 *   comment or an approval may record the session it happened in as
 *   *provenance*; deleting that session leaves an unavailable link and changes
 *   nothing about the entity.
 * - **Identity is opaque.** `projectId`, `entityId`, `revisionId`, `linkId` and
 *   `blobId` are strings this machine minted and nothing else may parse. A host
 *   path, a storage layout or a filename never appears in a wire shape. The key
 *   (`SPEC-12`) is a person-facing handle, never the identity.
 * - **Links are optional in every direction** (D-352). Nothing is pending,
 *   incomplete or nagged for a missing link, and staleness propagates only
 *   along links that exist.
 *
 * Everything in this file is pure: no clock, no filesystem, no Pi.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Kinds and keys
// ---------------------------------------------------------------------------

/**
 * The closed set of primary kinds. Adding a sixth is a decision and a protocol
 * change (leap, "Product boundary"), never a quiet addition here.
 */
export const PROJECT_WORK_KINDS = ["spec", "research", "design", "plan", "task"] as const;
export type ProjectWorkKind = (typeof PROJECT_WORK_KINDS)[number];

/** Which kinds are reviewed artifacts (everything but the Task). */
export const PROJECT_ARTIFACT_KINDS = ["spec", "research", "design", "plan"] as const;
export type ProjectArtifactKind = (typeof PROJECT_ARTIFACT_KINDS)[number];

export function isProjectWorkKind(value: unknown): value is ProjectWorkKind {
  return typeof value === "string" && (PROJECT_WORK_KINDS as readonly string[]).includes(value);
}

export function isProjectArtifactKind(value: unknown): value is ProjectArtifactKind {
  return typeof value === "string" && (PROJECT_ARTIFACT_KINDS as readonly string[]).includes(value);
}

/**
 * The key prefix per kind (D-355). Speakable, greppable, usable in a commit
 * message or a branch name, and 1:1 with an exported tracker key.
 */
export const PROJECT_WORK_KEY_PREFIXES: Readonly<Record<ProjectWorkKind, string>> = {
  spec: "SPEC",
  research: "RES",
  design: "DES",
  plan: "PLAN",
  task: "TASK",
};

const KIND_BY_PREFIX: Readonly<Record<string, ProjectWorkKind>> = Object.fromEntries(
  PROJECT_WORK_KINDS.map((kind) => [PROJECT_WORK_KEY_PREFIXES[kind], kind]),
) as Record<string, ProjectWorkKind>;

/** The largest key number the store will ever allocate. Far beyond any project. */
export const PROJECT_WORK_KEY_MAX = 9_999_999;

/** `spec` + 12 → `SPEC-12`. Numbers start at 1 and are never reused (D-355). */
export function projectWorkKey(kind: ProjectWorkKind, number: number): string {
  if (!Number.isSafeInteger(number) || number < 1 || number > PROJECT_WORK_KEY_MAX) {
    throw new RangeError(`a project work key number must be between 1 and ${PROJECT_WORK_KEY_MAX}`);
  }
  return `${PROJECT_WORK_KEY_PREFIXES[kind]}-${number}`;
}

/** `TASK-44` → `{ kind: "task", number: 44 }`, or `undefined` for anything else. */
export function parseProjectWorkKey(key: string): { kind: ProjectWorkKind; number: number } | undefined {
  const match = /^([A-Z]+)-(\d{1,7})$/.exec(key.trim());
  if (!match) return undefined;
  const prefix = match[1];
  const digits = match[2];
  if (prefix === undefined || digits === undefined) return undefined;
  const kind = KIND_BY_PREFIX[prefix];
  if (!kind) return undefined;
  const number = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(number) || number < 1 || number > PROJECT_WORK_KEY_MAX) return undefined;
  // `SPEC-007` is not the key the store minted, so it is not this key.
  if (String(number) !== digits) return undefined;
  return { kind, number };
}

export function isProjectWorkKeyString(value: unknown): value is string {
  return typeof value === "string" && parseProjectWorkKey(value) !== undefined;
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/** Artifact review states (leap, "Revision and staleness model"). */
export const ARTIFACT_REVIEW_STATES = ["draft", "needs_review", "approved", "stale", "superseded", "archived"] as const;
export type ArtifactReviewState = (typeof ARTIFACT_REVIEW_STATES)[number];

/**
 * Project Task states. There is deliberately no `failed`: a failed execution
 * attempt is evidence, not a failed Task (leap, "Revision and staleness model").
 */
export const PROJECT_TASK_STATES = ["draft", "blocked", "ready", "in_progress", "needs_review", "done", "cancelled"] as const;
export type ProjectTaskState = (typeof PROJECT_TASK_STATES)[number];

export type ProjectWorkState = ArtifactReviewState | ProjectTaskState;

export function isArtifactReviewState(value: unknown): value is ArtifactReviewState {
  return typeof value === "string" && (ARTIFACT_REVIEW_STATES as readonly string[]).includes(value);
}

export function isProjectTaskState(value: unknown): value is ProjectTaskState {
  return typeof value === "string" && (PROJECT_TASK_STATES as readonly string[]).includes(value);
}

/** The states a kind may hold. A Task never holds a review state, and vice versa. */
export function statesForKind(kind: ProjectWorkKind): readonly ProjectWorkState[] {
  return kind === "task" ? PROJECT_TASK_STATES : ARTIFACT_REVIEW_STATES;
}

export function isStateForKind(kind: ProjectWorkKind, state: unknown): state is ProjectWorkState {
  return typeof state === "string" && (statesForKind(kind) as readonly string[]).includes(state);
}

/** The state a newly created entity of this kind starts in. */
export function initialStateForKind(kind: ProjectWorkKind): ProjectWorkState {
  return kind === "task" ? "draft" : "draft";
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

/** Dependency edge relations between two exact revisions. */
export const PROJECT_WORK_EDGE_RELATIONS = [
  "supports",
  "implements",
  "depends_on",
  "verifies",
  "supersedes",
  "derived_from",
] as const;
export type ProjectWorkEdgeRelation = (typeof PROJECT_WORK_EDGE_RELATIONS)[number];

/**
 * Which end of an edge is upstream for staleness.
 *
 * An edge reads `subject —relation→ object`. Research *supports* a Spec, so the
 * Research is the upstream and a material change to it can stale the Spec. A
 * Plan *depends_on* a Spec, so the Spec is upstream. `supersedes` is not a
 * staleness edge: it records replacement, which has its own state.
 */
export const EDGE_UPSTREAM: Readonly<Record<ProjectWorkEdgeRelation, "subject" | "object" | "none">> = {
  supports: "subject",
  implements: "object",
  depends_on: "object",
  verifies: "object",
  supersedes: "none",
  derived_from: "object",
};

/** Repository provenance relations (D-345, leap "Repository provenance"). */
export const REPOSITORY_LINK_RELATIONS = ["based_on", "implemented_by", "verified_at", "published_as"] as const;
export type RepositoryLinkRelation = (typeof REPOSITORY_LINK_RELATIONS)[number];

/** What a Project Task's execution link points at. Never ownership. */
export const EXECUTION_LINK_KINDS = ["session", "agent_run", "checkpoint", "branch", "command"] as const;
export type ExecutionLinkKind = (typeof EXECUTION_LINK_KINDS)[number];

/** Which of the three hard gates an approval covers (leap, "Lifecycle and gates"). */
export const APPROVAL_GATES = ["brief", "design", "build"] as const;
export type ApprovalGate = (typeof APPROVAL_GATES)[number];

export const APPROVAL_DECISIONS = ["approved", "changes_requested", "archived"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** The permission mode a Build approval grants. Never a Pi mode name. */
export const APPROVAL_MODES = ["autonomous", "manual_tool_review"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** Comment lifecycle: open → addressed → resolved. Only a person resolves. */
export const COMMENT_STATES = ["open", "addressed", "resolved"] as const;
export type CommentState = (typeof COMMENT_STATES)[number];

/** What an evidence record is. `person_acceptance` is the person's own word. */
export const EVIDENCE_KINDS = [
  "test",
  "diff",
  "screenshot",
  "source_location",
  "commit",
  "review",
  "person_acceptance",
  "command_output",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Whether an evidence record satisfies the acceptance a `done` Task needs. */
export const EVIDENCE_ROLES = ["acceptance", "supporting", "deviation"] as const;
export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];

// ---------------------------------------------------------------------------
// Opaque identity
// ---------------------------------------------------------------------------

/**
 * Every id is opaque, bounded and printable ASCII. The pattern exists so a
 * malformed or path-shaped id is refused at the boundary, not so anybody may
 * read meaning out of one.
 */
export const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export const PROJECT_WORK_TITLE_MAX = 200;
export const PROJECT_WORK_LABEL_MAX = 200;
export const PROJECT_WORK_TEXT_MAX = 4000;
export const PROJECT_WORK_NOTE_MAX = 2000;

const opaqueId = z.string().regex(OPAQUE_ID_PATTERN, "an id this app minted");
const digest = z.string().regex(DIGEST_PATTERN, "a sha256 digest");
const isoInstant = z.string().min(1).max(64);
const title = z.string().min(1).max(PROJECT_WORK_TITLE_MAX);

export const projectIdSchema = opaqueId;
export const projectWorkIdSchema = opaqueId;
export const projectWorkRevisionIdSchema = opaqueId;
export const projectWorkDigestSchema = digest;
export const projectWorkKeySchema = z.string().refine(isProjectWorkKeyString, "a project work key such as SPEC-12");

export const projectWorkKindSchema = z.enum(PROJECT_WORK_KINDS);
export const artifactReviewStateSchema = z.enum(ARTIFACT_REVIEW_STATES);
export const projectTaskStateSchema = z.enum(PROJECT_TASK_STATES);
export const projectWorkStateSchema = z.union([artifactReviewStateSchema, projectTaskStateSchema]);

// ---------------------------------------------------------------------------
// ProjectWorkRef
// ---------------------------------------------------------------------------

/**
 * The reference every message, approval, execution packet and evidence record
 * carries (leap, "Vocabulary and identities"), plus the person-facing `key`
 * projection (D-355).
 *
 * The revision and the digest are mandatory: UI navigation may follow an
 * entity's current pointer, but a historical transcript never silently changes
 * what it referred to.
 */
export interface ProjectWorkRef {
  projectId: string;
  kind: ProjectWorkKind;
  entityId: string;
  revisionId: string;
  digest: string;
  /** The title as it read at that revision. Display only; may change. */
  label: string;
  /** `SPEC-12`. A person-facing handle, never the identity. */
  key: string;
}

export const projectWorkRefSchema = z
  .object({
    projectId: projectIdSchema,
    kind: projectWorkKindSchema,
    entityId: projectWorkIdSchema,
    revisionId: projectWorkRevisionIdSchema,
    digest: projectWorkDigestSchema,
    label: z.string().max(PROJECT_WORK_LABEL_MAX),
    key: projectWorkKeySchema,
  })
  .strict()
  .refine((ref) => parseProjectWorkKey(ref.key)?.kind === ref.kind, {
    message: "the key's prefix must match the kind",
    path: ["key"],
  });

/** The stable human form a transcript shows and a person copies: `TASK-44 · title`. */
export function projectWorkRefText(ref: Pick<ProjectWorkRef, "key" | "label">): string {
  return ref.label ? `${ref.key} · ${ref.label}` : ref.key;
}

/** True when two refs name the same exact revision of the same entity. */
export function sameProjectWorkRevision(a: ProjectWorkRef, b: ProjectWorkRef): boolean {
  return a.projectId === b.projectId && a.entityId === b.entityId && a.revisionId === b.revisionId && a.digest === b.digest;
}

// ---------------------------------------------------------------------------
// Actors and provenance
// ---------------------------------------------------------------------------

export const PROJECT_WORK_ACTOR_KINDS = ["person", "agent"] as const;
export type ProjectWorkActorKind = (typeof PROJECT_WORK_ACTOR_KINDS)[number];

/** Who did it. A label a person recognises, never a raw model name. */
export interface ProjectWorkActor {
  kind: ProjectWorkActorKind;
  label: string;
}

/**
 * Where a record came from.
 *
 * `sessionId` is provenance and nothing else: it says which conversation the
 * revision was written in, so "Recent" can show it. It confers no ownership,
 * and a session that no longer exists leaves the record intact with an
 * unavailable link (D-329).
 */
export interface ProjectWorkOrigin {
  actor: ProjectWorkActor;
  sessionId?: string;
  runId?: string;
}

export const projectWorkActorSchema = z
  .object({ kind: z.enum(PROJECT_WORK_ACTOR_KINDS), label: z.string().min(1).max(PROJECT_WORK_LABEL_MAX) })
  .strict();

export const projectWorkOriginSchema = z
  .object({
    actor: projectWorkActorSchema,
    sessionId: opaqueId.optional(),
    runId: opaqueId.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Entities and revisions
// ---------------------------------------------------------------------------

/**
 * One durable project entity.
 *
 * Deliberately absent: any owning session, run, actor or path. The only
 * identity is `projectId` + `entityId`; the only handle is `key`. The schema is
 * strict, so a field like `sessionId` is refused rather than ignored — there is
 * a test for exactly that.
 */
export interface ProjectWorkEntity {
  projectId: string;
  entityId: string;
  kind: ProjectWorkKind;
  key: string;
  /** The key's number, so a client can sort by key without parsing it. */
  keyNumber: number;
  title: string;
  state: ProjectWorkState;
  currentRevisionId: string;
  /** The digest of the current revision, so a list row can fence a mention. */
  currentDigest: string;
  revisionCount: number;
  createdAt: string;
  updatedAt: string;
  /** Set while the entity is archived. Reversible; links are kept. */
  archivedAt?: string;
  /** The state to restore on unarchive, for kinds whose state union has `archived`. */
  stateBeforeArchive?: ProjectWorkState;
  /** Why this entity is stale, when it is. Empty for everything else. */
  staleBecause?: ProjectWorkStaleCause;
  /** Open blocking comments. A gate cannot be approved while this is above zero. */
  blockingComments?: number;
  /** True when this entity is in the "needs you" queue. */
  needsAttention?: boolean;
}

/** Why an artifact went stale: the exact upstream revision that moved. */
export interface ProjectWorkStaleCause {
  upstreamEntityId: string;
  upstreamKey: string;
  upstreamRevisionId: string;
  relation: ProjectWorkEdgeRelation;
  at: string;
}

export const projectWorkStaleCauseSchema = z
  .object({
    upstreamEntityId: projectWorkIdSchema,
    upstreamKey: projectWorkKeySchema,
    upstreamRevisionId: projectWorkRevisionIdSchema,
    relation: z.enum(PROJECT_WORK_EDGE_RELATIONS),
    at: isoInstant,
  })
  .strict();

export const projectWorkEntitySchema = z
  .object({
    projectId: projectIdSchema,
    entityId: projectWorkIdSchema,
    kind: projectWorkKindSchema,
    key: projectWorkKeySchema,
    keyNumber: z.number().int().min(1).max(PROJECT_WORK_KEY_MAX),
    title: title,
    state: projectWorkStateSchema,
    currentRevisionId: projectWorkRevisionIdSchema,
    currentDigest: projectWorkDigestSchema,
    revisionCount: z.number().int().min(1),
    createdAt: isoInstant,
    updatedAt: isoInstant,
    archivedAt: isoInstant.optional(),
    stateBeforeArchive: projectWorkStateSchema.optional(),
    staleBecause: projectWorkStaleCauseSchema.optional(),
    blockingComments: z.number().int().nonnegative().optional(),
    needsAttention: z.boolean().optional(),
  })
  .strict()
  .refine((entity) => isStateForKind(entity.kind, entity.state), {
    message: "that state does not belong to this kind",
    path: ["state"],
  });

/**
 * One immutable revision. Editing creates a child; the entity's current
 * pointer moves only after the write commits.
 *
 * `bodyBytes` and `digest` describe the canonical JSON encoding of the body,
 * which is what a ranged read pages through and what an approval fences.
 */
export interface ProjectWorkRevision {
  projectId: string;
  entityId: string;
  revisionId: string;
  kind: ProjectWorkKind;
  /** 1 for the first revision of an entity, then monotonic. */
  index: number;
  parentRevisionId?: string;
  title: string;
  digest: string;
  bodyBytes: number;
  createdAt: string;
  origin: ProjectWorkOrigin;
  /** The state this revision was created in. */
  state: ProjectWorkState;
  /** Why this revision exists, in the person's words. */
  note?: string;
}

export const projectWorkRevisionSchema = z
  .object({
    projectId: projectIdSchema,
    entityId: projectWorkIdSchema,
    revisionId: projectWorkRevisionIdSchema,
    kind: projectWorkKindSchema,
    index: z.number().int().min(1),
    parentRevisionId: projectWorkRevisionIdSchema.optional(),
    title: title,
    digest: projectWorkDigestSchema,
    bodyBytes: z.number().int().nonnegative(),
    createdAt: isoInstant,
    origin: projectWorkOriginSchema,
    state: projectWorkStateSchema,
    note: z.string().max(PROJECT_WORK_NOTE_MAX).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Supporting records
// ---------------------------------------------------------------------------

/**
 * Where a comment is anchored. Coordinates only position a pin; the identity is
 * the semantic target (leap, "Design contract").
 */
export type ProjectWorkAnchor =
  | { target: "entity" }
  | { target: "section"; sectionId: string }
  | { target: "node"; nodeId: string; screenId?: string }
  | { target: "text"; sectionId: string; from: number; to: number; textHash: string }
  | { target: "flow_edge"; edgeId: string }
  | { target: "token"; tokenId: string }
  | { target: "region"; regionId: string };

export const projectWorkAnchorSchema = z.discriminatedUnion("target", [
  z.object({ target: z.literal("entity") }).strict(),
  z.object({ target: z.literal("section"), sectionId: opaqueId }).strict(),
  z.object({ target: z.literal("node"), nodeId: opaqueId, screenId: opaqueId.optional() }).strict(),
  z
    .object({
      target: z.literal("text"),
      sectionId: opaqueId,
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      textHash: digest,
    })
    .strict(),
  z.object({ target: z.literal("flow_edge"), edgeId: opaqueId }).strict(),
  z.object({ target: z.literal("token"), tokenId: z.string().min(1).max(120) }).strict(),
  z.object({ target: z.literal("region"), regionId: opaqueId }).strict(),
]);

export interface ProjectWorkComment {
  projectId: string;
  commentId: string;
  entityId: string;
  /** The exact revision the comment was written against. */
  revisionId: string;
  anchor: ProjectWorkAnchor;
  text: string;
  state: CommentState;
  /** A blocking comment prevents approval until a person resolves it. */
  blocking: boolean;
  createdAt: string;
  origin: ProjectWorkOrigin;
  addressedAt?: string;
  resolvedAt?: string;
  /** True when the anchor no longer resolves in the current revision. */
  orphaned?: boolean;
  parentCommentId?: string;
}

export const projectWorkCommentSchema = z
  .object({
    projectId: projectIdSchema,
    commentId: opaqueId,
    entityId: projectWorkIdSchema,
    revisionId: projectWorkRevisionIdSchema,
    anchor: projectWorkAnchorSchema,
    text: z.string().min(1).max(PROJECT_WORK_TEXT_MAX),
    state: z.enum(COMMENT_STATES),
    blocking: z.boolean(),
    createdAt: isoInstant,
    origin: projectWorkOriginSchema,
    addressedAt: isoInstant.optional(),
    resolvedAt: isoInstant.optional(),
    orphaned: z.boolean().optional(),
    parentCommentId: opaqueId.optional(),
  })
  .strict();

/** One exact revision an approval covers, with the digest it was approved at. */
export interface ApprovedRevision {
  entityId: string;
  kind: ProjectWorkKind;
  key: string;
  revisionId: string;
  digest: string;
}

export const approvedRevisionSchema = z
  .object({
    entityId: projectWorkIdSchema,
    kind: projectWorkKindSchema,
    key: projectWorkKeySchema,
    revisionId: projectWorkRevisionIdSchema,
    digest: projectWorkDigestSchema,
  })
  .strict();

/** An approval binds an immutable revision set (D-332). */
export interface ProjectWorkApproval {
  projectId: string;
  approvalId: string;
  entityId: string;
  gate: ApprovalGate;
  decision: ApprovalDecision;
  /** Every revision the decision covers, with its digest. Never a title. */
  covers: ApprovedRevision[];
  mode?: ApprovalMode;
  /** Why the Design gate was skipped, when it was. */
  skipReason?: string;
  note?: string;
  at: string;
  origin: ProjectWorkOrigin;
  /** Set when a later material change invalidated this approval. */
  invalidatedAt?: string;
}

export const projectWorkApprovalSchema = z
  .object({
    projectId: projectIdSchema,
    approvalId: opaqueId,
    entityId: projectWorkIdSchema,
    gate: z.enum(APPROVAL_GATES),
    decision: z.enum(APPROVAL_DECISIONS),
    covers: z.array(approvedRevisionSchema).min(1).max(64),
    mode: z.enum(APPROVAL_MODES).optional(),
    skipReason: z.string().max(PROJECT_WORK_NOTE_MAX).optional(),
    note: z.string().max(PROJECT_WORK_NOTE_MAX).optional(),
    at: isoInstant,
    origin: projectWorkOriginSchema,
    invalidatedAt: isoInstant.optional(),
  })
  .strict();

/**
 * A durable choice with rationale, consequences and supersession.
 *
 * A decision always belongs to an exact revision of an entity: that is what
 * makes it reviewable later, and it is what lets every mutation fence on
 * `expectedRevisionId` without an exception for project-level records.
 */
export interface ProjectWorkDecision {
  projectId: string;
  decisionId: string;
  entityId: string;
  revisionId: string;
  title: string;
  rationale: string;
  consequences: string[];
  at: string;
  origin: ProjectWorkOrigin;
  supersedesDecisionId?: string;
}

export const projectWorkDecisionSchema = z
  .object({
    projectId: projectIdSchema,
    decisionId: opaqueId,
    entityId: projectWorkIdSchema,
    revisionId: projectWorkRevisionIdSchema,
    title: title,
    rationale: z.string().min(1).max(PROJECT_WORK_TEXT_MAX),
    consequences: z.array(z.string().max(PROJECT_WORK_TEXT_MAX)).max(32),
    at: isoInstant,
    origin: projectWorkOriginSchema,
    supersedesDecisionId: opaqueId.optional(),
  })
  .strict();

/**
 * One piece of evidence. `role: "acceptance"` is what a Task needs before it
 * can reach `done`; a failed attempt is `supporting` evidence and leaves the
 * Task actionable.
 */
export interface ProjectWorkEvidence {
  projectId: string;
  evidenceId: string;
  entityId: string;
  revisionId: string;
  kind: EvidenceKind;
  role: EvidenceRole;
  summary: string;
  /** Bounded detail: a command, a path, a test name. Never a whole output. */
  detail?: string;
  /** Large captures live in the blob store; this is the handle. */
  blobId?: string;
  outcome: "passed" | "failed" | "inconclusive";
  at: string;
  origin: ProjectWorkOrigin;
  /** The exact repository state the evidence ran against, when there is one. */
  repositoryLinkId?: string;
}

export const projectWorkEvidenceSchema = z
  .object({
    projectId: projectIdSchema,
    evidenceId: opaqueId,
    entityId: projectWorkIdSchema,
    revisionId: projectWorkRevisionIdSchema,
    kind: z.enum(EVIDENCE_KINDS),
    role: z.enum(EVIDENCE_ROLES),
    summary: z.string().min(1).max(PROJECT_WORK_TEXT_MAX),
    detail: z.string().max(PROJECT_WORK_TEXT_MAX).optional(),
    blobId: opaqueId.optional(),
    outcome: z.enum(["passed", "failed", "inconclusive"]),
    at: isoInstant,
    origin: projectWorkOriginSchema,
    repositoryLinkId: opaqueId.optional(),
  })
  .strict();

/** A dependency edge between two exact revisions. Optional, always (D-352). */
export interface ProjectWorkEdge {
  projectId: string;
  linkId: string;
  relation: ProjectWorkEdgeRelation;
  subject: { entityId: string; revisionId: string; kind: ProjectWorkKind; key: string };
  object: { entityId: string; revisionId: string; kind: ProjectWorkKind; key: string };
  createdAt: string;
  origin: ProjectWorkOrigin;
  note?: string;
}

const edgeEndSchema = z
  .object({
    entityId: projectWorkIdSchema,
    revisionId: projectWorkRevisionIdSchema,
    kind: projectWorkKindSchema,
    key: projectWorkKeySchema,
  })
  .strict();

export const projectWorkEdgeSchema = z
  .object({
    projectId: projectIdSchema,
    linkId: opaqueId,
    relation: z.enum(PROJECT_WORK_EDGE_RELATIONS),
    subject: edgeEndSchema,
    object: edgeEndSchema,
    createdAt: isoInstant,
    origin: projectWorkOriginSchema,
    note: z.string().max(PROJECT_WORK_NOTE_MAX).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Repository provenance (D-345)
// ---------------------------------------------------------------------------

/**
 * An exact repository state. Commit object ids and digests are identity;
 * branch, checkout, worktree and remote are display context only.
 *
 * `repositoryId` lives on the link, not here, because one state ref is read in
 * the context of the repository the link names.
 */
export interface RepositoryStateRef {
  vcs: "git";
  /** `sha1` or `sha256`, as the repository declares it. */
  objectFormat: "sha1" | "sha256";
  commitObjectId: string;
  /** The Laser checkpoint this state came from, when it was uncommitted work. */
  checkpointId?: string;
  /** Repository-relative path at that state. Never an absolute host path. */
  path?: string;
  blobObjectId?: string;
  contentDigest?: string;
}

export const repositoryStateRefSchema = z
  .object({
    vcs: z.literal("git"),
    objectFormat: z.enum(["sha1", "sha256"]),
    commitObjectId: z.string().regex(/^[0-9a-f]{7,64}$/, "a git object id"),
    checkpointId: z.string().min(1).max(200).optional(),
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value), "a repository-relative path")
      .optional(),
    blobObjectId: z.string().regex(/^[0-9a-f]{7,64}$/, "a git object id").optional(),
    contentDigest: digest.optional(),
  })
  .strict();

/** An exact change: base → head, fenced by the digest of its diff. */
export interface RepositoryChangeRef {
  base: RepositoryStateRef;
  head: RepositoryStateRef;
  diffDigest: string;
}

export const repositoryChangeRefSchema = z
  .object({ base: repositoryStateRefSchema, head: repositoryStateRefSchema, diffDigest: digest })
  .strict();

/**
 * One artifact revision joined to one exact repository state or change.
 *
 * Many-to-many in both directions. A correction appends a superseding link and
 * keeps the old provenance; a pruned object keeps its identity and reports the
 * source as unavailable rather than resolving to current `HEAD`.
 */
export interface RepositoryLink {
  projectId: string;
  linkId: string;
  subject: ProjectWorkRef;
  relation: RepositoryLinkRelation;
  /** Stable and opaque: survives relocation, worktrees, branches and remotes. */
  repositoryId: string;
  target: { state: RepositoryStateRef } | { change: RepositoryChangeRef };
  /** For `published_as`: the repository-relative path the export was written to. */
  publishedPath?: string;
  createdBy: ProjectWorkActor;
  createdAt: string;
  supersedesLinkId?: string;
  /**
   * Set when the git object or checkpoint is no longer reachable. The link
   * keeps its recorded identity and says so; it never resolves to `HEAD`.
   */
  sourceUnavailable?: boolean;
  /** Bounded canonical capture kept so a gate stays reviewable after pruning. */
  captureBlobId?: string;
}

export const repositoryLinkSchema = z
  .object({
    projectId: projectIdSchema,
    linkId: opaqueId,
    subject: projectWorkRefSchema,
    relation: z.enum(REPOSITORY_LINK_RELATIONS),
    repositoryId: opaqueId,
    target: z.union([
      z.object({ state: repositoryStateRefSchema }).strict(),
      z.object({ change: repositoryChangeRefSchema }).strict(),
    ]),
    publishedPath: z.string().min(1).max(1024).optional(),
    createdBy: projectWorkActorSchema,
    createdAt: isoInstant,
    supersedesLinkId: opaqueId.optional(),
    sourceUnavailable: z.boolean().optional(),
    captureBlobId: opaqueId.optional(),
  })
  .strict()
  .refine(
    (link) =>
      link.relation === "implemented_by" ? "change" in link.target : "state" in link.target,
    { message: "implemented_by targets a change; every other relation targets a state", path: ["target"] },
  )
  .refine((link) => link.relation !== "published_as" || link.publishedPath !== undefined, {
    message: "published_as records the repository path the export was written to",
    path: ["publishedPath"],
  });

/**
 * A Project Task joined to a session, run, checkpoint, branch or command.
 * Ownership never transfers: deleting the session leaves an unavailable link.
 */
export interface ExecutionLink {
  projectId: string;
  linkId: string;
  entityId: string;
  kind: ExecutionLinkKind;
  /** The opaque id of the session/run/checkpoint/command. Never a path. */
  targetId: string;
  /** Which attempt this link belongs to. Attempts are 1-based per Task. */
  attempt: number;
  /** What the attempt ran on, as intent: the profile, never a raw model name. */
  profileId?: string;
  /** Branch the work happened on. Display context only. */
  branch?: string;
  /** The repository this attempt wrote in, when it wrote in one. */
  repositoryId?: string;
  /** The commit the attempt started from. */
  baseCommitObjectId?: string;
  startedAt: string;
  endedAt?: string;
  outcome?: "completed" | "blocked" | "cancelled" | "failed";
  /** True when the session or run is no longer on this machine. */
  targetUnavailable?: boolean;
  createdBy: ProjectWorkActor;
}

export const executionLinkSchema = z
  .object({
    projectId: projectIdSchema,
    linkId: opaqueId,
    entityId: projectWorkIdSchema,
    kind: z.enum(EXECUTION_LINK_KINDS),
    targetId: z.string().min(1).max(200),
    attempt: z.number().int().min(1).max(10_000),
    profileId: z.string().min(1).max(120).optional(),
    branch: z.string().min(1).max(255).optional(),
    repositoryId: opaqueId.optional(),
    baseCommitObjectId: z.string().regex(/^[0-9a-f]{7,64}$/, "a git object id").optional(),
    startedAt: isoInstant,
    endedAt: isoInstant.optional(),
    outcome: z.enum(["completed", "blocked", "cancelled", "failed"]).optional(),
    targetUnavailable: z.boolean().optional(),
    createdBy: projectWorkActorSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Who or what asked for a transition.
 *
 * `run_ended` exists so the rule "a run ending never marks a Task done" is a
 * type, not a comment: it is a trigger that can move a Task *out* of
 * `in_progress` into a state a person can act on, and can never produce `done`.
 */
export const TRANSITION_TRIGGERS = ["person", "agent", "run_ended", "policy", "system"] as const;
export type TransitionTrigger = (typeof TRANSITION_TRIGGERS)[number];

export type TransitionOutcome = { ok: true } | { ok: false; reason: string };

const allow: TransitionOutcome = { ok: true };
const refuse = (reason: string): TransitionOutcome => ({ ok: false, reason });

/** Legal artifact edges, before any context rule is applied. */
const ARTIFACT_EDGES: Readonly<Record<ArtifactReviewState, readonly ArtifactReviewState[]>> = {
  draft: ["needs_review", "archived", "superseded"],
  needs_review: ["draft", "approved", "stale", "archived", "superseded"],
  approved: ["draft", "needs_review", "stale", "archived", "superseded"],
  stale: ["draft", "needs_review", "approved", "archived", "superseded"],
  superseded: ["archived"],
  archived: ["draft", "needs_review", "approved", "stale", "superseded"],
};

export interface ArtifactTransitionInput {
  kind: ProjectWorkKind;
  from: ArtifactReviewState;
  to: ArtifactReviewState;
  trigger: TransitionTrigger;
  /** Open blocking comments on the entity. Approval is refused above zero. */
  blockingComments?: number;
  /** True when the move to `stale` follows a material change to an upstream. */
  upstreamChanged?: boolean;
  /** True when this transition restores an entity out of the archive. */
  restore?: boolean;
  /** Design gates cannot be passed by a Sketch-only Design (D-354). */
  sketchOnly?: boolean;
}

/**
 * Is this artifact transition legal?
 *
 * The rules, in the order a reader will want them:
 *
 * - a Task never uses this table (it has its own states);
 * - only a **person** approves, and only with no open blocking comments
 *   (D-332: an agent may address a comment, never resolve or approve it);
 * - `stale` is a *consequence*, not a choice: only a material upstream change
 *   produces it;
 * - leaving `archived` is a restore and must say so, so an ordinary edit
 *   cannot quietly resurrect an archived entity into an approved state;
 * - a Design made only of Sketches cannot pass a gate (D-354).
 */
export function artifactTransition(input: ArtifactTransitionInput): TransitionOutcome {
  if (input.kind === "task") {
    return refuse("A Task uses the Task states, not the review states.");
  }
  if (input.from === input.to) return allow;
  const legal = ARTIFACT_EDGES[input.from];
  if (!legal.includes(input.to)) {
    return refuse(`${input.from} cannot become ${input.to}.`);
  }
  if (input.from === "archived" && input.restore !== true) {
    return refuse("This is archived. Restore it before changing its state.");
  }
  if (input.to === "stale") {
    if (input.upstreamChanged !== true) {
      return refuse("Stale is what a changed upstream does to this artifact, not something to set by hand.");
    }
    return allow;
  }
  if (input.to === "approved") {
    if (input.trigger !== "person") {
      return refuse("Only a person approves project work.");
    }
    if ((input.blockingComments ?? 0) > 0) {
      const count = input.blockingComments ?? 0;
      return refuse(`${count} blocking comment${count === 1 ? "" : "s"} must be resolved before this can be approved.`);
    }
    if (input.kind === "design" && input.sketchOnly === true) {
      return refuse("A design made of sketches cannot be approved. Ground it into a tree first.");
    }
    return allow;
  }
  return allow;
}

/** The explicit actions a Task transition is requested through. */
export const PROJECT_TASK_ACTIONS = [
  "mark_ready",
  "block",
  "start",
  "submit_for_review",
  "request_changes",
  "complete",
  "reopen",
  "cancel",
  "return_to_draft",
] as const;
export type ProjectTaskAction = (typeof PROJECT_TASK_ACTIONS)[number];

/** The state each action asks for. The rules below decide whether it happens. */
export const TASK_ACTION_TARGET: Readonly<Record<ProjectTaskAction, ProjectTaskState>> = {
  mark_ready: "ready",
  block: "blocked",
  start: "in_progress",
  submit_for_review: "needs_review",
  request_changes: "in_progress",
  complete: "done",
  reopen: "in_progress",
  cancel: "cancelled",
  return_to_draft: "draft",
};

const TASK_EDGES: Readonly<Record<ProjectTaskState, readonly ProjectTaskState[]>> = {
  draft: ["ready", "blocked", "cancelled"],
  ready: ["draft", "blocked", "in_progress", "cancelled"],
  blocked: ["draft", "ready", "cancelled"],
  in_progress: ["blocked", "ready", "needs_review", "done", "cancelled"],
  needs_review: ["in_progress", "blocked", "done", "cancelled"],
  done: ["in_progress"],
  cancelled: ["draft", "ready"],
};

export interface TaskTransitionInput {
  from: ProjectTaskState;
  to: ProjectTaskState;
  trigger: TransitionTrigger;
  /** Dependency keys that are not satisfied yet. Named in the refusal (D-355). */
  unmetDependencies?: readonly string[];
  /** True when the Task has at least one passing acceptance evidence record. */
  hasAcceptanceEvidence?: boolean;
  /** A stale Plan prevents a not-yet-started Task from starting. */
  planStale?: boolean;
  /** A stale Design pauses new dependent implementation. */
  designStale?: boolean;
  /** Open blocking comments on the Task. */
  blockingComments?: number;
  /**
   * True when an explicit, person-approved policy may complete a Task. Without
   * it only a person completes one; with it, the trigger must still be
   * `policy`, so nothing an agent does can reach `done` on its own.
   */
  completionPolicy?: boolean;
}

/**
 * Is this Task transition legal?
 *
 * The rules that matter, all of them from the leap's "Plan and Project Task
 * contract":
 *
 * - a run ending is **never** a completion. `run_ended` may leave a Task in
 *   progress, block it or send it to review; it can never produce `done`;
 * - `done` requires acceptance evidence, and a person (or an explicit approved
 *   completion policy). An agent cannot complete a Task;
 * - `ready` requires every declared dependency to be satisfied, and the
 *   refusal names the ones that are not, by key;
 * - a stale Plan stops a not-yet-started Task from starting; a running attempt
 *   may finish but cannot complete the Task until reconciliation;
 * - there is no failed state: a failed attempt is evidence.
 */
export function taskTransition(input: TaskTransitionInput): TransitionOutcome {
  if (input.from === input.to) return allow;
  const legal = TASK_EDGES[input.from];
  if (!legal.includes(input.to)) {
    return refuse(`${input.from} cannot become ${input.to}.`);
  }
  const unmet = input.unmetDependencies ?? [];
  if (input.to === "ready" && unmet.length > 0) {
    return refuse(`${unmet.join(", ")} must be done first.`);
  }
  if (input.to === "in_progress" && input.from !== "needs_review") {
    if (unmet.length > 0) return refuse(`${unmet.join(", ")} must be done first.`);
    if (input.planStale === true) {
      return refuse("The plan this task came from changed. Reconcile the plan before starting this task.");
    }
    if (input.designStale === true) {
      return refuse("The design this task implements changed. Reconcile the design before starting this task.");
    }
  }
  if (input.to === "done") {
    if (input.trigger === "run_ended") {
      return refuse("A finished run is evidence, not a completed task. Complete it yourself when the evidence is right.");
    }
    if (input.trigger === "agent") {
      return refuse("An agent reports evidence; a person completes the task.");
    }
    if (input.trigger === "policy" && input.completionPolicy !== true) {
      return refuse("No approved completion policy covers this task, so a person completes it.");
    }
    if (input.trigger === "system") {
      return refuse("Nothing completes a task on its own.");
    }
    if (input.hasAcceptanceEvidence !== true) {
      return refuse("Add the acceptance evidence for this task before marking it done.");
    }
    if (input.planStale === true || input.designStale === true) {
      return refuse("An input this task depends on changed. Reconcile it before marking the task done.");
    }
    if ((input.blockingComments ?? 0) > 0) {
      const count = input.blockingComments ?? 0;
      return refuse(`${count} blocking comment${count === 1 ? "" : "s"} must be resolved before this task is done.`);
    }
  }
  return allow;
}

/** The transition an action asks for, refused with the same sentences. */
export function taskActionTransition(
  action: ProjectTaskAction,
  input: Omit<TaskTransitionInput, "to">,
): TransitionOutcome & { to: ProjectTaskState } {
  const to = TASK_ACTION_TARGET[action];
  return { ...taskTransition({ ...input, to }), to };
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

/** What the graph looks like to the staleness function. Entities and edges only. */
export interface StaleGraphEntity {
  entityId: string;
  kind: ProjectWorkKind;
  key: string;
  state: ProjectWorkState;
}

export interface StaleGraphEdge {
  linkId: string;
  relation: ProjectWorkEdgeRelation;
  subject: { entityId: string };
  object: { entityId: string };
}

export interface StaleImpact {
  entityId: string;
  key: string;
  kind: ProjectWorkKind;
  /** The edge that carried the staleness to this entity. */
  viaLinkId: string;
  relation: ProjectWorkEdgeRelation;
  /** How many edges away from the change this entity is. */
  depth: number;
}

export interface StalePropagationInput {
  /** The upstream that changed materially, and the state it was in. */
  changed: { entityId: string; state: ProjectWorkState };
  entities: readonly StaleGraphEntity[];
  edges: readonly StaleGraphEdge[];
}

export interface StalePropagationResult {
  /** Artifacts that become stale. Never includes the changed entity itself. */
  stale: StaleImpact[];
  /**
   * Tasks that a stale upstream pauses: a stale Plan blocks a Task that has not
   * started, and a stale Design pauses new dependent implementation. A running
   * attempt is not stopped — it simply cannot complete the Task.
   */
  paused: StaleImpact[];
}

/** States a dependent must be in for a change upstream to make it stale. */
const STALEABLE: readonly ProjectWorkState[] = ["needs_review", "approved"];

/** Task states that a stale Plan or Design prevents from proceeding. */
const PAUSABLE_TASK_STATES: readonly ProjectTaskState[] = ["draft", "ready", "blocked"];

/**
 * What a material change to one artifact makes stale.
 *
 * Only along edges that exist (D-352: with no links, nothing stales), only from
 * an **approved** upstream (leap: "changing an approved upstream artifact marks
 * dependent revisions stale"), and never onto a draft — an artifact nobody has
 * settled cannot go stale. Transitive, and safe on cycles.
 */
export function propagateStale(input: StalePropagationInput): StalePropagationResult {
  const result: StalePropagationResult = { stale: [], paused: [] };
  if (input.changed.state !== "approved") return result;

  const byId = new Map(input.entities.map((entity) => [entity.entityId, entity]));
  const downstream = new Map<string, Array<{ to: string; linkId: string; relation: ProjectWorkEdgeRelation }>>();
  for (const edge of input.edges) {
    const upstream = EDGE_UPSTREAM[edge.relation];
    if (upstream === "none") continue;
    const from = upstream === "subject" ? edge.subject.entityId : edge.object.entityId;
    const to = upstream === "subject" ? edge.object.entityId : edge.subject.entityId;
    if (from === to) continue;
    const list = downstream.get(from);
    if (list) list.push({ to, linkId: edge.linkId, relation: edge.relation });
    else downstream.set(from, [{ to, linkId: edge.linkId, relation: edge.relation }]);
  }

  const seen = new Set<string>([input.changed.entityId]);
  let frontier: Array<{ entityId: string; depth: number }> = [{ entityId: input.changed.entityId, depth: 0 }];
  while (frontier.length > 0) {
    const next: Array<{ entityId: string; depth: number }> = [];
    for (const node of frontier) {
      for (const edge of downstream.get(node.entityId) ?? []) {
        if (seen.has(edge.to)) continue;
        const entity = byId.get(edge.to);
        if (!entity) continue;
        seen.add(edge.to);
        const impact: StaleImpact = {
          entityId: entity.entityId,
          key: entity.key,
          kind: entity.kind,
          viaLinkId: edge.linkId,
          relation: edge.relation,
          depth: node.depth + 1,
        };
        if (entity.kind === "task") {
          if ((PAUSABLE_TASK_STATES as readonly string[]).includes(entity.state)) result.paused.push(impact);
          // A running or finished attempt is not paused by this; it simply
          // cannot complete the Task (see `taskTransition`). Staleness still
          // travels through the Task to whatever depends on it.
          next.push({ entityId: entity.entityId, depth: node.depth + 1 });
          continue;
        }
        if ((STALEABLE as readonly string[]).includes(entity.state)) {
          result.stale.push(impact);
          next.push({ entityId: entity.entityId, depth: node.depth + 1 });
        }
        // A draft dependent is left alone, and staleness stops there: nothing
        // downstream of an unsettled artifact was resting on this change.
      }
    }
    frontier = next;
  }
  return result;
}

/**
 * The dependency keys a Task is still waiting on.
 *
 * Readiness is derived from the accepted states of the dependencies, never
 * stored: a dependency is satisfied when it is `done` (a Task) or `approved`
 * (an artifact). Unknown dependencies are reported as unmet by their key, so a
 * refusal can name them.
 */
export function unmetTaskDependencies(
  dependencies: readonly string[],
  states: ReadonlyMap<string, { kind: ProjectWorkKind; state: ProjectWorkState }>,
): string[] {
  const unmet: string[] = [];
  for (const key of dependencies) {
    const found = states.get(key);
    if (!found) {
      unmet.push(key);
      continue;
    }
    const satisfied = found.kind === "task" ? found.state === "done" : found.state === "approved";
    if (!satisfied) unmet.push(key);
  }
  return unmet;
}
