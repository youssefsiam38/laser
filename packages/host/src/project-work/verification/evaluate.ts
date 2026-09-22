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
 * 3. **An accepted checkpoint preview, in every repository the work touched.**
 *    Native visual evidence exists only at Build, as a `verified_at` link a
 *    person made from an M20 checkpoint preview (D-353), and it is per
 *    repository (D-367): a workspace of two repositories needs two accepted
 *    previews, because accepting one build says nothing about the other's
 *    change. Until they are all there, the criterion is `needs_person` naming
 *    the ones that are not — never "probably fine".
 * 4. **Nobody.** A design state, a token, a boundary or a migration is
 *    `not_machine_verifiable`: the report names what to read instead of
 *    inventing a check for it.
 */
import {
  ATTEMPT_REPOSITORIES_MAX,
  convergenceOf,
  machineDecidable,
  type ExecutionLink,
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
  /**
   * The Task's attempts, for the repositories a visual criterion has to have
   * an accepted preview in (D-367).
   *
   * The work under verification is the Task's latest attempt that recorded
   * repositories, and every repository it recorded a state in needs its own
   * accepted preview. A repository the attempt could not read is not one a
   * person can be asked to review, so it is left out by the caller.
   */
  attempts?: readonly ExecutionLink[];
  /** A repository's name, for a sentence that says which one to look at. */
  repositoryName?: (repositoryId: string) => string | undefined;
  /** Every evidence record on those subjects, for the acceptance join. */
  evidence: readonly ProjectWorkEvidence[];
  /** Whether a link's stored capture is still readable. Never a git read. */
  captureReadable: (link: RepositoryLink) => boolean;
  /**
   * Whether a link's stored capture holds **every** source the decision it
   * backs rests on, checked against the bodies beside it (M21-T19).
   *
   * Still only the store: the capture is parsed, its required block is matched
   * against its own sources by path, side and digest, and the digest is taken
   * again over the text that is there. A capture taken before this rule
   * existed has no such block, and so is not native evidence — which is the
   * honest answer, not a downgrade.
   */
  captureComplete: (link: RepositoryLink) => boolean;
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
 * Six stored facts, and all six have to hold:
 *
 * 1. the link is a `verified_at` **state** on this exact subject — same
 *    entity, same revision, same digest, so a revision the work has moved on
 *    to cannot inherit a preview nobody looked at;
 * 2. a **person** created it;
 * 3. the host's own `acceptance` record is on it, which only the host writes,
 *    and it agrees with the link about the commit and the subject's digest;
 * 4. the bounded canonical capture is there and still readable;
 * 5. that capture holds every source the acceptance rests on, whole, at the
 *    digests and sides it records — not merely a flag saying so;
 * 6. a `person_acceptance` evidence record that passed is joined to it.
 */
export function acceptedPreview(
  links: readonly RepositoryLink[],
  subject: { entityId: string; revisionId: string; digest: string },
  evidence: readonly ProjectWorkEvidence[],
  captureReadable: (link: RepositoryLink) => boolean,
  captureComplete: (link: RepositoryLink) => boolean,
): RepositoryLink | undefined {
  return links.find((link) => provesSubject(link, subject, evidence, captureReadable, captureComplete));
}

/**
 * The accepted preview **per repository** (D-367).
 *
 * One repository's acceptance never speaks for another: a person who opened
 * the build of one repository and never looked at the other's change has
 * reviewed one of them, and the report has to say so. So the previews are
 * gathered by the repository they were accepted in, and the criterion is
 * decided against the repositories the work actually touched.
 *
 * The first accepted link per repository wins; links are stored oldest first,
 * and a superseding acceptance is a new link on a new revision, which this
 * subject match already excludes.
 */
export function acceptedPreviews(
  links: readonly RepositoryLink[],
  subject: { entityId: string; revisionId: string; digest: string },
  evidence: readonly ProjectWorkEvidence[],
  captureReadable: (link: RepositoryLink) => boolean,
  captureComplete: (link: RepositoryLink) => boolean,
): Map<string, RepositoryLink> {
  const byRepository = new Map<string, RepositoryLink>();
  for (const link of links) {
    if (byRepository.has(link.repositoryId)) continue;
    if (provesSubject(link, subject, evidence, captureReadable, captureComplete)) byRepository.set(link.repositoryId, link);
  }
  return byRepository;
}

/** The six stored facts, for one link. */
function provesSubject(
  link: RepositoryLink,
  subject: { entityId: string; revisionId: string; digest: string },
  evidence: readonly ProjectWorkEvidence[],
  captureReadable: (link: RepositoryLink) => boolean,
  captureComplete: (link: RepositoryLink) => boolean,
): boolean {
  if (link.relation !== "verified_at") return false;
  if (link.createdBy.kind !== "person") return false;
  if (link.subject.entityId !== subject.entityId) return false;
  if (link.subject.revisionId !== subject.revisionId || link.subject.digest !== subject.digest) return false;
  const accepted = link.acceptance;
  if (!accepted || accepted.kind !== "checkpoint_preview") return false;
  if (accepted.subjectDigest !== subject.digest) return false;
  if (!("state" in link.target) || link.target.state.commitObjectId !== accepted.commitObjectId) return false;
  // Readable and complete are both asked of the blob the **acceptance** was
  // bound to, never of the link's pointer of the day (D-363, review O2): the
  // two checks read one proof, so no later correction or release policy can
  // make them answer about different bytes.
  if (!captureReadable(link)) return false;
  if (!captureComplete(link)) return false;
  return evidence.some(
    (record) =>
      record.repositoryLinkId === link.linkId &&
      record.kind === "person_acceptance" &&
      record.role === "acceptance" &&
      record.outcome === "passed" &&
      record.origin.actor.kind === "person",
  );
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

/** How many repositories one sentence names before it counts the rest. */
const REPOSITORIES_NAMED_MAX = 4;
/** How many evidence records one finding carries (the report's own bound). */
const FINDING_EVIDENCE_MAX = 32;

/**
 * Native visual evidence: an accepted M20 checkpoint preview (D-353), in
 * **every** repository the work touched (D-367).
 *
 * The Design phase never runs the project, so there is no capture to compare
 * against and nothing an agent can produce. What exists is a preview the
 * person accepted, recorded as a `verified_at` link from the exact commit —
 * and until that link is there, for each repository, this is the person's to
 * settle. A workspace of two repositories is two builds and two changes: the
 * one a person opened is reviewed, and the one they never opened is not,
 * whatever the other says.
 */
function visualFinding(criterion: VerificationCriterion, input: EvaluationInput): VerificationFinding {
  // The subject is the authority the criterion came from, at the exact
  // revision the plan read it at: a Design criterion is proven by a preview
  // accepted against *that* Design revision, never against an earlier one.
  const subject =
    criterion.authority === "design"
      ? { entityId: criterion.source.entityId, revisionId: criterion.source.revisionId, digest: criterion.source.digest }
      : { entityId: input.plan.task.entityId, revisionId: input.plan.task.revisionId, digest: input.plan.task.digest };
  const accepted = acceptedPreviews(input.repositoryLinks, subject, input.evidence, input.captureReadable, input.captureComplete);
  const expected = expectedRepositories(input, subject);
  const missing = expected.filter((repositoryId) => !accepted.has(repositoryId));
  if (accepted.size === 0 || missing.length > 0) {
    return unreviewed(criterion, input, subject, accepted, missing, expected.length);
  }
  const links = expected.map((repositoryId) => accepted.get(repositoryId)!);
  const linkIds = new Set(links.map((link) => link.linkId));
  const evidenceIds = input.evidence
    .filter((record) => record.repositoryLinkId !== undefined && linkIds.has(record.repositoryLinkId))
    .map((record) => record.evidenceId)
    .slice(0, FINDING_EVIDENCE_MAX);
  // Bounded like every other sentence here: four of them are named, and a
  // workspace with more says how many more rather than growing without end.
  const named = links.slice(0, REPOSITORIES_NAMED_MAX).map((link) => {
    const state = "state" in link.target ? link.target.state : undefined;
    const commit = state?.commitObjectId.slice(0, 10) ?? "the recorded commit";
    const name = repositoryNameOf(input, link.repositoryId);
    return name === undefined ? commit : `${commit} in ${name}`;
  });
  const rest = links.length - named.length;
  const where = rest > 0 ? `${named.join(", ")} and ${String(rest)} more` : named.join(" and ");
  return {
    criterionId: criterion.id,
    outcome: "satisfied",
    detail:
      links.length === 1
        ? `You accepted the checkpoint preview at ${where}, linked verified_at to ${criterion.source.key}.`
        : `You accepted a checkpoint preview in each of the ${String(links.length)} repositories this work touched: ${where}, linked verified_at to ${criterion.source.key}.`,
    evidenceIds,
    repositoryLinkId: links[0]!.linkId,
    ...(links.length > 1 ? { repositoryLinkIds: links.slice(0, ATTEMPT_REPOSITORIES_MAX).map((link) => link.linkId) } : {}),
  };
}

/**
 * The repositories a visual criterion needs an accepted preview in (D-367).
 *
 * The work under verification is the Task's own attempt, and what it recorded
 * per repository is what a person has to have reviewed. When no attempt was
 * recorded at all — an older Task, or work done outside an attempt — the
 * honest stand-in is every repository that already carries a `verified_at`
 * state link for this exact subject: it never invents a repository nobody
 * linked, and it still refuses to let one of two acceptances answer for both.
 */
function expectedRepositories(input: EvaluationInput, subject: { entityId: string; revisionId: string }): string[] {
  const attempt = latestAttempt(input.attempts ?? []);
  if (attempt) return [...new Set(attempt.repositories!.map((record) => record.repositoryId))];
  const linked = new Set<string>();
  for (const link of input.repositoryLinks) {
    if (link.relation !== "verified_at" || !("state" in link.target)) continue;
    if (link.subject.entityId !== subject.entityId || link.subject.revisionId !== subject.revisionId) continue;
    linked.add(link.repositoryId);
  }
  return [...linked];
}

/**
 * The attempt whose work this run is verifying: the newest one that recorded
 * repositories at all. Attempt numbers are the Task's own counter, so the
 * highest is the latest; an attempt that recorded nothing readable says
 * nothing about which repositories were touched.
 */
function latestAttempt(attempts: readonly ExecutionLink[]): ExecutionLink | undefined {
  let latest: ExecutionLink | undefined;
  for (const attempt of attempts) {
    if (!attempt.repositories || attempt.repositories.length === 0) continue;
    if (!latest || attempt.attempt > latest.attempt) latest = attempt;
  }
  return latest;
}

function repositoryNameOf(input: EvaluationInput, repositoryId: string): string | undefined {
  const named = input.repositoryName?.(repositoryId);
  if (named !== undefined && named !== "") return named;
  for (const attempt of input.attempts ?? []) {
    const record = attempt.repositories?.find((row) => row.repositoryId === repositoryId);
    if (record?.name) return record.name;
  }
  return undefined;
}

/** The names of some repositories, for one sentence, bounded. */
function nameList(input: EvaluationInput, repositoryIds: readonly string[]): string {
  const names = repositoryIds.slice(0, REPOSITORIES_NAMED_MAX).map((id) => repositoryNameOf(input, id) ?? "another repository");
  const rest = repositoryIds.length - names.length;
  const listed = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
  return rest > 0 ? `${listed} and ${String(rest)} more` : listed;
}

/**
 * What the report says while a visual criterion is still the person's.
 *
 * Three different truths, and they are not interchangeable: nobody has
 * accepted anything; somebody accepted a review that did not keep every file
 * it rests on; or some repositories are reviewed and the rest are not. The
 * last one names the ones that are not, because "it needs a review" in a
 * two-repository workspace is precisely the sentence that let one acceptance
 * pass for two.
 */
function unreviewed(
  criterion: VerificationCriterion,
  input: EvaluationInput,
  subject: { entityId: string; revisionId: string; digest: string },
  accepted: ReadonlyMap<string, RepositoryLink>,
  missing: readonly string[],
  expected: number,
): VerificationFinding {
  // A review recorded before this rule existed kept a bounded capture rather
  // than every source the decision rests on — or kept one this store can no
  // longer attribute to that acceptance at all. Nothing of it is erased or
  // rewritten; it simply does not prove what native evidence has to prove,
  // and the step is to record the review again (M21-T19). Said of the
  // repositories that are still unreviewed, so a workspace where one
  // repository's review is whole and another's is not says which is which.
  const partial = input.repositoryLinks.some(
    (candidate) =>
      candidate.relation === "verified_at" &&
      candidate.acceptance?.kind === "checkpoint_preview" &&
      candidate.subject.entityId === subject.entityId &&
      candidate.subject.revisionId === subject.revisionId &&
      (missing.length === 0 || missing.includes(candidate.repositoryId)) &&
      candidate.captureBlobId !== undefined &&
      !input.captureComplete(candidate),
  );
  const named = missing.length > 0 ? nameList(input, missing) : undefined;
  const some = accepted.size > 0 && missing.length > 0;
  const detail = partial
    ? some
      ? `The review recorded for ${criterion.source.key} in ${named!} did not keep every file it rests on, so it cannot be read back as proof of this revision.`
      : `The review recorded for ${criterion.source.key} did not keep every file it rests on, so it cannot be read back as proof of this revision.`
    : some
      ? `${nameList(input, [...accepted.keys()])} has an accepted preview, but ${named!} ${missing.length === 1 ? "does" : "do"} not, and one repository's review does not speak for another.`
      : expected > 1
        ? `Nothing has been accepted as native visual evidence for ${criterion.source.key} at the revision this run checked. This work touched ${String(expected)} repositories, and each needs its own accepted preview.`
        : `Nothing has been accepted as native visual evidence for ${criterion.source.key} at the revision this run checked.`;
  const steps =
    missing.length > 0 && expected > 1
      ? [
          ...missing
            .slice(0, 10)
            .map(
              (repositoryId) =>
                `Open the checkpoint preview for this work in ${repositoryNameOf(input, repositoryId) ?? "the repository that has none"} and compare it with ${criterion.source.key}.`,
            ),
          "Accept each one that matches; accepting keeps the exact state where it can still be read and records it as verified_at, which is what native evidence is.",
        ]
      : [
          `Open the checkpoint preview for this work and compare it with ${criterion.source.key}.`,
          "Accept it if it matches; accepting keeps the exact state where it can still be read and records it as verified_at, which is what native evidence is.",
        ];
  return {
    criterionId: criterion.id,
    outcome: "needs_person",
    detail,
    evidenceIds: [],
    ...(accepted.size > 0
      ? {
          repositoryLinkId: [...accepted.values()][0]!.linkId,
          ...(accepted.size > 1
            ? { repositoryLinkIds: [...accepted.values()].slice(0, ATTEMPT_REPOSITORIES_MAX).map((link) => link.linkId) }
            : {}),
        }
      : {}),
    steps,
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
