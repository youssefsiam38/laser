/**
 * Deciding each criterion (M21-T19).
 *
 * The verifier supplies the one thing only it can: what happened when the
 * Task's declared commands ran in its own checkout. Everything else is read
 * here, from the store, by the host — so a run cannot report a verdict, only
 * facts, and a tool that skipped the worker's own rules changes nothing about
 * the answer.
 *
 * The four ways a criterion is decided:
 *
 * 1. **A command.** Exit zero is satisfied, anything else failed, and a
 *    command that never ran leaves the criterion undecided rather than passed.
 * 2. **The store's own records.** A review criterion is the blocking comments,
 *    the invalidated approvals and the stale upstream, all of which the store
 *    already knows.
 * 3. **An accepted checkpoint preview.** Native visual evidence exists only at
 *    Build, as a `verified_at` link a person made from an M20 checkpoint
 *    preview (D-353). Until there is one, the criterion is `needs_person` with
 *    the exact step — never "probably fine".
 * 4. **Nobody.** A design state, a token, a boundary or a migration is
 *    `not_machine_verifiable`: the report names what to read instead of
 *    inventing a check for it.
 */
import {
  convergenceOf,
  machineDecidable,
  type RepositoryLink,
  type VerificationBlocker,
  type VerificationCommandRun,
  type VerificationCriterion,
  type VerificationFinding,
  type VerificationPersonDecision,
  type VerificationPlan,
  type VerificationRunOutcome,
} from "@lasercode/protocol";
import type { GatheredAuthorities } from "./authorities.js";

export interface EvaluationInput {
  plan: VerificationPlan;
  gathered: GatheredAuthorities;
  commands: readonly VerificationCommandRun[];
  /** Every repository link on the Task and on the Design, for Native evidence. */
  repositoryLinks: readonly RepositoryLink[];
  stopped?: boolean;
}

export interface Evaluation {
  findings: VerificationFinding[];
  blockers: VerificationBlocker[];
  personDecisions: VerificationPersonDecision[];
  converged: boolean;
  outcome: VerificationRunOutcome;
}

/**
 * An accepted M20 checkpoint preview, linked `verified_at` (D-353).
 *
 * Three things have to be true at once, and each one is the reason for one of
 * the others: the relation is `verified_at` (it is a state, not a delivery),
 * the state names a **checkpoint** (a preview, not an arbitrary commit), and a
 * **person** made it (an agent's link would be a claim about its own work).
 */
export function acceptedPreview(links: readonly RepositoryLink[], subjectEntityId?: string): RepositoryLink | undefined {
  return links.find((link) => {
    if (link.relation !== "verified_at") return false;
    if (link.createdBy.kind !== "person") return false;
    if (subjectEntityId !== undefined && link.subject.entityId !== subjectEntityId) return false;
    return "state" in link.target && link.target.state.checkpointId !== undefined;
  });
}

export function evaluate(input: EvaluationInput): Evaluation {
  const runs = new Map(input.commands.map((run) => [run.command, run]));
  const findings: VerificationFinding[] = [];
  const personDecisions: VerificationPersonDecision[] = [];
  const blockers: VerificationBlocker[] = [...input.plan.blockers];

  for (const criterion of input.plan.criteria) {
    const finding = decide(criterion, runs, input);
    findings.push(finding);
    if (finding.outcome === "needs_person") {
      personDecisions.push({
        criterionId: criterion.id,
        question: criterion.text,
        steps: finding.steps ?? criterion.steps ?? ["Check it and record what you saw as evidence."],
      });
    }
    // A required check that failed is exactly the third thing the leap says
    // convergence cannot survive.
    if (finding.outcome === "failed" && criterion.required && machineDecidable(criterion)) {
      blockers.push({
        kind: "failed_check",
        detail: `${criterion.source.key}: ${finding.detail}`,
        key: criterion.source.key,
        ...(criterion.command !== undefined ? { reference: criterion.command } : {}),
      });
    }
  }

  const convergence = convergenceOf({
    criteria: input.plan.criteria,
    findings,
    blockers,
    ...(input.stopped === true ? { stopped: true } : {}),
  });
  return { findings, blockers, personDecisions, converged: convergence.converged, outcome: convergence.outcome };
}

function decide(
  criterion: VerificationCriterion,
  runs: Map<string, VerificationCommandRun>,
  input: EvaluationInput,
): VerificationFinding {
  if (criterion.kind === "browser_matrix") {
    return {
      criterionId: criterion.id,
      outcome: "needs_person",
      detail: "A browser matrix is walked by you, never by an agent. The steps are here.",
      evidenceIds: [],
      steps: criterion.steps ?? [],
    };
  }
  if (criterion.kind === "visual") return visualFinding(criterion, input);
  if (criterion.kind === "review") return reviewFinding(criterion, input);

  if (criterion.command !== undefined) {
    const run = runs.get(criterion.command);
    if (!run || run.status === "not_run") {
      return {
        criterionId: criterion.id,
        outcome: "needs_person",
        detail: `${criterion.command} did not run, so this was not checked.`,
        evidenceIds: [],
        commands: [criterion.command],
        steps: [`Run ${criterion.command} in this project's checkout and verify again.`],
      };
    }
    if (run.status === "unavailable") {
      return {
        criterionId: criterion.id,
        outcome: "needs_person",
        detail: run.detail ?? `${criterion.command} could not be run here.`,
        evidenceIds: [],
        commands: [criterion.command],
        steps: [`Make ${criterion.command} runnable in this project, then verify again.`],
      };
    }
    if (run.status === "stopped") {
      return {
        criterionId: criterion.id,
        outcome: "needs_person",
        detail: `${criterion.command} was stopped before it finished.`,
        evidenceIds: [],
        commands: [criterion.command],
        steps: [`Verify again to run ${criterion.command} to the end.`],
      };
    }
    return {
      criterionId: criterion.id,
      outcome: run.status === "passed" ? "satisfied" : "failed",
      detail:
        run.status === "passed"
          ? `${criterion.command} exited 0.`
          : `${criterion.command} exited ${String(run.exitCode ?? "without a code")}.`,
      evidenceIds: [],
      commands: [criterion.command],
    };
  }

  if (criterion.machineVerifiable) {
    return {
      criterionId: criterion.id,
      outcome: "needs_person",
      detail: "This says it can be checked by a command, but no command is bound to it.",
      evidenceIds: [],
      steps: criterion.steps ?? [`Bind a command to it on ${input.plan.task.key}, or check it yourself and record what you saw.`],
    };
  }
  return {
    criterionId: criterion.id,
    outcome: "not_machine_verifiable",
    detail: `Read ${criterion.source.key} and judge this one; no command here decides it.`,
    evidenceIds: [],
  };
}

/**
 * Native visual evidence: only an accepted M20 checkpoint preview (D-353).
 *
 * The Design phase never runs the project, so there is no capture to compare
 * against and nothing an agent can produce. What exists is a preview the
 * person accepted, recorded as a `verified_at` link from the exact commit —
 * and until that link is there, this is the person's to settle.
 */
function visualFinding(criterion: VerificationCriterion, input: EvaluationInput): VerificationFinding {
  const subject = criterion.authority === "design" ? criterion.source.entityId : input.plan.task.entityId;
  const link = acceptedPreview(input.repositoryLinks, subject);
  if (!link) {
    return {
      criterionId: criterion.id,
      outcome: "needs_person",
      detail: `Nothing has been accepted as native visual evidence for ${criterion.source.key} yet.`,
      evidenceIds: [],
      steps: [
        `Open the checkpoint preview for this work and compare it with ${criterion.source.key}.`,
        "Accept it if it matches; accepting records the exact commit as verified_at, which is what native evidence is.",
      ],
    };
  }
  const state = "state" in link.target ? link.target.state : undefined;
  const evidenceIds = input.gathered.task.evidence
    .filter((record) => record.repositoryLinkId === link.linkId)
    .map((record) => record.evidenceId);
  return {
    criterionId: criterion.id,
    outcome: "satisfied",
    detail: `You accepted the checkpoint preview at ${state?.commitObjectId.slice(0, 10) ?? "the recorded commit"}, linked verified_at to ${criterion.source.key}.`,
    evidenceIds,
    repositoryLinkId: link.linkId,
  };
}

/** Reviews: the blocking comments and stale approvals the store already knows. */
function reviewFinding(criterion: VerificationCriterion, input: EvaluationInput): VerificationFinding {
  const reasons = input.plan.blockers.filter(
    (blocker) => blocker.kind === "blocking_comment" || blocker.kind === "stale_approval" || blocker.kind === "stale_upstream",
  );
  if (reasons.length === 0) {
    return {
      criterionId: criterion.id,
      outcome: "satisfied",
      detail: "Nothing is open: no blocking comment, no invalidated approval, no stale upstream.",
      evidenceIds: [],
    };
  }
  return {
    criterionId: criterion.id,
    outcome: "failed",
    detail: reasons.map((reason) => reason.detail).join(" "),
    evidenceIds: [],
  };
}
