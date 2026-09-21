/**
 * M21-T19 · the rules a verification run cannot bend.
 *
 * Everything here is pure: what counts as decidable by a machine, what
 * convergence means, and the steps a browser-matrix cell hands a person. They
 * live in the protocol because the host decides with them and the worker and
 * the UI read them, and a second copy of "converged" would be a second answer.
 */
import { describe, expect, it } from "vitest";
import {
  VERIFICATION_REPORT_MEDIA_TYPE,
  browserMatrixSteps,
  convergenceOf,
  machineDecidable,
  verificationReportSchema,
  verificationRunLine,
  verificationSummary,
  type VerificationCriterion,
  type VerificationFinding,
  type VerificationReport,
  type VerificationSourceRef,
} from "../src/index.js";

const source: VerificationSourceRef = {
  authority: "task",
  entityId: "ent_1",
  kind: "task",
  key: "TASK-1",
  revisionId: "rev_1",
  digest: "a".repeat(64),
  title: "Failed rows say why",
};

function criterion(over: Partial<VerificationCriterion> & { id: string }): VerificationCriterion {
  return {
    authority: "task",
    kind: "command",
    text: "it passes",
    required: true,
    machineVerifiable: true,
    source,
    ...over,
  };
}

function finding(criterionId: string, outcome: VerificationFinding["outcome"]): VerificationFinding {
  return { criterionId, outcome, detail: "because", evidenceIds: [] };
}

describe("what a machine may decide", () => {
  it("counts a criterion with a bound command, and a review the store settles", () => {
    expect(machineDecidable(criterion({ id: "c1", command: "pnpm test" }))).toBe(true);
    expect(machineDecidable(criterion({ id: "c2", kind: "review", machineVerifiable: true }))).toBe(true);
  });

  it("never counts a visual or a browser-matrix criterion, whatever it declares", () => {
    expect(machineDecidable(criterion({ id: "c3", kind: "visual", machineVerifiable: true, command: "open it" }))).toBe(false);
    expect(machineDecidable(criterion({ id: "c4", kind: "browser_matrix", machineVerifiable: true }))).toBe(false);
  });

  it("does not count a criterion that says it is checkable and binds no command", () => {
    expect(machineDecidable(criterion({ id: "c5", kind: "acceptance", machineVerifiable: true }))).toBe(false);
  });
});

describe("convergence", () => {
  it("converges when every required decidable criterion passed and nothing blocks", () => {
    const criteria = [criterion({ id: "c1", command: "pnpm test" }), criterion({ id: "c2", kind: "design_state", machineVerifiable: false })];
    const outcome = convergenceOf({
      criteria,
      findings: [finding("c1", "satisfied"), finding("c2", "not_machine_verifiable")],
      blockers: [],
    });
    expect(outcome.converged, "what only a person can judge does not stand in the way of needs review").toBe(true);
    expect(outcome.outcome).toBe("converged");
  });

  it("does not converge on a failure, and names the criterion", () => {
    const criteria = [criterion({ id: "c1", command: "pnpm test", text: "the exports pass" })];
    const outcome = convergenceOf({ criteria, findings: [finding("c1", "failed")], blockers: [] });
    expect(outcome.converged).toBe(false);
    expect(outcome.outcome).toBe("failed");
    expect(outcome.reasons.join(" ")).toContain("the exports pass");
  });

  it("does not converge while a blocker remains, however well the commands did", () => {
    const criteria = [criterion({ id: "c1", command: "pnpm test" })];
    const outcome = convergenceOf({
      criteria,
      findings: [finding("c1", "satisfied")],
      blockers: [{ kind: "blocking_comment", detail: "TASK-1 has a blocking comment nobody has resolved." }],
    });
    expect(outcome.converged).toBe(false);
    expect(outcome.outcome).toBe("blocked");
  });

  it("does not converge on a criterion nothing checked, and says it was never checked", () => {
    const criteria = [criterion({ id: "c1", command: "pnpm test", text: "the exports pass" })];
    const outcome = convergenceOf({ criteria, findings: [], blockers: [] });
    expect(outcome.converged).toBe(false);
    expect(outcome.reasons.join(" ")).toContain("never checked");
  });

  it("is stopped rather than blocked when a person stopped it", () => {
    const criteria = [criterion({ id: "c1", command: "pnpm test" })];
    const outcome = convergenceOf({ criteria, findings: [finding("c1", "satisfied")], blockers: [], stopped: true });
    expect(outcome.outcome).toBe("stopped");
    expect(outcome.converged).toBe(false);
  });
});

describe("what a person reads", () => {
  it("summarises in counts, never a percentage", () => {
    const report: Omit<VerificationReport, "summary"> = {
      version: 1,
      runId: "ver_0001",
      task: source,
      startedAt: "2026-03-01T09:00:00.000Z",
      endedAt: "2026-03-01T09:05:00.000Z",
      authorities: [source],
      criteria: [criterion({ id: "c1" }), criterion({ id: "c2" }), criterion({ id: "c3" })],
      commands: [],
      findings: [finding("c1", "satisfied"), finding("c2", "failed"), finding("c3", "needs_person")],
      deviations: [],
      blockers: [],
      personDecisions: [],
      converged: false,
      outcome: "failed",
      truncated: [],
    };
    const summary = verificationSummary(report);
    expect(summary).toContain("1 of 3 satisfied");
    expect(summary).toContain("1 failed");
    expect(summary).toContain("1 waiting on you");
    expect(summary).not.toContain("%");
    expect(verificationReportSchema.safeParse({ ...report, summary }).success, "the canonical report round-trips").toBe(true);
    expect(VERIFICATION_REPORT_MEDIA_TYPE).toContain("verification-report");
  });

  it("says which command is running, and how many there are, with no estimate", () => {
    const line = verificationRunLine({
      runId: "ver_0001",
      taskKey: "TASK-1",
      entityId: "ent_1",
      phase: "running",
      startedAt: "2026-03-01T09:00:00.000Z",
      currentCommand: "pnpm -F exports test",
      commandsRun: 1,
      commandsTotal: 3,
      criteriaTotal: 9,
    });
    expect(line).toBe("pnpm -F exports test — command 2 of 3");
  });

  it("hands a browser-matrix cell the exact walk, because an agent never walks one", () => {
    const steps = browserMatrixSteps({ screen: "Export list", theme: "dark", width: "narrow", pointer: "coarse" });
    expect(steps[0]).toBe("Open Export list in the dark theme, at narrow, with a coarse pointer.");
    expect(steps.join(" ")).toContain("does not scroll sideways");
    expect(steps).toHaveLength(3);
  });
});
