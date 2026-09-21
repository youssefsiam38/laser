/**
 * Recording a person's review of a real build (M21-T19, D-353, D-361).
 *
 * **What this is, exactly.** Native evidence is the project's *real build*,
 * rendered at an exact M20 checkpoint, looked at by a person. Laser does not
 * render it, does not run the design code and never opens a browser to check
 * anything (`AGENTS.md`, D-342). The checkpoint list in the Task detail is an
 * identity list, and the changes overlay shows the files that changed — a
 * diff is not a running app. So what this surface records is the person's own
 * word: *I opened the build at this checkpoint and compared it with this exact
 * revision.* Everything else about it — that the checkpoint is real, that it
 * resolves to the commit named, that the subject is still the revision it
 * says, that the state is captured where it can still be read — is the host's
 * to prove, and it refuses the write when any of it does not hold.
 *
 * Everything here is pure: what can be accepted, against what, and the exact
 * request that says so. The component stays about what a person sees.
 */
import type {
  ClientRequests,
  VerificationAuthority,
  VerificationReport,
  VerificationSourceRef,
} from "@lasercode/protocol";

type Detail = ClientRequests["project/work/get"]["result"];
type LinkInput = ClientRequests["project/work/link"]["params"]["link"];

/** The most checkpoints offered at once. A picker, not a history. */
export const ACCEPTANCE_CHECKPOINTS_MAX = 40;

/**
 * What a review would be *about*: one artifact revision, exactly.
 *
 * A visual criterion that came from a Design is proven against **that Design
 * revision** and no other — a preview accepted against a revision the work has
 * moved past says nothing about the one that replaced it. A criterion that is
 * the Task's own is proven against the Task. This mirrors the host's rule
 * rather than inventing a second one.
 */
export interface AcceptanceSubject {
  /** `design` or `task`; what the person is comparing the build against. */
  authority: VerificationAuthority;
  entityId: string;
  revisionId: string;
  digest: string;
  key: string;
  title: string;
  /** The criteria this exact revision is the authority for. */
  criterionIds: string[];
  /** What those criteria ask, for the person to read while comparing. */
  asks: string[];
}

/** One checkpoint a review could name, with the repository it belongs to. */
export interface AcceptanceCheckpoint {
  /** Stable identity of this row, for selection only. */
  id: string;
  attempt: number;
  /**
   * The attempt row this checkpoint belongs to (M21-T19).
   *
   * Sent with the review so the host can work out which sources the review
   * rests on: the difference between what that attempt started from and this
   * exact checkpoint. Absent when the same checkpoint was recorded by more
   * than one attempt — the row can no longer be tied to exactly one, and a
   * guess is what this whole record exists to replace.
   */
  executionLinkId?: string;
  /** The task the attempt belongs to. Identity the host re-derives. */
  taskEntityId: string;
  repositoryId: string;
  repositoryName: string;
  objectFormat: "sha1" | "sha256";
  /** `refs/<product>/checkpoints/<session>/<turn>`, as recorded. */
  checkpointId: string;
  commitObjectId: string;
  turn: number;
  createdAt?: string;
  /** The conversation the attempt ran in. */
  sessionId: string;
  /** Its session file, when this window still has that conversation. */
  sessionPath?: string;
}

/**
 * The revisions a review can be recorded against, from the stored report.
 *
 * Only `visual` criteria: those are the ones the leap calls native evidence,
 * and the only ones an accepted preview settles. A report with none gives
 * nothing back, and the surface says so rather than offering an action that
 * would record an acceptance of nothing.
 */
export function acceptanceSubjects(report: VerificationReport | undefined): AcceptanceSubject[] {
  if (!report) return [];
  const byRevision = new Map<string, AcceptanceSubject>();
  for (const criterion of report.criteria) {
    if (criterion.kind !== "visual") continue;
    // The host's own rule (verification/evaluate.ts): a Design criterion is
    // proven against the Design revision the run read, anything else against
    // the Task.
    const source: VerificationSourceRef = criterion.authority === "design" ? criterion.source : report.task;
    const key = `${source.entityId}:${source.revisionId}`;
    const existing = byRevision.get(key);
    if (existing) {
      existing.criterionIds.push(criterion.id);
      if (!existing.asks.includes(criterion.text)) existing.asks.push(criterion.text);
      continue;
    }
    byRevision.set(key, {
      authority: criterion.authority === "design" ? "design" : "task",
      entityId: source.entityId,
      revisionId: source.revisionId,
      digest: source.digest,
      key: source.key,
      title: source.title,
      criterionIds: [criterion.id],
      asks: [criterion.text],
    });
  }
  return [...byRevision.values()];
}

/**
 * The checkpoints this Task's own attempts recorded, newest first.
 *
 * Every field is an identity the host wrote from git when the attempt was
 * recorded: the repository's opaque id, its object format, the checkpoint ref
 * and the commit **that repository's** ref pointed at. Two repositories in one
 * workspace produce two rows with two different commits; there is no
 * "the commit of this turn" across a workspace, and this never invents one.
 *
 * A repository record the host marked `unavailable` is left out: its objects
 * were already gone when it was written, so nothing could be reviewed at it.
 */
export function acceptanceCheckpoints(detail: Detail, sessions: ReadonlyArray<{ id: string; path: string }>): AcceptanceCheckpoint[] {
  const pathOf = new Map(sessions.map((session) => [session.id, session.path]));
  const rows: AcceptanceCheckpoint[] = [];
  const at = new Map<string, AcceptanceCheckpoint>();
  const attempts = [...detail.executionLinks].sort((a, b) => b.attempt - a.attempt);
  for (const link of attempts) {
    for (const repository of link.repositories ?? []) {
      if (repository.unavailable === true) continue;
      const checkpoints = [...repository.checkpoints].sort((a, b) => b.turn - a.turn);
      for (const checkpoint of checkpoints) {
        const id = `${repository.repositoryId}:${checkpoint.ref}:${checkpoint.commitObjectId}`;
        const already = at.get(id);
        if (already) {
          // The same checkpoint recorded by two attempts: there is no honest
          // way to say which attempt's work it is, so the row keeps its
          // identity and loses the attempt, and the dialog refuses it rather
          // than picking one.
          if (already.executionLinkId !== link.linkId) delete already.executionLinkId;
          continue;
        }
        const sessionPath = link.targetUnavailable === true ? undefined : pathOf.get(link.targetId);
        const row: AcceptanceCheckpoint = {
          id,
          attempt: link.attempt,
          executionLinkId: link.linkId,
          taskEntityId: link.entityId,
          repositoryId: repository.repositoryId,
          repositoryName: repository.name,
          objectFormat: repository.base.objectFormat,
          checkpointId: checkpoint.ref,
          commitObjectId: checkpoint.commitObjectId,
          turn: checkpoint.turn,
          ...(checkpoint.createdAt ? { createdAt: checkpoint.createdAt } : {}),
          sessionId: link.targetId,
          ...(sessionPath ? { sessionPath } : {}),
        };
        at.set(id, row);
        rows.push(row);
        if (rows.length >= ACCEPTANCE_CHECKPOINTS_MAX) return rows;
      }
    }
  }
  return rows;
}

/** The repositories those checkpoints belong to, in the order they appear. */
export function acceptanceRepositories(rows: readonly AcceptanceCheckpoint[]): Array<{ repositoryId: string; name: string }> {
  const byId = new Map<string, { repositoryId: string; name: string }>();
  for (const row of rows) {
    if (!byId.has(row.repositoryId)) byId.set(row.repositoryId, { repositoryId: row.repositoryId, name: row.repositoryName });
  }
  return [...byId.values()];
}

/** Why no review can be recorded here yet, in a sentence a person can act on. */
export type AcceptanceObstacle =
  | { kind: "no_report"; detail: string }
  | { kind: "no_visual_criterion"; detail: string }
  | { kind: "no_checkpoint"; detail: string };

export function acceptanceObstacle(input: {
  report: VerificationReport | undefined;
  subjects: readonly AcceptanceSubject[];
  checkpoints: readonly AcceptanceCheckpoint[];
}): AcceptanceObstacle | undefined {
  if (!input.report) {
    return {
      kind: "no_report",
      detail: "Verify this task first: a review is recorded against the exact design or task revision a run checked, and there is no run yet.",
    };
  }
  if (input.subjects.length === 0) {
    return {
      kind: "no_visual_criterion",
      detail: "Nothing in this task asks for a visual check, so there is no design or task revision to accept a build against.",
    };
  }
  if (input.checkpoints.length === 0) {
    return {
      kind: "no_checkpoint",
      detail: "No attempt has recorded a checkpoint in a repository yet. Start… joins this task to the conversation the work happens in; its checkpoints are what a build is reviewed at.",
    };
  }
  return undefined;
}

/**
 * What the person is asked to type to confirm. The subject's key, as every
 * other confirmation in this workspace does it — short, exact, and impossible
 * to produce by pressing Enter.
 */
export function acceptanceConfirmWord(subject: AcceptanceSubject): string {
  return subject.key;
}

/**
 * The exact request a recorded review sends.
 *
 * One evidence link, through the one door the host already validates: kind
 * `person_acceptance`, role `acceptance`, outcome `passed`, and a `verifiedAt`
 * carrying this repository's own state and the acceptance **request** marker.
 * The marker asks the host to record an acceptance; it is not the proof of
 * one, and nothing here can mint the record the host writes beside it.
 */
export function acceptanceLink(input: { subject: AcceptanceSubject; checkpoint: AcceptanceCheckpoint; note?: string }): LinkInput {
  const { subject, checkpoint } = input;
  const note = input.note?.trim();
  if (!checkpoint.executionLinkId) throw new Error(ACCEPTANCE_AMBIGUOUS_ATTEMPT);
  return {
    type: "evidence",
    entityId: subject.entityId,
    revisionId: subject.revisionId,
    kind: "person_acceptance",
    role: "acceptance",
    outcome: "passed",
    summary:
      `You compared this project's build at checkpoint ${String(checkpoint.turn)} of ${checkpoint.repositoryName} ` +
      `(${checkpoint.commitObjectId.slice(0, 10)}) with ${subject.key} at ${subject.revisionId}, and accepted it.`,
    ...(note ? { detail: note } : {}),
    verifiedAt: {
      repositoryId: checkpoint.repositoryId,
      state: {
        vcs: "git",
        objectFormat: checkpoint.objectFormat,
        commitObjectId: checkpoint.commitObjectId,
        checkpointId: checkpoint.checkpointId,
      },
      acceptance: { kind: "checkpoint_preview" },
      // Identity the person's own surface already holds, reported so the host
      // can work out the sources this review rests on. The host re-derives
      // every part of it and refuses when any of it disagrees.
      attempt: { taskEntityId: checkpoint.taskEntityId, executionLinkId: checkpoint.executionLinkId },
    },
  };
}

/** Said once, so the dialog and the model cannot drift apart on it. */
export const ACCEPTANCE_AMBIGUOUS_ATTEMPT =
  "More than one attempt recorded this checkpoint, so which work it is cannot be told from here. Pick a checkpoint from one attempt, or verify the task again and record your review at a newer one.";

/**
 * Is the checkpoint this review would name still the one it was?
 *
 * The answer the session's own checkpoint list gives, joined on the ref **and**
 * the commit, per repository — never on the turn's top-level commit, which is
 * one repository's and not a workspace's. The host asks git the same question
 * before it writes anything; asking here is what keeps a person from typing a
 * confirmation into something that is already gone.
 */
export type CheckpointLiveness =
  | { state: "unknown" }
  | { state: "present" }
  | { state: "pruned"; detail: string }
  | { state: "moved"; detail: string };

export function checkpointLiveness(
  row: AcceptanceCheckpoint,
  list: { checkpoints: ReadonlyArray<{ turn: number; ref: string; commit: string; repos?: ReadonlyArray<{ repo: string; ref: string; commit: string }> }> } | undefined,
): CheckpointLiveness {
  if (!list) return { state: "unknown" };
  const entry = list.checkpoints.find((candidate) => candidate.ref === row.checkpointId);
  if (!entry) {
    return {
      state: "pruned",
      detail: "That checkpoint is no longer in the repository, so there is nothing left to review at it. Pick a later checkpoint, or make a new one by working on this task.",
    };
  }
  const commits = entry.repos && entry.repos.length > 0 ? entry.repos.map((repo) => repo.commit) : [entry.commit];
  if (!commits.includes(row.commitObjectId)) {
    return {
      state: "moved",
      detail: "That checkpoint no longer points at the state recorded here. Look at the build again at a checkpoint that is still there, then record your review.",
    };
  }
  return { state: "present" };
}
