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
  type ProjectWorkEvidence,
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
  /** Every evidence record on those subjects, for the acceptance join. */
  evidence: readonly ProjectWorkEvidence[];
  /** Whether a link's stored capture is still readable. Never a git read. */
  captureReadable: (link: RepositoryLink) => boolean;
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
 * The accepted M20 checkpoint preview that proves one exact revision, read
 * **only from what is stored** (D-353, D-361).
 *
 * Everything this asks was established and written down when the person
 * accepted, and none of it is re-derived from git here. That is the whole
 * point: the contract protects this evidence precisely against the day
 * retention prunes the checkpoint, so a check that went back to git would
 * fail exactly when it is needed.
 *
 * Five stored facts, and all five have to hold:
 *
 * 1. the link is a `verified_at` **state** on this exact subject — same
 *    entity, same revision, same digest, so a revision the work has moved on
 *    to cannot inherit a preview nobody looked at;
 * 2. a **person** created it;
 * 3. the host's own `acceptance` record is on it, which only the host writes,
 *    and it agrees with the link about the commit and the subject's digest;
 * 4. the bounded canonical capture is there and still readable;
 * 5. a `person_acceptance` evidence record that passed is joined to it.
 */
export function acceptedPreview(
  links: readonly RepositoryLink[],
  subject: { entityId: string; revisionId: string; digest: string },
  evidence: readonly ProjectWorkEvidence[],
  captureReadable: (link: RepositoryLink) => boolean,
): RepositoryLink | undefined {
  return links.find((link) => {
    if (link.relation !== "verified_at") return false;
    if (link.createdBy.kind !== "person") return false;
    if (link.subject.entityId !== subject.entityId) return false;
    if (link.subject.revisionId !== subject.revisionId || link.subject.digest !== subject.digest) return false;
    const accepted = link.acceptance;
    if (!accepted || accepted.kind !== "checkpoint_preview") return false;
    if (accepted.subjectDigest !== subject.digest) return false;
    if (!("state" in link.target) || link.target.state.commitObjectId !== accepted.commitObjectId) return false;
    if (!link.captureBlobId || !captureReadable(link)) return false;
    return evidence.some(
      (record) =>
        record.repositoryLinkId === link.linkId &&
        record.kind === "person_acceptance" &&
        record.role === "acceptance" &&
        record.outcome === "passed" &&
        record.origin.actor.kind === "person",
    );
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
  // The subject is the authority the criterion came from, at the exact
  // revision the plan read it at: a Design criterion is proven by a preview
  // accepted against *that* Design revision, never against an earlier one.
  const subject =
    criterion.authority === "design"
      ? { entityId: criterion.source.entityId, revisionId: criterion.source.revisionId, digest: criterion.source.digest }
      : { entityId: input.plan.task.entityId, revisionId: input.plan.task.revisionId, digest: input.plan.task.digest };
  const link = acceptedPreview(input.repositoryLinks, subject, input.evidence, input.captureReadable);
  if (!link) {
    return {
      criterionId: criterion.id,
      outcome: "needs_person",
      detail: `Nothing has been accepted as native visual evidence for ${criterion.source.key} at the revision this run checked.`,
      evidenceIds: [],
      steps: [
        `Open the checkpoint preview for this work and compare it with ${criterion.source.key}.`,
        "Accept it if it matches; accepting keeps the exact state where it can still be read and records it as verified_at, which is what native evidence is.",
      ],
    };
  }
  const state = "state" in link.target ? link.target.state : undefined;
  const evidenceIds = input.evidence.filter((record) => record.repositoryLinkId === link.linkId).map((record) => record.evidenceId);
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
