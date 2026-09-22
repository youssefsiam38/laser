/**
 * The three hard gates (M21-T8, D-332, leap "Lifecycle and gates").
 *
 * A gate is not a flag on a row: it is a question about a *set* of exact
 * revisions — is the brief the one that was read, does the design name the
 * profile it composed from, does the plan's task graph hold together — and an
 * approval records the answer as digests, so nobody can later claim a person
 * approved bytes they never saw.
 *
 * Four rules shape everything here:
 *
 * 1. **Gates bind only when chosen** (D-352). They apply to a Spec whose body
 *    carries `gated: true`, and to the Design and Plan that Spec's gates are
 *    decided on. Every other artifact in the project is ungated: it waits on
 *    nobody, and no surface nags it for a gate it never opted into.
 * 2. **An approval covers the complete digest set** of its gate's required
 *    revisions, and each one must still be exactly what the store holds. A
 *    missing, moved, stale or unsettled input refuses the decision with a
 *    sentence naming the key.
 * 3. **A blocking comment stops an approval**, on the subject or on anything
 *    the decision covers, and the refusal names the comments so a person can
 *    go and answer them rather than hunt for them.
 * 4. **Only a person approves.** That is enforced one layer down by
 *    `artifactTransition`; this module never sees an actor it can trust,
 *    because the actor kind comes from the *source* of the call (M21-T3).
 *
 * Everything here reads: it computes a report and answers yes or no. The
 * writing — the approval row, the state move, the cascade — stays in the
 * store, which is the only thing with a transaction.
 */
import {
  GATE_OUTCOMES,
  designIsSketchOnly,
  gateDecisionAllowed,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalMode,
  type ApprovedRevision,
  type BlockingCommentRef,
  type GateReport,
  type GateRequirementReport,
  type GateRole,
  type GateState,
  type GateStatusReport,
  type GateSubject,
  type PlanGraphReport,
  type ProjectWorkApproval,
  type ProjectWorkBody,
  type ProjectWorkKind,
  type ProjectWorkState,
} from "@lasercode/protocol";

/** One entity, as a gate needs to see it. The store's row, narrowed. */
export interface GateEntity {
  entityId: string;
  kind: ProjectWorkKind;
  key: string;
  title: string;
  state: ProjectWorkState;
  currentRevisionId: string;
  currentDigest: string;
  archived: boolean;
  blockingComments: number;
}

/**
 * What the engine reads. The store implements it over its own rows; a test can
 * implement it over three arrays.
 */
export interface GateReader {
  entity(projectId: string, entityId: string): GateEntity | undefined;
  body(projectId: string, revisionId: string): ProjectWorkBody | undefined;
  /** Everything joined to this entity by an edge, in either direction. */
  neighbours(projectId: string, entityId: string): GateEntity[];
  /** Every approval recorded on this entity, oldest first. */
  approvals(projectId: string, entityId: string): ProjectWorkApproval[];
  /** The open blocking comments on this entity, oldest first. */
  blockingComments(projectId: string, entityId: string): BlockingCommentRef[];
  /** The Plan's task graph, as M21-T15 computes it. */
  planGraph(projectId: string, planEntityId: string): PlanGraphReport | undefined;
}

/** The order a person meets the gates in. */
export const GATE_ORDER: readonly ApprovalGate[] = ["brief", "design", "build"];

export interface GateDecisionRequest {
  gate: ApprovalGate;
  decision: ApprovalDecision;
  mode?: ApprovalMode | undefined;
  covers: readonly ApprovedRevision[];
  skipReason?: string | undefined;
}

/**
 * The answer to "may this decision be recorded?".
 *
 * `report` is present only when the decision is a **gate** decision — that is,
 * when the Spec it belongs to is on the gated path. Off that path a decision
 * is still a durable, person-only record of what someone approved, with its
 * digests checked; it simply has no gate to satisfy, because the Spec never
 * opted into one (D-352, leap "Gates only when chosen").
 */
export type GateCheck = { ok: true; report?: GateReport } | { ok: false; reason: string };

const coveredOf = (entity: GateEntity): ApprovedRevision => ({
  entityId: entity.entityId,
  kind: entity.kind,
  key: entity.key,
  revisionId: entity.currentRevisionId,
  digest: entity.currentDigest,
});

const subjectOf = (entity: GateEntity): GateSubject => ({
  entityId: entity.entityId,
  kind: entity.kind,
  key: entity.key,
  title: entity.title,
  revisionId: entity.currentRevisionId,
  digest: entity.currentDigest,
  state: entity.state,
});

/** A decision that settled a gate and has not been invalidated since. */
function settledApproval(approvals: readonly ProjectWorkApproval[], gate: ApprovalGate): ProjectWorkApproval | undefined {
  return [...approvals].reverse().find((approval) => approval.gate === gate && approval.invalidatedAt === undefined);
}

function latestApproval(approvals: readonly ProjectWorkApproval[], gate: ApprovalGate): ProjectWorkApproval | undefined {
  return [...approvals].reverse().find((approval) => approval.gate === gate);
}

export class GateEngine {
  // A declared field and an assignment, not a parameter property: this file is
  // loaded by Node's type stripping in the crash fixture, which cannot rewrite
  // one (`test/project-work/crash-fixture.ts`).
  private readonly reader: GateReader;

  constructor(reader: GateReader) {
    this.reader = reader;
  }

  /**
   * The Spec whose lifecycle this entity's gates belong to.
   *
   * A Spec is its own. A Design or a Plan borrows the Spec it is linked to —
   * along an edge that exists, in either direction, because the relation
   * between a Spec and its Design is written from whichever end the person
   * happened to link from (D-352). With no linked Spec there is no gate,
   * which is the normal case for a standalone Design or Plan.
   */
  specFor(projectId: string, entity: GateEntity): GateEntity | undefined {
    if (entity.kind === "spec") return entity;
    if (entity.kind !== "design" && entity.kind !== "plan") return undefined;
    const specs = this.reader.neighbours(projectId, entity.entityId).filter((candidate) => candidate.kind === "spec");
    return pick(specs);
  }

  /** Where all three gates of one Spec stand. `undefined` if it is not a Spec. */
  report(projectId: string, spec: GateEntity): GateReport | undefined {
    if (spec.kind !== "spec") return undefined;
    const body = this.reader.body(projectId, spec.currentRevisionId);
    const gated = body?.kind === "spec" && body.spec.gated === true;
    const neighbours = this.reader.neighbours(projectId, spec.entityId);
    const design = pick(neighbours.filter((candidate) => candidate.kind === "design"));
    const plan = pick(neighbours.filter((candidate) => candidate.kind === "plan"));
    const specApprovals = this.reader.approvals(projectId, spec.entityId);

    const gates: GateStatusReport[] = [
      this.brief({ projectId, spec, body, gated, approvals: specApprovals }),
      this.design({ projectId, spec, design, gated, specApprovals }),
      this.build({ projectId, spec, body, design, plan, gated, specApprovals }),
    ];
    const next = GATE_ORDER.find((gate) => {
      const status = gates.find((candidate) => candidate.gate === gate);
      return status !== undefined && (status.state === "ready" || status.state === "waiting" || status.state === "invalidated");
    });
    return {
      specEntityId: spec.entityId,
      specKey: spec.key,
      gated,
      ...(next ? { next } : {}),
      gates,
    };
  }

  /**
   * May this decision be recorded?
   *
   * The subject is the entity the decision is written on — the Spec for the
   * brief, the Design for the design gate (or the Spec, when the gate is being
   * skipped for a spec with no UI impact), the Plan for the build.
   */
  check(projectId: string, subject: GateEntity, request: GateDecisionRequest): GateCheck {
    const spec = this.specFor(projectId, subject);
    const report = spec ? this.report(projectId, spec) : undefined;
    // Off the gated path there is nothing to bind: the decision is recorded as
    // what it is — a person's approval of exact digests — and the three hard
    // gates stay out of the way of work that never asked for them. The one
    // rule that still holds is that a permission mode means nothing outside a
    // build approval, so carrying one there is a mistake, not a detail.
    if (!spec || !report || !report.gated) {
      if (request.mode !== undefined && !(request.gate === "build" && request.decision === "approved")) {
        return { ok: false, reason: "A permission mode belongs to approving the build, and to nothing else." };
      }
      return { ok: true };
    }

    const legal = gateDecisionAllowed({ gate: request.gate, decision: request.decision, ...(request.mode !== undefined ? { mode: request.mode } : {}) });
    if (!legal.ok) return { ok: false, reason: legal.reason };
    const status = report.gates.find((candidate) => candidate.gate === request.gate);
    if (!status) return { ok: false, reason: `There is no ${request.gate} gate on ${spec.key}.` };

    const skipping = request.gate === "design" && request.skipReason !== undefined && request.skipReason.trim().length > 0;
    const expectedSubject = skipping ? spec : status.subject;
    if (!expectedSubject) {
      return { ok: false, reason: refusalOf(status) ?? `The ${request.gate} gate has nothing to decide on yet.` };
    }
    if (expectedSubject.entityId !== subject.entityId) {
      return { ok: false, reason: `The ${request.gate} gate is decided on ${expectedSubject.key}, not on ${subject.key}.` };
    }

    const outcome = GATE_OUTCOMES[request.gate].find(
      (candidate) => candidate.decision === request.decision && (candidate.mode ?? undefined) === (request.mode ?? undefined),
    );
    // A change request and an archive settle nothing and cover nothing but the
    // subject: they ask for a revision, and a revision is never the approved
    // bytes being edited (leap, "Lifecycle and gates").
    if (outcome?.approves !== true) {
      const covered = request.covers.some((candidate) => candidate.entityId === subject.entityId && candidate.revisionId === subject.currentRevisionId);
      if (!covered) {
        return { ok: false, reason: `${subject.key} moved while this was being written. Open it again before deciding.` };
      }
      return { ok: true, report };
    }

    if (skipping) {
      // Skipping the design gate needs a reason, and nothing else: there is no
      // design to bind, so the record is the reason plus the spec it belongs to.
      const covered = request.covers.some((candidate) => candidate.entityId === spec.entityId && candidate.revisionId === spec.currentRevisionId);
      if (!covered) return { ok: false, reason: `${spec.key} moved while this was being written. Open it again before deciding.` };
      const brief = report.gates.find((candidate) => candidate.gate === "brief");
      if (brief?.state !== "approved") return { ok: false, reason: "Approve the brief before deciding what happens to the design." };
      const blocking = status.blockingComments;
      if (blocking.length > 0) return { ok: false, reason: blockingSentence(blocking) };
      return { ok: true, report };
    }

    const unmet = status.requirements.find((requirement) => !requirement.satisfied);
    if (unmet) return { ok: false, reason: unmet.detail };
    if (status.blockingComments.length > 0) return { ok: false, reason: blockingSentence(status.blockingComments) };

    for (const required of status.covers) {
      const covered = request.covers.find((candidate) => candidate.entityId === required.entityId);
      if (!covered) {
        return { ok: false, reason: `This decision has to cover ${required.key} at the revision you read. Open the gate again and approve from there.` };
      }
      if (covered.revisionId !== required.revisionId || covered.digest !== required.digest) {
        return { ok: false, reason: `${required.key} changed since this was prepared. Open it again before approving.` };
      }
    }
    return { ok: true, report };
  }

  // ------------------------------------------------------------------- gates

  private brief(input: { projectId: string; spec: GateEntity; body: ProjectWorkBody | undefined; gated: boolean; approvals: ProjectWorkApproval[] }): GateStatusReport {
    const { spec, body, gated, approvals } = input;
    const requirements: GateRequirementReport[] = [];
    const brief = body?.kind === "spec" ? body.spec.brief.trim() : "";
    if (spec.archived) {
      requirements.push({
        role: "spec_brief",
        satisfied: false,
        problem: "unavailable",
        detail: `${spec.key} is archived. Restore it before deciding its brief.`,
      });
    } else if (brief.length === 0) {
      requirements.push({
        role: "spec_brief",
        satisfied: false,
        problem: "missing",
        detail: `${spec.key} has no brief yet. Write what this is, in a few sentences, before asking for a decision.`,
      });
    } else {
      requirements.push({ role: "spec_brief", satisfied: true, covered: coveredOf(spec), detail: `${spec.key}'s brief, at the revision on screen.` });
    }
    return this.status({
      projectId: input.projectId,
      gate: "brief",
      gated,
      subject: spec,
      subjectRole: "spec_brief",
      requirements,
      covers: [coveredOf(spec)],
      approvals,
      commentSources: [spec],
    });
  }

  private design(input: { projectId: string; spec: GateEntity; design: GateEntity | undefined; gated: boolean; specApprovals: ProjectWorkApproval[] }): GateStatusReport {
    const { projectId, spec, design, gated, specApprovals } = input;
    const requirements: GateRequirementReport[] = [];
    const briefApproval = settledApproval(specApprovals, "brief");
    if (briefApproval?.decision !== "approved") {
      requirements.push({
        role: "spec_brief",
        satisfied: false,
        problem: "gate_not_passed",
        detail: `Approve ${spec.key}'s brief before the design.`,
      });
    }
    // A design gate skipped for a spec with no UI impact is recorded on the
    // spec itself, so the reason survives with the lifecycle (D-332).
    const skip = [...specApprovals].reverse().find((approval) => approval.gate === "design" && approval.skipReason !== undefined && approval.invalidatedAt === undefined);
    if (skip) {
      requirements.push({ role: "design_skip", satisfied: true, detail: `No design was needed: ${skip.skipReason ?? ""}`.trim() });
      return this.status({
        projectId,
        gate: "design",
        gated,
        subject: spec,
        subjectRole: "design_skip",
        requirements,
        covers: [coveredOf(spec)],
        approvals: specApprovals,
        commentSources: [spec],
      });
    }
    if (!design) {
      requirements.push({
        role: "design",
        satisfied: false,
        problem: "missing",
        detail: `${spec.key} has no design linked to it. Link the design this gate covers, or record why this spec needs none.`,
      });
      return this.status({
        projectId,
        gate: "design",
        gated,
        subjectRole: "design",
        requirements,
        covers: [],
        approvals: this.reader.approvals(projectId, spec.entityId),
        commentSources: [spec],
      });
    }
    const body = this.reader.body(projectId, design.currentRevisionId);
    if (design.archived) {
      requirements.push({ role: "design", satisfied: false, problem: "unavailable", detail: `${design.key} is archived. Restore it before approving it.` });
    } else if (design.state === "stale") {
      requirements.push({ role: "design", satisfied: false, problem: "stale", detail: `${design.key} went stale when something it rests on changed. Reconcile it before approving.` });
    } else if (body?.kind === "design" && designIsSketchOnly(body.design)) {
      requirements.push({
        role: "design",
        satisfied: false,
        problem: "sketch_only",
        detail: `${design.key} is still sketches. Ground it into a tree before it can pass a gate.`,
      });
    } else {
      requirements.push({ role: "design", satisfied: true, covered: coveredOf(design), detail: `${design.key}, at the revision on screen.` });
    }
    const profileDigest = body?.kind === "design" ? body.design.designIndexRef?.profileDigest : undefined;
    const hasFoundation = body?.kind === "design" && body.design.foundation !== undefined;
    if (profileDigest === undefined && !hasFoundation) {
      requirements.push({
        role: "design_profile",
        satisfied: false,
        problem: "missing",
        detail: `${design.key} does not say which design profile it composed from. Review this project's design index, or record the foundation this design proposes.`,
      });
    } else {
      requirements.push({
        role: "design_profile",
        satisfied: true,
        detail: profileDigest !== undefined ? `Design profile ${profileDigest.slice(0, 12)}.` : `${design.key} proposes its own foundation.`,
      });
    }
    return this.status({
      projectId,
      gate: "design",
      gated,
      subject: design,
      subjectRole: "design",
      requirements,
      covers: [coveredOf(design)],
      approvals: this.reader.approvals(projectId, design.entityId),
      commentSources: [design, spec],
    });
  }

  private build(input: {
    projectId: string;
    spec: GateEntity;
    body: ProjectWorkBody | undefined;
    design: GateEntity | undefined;
    plan: GateEntity | undefined;
    gated: boolean;
    specApprovals: ProjectWorkApproval[];
  }): GateStatusReport {
    const { projectId, spec, body, design, plan, gated, specApprovals } = input;
    const requirements: GateRequirementReport[] = [];
    const covers: ApprovedRevision[] = [];

    const briefApproval = settledApproval(specApprovals, "brief");
    const form = body?.kind === "spec" ? body.spec.form : undefined;
    if (briefApproval?.decision !== "approved") {
      requirements.push({ role: "spec_full", satisfied: false, problem: "gate_not_passed", detail: `Approve ${spec.key}'s brief before the build.` });
    } else if (form !== "full") {
      requirements.push({
        role: "spec_full",
        satisfied: false,
        problem: "draft",
        detail: `${spec.key} is still a brief. Write the full spec — the agreed behaviour and its acceptance criteria — before the build gate.`,
      });
    } else {
      requirements.push({ role: "spec_full", satisfied: true, covered: coveredOf(spec), detail: `${spec.key}, the full spec at the revision on screen.` });
      covers.push(coveredOf(spec));
    }

    const skip = [...specApprovals].reverse().find((approval) => approval.gate === "design" && approval.skipReason !== undefined && approval.invalidatedAt === undefined);
    if (skip) {
      requirements.push({ role: "design_skip", satisfied: true, detail: `No design was needed: ${skip.skipReason ?? ""}`.trim() });
    } else if (!design) {
      requirements.push({
        role: "design",
        satisfied: false,
        problem: "missing",
        detail: `${spec.key} has no design and no recorded reason to skip one. The build gate needs one or the other.`,
      });
    } else {
      const designApproval = settledApproval(this.reader.approvals(projectId, design.entityId), "design");
      if (designApproval?.decision !== "approved") {
        requirements.push({ role: "design", satisfied: false, problem: "gate_not_passed", detail: `Approve ${design.key} at the design gate before the build.` });
      } else if (design.state === "stale") {
        requirements.push({ role: "design", satisfied: false, problem: "stale", detail: `${design.key} went stale after it was approved. Reconcile it and approve it again.` });
      } else {
        requirements.push({ role: "design", satisfied: true, covered: coveredOf(design), detail: `${design.key}, approved.` });
        covers.push(coveredOf(design));
      }
    }

    if (!plan) {
      requirements.push({
        role: "plan",
        satisfied: false,
        problem: "missing",
        detail: `${spec.key} has no plan linked to it. The build gate approves a plan and its tasks.`,
      });
    } else if (plan.archived) {
      requirements.push({ role: "plan", satisfied: false, problem: "unavailable", detail: `${plan.key} is archived. Restore it before approving the build.` });
    } else if (plan.state === "stale") {
      requirements.push({ role: "plan", satisfied: false, problem: "stale", detail: `${plan.key} went stale when something it rests on changed. Reconcile it before the build gate.` });
    } else {
      requirements.push({ role: "plan", satisfied: true, covered: coveredOf(plan), detail: `${plan.key}, at the revision on screen.` });
      covers.push(coveredOf(plan));
    }

    if (plan) {
      const graph = this.reader.planGraph(projectId, plan.entityId);
      const planBody = this.reader.body(projectId, plan.currentRevisionId);
      const taskKeys = planBody?.kind === "plan" ? planBody.plan.phases.flatMap((phase) => phase.taskKeys) : [];
      if (!graph || !graph.ok) {
        requirements.push({
          role: "task_graph",
          satisfied: false,
          problem: "incomplete_graph",
          detail: graph?.problems[0]?.message ?? `${plan.key}'s task graph does not hold together yet.`,
        });
      } else if (taskKeys.length === 0) {
        requirements.push({
          role: "task_graph",
          satisfied: false,
          problem: "incomplete_graph",
          detail: `${plan.key} lists no tasks. A build approval is an approval of the work it authorises.`,
        });
      } else {
        requirements.push({
          role: "task_graph",
          satisfied: true,
          detail: `${taskKeys.length} task${taskKeys.length === 1 ? "" : "s"} in ${plan.key}, in a graph that orders.`,
        });
      }
    }

    return this.status({
      projectId,
      gate: "build",
      gated,
      ...(plan ? { subject: plan } : {}),
      subjectRole: "plan",
      requirements,
      covers,
      approvals: plan ? this.reader.approvals(projectId, plan.entityId) : specApprovals,
      commentSources: [spec, ...(design ? [design] : []), ...(plan ? [plan] : [])],
    });
  }

  private status(input: {
    projectId: string;
    gate: ApprovalGate;
    gated: boolean;
    subject?: GateEntity | undefined;
    /** Which role the subject plays, for the "not sent for review" requirement. */
    subjectRole: GateRole;
    requirements: GateRequirementReport[];
    covers: ApprovedRevision[];
    approvals: ProjectWorkApproval[];
    commentSources: GateEntity[];
  }): GateStatusReport {
    // A draft is not up for decision yet. The spine's transition table says so
    // (`draft` cannot become `approved`), and the gate says *why* rather than
    // letting a person press Approve into a refusal: asking for the decision
    // is its own small, deliberate act.
    const requirements = [...input.requirements];
    if (input.gated && input.subject && input.subject.state === "draft" && requirements.every((requirement) => requirement.satisfied)) {
      requirements.push({
        role: input.subjectRole,
        satisfied: false,
        problem: "draft",
        detail: `${input.subject.key} has not been sent for review yet. Ask for a decision when it is ready.`,
      });
    }
    const blockingComments: BlockingCommentRef[] = [];
    const seen = new Set<string>();
    for (const source of input.commentSources) {
      for (const comment of this.reader.blockingComments(input.projectId, source.entityId)) {
        if (seen.has(comment.commentId)) continue;
        seen.add(comment.commentId);
        blockingComments.push(comment);
      }
    }
    const settled = settledApproval(input.approvals, input.gate);
    const latest = latestApproval(input.approvals, input.gate);
    const unmet = requirements.some((requirement) => !requirement.satisfied);
    const state: GateState = !input.gated
      ? "not_applicable"
      : settled?.decision === "approved"
        ? "approved"
        : settled?.decision === "archived"
          ? "archived"
          : latest?.invalidatedAt !== undefined
            ? "invalidated"
            : settled?.decision === "changes_requested"
              ? "changes_requested"
              : unmet || blockingComments.length > 0
                ? "waiting"
                : "ready";
    const status: GateStatusReport = {
      gate: input.gate,
      state,
      ...(input.subject ? { subject: subjectOf(input.subject) } : {}),
      requirements,
      covers: input.covers,
      outcomes: [...GATE_OUTCOMES[input.gate]],
      blockingComments,
      ...(latest ? { approval: latest } : {}),
    };
    const refusal = refusalOf(status);
    return refusal === undefined ? status : { ...status, refusal };
  }
}

/** Why this gate cannot be approved right now, in one sentence. */
function refusalOf(status: GateStatusReport): string | undefined {
  if (status.state === "not_applicable") return undefined;
  if (status.blockingComments.length > 0) return blockingSentence(status.blockingComments);
  const unmet = status.requirements.find((requirement) => !requirement.satisfied);
  if (unmet) return unmet.detail;
  if (!status.subject) return "There is nothing to decide on yet.";
  return undefined;
}

/** The refusal that names the comments, so a person can go and answer them. */
export function blockingSentence(comments: readonly BlockingCommentRef[]): string {
  const named = comments.slice(0, 5).map((comment) => `${comment.key} ${comment.commentId}`).join(", ");
  const rest = comments.length > 5 ? `, and ${comments.length - 5} more` : "";
  return `${comments.length} blocking comment${comments.length === 1 ? "" : "s"} must be resolved before this can be approved: ${named}${rest}.`;
}

/** The liveliest candidate of a kind: not archived if possible, newest key wins. */
function pick(candidates: readonly GateEntity[]): GateEntity | undefined {
  const live = candidates.filter((candidate) => !candidate.archived);
  const pool = live.length > 0 ? live : candidates;
  return [...pool].sort((a, b) => keyNumber(b.key) - keyNumber(a.key))[0];
}

function keyNumber(key: string): number {
  const dash = key.lastIndexOf("-");
  const parsed = dash === -1 ? Number.NaN : Number.parseInt(key.slice(dash + 1), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
