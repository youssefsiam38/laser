/**
 * What a Project Task's records *mean*, computed once (M21-T16).
 *
 * Everything here is a pure reading of what the host already answered with —
 * execution links, evidence, repository links, readiness and conflicts
 * (M21-T15). Nothing is derived that the protocol does not carry: there is no
 * progress, no estimate, no "probably passing", and an attempt that ended
 * badly stays an attempt with a reason rather than becoming a failed Task.
 */
import type {
  ExecutionLink,
  EvidenceKind,
  ProjectWorkEvidence,
  RepositoryLink,
  StaleUpstreamRef,
  TaskAssignment,
  TaskConflict,
  TaskReadiness,
} from "@lasercode/protocol";

// ---------------------------------------------------------------------------
// Attempts
// ---------------------------------------------------------------------------

export interface TaskAttempt {
  /** 1-based, as the protocol mints it. */
  attempt: number;
  /** The session, run or command this attempt ran in. */
  links: ExecutionLink[];
  /** The evidence this attempt produced, matched by the session it came from. */
  evidence: ProjectWorkEvidence[];
  startedAt: string;
  endedAt: string | undefined;
  outcome: ExecutionLink["outcome"];
  /** True when every link of the attempt points at something no longer here. */
  unavailable: boolean;
}

export interface TaskAttempts {
  /** Newest attempt first: the one a person is looking for is the last one. */
  attempts: TaskAttempt[];
  /** Evidence that belongs to no attempt — a person's own acceptance, a review. */
  unattributed: ProjectWorkEvidence[];
}

/**
 * Group execution links into attempts, and hang each attempt's evidence off it.
 *
 * Evidence carries no attempt number; what it carries is provenance
 * (`origin.sessionId`). So a record is placed under an attempt when it came
 * from a session or run that attempt links to, and everything else is listed on
 * its own rather than guessed at.
 */
export function attemptsOf(
  links: readonly ExecutionLink[],
  evidence: readonly ProjectWorkEvidence[],
): TaskAttempts {
  const byAttempt = new Map<number, ExecutionLink[]>();
  for (const link of links) {
    const bucket = byAttempt.get(link.attempt);
    if (bucket) bucket.push(link);
    else byAttempt.set(link.attempt, [link]);
  }

  const claimed = new Set<string>();
  const attempts: TaskAttempt[] = [...byAttempt.entries()]
    .map(([attempt, group]) => {
      const targets = new Set(group.map((link) => link.targetId));
      const mine = evidence.filter((record) => {
        const sessionId = record.origin.sessionId;
        if (!sessionId || !targets.has(sessionId)) return false;
        claimed.add(record.evidenceId);
        return true;
      });
      const started = group.map((link) => link.startedAt).sort();
      const ended = group.flatMap((link) => (link.endedAt ? [link.endedAt] : [])).sort();
      const outcome = group.find((link) => link.outcome !== undefined)?.outcome;
      return {
        attempt,
        links: [...group].sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
        evidence: mine,
        startedAt: started[0] ?? "",
        endedAt: ended[ended.length - 1],
        outcome,
        unavailable: group.every((link) => link.targetUnavailable === true),
      } satisfies TaskAttempt;
    })
    .sort((left, right) => right.attempt - left.attempt);

  return { attempts, unattributed: evidence.filter((record) => !claimed.has(record.evidenceId)) };
}

/** The next attempt number a new execution link would take. */
export function nextAttempt(links: readonly ExecutionLink[]): number {
  return links.reduce((highest, link) => Math.max(highest, link.attempt), 0) + 1;
}

export const EXECUTION_KIND_LABEL = {
  session: "Session",
  agent_run: "Agent run",
  checkpoint: "Checkpoint",
  branch: "Branch",
  command: "Command",
} as const;

export const ATTEMPT_OUTCOME_LABEL = {
  completed: "finished",
  failed: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
} as const;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** What each evidence kind is called in words, never the wire value. */
export const EVIDENCE_KIND_LABEL: Readonly<Record<EvidenceKind, string>> = {
  test: "Test run",
  diff: "Diff",
  screenshot: "Screenshot",
  source_location: "Source location",
  commit: "Commit",
  review: "Review",
  person_acceptance: "You accepted it",
  command_output: "Command output",
  verification: "Verification report",
};

export const EVIDENCE_ROLE_LABEL = {
  acceptance: "acceptance",
  supporting: "supporting",
  deviation: "deviation",
} as const;

/**
 * The exact revision a piece of evidence ran against, as a repository link.
 *
 * Evidence names a `repositoryLinkId` and nothing else; resolving it here keeps
 * the surface from showing a commit the record does not actually claim.
 */
export function revisionOfEvidence(
  record: ProjectWorkEvidence,
  repositoryLinks: readonly RepositoryLink[],
): RepositoryLink | undefined {
  if (!record.repositoryLinkId) return undefined;
  return repositoryLinks.find((link) => link.linkId === record.repositoryLinkId);
}

// ---------------------------------------------------------------------------
// Checkpoints, from git
// ---------------------------------------------------------------------------

export interface TaskCheckpoint {
  id: string;
  /** `based on`, `implemented by`, `verified at`, `published as`. */
  relation: RepositoryLink["relation"];
  /** The commit, or `base → head` for a change. */
  commit: string;
  /** The Laser checkpoint the state came from, when it was uncommitted work. */
  checkpointId: string | undefined;
  path: string | undefined;
  at: string;
  /** The git object is no longer reachable; the link keeps what it recorded. */
  unavailable: boolean;
  actor: string;
}

const REPOSITORY_RELATION_LABEL = {
  based_on: "based on",
  implemented_by: "implemented by",
  verified_at: "verified at",
  published_as: "published as",
} as const;

export function repositoryRelationLabel(relation: RepositoryLink["relation"]): string {
  return REPOSITORY_RELATION_LABEL[relation];
}

const short = (commit: string): string => commit.slice(0, 10);

/**
 * The checkpoints and repository states this Task's work is recorded at.
 *
 * "Checkpoints and git determine changed files; tool calls never do" (leap,
 * "Execution and convergence"), so this reads the repository links and nothing
 * else — newest first.
 */
export function checkpointsOf(links: readonly RepositoryLink[]): TaskCheckpoint[] {
  return [...links]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((link) => {
      const state = "state" in link.target ? link.target.state : link.target.change.head;
      const commit =
        "state" in link.target
          ? short(link.target.state.commitObjectId)
          : `${short(link.target.change.base.commitObjectId)} → ${short(link.target.change.head.commitObjectId)}`;
      return {
        id: link.linkId,
        relation: link.relation,
        commit,
        checkpointId: state.checkpointId,
        path: link.publishedPath ?? state.path,
        at: link.createdAt,
        unavailable: link.sourceUnavailable === true,
        actor: link.createdBy.label,
      } satisfies TaskCheckpoint;
    });
}

// ---------------------------------------------------------------------------
// Why a Task cannot move
// ---------------------------------------------------------------------------

/**
 * The blocked banner's sentence, naming the keys (D-355).
 *
 * Only what `readiness` actually says: the unmet dependency keys, the stale
 * upstream, and blocking comments. Returns nothing when there is nothing
 * standing in the way — a banner with no reason is a nag.
 */
export function blockedSentence(readiness: TaskReadiness | undefined): string | undefined {
  if (!readiness) return undefined;
  const parts: string[] = [];
  if (readiness.unmetDependencies.length > 0) {
    parts.push(`${readiness.unmetDependencies.join(", ")} must be done first.`);
  }
  if (readiness.blockingComments > 0) {
    parts.push(
      `${readiness.blockingComments} blocking comment${readiness.blockingComments === 1 ? "" : "s"} have to be resolved.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** The sentence a completion is refused with when nothing has accepted it yet. */
export const NO_ACCEPTANCE_EVIDENCE =
  "Nothing has accepted this task yet. A task is done when a passing acceptance record says so — a finished attempt is evidence, not a completion.";

/**
 * The stale-upstream refusal, decoded from what the host put in `data`
 * (M21-T15: `data: { refused: "stale_upstream", upstream }`).
 *
 * The message is the host's own sentence; this is only the reference beside it,
 * so the surface can offer to open the upstream that moved.
 */
export function staleUpstreamOf(data: unknown): StaleUpstreamRef | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as { refused?: unknown; upstream?: unknown };
  if (record.refused !== "stale_upstream") return undefined;
  const upstream = record.upstream as Partial<StaleUpstreamRef> | undefined;
  if (!upstream || typeof upstream.key !== "string" || typeof upstream.entityId !== "string") return undefined;
  return upstream as StaleUpstreamRef;
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/**
 * What two Tasks writing in the same place means, in one sentence.
 *
 * `observed` is the sharper case: the other Task did not say it would write
 * there — a recorded repository change says it did.
 */
export function conflictSentence(conflict: TaskConflict): string {
  const where = [...conflict.overlap.packages, ...conflict.overlap.paths];
  const place = where.length === 0 ? "the same files" : where.slice(0, 3).join(", ");
  const rest = where.length > 3 ? ` and ${where.length - 3} more` : "";
  return conflict.observed
    ? `${conflict.key} has already written in ${place}${rest}.`
    : `${conflict.key} says it writes in ${place}${rest}.`;
}

/** The conflicts a person has not accepted the shared-checkout risk for. */
export function unacceptedConflicts(conflicts: readonly TaskConflict[] | undefined): TaskConflict[] {
  return (conflicts ?? []).filter((conflict) => !conflict.accepted);
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/** The wire value of an assignment as one string, for a radio or a select. */
export function assignmentValue(assignment: TaskAssignment): string {
  return assignment.policy === "agent" ? `agent:${assignment.agentName}` : assignment.policy;
}

export function assignmentLabel(assignment: TaskAssignment): string {
  if (assignment.policy === "agent") return assignment.agentName;
  return assignment.policy === "person" ? "You" : "Nobody yet";
}

/**
 * Every assignment this project can actually make: nobody, you, or one of the
 * agents this device has. An agent that is not in the catalog is still shown
 * when the Task names it — the record is what it is, and hiding it would make
 * the control lie about the value it holds.
 */
export function assignmentOptions(
  agents: readonly { name: string; description?: string }[],
  current: TaskAssignment,
): Array<{ value: string; label: string; detail?: string }> {
  const options = [
    { value: "unassigned", label: "Nobody yet", detail: "It is written down; nothing is working on it." },
    { value: "person", label: "You", detail: "You are the one who will do this." },
    ...agents.map((agent) => ({ value: `agent:${agent.name}`, label: agent.name, ...(agent.description ? { detail: agent.description } : {}) })),
  ];
  const value = assignmentValue(current);
  if (options.some((option) => option.value === value)) return options;
  return [...options, { value, label: assignmentLabel(current), detail: "This agent is not on this device." }];
}
