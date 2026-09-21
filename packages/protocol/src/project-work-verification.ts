/**
 * Verification and convergence (M21-T19; leap, "Execution and convergence").
 *
 * A verification run compares one implementation against **four authorities**,
 * each read at an exact revision:
 *
 * 1. the Spec's acceptance criteria and behavioural tests;
 * 2. the Design's states, token and component usage, and its native visual
 *    evidence — which exists only at Build, as an M20 checkpoint preview the
 *    person accepted, linked `verified_at` (D-353);
 * 3. the Plan's boundaries, security, accessibility and migration
 *    requirements;
 * 4. the Task's own commands, diffs, reviews and person feedback.
 *
 * Three rules are structural rather than advisory, and this file is where they
 * are expressible:
 *
 * - **Verification produces evidence, never approval** (leap, "Lifecycle and
 *   gates"). The report's strongest outcome is `converged`, which may move a
 *   Task to `needs_review`. Nothing here can reach `done`.
 * - **An agent never drives a browser** (`AGENTS.md`, D-342). A browser matrix
 *   declared on a Design or a Plan becomes `needs_person` items carrying the
 *   exact steps a person takes; the run refuses to pretend it checked them.
 * - **A deviation is a proposal, not an edit.** It names the criterion it
 *   could not satisfy, why, and the upstream revision it proposes to change.
 *   Accepting one is a person's act that goes through the ordinary revise
 *   path, which is what makes only the reachable graph stale.
 */
import { z } from "zod";
import { projectWorkBodySchema, type ProjectWorkBody } from "./project-work-bodies.js";
import {
  DIGEST_PATTERN,
  OPAQUE_ID_PATTERN,
  PROJECT_WORK_NOTE_MAX,
  PROJECT_WORK_TEXT_MAX,
  isProjectWorkKeyString,
  type ProjectWorkKind,
} from "./project-work.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The four authorities a verification run compares against. */
export const VERIFICATION_AUTHORITIES = ["spec", "design", "plan", "task"] as const;
export type VerificationAuthority = (typeof VERIFICATION_AUTHORITIES)[number];

/**
 * What one criterion is *about*. The kind decides how it can be decided at
 * all: a `command` criterion is settled by an exit code, a `visual` one only
 * by an accepted checkpoint preview, a `browser_matrix` one only by a person.
 */
export const VERIFICATION_CRITERION_KINDS = [
  "acceptance",
  "requirement",
  "command",
  "design_state",
  "design_token",
  "design_component",
  "visual",
  "browser_matrix",
  "boundary",
  "security",
  "accessibility",
  "migration",
  "review",
] as const;
export type VerificationCriterionKind = (typeof VERIFICATION_CRITERION_KINDS)[number];

/**
 * How one criterion came out.
 *
 * `needs_person` and `not_machine_verifiable` are different answers on
 * purpose: the first has an exact next step for a person (accept the preview,
 * walk the matrix), the second says no procedure this run has can decide it,
 * and names what to read instead. Neither is a failure, and neither is a pass.
 */
export const VERIFICATION_OUTCOMES = ["satisfied", "failed", "needs_person", "not_machine_verifiable"] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

/** What a command run did. `stopped` is a person's stop, not a failure. */
export const VERIFICATION_COMMAND_STATUSES = ["passed", "failed", "stopped", "not_run", "unavailable"] as const;
export type VerificationCommandStatus = (typeof VERIFICATION_COMMAND_STATUSES)[number];

/** Why nothing is converged yet (leap: "nothing is called converged while…"). */
export const VERIFICATION_BLOCKER_KINDS = [
  "blocking_comment",
  "stale_approval",
  "failed_check",
  "stale_upstream",
  "unmet_dependency",
] as const;
export type VerificationBlockerKind = (typeof VERIFICATION_BLOCKER_KINDS)[number];

/** The run as a whole. `converged` is the only one that may reach `needs_review`. */
export const VERIFICATION_RUN_OUTCOMES = ["converged", "blocked", "failed", "stopped"] as const;
export type VerificationRunOutcome = (typeof VERIFICATION_RUN_OUTCOMES)[number];

/** What a deviation is waiting for. Only a person accepts one. */
export const VERIFICATION_DEVIATION_STATES = ["proposed", "accepted", "declined"] as const;
export type VerificationDeviationState = (typeof VERIFICATION_DEVIATION_STATES)[number];

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** A run reads at most this many criteria; a bigger authority says it was cut. */
export const VERIFICATION_CRITERIA_MAX = 400;
/** How many commands one run may execute. */
export const VERIFICATION_COMMANDS_MAX = 32;
/** How long one command may run before the runner stops it. */
export const VERIFICATION_COMMAND_TIMEOUT_MS = 30 * 60_000;
/** The most output one command's record keeps, in bytes of the tail. */
export const VERIFICATION_COMMAND_TAIL_BYTES = 4_000;
/** How many browser-matrix cells are listed before the rest are summarised. */
export const VERIFICATION_MATRIX_CELLS_MAX = 24;
/** How many deviations one report carries. */
export const VERIFICATION_DEVIATIONS_MAX = 32;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

const opaqueId = z.string().regex(OPAQUE_ID_PATTERN, "an id this app minted");
const digest = z.string().regex(DIGEST_PATTERN, "a sha256 digest");
const isoInstant = z.string().min(1).max(64);
const line = z.string().min(1).max(500);

/**
 * One authority, at the exact revision it was read at.
 *
 * The digest is what makes "at exact revisions" checkable later: a report that
 * names a revision whose bytes have since changed is visibly about something
 * else.
 */
export interface VerificationSourceRef {
  authority: VerificationAuthority;
  entityId: string;
  kind: ProjectWorkKind;
  key: string;
  revisionId: string;
  digest: string;
  title: string;
}

export const verificationSourceRefSchema = z
  .object({
    authority: z.enum(VERIFICATION_AUTHORITIES),
    entityId: opaqueId,
    kind: z.enum(["spec", "research", "design", "plan", "task"]),
    key: z.string().refine(isProjectWorkKeyString, "a project work key such as SPEC-12"),
    revisionId: opaqueId,
    digest,
    title: z.string().max(200),
  })
  .strict();

/**
 * One thing the implementation has to be true of.
 *
 * `machineVerifiable` is what the authority *declared*; `command` is what this
 * run can actually decide it with. A criterion that declares itself checkable
 * and binds no command is still not decided by a machine, and the finding says
 * exactly that rather than counting it as a pass.
 */
export interface VerificationCriterion {
  id: string;
  authority: VerificationAuthority;
  kind: VerificationCriterionKind;
  text: string;
  /** A `must` blocks convergence; a `should` is reported and does not. */
  required: boolean;
  machineVerifiable: boolean;
  source: VerificationSourceRef;
  /** The command that decides it, when one is bound. */
  command?: string;
  /** The exact steps a person takes, for anything only a person can decide. */
  steps?: string[];
}

export const verificationCriterionSchema = z
  .object({
    id: z.string().min(1).max(200),
    authority: z.enum(VERIFICATION_AUTHORITIES),
    kind: z.enum(VERIFICATION_CRITERION_KINDS),
    text: z.string().min(1).max(PROJECT_WORK_TEXT_MAX),
    required: z.boolean(),
    machineVerifiable: z.boolean(),
    source: verificationSourceRefSchema,
    command: z.string().min(1).max(2000).optional(),
    steps: z.array(line).max(12).optional(),
  })
  .strict();

/**
 * One command, as it really ran.
 *
 * The bytes are bounded and the digest covers every one of them, so a tail
 * that was cut is labelled rather than passed off as the whole output — the
 * same rule background commands follow (`docs/agents.md` §6).
 */
export interface VerificationCommandRun {
  command: string;
  status: VerificationCommandStatus;
  /** Absent when the command never ran or was stopped before it ended. */
  exitCode?: number;
  startedAt: string;
  endedAt: string;
  outputBytes: number;
  outputDigest: string;
  /** The last bytes of the output, bounded. */
  tail: string;
  truncated?: boolean;
  /** Why it could not run, when it could not. Written for a person. */
  detail?: string;
}

export const verificationCommandRunSchema = z
  .object({
    command: z.string().min(1).max(2000),
    status: z.enum(VERIFICATION_COMMAND_STATUSES),
    exitCode: z.number().int().min(-64).max(255).optional(),
    startedAt: isoInstant,
    endedAt: isoInstant,
    outputBytes: z.number().int().min(0),
    outputDigest: digest,
    tail: z.string().max(VERIFICATION_COMMAND_TAIL_BYTES * 2),
    truncated: z.boolean().optional(),
    detail: z.string().max(PROJECT_WORK_TEXT_MAX).optional(),
  })
  .strict();

/** What one criterion came out as, and what says so. */
export interface VerificationFinding {
  criterionId: string;
  outcome: VerificationOutcome;
  /** One sentence a person reads. Never a stack trace, never a whole output. */
  detail: string;
  /** Evidence records this finding rests on, by id. */
  evidenceIds: string[];
  /** The commands that decided it, by their command line. */
  commands?: string[];
  /** The repository link that proves it: a delivery, or an accepted preview. */
  repositoryLinkId?: string;
  /** What a person does next, for `needs_person`. */
  steps?: string[];
}

export const verificationFindingSchema = z
  .object({
    criterionId: z.string().min(1).max(200),
    outcome: z.enum(VERIFICATION_OUTCOMES),
    detail: z.string().min(1).max(PROJECT_WORK_TEXT_MAX),
    evidenceIds: z.array(opaqueId).max(32),
    commands: z.array(z.string().min(1).max(2000)).max(VERIFICATION_COMMANDS_MAX).optional(),
    repositoryLinkId: opaqueId.optional(),
    steps: z.array(line).max(12).optional(),
  })
  .strict();

/**
 * A required change to an approved upstream artifact, proposed rather than
 * made.
 *
 * `proposedBody` is the whole typed body the upstream would have after the
 * change: accepting the deviation sends exactly it through
 * `project/work/revise`, which is the ordinary path, which is what stales the
 * reachable graph and nothing else.
 */
export interface VerificationDeviation {
  id: string;
  /** The criterion this deviation is about, when it is about one. */
  criterionId?: string;
  /** Why the implementation deviates, in the verifier's own words. */
  reason: string;
  /** What the upstream would have to say instead, for a person to read. */
  proposal: string;
  upstream: {
    entityId: string;
    kind: ProjectWorkKind;
    key: string;
    /** The exact revision the proposal was written against. */
    revisionId: string;
    digest: string;
  };
  /** The body a person's acceptance would store. Absent: a prose proposal. */
  proposedBody?: ProjectWorkBody;
  state: VerificationDeviationState;
}

export const verificationDeviationSchema = z
  .object({
    id: z.string().min(1).max(200),
    criterionId: z.string().min(1).max(200).optional(),
    reason: z.string().min(1).max(PROJECT_WORK_TEXT_MAX),
    proposal: z.string().min(1).max(PROJECT_WORK_TEXT_MAX),
    upstream: z
      .object({
        entityId: opaqueId,
        kind: z.enum(["spec", "research", "design", "plan", "task"]),
        key: z.string().refine(isProjectWorkKeyString, "a project work key such as SPEC-12"),
        revisionId: opaqueId,
        digest,
      })
      .strict(),
    proposedBody: projectWorkBodySchema.optional(),
    state: z.enum(VERIFICATION_DEVIATION_STATES),
  })
  .strict();

/** One reason convergence is refused, named so a person can go and fix it. */
export interface VerificationBlocker {
  kind: VerificationBlockerKind;
  detail: string;
  /** The work this blocker is on, when it is on one. */
  key?: string;
  /** The comment, approval or command it names. */
  reference?: string;
}

export const verificationBlockerSchema = z
  .object({
    kind: z.enum(VERIFICATION_BLOCKER_KINDS),
    detail: z.string().min(1).max(PROJECT_WORK_TEXT_MAX),
    key: z.string().max(40).optional(),
    reference: z.string().max(200).optional(),
  })
  .strict();

/** One thing that is still a person's to decide, with the steps to decide it. */
export interface VerificationPersonDecision {
  criterionId: string;
  question: string;
  steps: string[];
}

export const verificationPersonDecisionSchema = z
  .object({
    criterionId: z.string().min(1).max(200),
    question: z.string().min(1).max(PROJECT_WORK_TEXT_MAX),
    steps: z.array(line).max(12),
  })
  .strict();

/**
 * What a run will compare against, derived by the host from the store before
 * a single command runs.
 *
 * The plan is the host's answer and never the caller's: a verifier asks what
 * to check, runs exactly the commands the plan names, and reports the exit
 * codes. It cannot add a criterion, and it cannot decide one.
 */
export interface VerificationPlan {
  task: VerificationSourceRef;
  authorities: VerificationSourceRef[];
  criteria: VerificationCriterion[];
  /** The Task's declared verification commands, in the order it declared them. */
  commands: string[];
  /** What already blocks convergence, before anything runs. */
  blockers: VerificationBlocker[];
  /** Authorities whose criteria were cut at the bound, by key. */
  truncated: string[];
}

export const verificationPlanSchema = z
  .object({
    task: verificationSourceRefSchema,
    authorities: z.array(verificationSourceRefSchema).max(64),
    criteria: z.array(verificationCriterionSchema).max(VERIFICATION_CRITERIA_MAX),
    commands: z.array(z.string().min(1).max(2000)).max(VERIFICATION_COMMANDS_MAX),
    blockers: z.array(verificationBlockerSchema).max(64),
    truncated: z.array(z.string().max(40)).max(64),
  })
  .strict();

/** The canonical report, stored as a blob and referenced by its evidence row. */
export interface VerificationReport {
  version: 1;
  runId: string;
  task: VerificationSourceRef;
  startedAt: string;
  endedAt: string;
  /** Set when a person stopped the run. The report still says what it knows. */
  stopped?: { reason: string };
  authorities: VerificationSourceRef[];
  criteria: VerificationCriterion[];
  commands: VerificationCommandRun[];
  findings: VerificationFinding[];
  deviations: VerificationDeviation[];
  blockers: VerificationBlocker[];
  personDecisions: VerificationPersonDecision[];
  /** True only when every required machine-decided criterion passed and nothing blocks. */
  converged: boolean;
  outcome: VerificationRunOutcome;
  /** One line for a list row. Never the whole report. */
  summary: string;
  truncated: string[];
}

export const verificationReportSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().min(1).max(64),
    task: verificationSourceRefSchema,
    startedAt: isoInstant,
    endedAt: isoInstant,
    stopped: z.object({ reason: z.string().min(1).max(PROJECT_WORK_NOTE_MAX) }).strict().optional(),
    authorities: z.array(verificationSourceRefSchema).max(64),
    criteria: z.array(verificationCriterionSchema).max(VERIFICATION_CRITERIA_MAX),
    commands: z.array(verificationCommandRunSchema).max(VERIFICATION_COMMANDS_MAX),
    findings: z.array(verificationFindingSchema).max(VERIFICATION_CRITERIA_MAX),
    deviations: z.array(verificationDeviationSchema).max(VERIFICATION_DEVIATIONS_MAX),
    blockers: z.array(verificationBlockerSchema).max(64),
    personDecisions: z.array(verificationPersonDecisionSchema).max(VERIFICATION_CRITERIA_MAX),
    converged: z.boolean(),
    outcome: z.enum(VERIFICATION_RUN_OUTCOMES),
    summary: z.string().min(1).max(PROJECT_WORK_TEXT_MAX),
    truncated: z.array(z.string().max(40)).max(64),
  })
  .strict();

/** The media type the report blob is stored under. */
export const VERIFICATION_REPORT_MEDIA_TYPE = "application/vnd.lasercode.verification-report+json";

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/**
 * Whether a criterion is one this run could decide by itself.
 *
 * Declaring a criterion machine-verifiable is not the same as binding a
 * command to it. Only a criterion with a command, or one settled by a record
 * the store already holds (a review), is decided here — and the convergence
 * rule counts exactly those.
 *
 * Visual and browser-matrix criteria are never decidable here, whatever they
 * declare: one needs a preview a person accepted (D-353) and the other needs a
 * person at a browser (D-342).
 */
export function machineDecidable(criterion: VerificationCriterion): boolean {
  if (criterion.kind === "browser_matrix" || criterion.kind === "visual") return false;
  // A review criterion is settled by the store's own comment and approval
  // records, which is a machine deciding it as much as an exit code is.
  if (criterion.kind === "review") return true;
  return criterion.machineVerifiable && criterion.command !== undefined;
}

/**
 * The convergence rule, in one place (leap, "Execution and convergence").
 *
 * A Task may be moved to `needs_review` when **every required criterion this
 * run could decide came out satisfied**, nothing came out `failed`, and no
 * blocker remains. Items only a person can settle do not stand in the way:
 * `needs_review` is precisely the state that hands them to a person.
 */
export function convergenceOf(input: {
  criteria: readonly VerificationCriterion[];
  findings: readonly VerificationFinding[];
  blockers: readonly VerificationBlocker[];
  stopped?: boolean;
}): { converged: boolean; outcome: VerificationRunOutcome; reasons: string[] } {
  const byId = new Map(input.criteria.map((criterion) => [criterion.id, criterion]));
  const reasons: string[] = [];
  let failed = false;
  for (const finding of input.findings) {
    const criterion = byId.get(finding.criterionId);
    if (!criterion) continue;
    if (finding.outcome === "failed") {
      failed = true;
      if (criterion.required) reasons.push(`${criterion.source.key}: ${criterion.text}`);
    }
    if (criterion.required && machineDecidable(criterion) && finding.outcome !== "satisfied" && finding.outcome !== "failed") {
      reasons.push(`${criterion.source.key}: ${criterion.text} was not decided by this run.`);
    }
  }
  // A required criterion with no finding at all is not a pass: the run simply
  // did not reach it, which is exactly what stopping a run does.
  for (const criterion of input.criteria) {
    if (!criterion.required || !machineDecidable(criterion)) continue;
    if (!input.findings.some((finding) => finding.criterionId === criterion.id)) {
      reasons.push(`${criterion.source.key}: ${criterion.text} was never checked.`);
    }
  }
  for (const blocker of input.blockers) reasons.push(blocker.detail);
  if (input.stopped === true) return { converged: false, outcome: "stopped", reasons };
  if (failed) return { converged: false, outcome: "failed", reasons };
  if (reasons.length > 0) return { converged: false, outcome: "blocked", reasons };
  return { converged: true, outcome: "converged", reasons };
}

/** The one line a report row shows. Counts, never percentages. */
export function verificationSummary(report: Omit<VerificationReport, "summary">): string {
  const satisfied = report.findings.filter((finding) => finding.outcome === "satisfied").length;
  const failed = report.findings.filter((finding) => finding.outcome === "failed").length;
  const person = report.findings.filter((finding) => finding.outcome === "needs_person").length;
  const open = report.findings.filter((finding) => finding.outcome === "not_machine_verifiable").length;
  const parts = [`${String(satisfied)} of ${String(report.criteria.length)} satisfied`];
  if (failed > 0) parts.push(`${String(failed)} failed`);
  if (person > 0) parts.push(`${String(person)} waiting on you`);
  if (open > 0) parts.push(`${String(open)} not checkable here`);
  if (report.blockers.length > 0) parts.push(`${String(report.blockers.length)} blocking`);
  return parts.join(" · ");
}

/**
 * The steps a person takes for one browser-matrix cell.
 *
 * Written out rather than implied, because this is the one requirement Laser's
 * own rules forbid an agent from checking (`AGENTS.md`, D-342): the report
 * hands a person the exact walk instead of a claim.
 */
export function browserMatrixSteps(cell: { screen?: string; theme?: string; width?: string; pointer?: string }): string[] {
  const where = cell.screen ? `Open ${cell.screen}` : "Open the changed screen";
  const how = [
    cell.theme ? `in the ${cell.theme} theme` : undefined,
    cell.width ? `at ${cell.width}` : undefined,
    cell.pointer ? `with a ${cell.pointer} pointer` : undefined,
  ].filter((part): part is string => part !== undefined);
  return [
    `${where}${how.length > 0 ? ` ${how.join(", ")}` : ""}.`,
    "Check that nothing overflows, no text is clipped and the page does not scroll sideways.",
    "Record what you saw with Accept, or leave a comment saying what is wrong.",
  ];
}

// ---------------------------------------------------------------------------
// The run, as a person's surface sees it
// ---------------------------------------------------------------------------

/** Where a run has got to. `done` and `stopped` are terminal. */
export const VERIFICATION_PHASES = ["gathering", "running", "reporting", "done", "stopped", "failed"] as const;
export type VerificationPhase = (typeof VERIFICATION_PHASES)[number];

/**
 * One verification run, as the Task detail and the fleet read it.
 *
 * Progress is counts and the command that is running — never a percentage and
 * never an invented estimate, the rule every long-running Laser surface keeps.
 */
export interface VerificationRunState {
  runId: string;
  /** The Task, by key, so a row reads without another request. */
  taskKey: string;
  entityId: string;
  phase: VerificationPhase;
  startedAt: string;
  endedAt?: string;
  /** The command being run right now, when one is. */
  currentCommand?: string;
  commandsRun: number;
  commandsTotal: number;
  criteriaTotal: number;
  /** One line for the fleet row and the live region. */
  line: string;
  /** The finished report, once there is one. */
  report?: VerificationReport;
  /** The evidence record the report was stored as. */
  evidenceId?: string;
  /** The blob the canonical report is in, for a surface reading it later. */
  blobId?: string;
  /** The Task's state after the run, when the run moved it. */
  taskState?: string;
  /** Why the run could not finish, written for a person. */
  problem?: string;
}

export const verificationRunStateSchema = z
  .object({
    runId: z.string().min(1).max(64),
    taskKey: z.string().max(40),
    entityId: opaqueId,
    phase: z.enum(VERIFICATION_PHASES),
    startedAt: isoInstant,
    endedAt: isoInstant.optional(),
    currentCommand: z.string().max(2000).optional(),
    commandsRun: z.number().int().min(0),
    commandsTotal: z.number().int().min(0),
    criteriaTotal: z.number().int().min(0),
    line: z.string().max(PROJECT_WORK_TEXT_MAX),
    report: verificationReportSchema.optional(),
    evidenceId: opaqueId.optional(),
    blobId: opaqueId.optional(),
    taskState: z.string().max(40).optional(),
    problem: z.string().max(PROJECT_WORK_TEXT_MAX).optional(),
  })
  .strict();

/** The line a run's fleet row and live region show. */
export function verificationRunLine(state: Omit<VerificationRunState, "line">): string {
  switch (state.phase) {
    case "gathering":
      return `Reading what ${state.taskKey} has to satisfy`;
    case "running":
      return state.currentCommand
        ? `${state.currentCommand} — command ${String(state.commandsRun + 1)} of ${String(state.commandsTotal)}`
        : `Running ${String(state.commandsTotal)} command${state.commandsTotal === 1 ? "" : "s"}`;
    case "reporting":
      return `Writing the report for ${state.taskKey}`;
    case "stopped":
      return `Stopped after ${String(state.commandsRun)} of ${String(state.commandsTotal)} commands`;
    case "failed":
      return state.problem ?? `Verification of ${state.taskKey} could not finish`;
    case "done":
      return state.report?.summary ?? `Verification of ${state.taskKey} finished`;
  }
}

// ---------------------------------------------------------------------------
// The bridge envelope (worker → host)
// ---------------------------------------------------------------------------

/**
 * What a verifier asks the host for.
 *
 * `plan` derives the criteria; `report` hands back the command runs and the
 * deviations and gets the stored report. The verifier supplies *facts it alone
 * can produce* — exit codes and bounded output — and never a verdict: the host
 * evaluates every criterion itself, from the plan it derived itself.
 */
export type VerificationEnvelope =
  | { action: "plan" }
  | {
      action: "report";
      runId: string;
      startedAt: string;
      endedAt: string;
      commands: VerificationCommandRun[];
      deviations?: Array<Omit<VerificationDeviation, "state">>;
      stopped?: { reason: string };
    };

export const verificationEnvelopeSchema = z.union([
  z.object({ action: z.literal("plan") }).strict(),
  z
    .object({
      action: z.literal("report"),
      runId: z.string().min(1).max(64),
      startedAt: isoInstant,
      endedAt: isoInstant,
      commands: z.array(verificationCommandRunSchema).max(VERIFICATION_COMMANDS_MAX),
      deviations: z.array(verificationDeviationSchema.omit({ state: true })).max(VERIFICATION_DEVIATIONS_MAX).optional(),
      stopped: z.object({ reason: z.string().min(1).max(PROJECT_WORK_NOTE_MAX) }).strict().optional(),
    })
    .strict(),
]);

/** What the host answers a verification bridge call with. */
export interface VerificationBridgeResult {
  plan?: VerificationPlan;
  report?: VerificationReport;
  /** The evidence record the report was written as, kind `verification`. */
  evidenceId?: string;
  blobId?: string;
  /** The Task's state after the report. Never `done`. */
  taskState?: string;
  /** The move the report caused, when it caused one. */
  transition?: { from: string; to: string };
}

// ---------------------------------------------------------------------------
// The run-control methods (client → worker)
// ---------------------------------------------------------------------------

export interface VerificationStartParams {
  /** The checkout the commands run in. The project is resolved from it. */
  cwd: string;
  /** The Task, by opaque id. */
  entityId?: string;
  /** The Task, by key, for a caller that has one. */
  key?: string;
}

export interface VerificationStartResult {
  run: VerificationRunState;
}

export interface VerificationStateParams {
  cwd: string;
  /** One run. Omitted answers with every run this worker knows of. */
  runId?: string;
}

export interface VerificationStateResult {
  runs: VerificationRunState[];
}

export interface VerificationStopParams {
  cwd: string;
  runId: string;
  reason?: string;
}

export interface VerificationStopResult {
  stopped: boolean;
  run?: VerificationRunState;
}
