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
import { PRODUCT_NAME } from "./identity.js";

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

/**
 * What an evidence record is. `person_acceptance` is the person's own word.
 *
 * `verification` is a whole verification run's report (M21-T19): the four
 * authorities it compared against, every criterion's outcome and the
 * deviations it proposed, stored canonically in the blob the record names. It
 * is its own kind because it is not a test, a diff or a command's output — it
 * is the reasoning over all of them, and a surface that shows it shows a
 * report rather than a line.
 */
export const EVIDENCE_KINDS = [
  "test",
  "diff",
  "screenshot",
  "source_location",
  "commit",
  "review",
  "person_acceptance",
  "command_output",
  "verification",
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

/**
 * What one attempt record may hold (M21-T18).
 *
 * An attempt is a record of what happened, not a copy of the repository: a
 * session of a thousand turns in a forty-repository workspace must cost a
 * bounded number of rows, and a record that hits one of these bounds says so
 * rather than growing. The checkpoint list keeps its **ends** when it is cut,
 * because the first and the last are what the change is computed from.
 */
export const ATTEMPT_REPOSITORIES_MAX = 64;
export const ATTEMPT_CHECKPOINTS_MAX = 200;
export const ATTEMPT_CHANGED_PATHS_MAX = 500;
export const ATTEMPT_COMMITS_MAX = 100;

/** What one canonical capture may hold before it says what it left out. */
export const REPOSITORY_CAPTURE_FILES_MAX = 500;
export const REPOSITORY_CAPTURE_SOURCES_MAX = 100;
/**
 * The most sources one decision may rest on (M21-T19).
 *
 * The same bound as {@link REPOSITORY_CAPTURE_SOURCES_MAX}, because they are
 * the same thing seen from two sides: a decision whose required set does not
 * fit in a bounded capture is refused with what to do, never captured as a
 * silent prefix and never given a larger budget.
 */
export const REQUIRED_PATHS_MAX = 100;
export const REPOSITORY_CAPTURE_SOURCE_BYTES_MAX = 128 * 1024;
export const REPOSITORY_CAPTURE_BYTES_MAX = 4 * 1024 * 1024;

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
  /** The attempt this delivery came out of, when it came out of one. */
  executionLinkId?: string;
  /**
   * The host's own record that a person accepted this state as native visual
   * evidence (M21-T19, D-361).
   *
   * Written by the host and by nothing else: a caller asks for the acceptance,
   * and what is stored is what the host proved when it validated the ask — the
   * checkpoint ref it really found, the commit that ref really pointed at, and
   * when it confirmed it. A request body can never mint this field, which is
   * what makes it proof rather than a claim.
   */
  acceptance?: RepositoryLinkAcceptance;
  /**
   * Branch, remote and pull request: what a person reads the link *by*, and
   * never what it *is* (M21-T18). Identity is the object ids in `target`;
   * every field here may move, be renamed or be deleted without the link
   * meaning anything different.
   */
  display?: RepositoryLinkContext;
}

/**
 * Display context on a repository link (leap, "Repository provenance").
 *
 * A pull request is the most useful thing to show and the least reliable thing
 * to trust: it can be closed, renumbered across a repository transfer or point
 * at a force-pushed head. It lives here, beside the branch and the remote
 * *name*, so that nothing reading identity can reach it by accident.
 */
/**
 * What the host proved when a person accepted a checkpoint preview.
 *
 * `checkpointRef` and `commitObjectId` are what it read out of git at that
 * moment; `subjectDigest` is the artifact revision the acceptance was about,
 * so a later revision cannot inherit it. Everything a reader needs is here and
 * in the capture: convergence never re-reads git (D-361).
 */
export interface RepositoryLinkAcceptance {
  kind: "checkpoint_preview";
  confirmedAt: string;
  /** The ref the host found, exactly as git named it. */
  checkpointRef: string;
  /** The commit that ref pointed at when it was confirmed. */
  commitObjectId: string;
  /** The digest of the artifact revision this acceptance is about. */
  subjectDigest: string;
  /** The person the host recorded it for. */
  acceptedBy: ProjectWorkActor;
}

export interface RepositoryLinkContext {
  branch?: string;
  /** The remote's name (`origin`), never its URL. */
  remote?: string;
  pullRequest?: { number: number; host: string; url?: string; title?: string };
}

export const repositoryLinkContextSchema = z
  .object({
    branch: z.string().min(1).max(255).optional(),
    remote: z.string().min(1).max(255).optional(),
    pullRequest: z
      .object({
        number: z.number().int().min(1).max(10_000_000),
        host: z.string().min(1).max(60),
        url: z.string().min(1).max(2048).optional(),
        title: z.string().min(1).max(400).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

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
    executionLinkId: opaqueId.optional(),
    display: repositoryLinkContextSchema.optional(),
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

// ---------------------------------------------------------------------------
// Attempt facts and canonical captures (M21-T18)
// ---------------------------------------------------------------------------

/**
 * One checkpoint an attempt made, resolved to its commit object id **at record
 * time** (leap, "Execution and convergence").
 *
 * The ref is kept because it says which session and which turn produced the
 * commit; the commit object id is what the record means. Retention may delete
 * the ref later without changing anything this row says.
 */
export interface AttemptCheckpointRef {
  /** The turn the checkpoint was taken after. 0 is the open-time baseline. */
  turn: number;
  /** `refs/<product>/checkpoints/<session>/<turn>` as it was when recorded. */
  ref: string;
  commitObjectId: string;
  createdAt?: string;
}

export const attemptCheckpointRefSchema = z
  .object({
    turn: z.number().int().min(0).max(1_000_000),
    ref: z.string().min(1).max(512),
    commitObjectId: z.string().regex(/^[0-9a-f]{7,64}$/, "a git object id"),
    createdAt: z.string().min(1).max(64).optional(),
  })
  .strict();

/**
 * What one repository of the workspace shape did during one attempt.
 *
 * Everything here is read from git: the base the attempt started at, the
 * checkpoints it made, the change between its first and last checkpoint and
 * the paths that change touched. **No tool call contributes a path** (leap,
 * "Execution and convergence"): a model reporting that it edited a file
 * changes nothing about this record, and a model that edited a file without
 * saying so is in it anyway.
 *
 * A monorepo with two repositories produces two of these, with two distinct
 * `repositoryId`s, and never one merged list.
 */
export interface AttemptRepositoryRecord {
  repositoryId: string;
  /** The repository's directory name. Display context only. */
  name: string;
  /** The commit the attempt started from. */
  base: RepositoryStateRef;
  /**
   * The checkpoint turn this repository was already at when the attempt
   * started, or `-1` when it had none.
   *
   * Turns are the session's own monotonic counter, so "the checkpoints this
   * attempt made" is `turn > sinceTurn` and needs no clock: a ref's date has
   * one-second resolution, and two attempts in the same second must not
   * inherit each other's work.
   */
  sinceTurn: number;
  checkpoints: AttemptCheckpointRef[];
  /** checkpoint(first) → checkpoint(last), fenced by the digest of its diff. */
  change?: RepositoryChangeRef;
  /** Repository-relative paths the change touched, from git. */
  changedPaths: string[];
  /** Commits the attempt added on top of its base, newest first. */
  commits: string[];
  /** True when a recorded object could not be found when this was written. */
  unavailable?: boolean;
}

export const attemptRepositoryRecordSchema = z
  .object({
    repositoryId: opaqueId,
    name: z.string().min(1).max(200),
    base: repositoryStateRefSchema,
    sinceTurn: z.number().int().min(-1).max(1_000_000),
    checkpoints: z.array(attemptCheckpointRefSchema).max(ATTEMPT_CHECKPOINTS_MAX),
    change: repositoryChangeRefSchema.optional(),
    changedPaths: z.array(z.string().min(1).max(1024)).max(ATTEMPT_CHANGED_PATHS_MAX),
    commits: z.array(z.string().regex(/^[0-9a-f]{7,64}$/, "a git object id")).max(ATTEMPT_COMMITS_MAX),
    unavailable: z.boolean().optional(),
  })
  .strict();

/** Whether a link's git objects are still reachable, and what is kept if not. */
export interface RepositoryLinkAvailability {
  linkId: string;
  /** False when git no longer has one of the objects this link names. */
  sourceAvailable: boolean;
  /** Which recorded object ids could not be found. Identity, not `HEAD`. */
  missing: string[];
  /** True when the bounded canonical capture is still readable. */
  captureAvailable: boolean;
  captureBlobId?: string;
  /** One sentence for a person, when something is missing. */
  detail?: string;
}

/**
 * The bounded canonical capture that keeps an accepted delivery reviewable
 * after the checkpoint ref it came from is pruned (leap, "Repository
 * provenance"; D-345).
 *
 * It is a diff **manifest** plus the source of the files the change touched,
 * both bounded: enough to review what was accepted, never a second copy of the
 * repository. It is stored as canonical JSON in the content-addressed blob
 * store and referenced by the link's `captureBlobId`.
 */
export const REPOSITORY_CAPTURE_MEDIA_TYPE = `application/vnd.${PRODUCT_NAME}.repository-capture+json`;

export interface RepositoryCaptureFile {
  path: string;
  /**
   * The three words the product speaks about a file (`FileChangeStatus`).
   *
   * A state capture has no difference to speak of, so every file in one is
   * `present`: it is the tree as it stood, not a change to it.
   */
  status: "added" | "modified" | "deleted" | "present";
  added: number | null;
  removed: number | null;
  /** The head-side blob object id, when the file exists at head. */
  blobObjectId?: string;
  /** The file's mode as git records it (`100644`). Identity, not display. */
  mode?: string;
  /**
   * The file's true size in bytes, as git reports it.
   *
   * Recorded whether or not the bytes were captured, so a file left out is
   * still described by its real size rather than by the size of what was
   * kept (M21-T19, review F9).
   */
  bytes?: number;
  /** sha256 of the captured bytes, when they were captured. */
  contentDigest?: string;
  /** Why this file's bytes are not in the capture. */
  omitted?: "binary" | "too_large" | "budget" | "deleted";
}

export interface RepositoryCaptureSource {
  path: string;
  bytes: number;
  /** True when only the first bytes of the file were kept. */
  truncated?: boolean;
  contentDigest: string;
  text: string;
  /**
   * Which side of the change these bytes are (M21-T19).
   *
   * A deleted file is reviewed by reading what was removed, so its body is the
   * one at the **base**. Absent means `after`, which is what every body of a
   * state or a head side is — and saying so explicitly is what keeps a
   * before-body from ever being read back as the accepted state's content.
   */
  side?: "before" | "after";
}

/**
 * How a capture's required set was derived (M21-T19).
 *
 * Never a caller's word for it: each basis names an exact pair of commits (or,
 * for `complete_bounded_state`, an exact bounded scope) the host read out of
 * git itself.
 */
export const REPOSITORY_CAPTURE_BASES = [
  /** The attempt's recorded base → the exact state being accepted. */
  "attempt_base_to_state",
  /** A parented commit's own `commit^ → commit`. */
  "commit_parent_to_commit",
  /** The accepted delivery's own `base → head`. */
  "accepted_change",
  /**
   * Nothing changed between the base and the state, so what is kept whole is
   * the named scope itself: a person can verify unchanged code, and demanding
   * a fabricated edit before they may say so would be the wrong refusal.
   */
  "complete_bounded_state",
] as const;
export type RepositoryCaptureBasis = (typeof REPOSITORY_CAPTURE_BASES)[number];

/** One source the decision rests on, as the host found it. */
export interface RepositoryCaptureRequiredEntry {
  path: string;
  status: "added" | "modified" | "deleted" | "present";
  side: "before" | "after";
  /** sha256 of the whole body kept in `sources` at that side. */
  contentDigest: string;
  blobObjectId?: string;
}

/**
 * The proof that a capture holds **every** source its decision rests on.
 *
 * Written by the host from what git answered, canonicalised into the
 * content-addressed blob, and never taken from a request: a caller-uploaded
 * blob cannot mint it, because the link that points at a capture is only ever
 * written by the host in the same act that built it. `complete` exists only in
 * the `true` form — a capture that could not keep every required body whole is
 * not stored with a weaker flag, the decision is refused.
 */
export interface RepositoryCaptureRequired {
  basis: RepositoryCaptureBasis;
  from: {
    /** The commit the difference was taken from, when there is one. */
    baseCommitObjectId?: string;
    /** The attempt this state belongs to, when it is one. */
    executionLinkId?: string;
    taskEntityId?: string;
    /** The repository-relative scope a `complete_bounded_state` covers. */
    scopePath?: string;
  };
  entries: RepositoryCaptureRequiredEntry[];
  complete: true;
}

interface RepositoryCaptureBase {
  version: 1;
  createdAt: string;
  repositoryId: string;
  repositoryName?: string;
  files: RepositoryCaptureFile[];
  /** The head-side source of the files the capture covers, bounded. */
  sources: RepositoryCaptureSource[];
  /**
   * Every source the decision this capture backs rests on, kept whole
   * (M21-T19). Absent on an ordinary provenance capture, which may be honestly
   * partial — and which therefore never satisfies a decision.
   */
  required?: RepositoryCaptureRequired;
  /** What was left out, in one sentence a person can act on. */
  truncated?: string;
}

/**
 * A bounded canonical record of what a link points at, kept so a decision
 * stays reviewable after git has pruned what it was taken from (D-361).
 *
 * Exactly one of `change` and `state`, never both and never neither: a capture
 * of a difference and a capture of a tree are different documents, and a shape
 * that allowed both would let a reader pick the wrong one. The alternative is
 * a discriminated union rather than two optional fields for that reason.
 */
export type RepositoryCapture =
  | (RepositoryCaptureBase & { change: RepositoryChangeRef; state?: never })
  | (RepositoryCaptureBase & { state: RepositoryStateRef; change?: never });

const repositoryCaptureFileSchema = z
  .object({
    path: z.string().min(1).max(1024),
    status: z.enum(["added", "modified", "deleted", "present"]),
    added: z.number().int().nullable(),
    removed: z.number().int().nullable(),
    blobObjectId: z.string().min(1).max(64).optional(),
    mode: z.string().min(1).max(16).optional(),
    bytes: z.number().int().min(0).optional(),
    contentDigest: digest.optional(),
    omitted: z.enum(["binary", "too_large", "budget", "deleted"]).optional(),
  })
  .strict();

const repositoryCaptureSourceSchema = z
  .object({
    path: z.string().min(1).max(1024),
    bytes: z.number().int().min(0),
    truncated: z.boolean().optional(),
    contentDigest: digest,
    text: z.string(),
    side: z.enum(["before", "after"]).optional(),
  })
  .strict();

export const repositoryCaptureRequiredSchema = z
  .object({
    basis: z.enum(REPOSITORY_CAPTURE_BASES),
    from: z
      .object({
        baseCommitObjectId: z.string().regex(/^[0-9a-f]{7,64}$/, "a git object id").optional(),
        executionLinkId: opaqueId.optional(),
        taskEntityId: opaqueId.optional(),
        scopePath: z.string().min(1).max(1024).optional(),
      })
      .strict(),
    entries: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1024),
            status: z.enum(["added", "modified", "deleted", "present"]),
            side: z.enum(["before", "after"]),
            contentDigest: digest,
            blobObjectId: z.string().min(1).max(64).optional(),
          })
          .strict(),
      )
      .max(REQUIRED_PATHS_MAX),
    complete: z.literal(true),
  })
  .strict();

const repositoryCaptureBaseSchema = {
  version: z.literal(1),
  createdAt: isoInstant,
  repositoryId: opaqueId,
  repositoryName: z.string().min(1).max(200).optional(),
  files: z.array(repositoryCaptureFileSchema).max(REPOSITORY_CAPTURE_FILES_MAX),
  sources: z.array(repositoryCaptureSourceSchema).max(REPOSITORY_CAPTURE_SOURCES_MAX),
  required: repositoryCaptureRequiredSchema.optional(),
  truncated: z.string().max(PROJECT_WORK_TEXT_MAX).optional(),
};

/**
 * A stored capture, read back.
 *
 * Parsed rather than cast: everything a decision is re-checked against later
 * comes out of this blob, so a blob that is not a capture of the shape the
 * host writes answers nothing rather than half a proof.
 */
export const repositoryCaptureSchema = z.union([
  z.object({ ...repositoryCaptureBaseSchema, change: repositoryChangeRefSchema }).strict(),
  z.object({ ...repositoryCaptureBaseSchema, state: repositoryStateRefSchema }).strict(),
]);

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
  /**
   * What each repository of the workspace shape did during this attempt
   * (M21-T18). One row per repository, so two repositories stay two records.
   */
  repositories?: AttemptRepositoryRecord[];
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
    repositories: z.array(attemptRepositoryRecordSchema).max(ATTEMPT_REPOSITORIES_MAX).optional(),
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

/**
 * The exact upstream revision that went stale, so a refusal can name it
 * rather than say "something changed" (D-355).
 */
export interface StaleUpstreamRef {
  entityId: string;
  kind: ProjectWorkKind;
  key: string;
  /** The upstream's current revision — what reconciliation has to catch up to. */
  revisionId: string;
}

export interface TaskTransitionInput {
  from: ProjectTaskState;
  to: ProjectTaskState;
  trigger: TransitionTrigger;
  /** Dependency keys that are not satisfied yet. Named in the refusal (D-355). */
  unmetDependencies?: readonly string[];
  /** True when the Task has at least one passing acceptance evidence record. */
  hasAcceptanceEvidence?: boolean;
  /**
   * True when at least one verification of this Task passed. An agent reports
   * evidence before it asks for review; a person never has to.
   */
  hasPassingVerification?: boolean;
  /** A stale Plan prevents a not-yet-started Task from starting. */
  planStale?: boolean;
  /** A stale Design pauses new dependent implementation. */
  designStale?: boolean;
  /** Which upstream went stale, named in the refusal when there is one. */
  staleUpstream?: StaleUpstreamRef;
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
      return refuse(`${staleSubject(input, "plan")} changed after this task was planned. Reconcile it before starting this task.`);
    }
    if (input.designStale === true) {
      return refuse(`${staleSubject(input, "design")} changed after this task was planned. Reconcile it before starting this task.`);
    }
  }
  if (input.to === "needs_review" && input.trigger === "agent" && input.hasPassingVerification !== true) {
    return refuse("Report the evidence for this task before sending it for review.");
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
      return refuse(
        `${staleSubject(input, input.planStale === true ? "plan" : "design")} changed after this task was planned. ` +
          "Reconcile it before marking the task done.",
      );
    }
    if ((input.blockingComments ?? 0) > 0) {
      const count = input.blockingComments ?? 0;
      return refuse(`${count} blocking comment${count === 1 ? "" : "s"} must be resolved before this task is done.`);
    }
  }
  return allow;
}

/**
 * How a refusal names the upstream that moved: its key when the caller knows
 * it, and the kind's own words when it does not.
 */
function staleSubject(input: Pick<TaskTransitionInput, "staleUpstream">, kind: "plan" | "design"): string {
  if (input.staleUpstream) return input.staleUpstream.key;
  return kind === "plan" ? "The plan this task came from" : "The design this task implements";
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
// Gates, comments and threads (M21-T8)
// ---------------------------------------------------------------------------

/**
 * What a gate needs, by the part each required revision plays in it.
 *
 * The three gates of the leap's "Lifecycle and gates" table, expressed as
 * roles rather than as a list of ids, so a refusal can say *what* is missing
 * ("this spec has no design and no recorded reason to skip one") instead of
 * naming an id a person has never seen.
 */
export const GATE_ROLES = ["spec_brief", "spec_full", "design", "design_profile", "design_skip", "plan", "task_graph"] as const;
export type GateRole = (typeof GATE_ROLES)[number];

/** Why a required revision does not satisfy its role. */
export const GATE_PROBLEMS = [
  /** Nothing plays this role yet. */
  "missing",
  /** It exists but has not passed its own gate. */
  "draft",
  /** Something it rests on changed after it was written. */
  "stale",
  /** The decision was prepared against a revision that is no longer current. */
  "not_current",
  /** A design made only of sketches cannot pass a gate (D-354). */
  "sketch_only",
  /** The plan's task graph does not hold together yet. */
  "incomplete_graph",
  /** An earlier gate has not been decided, or was invalidated by a change. */
  "gate_not_passed",
  /** It is archived or superseded, so it cannot be approved into anything. */
  "unavailable",
] as const;
export type GateProblem = (typeof GATE_PROBLEMS)[number];

export interface GateRequirementReport {
  role: GateRole;
  satisfied: boolean;
  problem?: GateProblem;
  /** The exact revision bound to this role, when one is known. */
  covered?: ApprovedRevision;
  /** One sentence, written for a person, saying what this role needs. */
  detail: string;
}

/** An open blocking comment, named so a refusal can point at it (D-355). */
export interface BlockingCommentRef {
  commentId: string;
  entityId: string;
  key: string;
  state: CommentState;
  /** The first line of the comment. Never the whole thread. */
  excerpt: string;
  /** True when the thing it was anchored to is no longer in the revision. */
  orphaned?: boolean;
}

/**
 * Where one gate stands.
 *
 * `not_applicable` is the normal state of most project work: gates bind only
 * to a Spec a person put on the gated path (D-352, leap "Gates only when
 * chosen"). Nothing is pending because a gate exists.
 */
export const GATE_STATES = ["not_applicable", "waiting", "ready", "approved", "changes_requested", "invalidated", "archived"] as const;
export type GateState = (typeof GATE_STATES)[number];

/** The entity a gate's decision is recorded on, at the exact revision. */
export interface GateSubject {
  entityId: string;
  kind: ProjectWorkKind;
  key: string;
  title: string;
  revisionId: string;
  digest: string;
  state: ProjectWorkState;
}

export interface GateStatusReport {
  gate: ApprovalGate;
  state: GateState;
  /** Absent when nothing plays the gate's part yet (no design, no plan). */
  subject?: GateSubject;
  requirements: GateRequirementReport[];
  /** The complete digest set an approval of this gate must carry (D-332). */
  covers: ApprovedRevision[];
  /** The outcomes this gate offers, in the leap's own words. */
  outcomes: GateOutcome[];
  blockingComments: BlockingCommentRef[];
  /** The decision already recorded, when there is one. */
  approval?: ProjectWorkApproval;
  /** Why a decision cannot be recorded right now. Absent when it can. */
  refusal?: string;
}

export interface GateReport {
  /** The Spec whose lifecycle these gates belong to. */
  specEntityId: string;
  specKey: string;
  /** False unless the Spec was put on the gated path. Nothing waits when false. */
  gated: boolean;
  /** The gate a person would decide next, when one is ready or waiting. */
  next?: ApprovalGate;
  gates: GateStatusReport[];
}

/**
 * One outcome of a gate, in the words the leap uses for it.
 *
 * `id` is the person-facing outcome; `decision` and `mode` are what the
 * approval records. "Build autonomously" and "Build with manual tool review"
 * are the same decision with two permission modes, which is exactly why the
 * mode cannot be a separate afterthought on the Build gate.
 */
export interface GateOutcome {
  id: string;
  label: string;
  decision: ApprovalDecision;
  mode?: ApprovalMode;
  /** True for the outcome that settles the gate in favour of the work. */
  approves: boolean;
}

export const GATE_OUTCOMES: Readonly<Record<ApprovalGate, readonly GateOutcome[]>> = {
  brief: [
    { id: "approve", label: "Approve direction", decision: "approved", approves: true },
    { id: "request_changes", label: "Request changes", decision: "changes_requested", approves: false },
    { id: "archive", label: "Archive", decision: "archived", approves: false },
  ],
  design: [
    { id: "approve", label: "Approve", decision: "approved", approves: true },
    { id: "request_changes", label: "Request changes", decision: "changes_requested", approves: false },
  ],
  build: [
    { id: "build_autonomously", label: "Build autonomously", decision: "approved", mode: "autonomous", approves: true },
    {
      id: "build_with_manual_tool_review",
      label: "Build with manual tool review",
      decision: "approved",
      mode: "manual_tool_review",
      approves: true,
    },
    { id: "request_changes", label: "Request changes", decision: "changes_requested", approves: false },
  ],
};

/** The outcome a gate offers under that id, or `undefined` if it offers none. */
export function gateOutcome(gate: ApprovalGate, id: string): GateOutcome | undefined {
  return GATE_OUTCOMES[gate].find((outcome) => outcome.id === id);
}

/** What this gate's outcomes are called, for a refusal that has to list them. */
function outcomeList(gate: ApprovalGate): string {
  return GATE_OUTCOMES[gate].map((outcome) => outcome.label.toLowerCase()).join(", ");
}

/**
 * Is this decision one this gate can record, with the permission mode it came
 * with?
 *
 * Three rules, all from the leap's gate table: a Design gate cannot archive a
 * Spec; a Build approval has to say how the build may run; and a permission
 * mode means nothing anywhere else, so carrying one is a mistake rather than
 * something to ignore.
 */
export function gateDecisionAllowed(input: { gate: ApprovalGate; decision: ApprovalDecision; mode?: ApprovalMode | undefined }): TransitionOutcome {
  const allowed = GATE_OUTCOMES[input.gate].some((outcome) => outcome.decision === input.decision);
  if (!allowed) {
    return refuse(`The ${input.gate} gate has these outcomes: ${outcomeList(input.gate)}.`);
  }
  if (input.gate === "build" && input.decision === "approved" && input.mode === undefined) {
    return refuse("Say how the build may run: autonomously, or with manual tool review.");
  }
  if (input.mode !== undefined && (input.gate !== "build" || input.decision !== "approved")) {
    return refuse("A permission mode belongs to approving the build, and to nothing else.");
  }
  return allow;
}

/** A comment and everything written under it, oldest first. */
export interface CommentThread {
  root: ProjectWorkComment;
  replies: ProjectWorkComment[];
  /** `open` while anything in the thread is open, then `addressed`, then `resolved`. */
  state: CommentState;
  /** True while an unresolved comment in the thread is marked blocking. */
  blocking: boolean;
  /** True when the root's anchor no longer resolves in the current revision. */
  orphaned: boolean;
}

/**
 * Group comments into threads.
 *
 * A reply whose parent is not in the list becomes its own root rather than
 * disappearing: a thread that lost its head is still something a person wrote,
 * and losing it would be the one thing this model must never do.
 */
export function commentThreads(comments: readonly ProjectWorkComment[]): CommentThread[] {
  const byId = new Map(comments.map((comment) => [comment.commentId, comment]));
  const replies = new Map<string, ProjectWorkComment[]>();
  const roots: ProjectWorkComment[] = [];
  for (const comment of comments) {
    const parentId = comment.parentCommentId;
    if (parentId !== undefined && byId.has(parentId) && parentId !== comment.commentId) {
      const list = replies.get(parentId);
      if (list) list.push(comment);
      else replies.set(parentId, [comment]);
      continue;
    }
    roots.push(comment);
  }
  return roots.map((root) => {
    const own = (replies.get(root.commentId) ?? []).slice().sort((a, b) => (a.createdAt === b.createdAt ? a.commentId.localeCompare(b.commentId) : a.createdAt < b.createdAt ? -1 : 1));
    const all = [root, ...own];
    const state: CommentState = all.some((comment) => comment.state === "open")
      ? "open"
      : all.some((comment) => comment.state === "addressed")
        ? "addressed"
        : "resolved";
    return {
      root,
      replies: own,
      state,
      blocking: all.some((comment) => comment.blocking && comment.state !== "resolved"),
      orphaned: root.orphaned === true,
    };
  });
}

/** The comments that stop an approval: blocking, and not resolved yet. */
export function openBlockingComments(comments: readonly ProjectWorkComment[]): ProjectWorkComment[] {
  return comments.filter((comment) => comment.blocking && comment.state !== "resolved");
}

/**
 * Who may move a comment where (D-332).
 *
 * The agent's half of the rule is as important as the person's: an agent that
 * fixed something says so, and the comment stays visibly unresolved until the
 * person who wrote it agrees.
 */
export function commentResolutionAllowed(input: {
  resolution: "addressed" | "resolved" | "reopened";
  actor: "person" | "agent";
  from: CommentState;
}): TransitionOutcome {
  if (input.resolution !== "addressed" && input.actor !== "person") {
    return refuse("An agent can mark a comment addressed; only you can resolve or reopen it.");
  }
  if (input.resolution === "addressed" && input.from === "resolved") {
    return refuse("That comment is resolved. Reopen it before marking it addressed again.");
  }
  if (input.resolution === "reopened" && input.from === "open") {
    return refuse("That comment is already open.");
  }
  return allow;
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

// ---------------------------------------------------------------------------
// The Plan graph (M21-T15)
// ---------------------------------------------------------------------------

/**
 * What can be wrong with a Plan's Task graph.
 *
 * All five are refusals: a Plan that names work this project does not have,
 * or that cannot be ordered, is not a plan anybody can execute. The orphan
 * case — a Task this Plan used to list and no longer does — is deliberately
 * *not* here: it is recorded, not refused (see {@link PlanGraphOrphan}).
 */
export const PLAN_GRAPH_PROBLEMS = [
  "cycle",
  "unknown_task",
  "not_a_task",
  "self_dependency",
  "dependency_outside_plan",
] as const;
export type PlanGraphProblemKind = (typeof PLAN_GRAPH_PROBLEMS)[number];

export interface PlanGraphProblem {
  problem: PlanGraphProblemKind;
  /** Every key the problem is about, in the order it reads (D-355). */
  keys: string[];
  /** The refusal, in one sentence a person can act on. */
  message: string;
}

/**
 * A Task that says it belongs to this Plan, which this revision of the Plan
 * no longer lists in any phase.
 *
 * Recorded rather than refused: a person revising a Plan is allowed to drop a
 * Task from it, and the Task keeps existing with its own state and its own
 * links. What is not allowed is losing sight of it, so the write answers with
 * the orphan and the Plan reports it on every read until it is adopted again,
 * cancelled or unlinked.
 */
export interface PlanGraphOrphan {
  key: string;
  entityId: string;
  title: string;
  state: ProjectWorkState;
  reason: "removed_from_plan";
}

export interface PlanGraphReport {
  ok: boolean;
  problems: PlanGraphProblem[];
  orphans: PlanGraphOrphan[];
  /**
   * The Plan's Tasks in dependency order, dependencies first. Empty when the
   * graph has a cycle, because a cyclic graph has no order.
   */
  order: string[];
}

export interface PlanGraphInput {
  /** The Plan's phases, which are what declares a Task to be part of it. */
  phases: ReadonlyArray<{ readonly taskKeys: readonly string[] }>;
  /** `from` depends on `to`: `to` must be done first. */
  dependencies: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  /** Every key this project has, with its kind and state. */
  known: ReadonlyMap<string, { kind: ProjectWorkKind; state: ProjectWorkState; entityId: string; title: string }>;
  /** Keys of Tasks whose body names this Plan. The ones no phase lists are orphans. */
  claimed?: readonly string[];
}

/**
 * Validate a Plan's Task graph.
 *
 * A Plan is a dependency graph, not a schedule (leap, "Plan and Project Task
 * contract"), so the rules are exactly the ones that make a graph executable:
 *
 * - every key a phase or a dependency names is a Task **this project has** —
 *   keys are minted by the store, so one it never minted is a typo or a
 *   hallucination, never a forward reference;
 * - a dependency's two ends are both listed by the Plan, so removing a Task
 *   from a phase and leaving a dependency pointing at it is refused rather
 *   than silently dangling;
 * - nothing depends on itself, and the graph has no cycle. A cycle is named by
 *   its keys, in the order it goes round.
 *
 * Pure: it decides nothing about state, writes nothing and reads no clock.
 */
export function validatePlanGraph(input: PlanGraphInput): PlanGraphReport {
  const problems: PlanGraphProblem[] = [];
  const seen = new Set<string>();
  const add = (problem: PlanGraphProblem): void => {
    const fingerprint = `${problem.problem}:${problem.keys.join(">")}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    problems.push(problem);
  };

  const declared: string[] = [];
  const declaredSet = new Set<string>();
  for (const phase of input.phases) {
    for (const key of phase.taskKeys) {
      if (declaredSet.has(key)) continue;
      declaredSet.add(key);
      declared.push(key);
    }
  }

  const checkExists = (key: string): boolean => {
    const found = input.known.get(key);
    if (!found) {
      add({ problem: "unknown_task", keys: [key], message: `${key} is not in this project, so this plan cannot name it.` });
      return false;
    }
    if (found.kind !== "task") {
      add({ problem: "not_a_task", keys: [key], message: `${key} is not a task. A plan's phases and dependencies name tasks.` });
      return false;
    }
    return true;
  };

  for (const key of declared) checkExists(key);

  const outgoing = new Map<string, string[]>();
  for (const edge of input.dependencies) {
    if (edge.from === edge.to) {
      add({ problem: "self_dependency", keys: [edge.from], message: `${edge.from} cannot depend on itself.` });
      continue;
    }
    let usable = true;
    for (const end of [edge.from, edge.to]) {
      if (declaredSet.has(end)) continue;
      if (checkExists(end)) {
        add({
          problem: "dependency_outside_plan",
          keys: [end],
          message: `${end} is named by a dependency, but this plan does not list it in any phase. Add it to a phase, or remove the dependency.`,
        });
      }
      usable = false;
    }
    if (!usable) continue;
    const list = outgoing.get(edge.from);
    if (list) list.push(edge.to);
    else outgoing.set(edge.from, [edge.to]);
  }

  const cycle = findDependencyCycle(declared, outgoing);
  if (cycle) add({ problem: "cycle", keys: cycle, message: planCycleMessage(cycle) });

  const orphans: PlanGraphOrphan[] = [];
  for (const key of input.claimed ?? []) {
    if (declaredSet.has(key)) continue;
    const found = input.known.get(key);
    if (!found) continue;
    orphans.push({ key, entityId: found.entityId, title: found.title, state: found.state, reason: "removed_from_plan" });
  }

  return {
    ok: problems.length === 0,
    problems,
    orphans,
    order: cycle ? [] : dependencyOrder(declared, outgoing),
  };
}

/**
 * One cycle in a list of declared dependencies, by key, or `undefined`.
 *
 * The body schema and {@link validatePlanGraph} both refuse a cyclic plan, and
 * both say the same sentence, because a person must not get two different
 * answers depending on which layer noticed (D-355).
 */
export function planDependencyCycle(dependencies: ReadonlyArray<{ readonly from: string; readonly to: string }>): string[] | undefined {
  const outgoing = new Map<string, string[]>();
  const nodes: string[] = [];
  for (const edge of dependencies) {
    if (!nodes.includes(edge.from)) nodes.push(edge.from);
    const list = outgoing.get(edge.from);
    if (list) list.push(edge.to);
    else outgoing.set(edge.from, [edge.to]);
  }
  return findDependencyCycle(nodes, outgoing);
}

/** How a cyclic plan is refused, wherever it is noticed. */
export function planCycleMessage(cycle: readonly string[]): string {
  return `This plan's dependencies go in a circle: ${cycle.join(" → ")}. A plan is dependency-ordered, so one of those dependencies has to go.`;
}

/** The keys of one cycle, in the order it goes round and back to its start. */
function findDependencyCycle(nodes: readonly string[], outgoing: ReadonlyMap<string, string[]>): string[] | undefined {
  const state = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];
  const roots = new Set<string>([...nodes, ...outgoing.keys()]);
  const visit = (node: string): string[] | undefined => {
    const mark = state.get(node);
    if (mark === 2) return undefined;
    if (mark === 1) {
      const at = path.indexOf(node);
      return [...path.slice(at), node];
    }
    state.set(node, 1);
    path.push(node);
    for (const next of outgoing.get(node) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    path.pop();
    state.set(node, 2);
    return undefined;
  };
  for (const node of roots) {
    const found = visit(node);
    if (found) return found;
  }
  return undefined;
}

/** Dependencies first, then what waits on them; ties keep the declared order. */
function dependencyOrder(nodes: readonly string[], outgoing: ReadonlyMap<string, string[]>): string[] {
  const order: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (node: string): void => {
    if (done.has(node) || visiting.has(node)) return;
    visiting.add(node);
    for (const next of outgoing.get(node) ?? []) visit(next);
    visiting.delete(node);
    done.add(node);
    order.push(node);
  };
  for (const node of nodes) visit(node);
  return order;
}

// ---------------------------------------------------------------------------
// Readiness and scope conflicts (M21-T15)
// ---------------------------------------------------------------------------

/**
 * Why a Task can or cannot be worked on right now, derived on every read.
 *
 * Nothing here is stored: readiness is a function of the dependencies' states
 * and of the upstream artifacts, so it can never drift from them.
 */
export interface TaskReadiness {
  /** True when every declared dependency is satisfied. */
  ready: boolean;
  /** The dependency keys still waiting, named for the board's refusals (D-355). */
  unmetDependencies: string[];
  /** The upstream Plan or Design that is stale, when one is. */
  stalePausedBy?: StaleUpstreamRef;
  /** True when a passing acceptance evidence record is linked to the Task. */
  hasAcceptanceEvidence: boolean;
  /** True when at least one verification of the Task passed. */
  hasPassingVerification: boolean;
  blockingComments: number;
}

/** The files and packages a Task says, or is observed, to write in. */
export interface TaskScope {
  packages: readonly string[];
  paths: readonly string[];
}

/**
 * Another active Task that writes where this one does.
 *
 * `observed` marks an overlap that came from a recorded repository change
 * rather than from the declared scope: the Task did not say it would write
 * there, and it did.
 */
export interface TaskConflict {
  entityId: string;
  key: string;
  title: string;
  state: ProjectTaskState;
  overlap: { packages: string[]; paths: string[] };
  observed: boolean;
  /** True when a person recorded that they accept the shared-checkout risk. */
  accepted: boolean;
}

/** Task states in which a Task may be about to write. */
export const ACTIVE_TASK_STATES: readonly ProjectTaskState[] = ["ready", "in_progress", "needs_review"];

export function isActiveTaskState(state: ProjectWorkState): boolean {
  return (ACTIVE_TASK_STATES as readonly string[]).includes(state);
}

/** `./packages/ui/` and `packages/ui` are the same place. */
export function normalizeScopePath(path: string): string {
  let value = path.trim().replace(/\\/g, "/");
  while (value.startsWith("./")) value = value.slice(2);
  value = value.replace(/\/{2,}/g, "/");
  while (value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

/** Two paths overlap when they are the same place, or one contains the other. */
export function scopePathsOverlap(a: string, b: string): boolean {
  const left = normalizeScopePath(a);
  const right = normalizeScopePath(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** What two scopes share: the packages in both, and the paths that contain each other. */
export function overlappingScope(a: TaskScope, b: TaskScope): { packages: string[]; paths: string[] } {
  const theirs = new Set(b.packages.map((name) => name.trim()).filter((name) => name.length > 0));
  const packages: string[] = [];
  for (const name of a.packages) {
    const trimmed = name.trim();
    if (trimmed && theirs.has(trimmed) && !packages.includes(trimmed)) packages.push(trimmed);
  }
  const paths: string[] = [];
  for (const mine of a.paths) {
    for (const other of b.paths) {
      if (!scopePathsOverlap(mine, other)) continue;
      // The narrower of the two is the place they actually meet.
      const left = normalizeScopePath(mine);
      const right = normalizeScopePath(other);
      const meeting = left.length >= right.length ? left : right;
      if (meeting && !paths.includes(meeting)) paths.push(meeting);
    }
  }
  return { packages, paths };
}
