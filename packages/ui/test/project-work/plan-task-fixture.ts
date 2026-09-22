/**
 * One `project/work/get` answer, shaped exactly as the host answers it
 * (M21-T15), for the Plan and Task detail tests.
 *
 * Everything optional is left out unless a test puts it in: a fixture that
 * quietly fills `readiness` or `planGraph` would prove the surfaces read
 * fields the host may not have sent.
 */
import type {
  AttemptRepositoryRecord,
  ClientRequests,
  ExecutionLink,
  PlanBody,
  ProjectTaskBody,
  ProjectWorkBody,
  ProjectWorkEvidence,
  ProjectWorkKind,
  ProjectWorkState,
  RepositoryLink,
} from "@lasercode/protocol";

export type Detail = ClientRequests["project/work/get"]["result"];

const PREFIX: Record<ProjectWorkKind, string> = { spec: "SPEC", research: "RES", design: "DES", plan: "PLAN", task: "TASK" };
const ORIGIN = { actor: { kind: "person", label: "You" } } as const;

export const planBody = (over: Partial<PlanBody> = {}): PlanBody => ({
  brief: "Ship the embedded workspace.",
  phases: [],
  dependencies: [],
  boundaries: [],
  migrations: [],
  risks: [],
  verification: [],
  ...over,
});

export const taskBody = (over: Partial<ProjectTaskBody> = {}): ProjectTaskBody => ({
  outcome: "The board performs real transitions.",
  nonGoals: [],
  dependencies: [],
  scope: { packages: [], repositories: [], paths: [], capabilities: [] },
  acceptance: [],
  verificationCommands: [],
  visualEvidenceRequired: false,
  assignment: { policy: "unassigned" },
  ...over,
});

export function detail(over: {
  entityId?: string;
  kind: ProjectWorkKind;
  number: number;
  title?: string;
  state?: ProjectWorkState;
  body: ProjectWorkBody;
  readiness?: Detail["readiness"];
  conflicts?: Detail["conflicts"];
  planGraph?: Detail["planGraph"];
  edges?: Detail["edges"];
  evidence?: ProjectWorkEvidence[];
  executionLinks?: ExecutionLink[];
  repositoryLinks?: RepositoryLink[];
}): Detail {
  const entityId = over.entityId ?? `e-${over.kind}-${over.number}`;
  const key = `${PREFIX[over.kind]}-${over.number}`;
  const revisionId = `${entityId}r1`;
  const digest = "a".repeat(64);
  const title = over.title ?? key;
  const state = over.state ?? (over.kind === "task" ? "draft" : "draft");
  return {
    ref: { projectId: "p1", kind: over.kind, entityId, revisionId, digest, label: title, key },
    entity: {
      projectId: "p1",
      entityId,
      kind: over.kind,
      key,
      keyNumber: over.number,
      title,
      state,
      currentRevisionId: revisionId,
      currentDigest: digest,
      revisionCount: 1,
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-02T00:00:00.000Z",
    },
    revision: {
      projectId: "p1",
      entityId,
      revisionId,
      kind: over.kind,
      index: 1,
      title,
      digest,
      bodyBytes: 256,
      createdAt: "2026-02-01T00:00:00.000Z",
      origin: ORIGIN,
      state,
    },
    fence: { entityId, revisionId, digest, seq: 7 },
    body: {
      encoding: "application/json",
      totalBytes: 256,
      offset: 0,
      bytes: 256,
      text: JSON.stringify(over.body),
      body: over.body,
    },
    edges: over.edges ?? [],
    repositoryLinks: over.repositoryLinks ?? [],
    executionLinks: over.executionLinks ?? [],
    comments: [],
    approvals: [],
    evidence: over.evidence ?? [],
    decisions: [],
    truncated: [],
    ...(over.readiness ? { readiness: over.readiness } : {}),
    ...(over.conflicts ? { conflicts: over.conflicts } : {}),
    ...(over.planGraph ? { planGraph: over.planGraph } : {}),
  };
}

export function evidence(over: Partial<ProjectWorkEvidence> & { evidenceId: string }): ProjectWorkEvidence {
  return {
    projectId: "p1",
    entityId: over.entityId ?? "e-task-44",
    revisionId: over.revisionId ?? "e-task-44r1",
    kind: over.kind ?? "test",
    role: over.role ?? "supporting",
    summary: over.summary ?? "pnpm -F @lasercode/ui test",
    outcome: over.outcome ?? "passed",
    at: over.at ?? "2026-02-02T09:00:00.000Z",
    origin: over.origin ?? ORIGIN,
    ...(over.detail ? { detail: over.detail } : {}),
    ...(over.blobId ? { blobId: over.blobId } : {}),
    ...(over.repositoryLinkId ? { repositoryLinkId: over.repositoryLinkId } : {}),
    evidenceId: over.evidenceId,
  };
}

export function executionLink(over: Partial<ExecutionLink> & { linkId: string; targetId: string }): ExecutionLink {
  return {
    projectId: "p1",
    entityId: over.entityId ?? "e-task-44",
    kind: over.kind ?? "session",
    attempt: over.attempt ?? 1,
    startedAt: over.startedAt ?? "2026-02-02T08:00:00.000Z",
    createdBy: { kind: "person", label: "You" },
    ...(over.endedAt ? { endedAt: over.endedAt } : {}),
    ...(over.outcome ? { outcome: over.outcome } : {}),
    ...(over.branch ? { branch: over.branch } : {}),
    ...(over.baseCommitObjectId ? { baseCommitObjectId: over.baseCommitObjectId } : {}),
    ...(over.targetUnavailable ? { targetUnavailable: over.targetUnavailable } : {}),
    ...(over.repositories ? { repositories: over.repositories } : {}),
    linkId: over.linkId,
    targetId: over.targetId,
  };
}

/**
 * One repository's record of an attempt, as the host writes it from git: the
 * opaque repository id, the base it started at and the checkpoints it made,
 * each with its own ref and its own commit.
 */
export function attemptRepository(
  over: Partial<AttemptRepositoryRecord> & { repositoryId: string; name: string },
): AttemptRepositoryRecord {
  return {
    base: over.base ?? { vcs: "git", objectFormat: "sha1", commitObjectId: "b".repeat(40) },
    sinceTurn: over.sinceTurn ?? -1,
    checkpoints: over.checkpoints ?? [],
    changedPaths: over.changedPaths ?? [],
    commits: over.commits ?? [],
    ...(over.change ? { change: over.change } : {}),
    ...(over.unavailable ? { unavailable: over.unavailable } : {}),
    repositoryId: over.repositoryId,
    name: over.name,
  };
}

export function repositoryLink(
  over: Partial<RepositoryLink> & { linkId: string; commit: string; checkpointId?: string },
): RepositoryLink {
  return {
    projectId: "p1",
    linkId: over.linkId,
    subject: over.subject ?? {
      projectId: "p1",
      kind: "task",
      entityId: "e-task-44",
      revisionId: "e-task-44r1",
      digest: "a".repeat(64),
      label: "TASK-44",
      key: "TASK-44",
    },
    relation: over.relation ?? "verified_at",
    repositoryId: over.repositoryId ?? "repo1",
    target: {
      state: {
        vcs: "git",
        objectFormat: "sha1",
        commitObjectId: over.commit,
        ...(over.checkpointId ? { checkpointId: over.checkpointId } : {}),
      },
    },
    createdBy: { kind: "person", label: "You" },
    createdAt: over.createdAt ?? "2026-02-02T10:00:00.000Z",
    ...(over.sourceUnavailable ? { sourceUnavailable: over.sourceUnavailable } : {}),
  };
}
