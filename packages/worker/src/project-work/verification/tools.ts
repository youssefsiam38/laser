/**
 * `verify_project_task` — the model's door to a verification run (M21-T19,
 * under `docs/agent-tool-contract.md`, D-350).
 *
 * The tool is deliberately thin, and its description says the three things a
 * model gets wrong otherwise:
 *
 * - it **runs the task's own declared commands**, not commands the model
 *   chooses, so there is no command argument to pass;
 * - it **decides nothing**: the report comes back with each criterion's
 *   outcome as the app worked it out, including the ones only a person can
 *   settle;
 * - it **never marks a task done**, and it never opens a browser — a declared
 *   browser matrix comes back as steps for the person.
 */
import {
  type LaserToolSpec,
  type ProjectWorkGetResult,
  type VerificationCriterion,
  type VerificationDeviation,
  type VerificationFinding,
  type VerificationReport,
  type VerificationRunState,
} from "@lasercode/protocol";
import { refuseProjectWork, type ProjectWorkBridge } from "../bridge.js";
import type { VerificationService } from "./service.js";

const ID_MAX = 64;
/** How many findings one answer lists before it says how many it left out. */
export const VERIFY_FINDINGS_MAX = 25;

export const VERIFY_PROJECT_TASK_SPEC: LaserToolSpec = {
  name: "verify_project_task",
  description:
    "Verify a project task against everything it is answerable to: the spec's acceptance criteria, the design's states and token and component usage, the plan's boundaries, security, accessibility and migration requirements, and the task's own commands, diffs and reviews. " +
    "It runs the task's own declared verification commands in this project's checkout — you do not choose them and there is nothing to pass — records the exit codes, and answers with each criterion as satisfied, failed, waiting on a person, or not checkable by a command. " +
    "Anything that needs a person comes back with the exact steps for them, including a declared browser matrix, which you never check yourself. " +
    "Visual evidence counts only when the person has accepted a checkpoint preview. " +
    "A run that satisfies everything it can decide, with nothing blocking, moves the task to needs review; nothing here ever marks a task done.",
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      key: { type: "string", description: "The task, by key, like TASK-7.", maxLength: 40 },
      entity_id: { type: "string", description: "The task, by opaque id, when you have it instead of a key.", maxLength: ID_MAX },
      deviation_reason: {
        type: "string",
        description: "Why the implementation deviates from what an upstream artifact says, when it does. Recorded as a proposal for the person.",
        maxLength: 2000,
      },
      deviation_upstream_key: { type: "string", description: "The upstream artifact the deviation is about, by key, like SPEC-2.", maxLength: 40 },
      deviation_proposal: { type: "string", description: "What that artifact would have to say instead, in one or two sentences.", maxLength: 2000 },
    },
    required: [],
  },
  output: {
    type: "object",
    properties: {
      key: { type: "string", description: "The task that was verified." },
      run_id: { type: "string", description: "This run, for a person following it." },
      outcome: { type: "string", description: "converged, blocked, failed or stopped." },
      state: { type: "string", description: "The task's state after the run." },
      summary: { type: "string", description: "Counts: satisfied, failed, waiting on a person." },
      satisfied: { type: "integer", description: "How many criteria came out satisfied." },
      failed: { type: "array", description: "The criteria that failed, with what said so.", items: { type: "object", description: "One failed criterion." } },
      needs_person: { type: "array", description: "What only a person can settle, with the steps.", items: { type: "object", description: "One decision for a person." } },
      blockers: { type: "array", description: "What stops this converging: a blocking comment, a stale approval, a failed check.", items: { type: "object", description: "One blocker." } },
      commands: { type: "array", description: "Each declared command with its exit code.", items: { type: "object", description: "One command run." } },
      deviations: { type: "integer", description: "How many deviations were proposed for the person." },
      evidence_id: { type: "string", description: "The evidence record the report was stored as." },
      omitted: { type: "integer", description: "How many rows were left out of a truncated list." },
      note: { type: "string", description: "What happens next, in one sentence." },
    },
  },
  annotations: { readOnly: false, idempotent: false, destructive: false, external: false },
  label: "injected",
};

export interface VerifyProjectTaskInput {
  key?: string;
  entity_id?: string;
  deviation_reason?: string;
  deviation_upstream_key?: string;
  deviation_proposal?: string;
}

export interface VerifyProjectTaskDeps {
  bridge: ProjectWorkBridge;
  service: VerificationService;
  cwd: string;
  /**
   * The session this tool call is running in (M21-T19).
   *
   * A model's run belongs to the conversation that asked for it, and appears
   * in the fleet under it: the identity is the worker's, never the model's,
   * so a tool cannot claim to be running somewhere else.
   */
  sessionPath: () => string | undefined;
}

export async function verifyProjectTask(
  deps: VerifyProjectTaskDeps,
  input: VerifyProjectTaskInput,
): Promise<Record<string, unknown>> {
  if (deps.bridge.projectId() === undefined) {
    refuseProjectWork(
      "no_project",
      "This session is not working in a project, so it has no task to verify.",
      "ask the person to open this chat in the project the task belongs to",
    );
  }
  if (input.key === undefined && input.entity_id === undefined) {
    refuseProjectWork(
      "no_item",
      "Name the task to verify, by key (TASK-7) or by entity_id.",
      "call inspect_project_work with action list to see this project's tasks with their keys",
    );
  }
  if (input.deviation_reason !== undefined && input.deviation_upstream_key === undefined) {
    refuseProjectWork(
      "no_deviation_upstream",
      "A deviation says which upstream artifact it is about.",
      "call verify_project_task again with deviation_upstream_key set to the spec, design or plan the deviation is from",
    );
  }

  const deviations = await deviationsOf(deps, input);
  const sessionPath = deps.sessionPath();
  if (sessionPath === undefined) {
    refuseProjectWork(
      "no_session_identity",
      "This conversation has no identity yet, so a verification run started here could not be watched or stopped.",
      "carry on with the work and verify again on your next turn",
    );
  }
  let state: VerificationRunState;
  try {
    state = await deps.service.run({
      cwd: deps.cwd,
      sessionPath,
      ...(input.entity_id !== undefined ? { entityId: input.entity_id } : {}),
      ...(input.key !== undefined ? { key: input.key } : {}),
      ...(deviations.length > 0 ? { deviations } : {}),
    });
  } catch (error) {
    refuseProjectWork(
      "verification_failed",
      error instanceof Error ? error.message : "The verification run could not be started.",
      "call inspect_project_work on the task to read its state, then try again",
    );
  }
  if (state.phase === "failed" || !state.report) {
    refuseProjectWork(
      "verification_failed",
      state.problem ?? "The verification run could not finish.",
      "call inspect_project_work on the task to read its state and its evidence, then try again",
    );
  }
  return answerOf(state, state.report);
}

/**
 * The deviation a run proposes, resolved to the exact upstream revision.
 *
 * A deviation is a proposal about *something approved*, so it has to name the
 * revision it was written against: accepting it later revises that exact
 * revision, and a proposal about a revision that has since moved is one a
 * person can see has moved. Nothing here changes anything.
 */
async function deviationsOf(
  deps: VerifyProjectTaskDeps,
  input: VerifyProjectTaskInput,
): Promise<Array<Omit<VerificationDeviation, "state">>> {
  if (input.deviation_reason === undefined || input.deviation_upstream_key === undefined) return [];
  const projectId = deps.bridge.projectId()!;
  let upstream: ProjectWorkGetResult;
  try {
    upstream = (await deps.bridge.call("project/work/get", {
      projectId,
      key: input.deviation_upstream_key,
      body: { mode: "none" as const },
    })) as ProjectWorkGetResult;
  } catch {
    refuseProjectWork(
      "unknown_upstream",
      `${input.deviation_upstream_key} is not something this project has, so a deviation cannot be about it.`,
      "call inspect_project_work with action list to see this project's items, then name one of them",
    );
  }
  return [
    {
      id: `dev-${upstream.entity.key}`,
      reason: input.deviation_reason,
      proposal: input.deviation_proposal ?? input.deviation_reason,
      upstream: {
        entityId: upstream.entity.entityId,
        kind: upstream.entity.kind,
        key: upstream.entity.key,
        revisionId: upstream.revision.revisionId,
        digest: upstream.revision.digest,
      },
    },
  ];
}

function answerOf(state: VerificationRunState, report: VerificationReport): Record<string, unknown> {
  const byId = new Map(report.criteria.map((criterion) => [criterion.id, criterion]));
  const failed = report.findings.filter((finding) => finding.outcome === "failed");
  const satisfied = report.findings.filter((finding) => finding.outcome === "satisfied").length;
  const decisions = report.personDecisions.slice(0, VERIFY_FINDINGS_MAX);
  const omitted =
    Math.max(0, failed.length - VERIFY_FINDINGS_MAX) + Math.max(0, report.personDecisions.length - VERIFY_FINDINGS_MAX);
  return {
    key: report.task.key,
    run_id: state.runId,
    outcome: report.outcome,
    ...(state.taskState !== undefined ? { state: state.taskState } : {}),
    summary: report.summary,
    satisfied,
    ...(failed.length > 0 ? { failed: failed.slice(0, VERIFY_FINDINGS_MAX).map((finding) => failedRow(finding, byId)) } : {}),
    ...(decisions.length > 0
      ? { needs_person: decisions.map((decision) => ({ criterion: decision.question, steps: decision.steps })) }
      : {}),
    ...(report.blockers.length > 0
      ? { blockers: report.blockers.map((blocker) => ({ kind: blocker.kind, detail: blocker.detail, ...(blocker.key ? { key: blocker.key } : {}) })) }
      : {}),
    ...(report.commands.length > 0
      ? {
          commands: report.commands.map((command) => ({
            command: command.command,
            status: command.status,
            ...(command.exitCode !== undefined ? { exit_code: command.exitCode } : {}),
            output_bytes: command.outputBytes,
          })),
        }
      : {}),
    ...(report.deviations.length > 0 ? { deviations: report.deviations.length } : {}),
    ...(state.evidenceId !== undefined ? { evidence_id: state.evidenceId } : {}),
    ...(omitted > 0 ? { omitted } : {}),
    note: noteOf(report, state),
  };
}

function failedRow(finding: VerificationFinding, byId: Map<string, VerificationCriterion>): Record<string, unknown> {
  const criterion = byId.get(finding.criterionId);
  return {
    criterion: criterion?.text ?? finding.criterionId,
    from: criterion?.source.key ?? "",
    detail: finding.detail,
    ...(finding.commands ? { commands: finding.commands } : {}),
  };
}

function noteOf(report: VerificationReport, state: VerificationRunState): string {
  if (report.outcome === "converged") {
    return state.taskState === "needs_review"
      ? `${report.task.key} is with a person to review. Only they mark it done.`
      : `Everything this run could decide is satisfied. ${report.task.key} stays where it is; a person takes it from here.`;
  }
  if (report.outcome === "stopped") return "The run was stopped. What it proved is recorded; run it again to finish.";
  if (report.outcome === "failed") return "Fix what failed and verify again. A failed run is evidence, not a failed task.";
  return "Something still blocks this task. Deal with what the blockers name, then verify again.";
}

/** What this tool says when a failure does not know its own recovery. */
export const VERIFY_TOOL_RECOVERY = {
  code: "verification_refused",
  next: "call inspect_project_work on the task to read its state and readiness, then verify again",
};
