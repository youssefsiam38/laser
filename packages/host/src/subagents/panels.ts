/**
 * pi-subagents → panels (docs/ux-panels.md, docs/ux-agent-work.md).
 *
 * Pure mappers: on-disk `AsyncStatus` in, `Panel[]` out. No I/O, no clocks, no
 * React — the watcher in `layer.ts` supplies file sizes and the session path,
 * and everything here is a total function of its inputs, so the interesting
 * decisions (the state mapping, the capability matrix, the usage honesty) are
 * testable without a filesystem.
 *
 * Three rules from the contract shape every function below:
 *
 *   R2  capability honesty — an action appears only if it actually works on
 *       this run's path. Hidden, never disabled.
 *   R3  provenance honesty — a plan we rebuilt from `workflow.trace` and the
 *       preflight lanes is `inferred: true`; only a persisted `workflowGraph`
 *       is declared. pi-subagents 0.65 persists no graph for scripted
 *       workflows, so `inferred` is the common case, not the exception.
 *   R8  cost is visible wherever work is spawned, and `usage` is raw: `null`
 *       means "not measured", which is a different thing from zero, and a
 *       missing cache-read count says so instead of reading as zero.
 *
 * Panel ids are the dedupe key (R9, and "a child seen by both paths appears
 * exactly once"). They are derived only from pi-subagents' own identities, so
 * the in-process module and this file layer land on the same id for the same
 * child:
 *
 *   subagents:run:<runId>                     a single-step background run
 *   subagents:plan:<runId>                    a workflow / chain / parallel run
 *   subagents:child:<runId>:<childId|index>   one step of such a run
 *   subagents:nested:<runId>:<i>:<nestedId>   a child that fanned out again
 *   subagents:fg:<runId>[:<index>]            a foreground child
 *   subagents:check:<runId>:<childKey>        its acceptance / watchdog ledger
 *   subagents:mission:<missionId>             a mission ledger
 *   subagents:steer:<panelId>                 the question "Steer" opens
 */
import type {
  Action,
  CollectionItem,
  CollectionPanel,
  DecisionPanel,
  Panel,
  PanelUsage,
  PlanPanel,
  PlanStep,
  PlanStepState,
  RunLifecycle,
  RunPanel,
} from "@lasercode/protocol";
import type { AcceptanceLedger, AsyncStatus, ForegroundChild, RunState, StatusStep, StepState } from "./status.js";

export const PANEL_SOURCE = "pi-subagents";
export const PANEL_ID_PREFIX = "subagents:";

/** True for every panel id this layer owns, so the router can claim its actions. */
export function isSubagentsPanelId(id: string): boolean {
  return id.startsWith(PANEL_ID_PREFIX);
}

// ---------------------------------------------------------------------------
// The state mapping — declared, not guessed
// ---------------------------------------------------------------------------

/**
 * pi-subagents' eight run states and the six-state lifecycle the panel
 * contract defines. The mapping is written out rather than inferred because
 * the two vocabularies disagree in exactly the places that matter:
 *
 *   partial   the run produced some output and then gave up. It is `done`
 *             with a reason, not `failed`: the work is there.
 *   stopped   a person stopped it. `cancelled`, never `failed` — the
 *             contract's own note that "everybody loses the reason" is about
 *             precisely this collapse.
 *   rejected  a gate refused the launch. `failed`, because nothing ran.
 *   detached  (steps only) the parent stopped watching; the child may still
 *             be going. `running`, with the fidelity note on the panel.
 */
export const LIFECYCLE_OF: Readonly<Record<StepState, RunLifecycle>> = {
  queued: "queued",
  pending: "queued",
  running: "running",
  detached: "running",
  paused: "paused",
  complete: "done",
  completed: "done",
  partial: "done",
  failed: "failed",
  stopped: "cancelled",
  rejected: "failed",
};

/** The plan-step vocabulary, which is a different six. */
export const STEP_STATE_OF: Readonly<Record<StepState, PlanStepState>> = {
  queued: "pending",
  pending: "pending",
  running: "running",
  detached: "running",
  paused: "blocked",
  complete: "done",
  completed: "done",
  partial: "done",
  failed: "failed",
  stopped: "skipped",
  rejected: "skipped",
};

const TERMINAL: ReadonlySet<RunLifecycle> = new Set<RunLifecycle>(["done", "failed", "cancelled"]);

/**
 * Why it ended, in words for a person. pi-subagents keeps the reason in five
 * different flags and then renders every one of them as "stopped"; this is
 * where it is put back together.
 */
function terminalReason(state: StepState, step: Pick<StatusStep, "timedOut" | "stopped" | "toolBudgetBlocked" | "contextOverflow" | "exitCode">): string | undefined {
  if (step.timedOut) return "it ran out of time";
  if (step.toolBudgetBlocked) return "it reached its tool budget";
  if (step.contextOverflow) return "the input exceeded the model's context window";
  if (state === "stopped" || step.stopped) return "you stopped it";
  if (state === "partial") return "it finished early with partial output";
  if (state === "rejected") return "a gate refused the launch";
  if (state === "paused") return "it is waiting to be resumed";
  if (typeof step.exitCode === "number" && step.exitCode !== 0) return `it exited with code ${step.exitCode}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Usage — raw, and honest about what was never measured
// ---------------------------------------------------------------------------

const NO_CACHE_READS =
  "pi-subagents records cache reads only in the per-attempt ledger, which this run has not written yet";

/**
 * `modelAttempts[].usage` is the only place cache reads and cost live, so it is
 * preferred; `tokens` is the live counter and carries neither. A run with
 * neither returns `null`, which renders as "not measured".
 */
export function usageOfStep(step: Pick<StatusStep, "modelAttempts" | "tokens" | "totalCost">): PanelUsage | null {
  const attempts = step.modelAttempts?.map((a) => a.usage).filter((u): u is NonNullable<typeof u> => u !== undefined) ?? [];
  if (attempts.length > 0) {
    const sum = (pick: (u: (typeof attempts)[number]) => number | undefined): number | undefined => {
      const values = attempts.map(pick).filter((v): v is number => v !== undefined);
      return values.length > 0 ? values.reduce((a, b) => a + b, 0) : undefined;
    };
    const cost = sum((u) => u.cost);
    const usage: PanelUsage = {
      ...opt(sum((u) => u.input), "input"),
      ...opt(sum((u) => u.output), "output"),
      ...opt(sum((u) => u.cacheRead), "cacheRead"),
      ...opt(sum((u) => u.cacheWrite), "cacheWrite"),
      costUsd: cost ?? step.totalCost?.costUsd ?? null,
    };
    return usage;
  }
  const tokens = step.tokens;
  if (!tokens || (tokens.input === undefined && tokens.output === undefined && tokens.total === undefined)) {
    return null;
  }
  return {
    ...opt(tokens.input, "input"),
    ...opt(tokens.output, "output"),
    costUsd: step.totalCost?.costUsd ?? null,
    unavailableReason: NO_CACHE_READS,
  };
}

/** The run-level roll-up. Same rules; `totalTokens` is a live counter with no cache reads. */
export function usageOfRun(status: Pick<AsyncStatus, "steps" | "totalTokens" | "totalCost">): PanelUsage | null {
  const perStep = status.steps.map((s) => usageOfStep(s)).filter((u): u is PanelUsage => u !== null);
  if (perStep.length > 0) {
    const sum = (pick: (u: PanelUsage) => number | undefined): number | undefined => {
      const values = perStep.map(pick).filter((v): v is number => v !== undefined);
      return values.length > 0 ? values.reduce((a, b) => a + b, 0) : undefined;
    };
    const costs = perStep.map((u) => u.costUsd).filter((c): c is number => typeof c === "number");
    const reasons = perStep.map((u) => u.unavailableReason).filter((r): r is string => r !== undefined);
    return {
      ...opt(sum((u) => u.input), "input"),
      ...opt(sum((u) => u.output), "output"),
      ...opt(sum((u) => u.cacheRead), "cacheRead"),
      ...opt(sum((u) => u.cacheWrite), "cacheWrite"),
      costUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : (status.totalCost?.costUsd ?? null),
      ...(reasons[0] !== undefined ? { unavailableReason: reasons[0] } : {}),
    };
  }
  const tokens = status.totalTokens;
  if (!tokens) return null;
  return {
    ...opt(tokens.input, "input"),
    ...opt(tokens.output, "output"),
    costUsd: status.totalCost?.costUsd ?? null,
    unavailableReason: NO_CACHE_READS,
  };
}

const opt = <T>(value: T | undefined, key: string): Record<string, T> =>
  value === undefined ? {} : ({ [key]: value } as Record<string, T>);

// ---------------------------------------------------------------------------
// Capabilities — R2, made concrete against the four control paths
// ---------------------------------------------------------------------------

export interface Capabilities {
  /** The runner process is still there (or we cannot tell, which counts as there). */
  runnerAlive: boolean;
  /** `control/steer-inbox-closed.json` exists: the runner has stopped reading steers. */
  steerClosed: boolean;
  /**
   * A live laser worker holds this session with the subagents module active,
   * so `subagents:rpc:v1` is reachable. Resume exists only through the owning
   * session (findings.md), so it appears only here.
   */
  busReachable: boolean;
}

const STEER: Action = { id: "steer", label: "Steer" };
const STOP: Action = { id: "stop", label: "Stop", confirm: "Stop this run?", destructive: true };
const INTERRUPT: Action = { id: "interrupt", label: "Interrupt" };
const RESUME: Action = { id: "resume", label: "Resume" };
/** Nested children have no control file of their own; both of theirs act on the run. */
const NESTED_INTERRUPT: Action = {
  id: "interrupt",
  label: "Interrupt",
  confirm: "Interrupt the whole run? A nested child cannot be interrupted on its own.",
};
const NESTED_RESUME: Action = { id: "resume", label: "Resume the run" };

/**
 * The capability matrix from docs/ux-agent-work.md, as code.
 *
 * | path                          | steer | stop | resume | interrupt |
 * | background, via control inbox |  yes  | yes  |   no   |    yes    |
 * | background, parent alive      |  yes  | yes  |  yes   |    yes    |
 * | foreground child              |  no   |  no  |   no   |    no     |
 * | nested child                  |  no   |  no  |  yes   |    yes    |
 * | external run                  |  no   |  no  |   no   |    no     |
 *
 * A child of a workflow takes steer and stop (both accept a `targetIndex`);
 * interrupt is a run-level file, so a workflow child does not carry it — the
 * run above it does, and that is one press away. A nested child is the one
 * exception: nothing else in the tree addresses it, so its row carries the run
 * interrupt and the run resume, labelled as acting on the run
 * ({@link actionsForNested}).
 */
export function actionsForRun(state: RunState, caps: Capabilities): Action[] {
  const live = state === "running" || state === "queued";
  if (live) {
    return [...(caps.runnerAlive && !caps.steerClosed ? [STEER] : []), ...(caps.runnerAlive ? [STOP, INTERRUPT] : [])];
  }
  // Resume is only reachable through the owning Pi session's bus.
  if ((state === "paused" || state === "complete" || state === "partial") && caps.busReachable) return [RESUME];
  return [];
}

/**
 * A nested child takes interrupt and resume, never steer or stop. Both reach
 * it through the run that owns it, so the labels say so.
 */
export function actionsForNested(lifecycle: RunLifecycle, caps: Capabilities): Action[] {
  if (lifecycle === "running" || lifecycle === "queued") {
    return caps.runnerAlive ? [NESTED_INTERRUPT] : [];
  }
  if (lifecycle === "paused" || lifecycle === "done") return caps.busReachable ? [NESTED_RESUME] : [];
  return [];
}

export function actionsForChild(step: StatusStep, runState: RunState, caps: Capabilities): Action[] {
  const live = step.status === "running" || step.status === "pending" || step.status === "queued";
  if (!live || !caps.runnerAlive || runState !== "running") return [];
  if (step.stopRequested) return [];
  return [...(caps.steerClosed ? [] : [STEER]), STOP];
}

// ---------------------------------------------------------------------------
// Run panels
// ---------------------------------------------------------------------------

export interface MapOptions {
  caps: Capabilities;
  /** Size of a file, for the liveness signal on a run's output. */
  bytesOf?: (absolutePath: string) => number | undefined;
}

export const runPanelId = (runId: string): string => `${PANEL_ID_PREFIX}run:${runId}`;
export const planPanelId = (runId: string): string => `${PANEL_ID_PREFIX}plan:${runId}`;
export const childPanelId = (runId: string, step: StatusStep, index: number): string =>
  `${PANEL_ID_PREFIX}child:${runId}:${step.childId ?? step.workflowKey ?? String(index)}`;
export const foregroundPanelId = (runId: string, index: number | undefined): string =>
  `${PANEL_ID_PREFIX}fg:${runId}${index === undefined ? "" : `:${index}`}`;
export const checkPanelId = (parentPanelId: string): string => parentPanelId.replace(/^subagents:(run|child|fg):/, `${PANEL_ID_PREFIX}check:`);
export const steerDecisionId = (parentPanelId: string): string => `${PANEL_ID_PREFIX}steer:${parentPanelId}`;
export const resumeDecisionId = (parentPanelId: string): string => `${PANEL_ID_PREFIX}resume:${parentPanelId}`;

const iso = (ms: number | undefined): string | undefined =>
  ms === undefined || !Number.isFinite(ms) ? undefined : new Date(ms).toISOString();

/** One line, the agent's own words if it has any, else what it is doing. */
function activityOf(step: StatusStep): string | undefined {
  const said = step.recentOutput?.at(-1)?.trim();
  if (said) return said;
  if (step.currentTool) return step.currentPath ? `${step.currentTool} ${step.currentPath}` : step.currentTool;
  const recent = step.recentTools?.at(-1);
  if (recent?.tool) return recent.args ? `${recent.tool} ${recent.args}` : recent.tool;
  const watch = watchdogLine(step);
  return watch;
}

/** "watchdog: review stale" — surfaced only when there is nothing else to say. */
function watchdogLine(step: StatusStep): string | undefined {
  const phase = step.watchdog?.phase;
  if (!phase || phase === "ok" || phase === "healthy") return undefined;
  return step.watchdog?.reason ? `watchdog: ${step.watchdog.reason}` : `watchdog: ${phase}`;
}

function titleOfStep(step: StatusStep, index: number, total: number): string {
  const named = step.label ?? step.workflowKey;
  if (named) return named;
  const agent = step.agent ?? "child";
  return total > 1 ? `${agent}#${index + 1}` : agent;
}

/** Everything worth opening: the child's transcript, its structured output, its input. */
function artifactsOf(step: StatusStep): Array<{ label: string; ref: string }> {
  const out: Array<{ label: string; ref: string }> = [];
  if (step.structuredOutputPath) out.push({ label: "Structured output", ref: `file:${step.structuredOutputPath}` });
  if (step.sessionFile) out.push({ label: "Child session", ref: `file:${step.sessionFile}` });
  return out;
}

/**
 * One background child as a run panel. `parent` links it to its plan, never a
 * copy of the plan's state (R6/R10: one identity, replace in place).
 */
export function childRunPanel(
  status: AsyncStatus,
  step: StatusStep,
  index: number,
  options: MapOptions,
): RunPanel {
  const id = childPanelId(status.runId, step, index);
  const lifecycle = LIFECYCLE_OF[step.status];
  const transcript = step.transcriptPath;
  const bytes = transcript ? options.bytesOf?.(transcript) : undefined;
  const reason = terminalReason(step.status, step) ?? (TERMINAL.has(lifecycle) ? acceptanceReason(step.acceptance) : undefined);
  const requestedModel = step.attemptedModels?.[0];
  const requested =
    requestedModel !== undefined || step.thinkingCeiling !== undefined
      ? { ...opt(requestedModel, "model"), ...opt(step.thinkingCeiling, "thinking") }
      : undefined;
  const total = status.steps.length;
  return {
    kind: "run",
    id,
    source: PANEL_SOURCE,
    intent: "follow",
    title: titleOfStep(step, index, total),
    ...opt(step.agent ? `@${step.agent}` : undefined, "handle"),
    lifecycle,
    ...opt(reason, "terminalReason"),
    ...opt(activityOf(step), "activity"),
    ...(step.phase !== undefined
      ? { phase: { label: step.phase } }
      : total > 1 && status.mode === "chain"
        ? { phase: { label: step.agent ?? "step", index: index + 1, total } }
        : {}),
    origin: originOf(status),
    ...(total > 1 ? { parent: { id: planPanelId(status.runId), relation: "step-of" as const } } : {}),
    ...opt(requested, "requested"),
    ...opt(step.model, "model"),
    ...opt(iso(step.startedAt ?? status.startedAt), "startedAt"),
    // A finished child that never wrote its own end time still ended when the
    // run did; "—" where a duration belongs reads as a bug, not as honesty.
    ...opt(iso(step.endedAt ?? (TERMINAL.has(lifecycle) ? status.endedAt : undefined)), "endedAt"),
    usage: usageOfStep(step),
    ...(transcript ? { output: { ref: `file:${transcript}`, ...opt(bytes, "bytes") } } : {}),
    ...(artifactsOf(step).length > 0 ? { artifacts: artifactsOf(step) } : {}),
    ...(actionsForChild(step, status.state, options.caps).length > 0
      ? { actions: total > 1 ? actionsForChild(step, status.state, options.caps) : actionsForRun(status.state, options.caps) }
      : {}),
    ...opt(step.error, "error"),
  };
}

/** A single-step background run: the run *is* the child, so there is one panel. */
export function singleRunPanel(status: AsyncStatus, options: MapOptions): RunPanel {
  const step = status.steps[0] ?? ({ status: status.state } as StatusStep);
  const child = childRunPanel(status, step, 0, options);
  const actions = actionsForRun(status.state, options.caps);
  return {
    ...child,
    id: runPanelId(status.runId),
    lifecycle: LIFECYCLE_OF[status.state] ?? child.lifecycle,
    ...opt(
      terminalReason(status.state, {
        ...step,
        ...opt(status.timedOut ?? step.timedOut, "timedOut"),
        ...opt(status.stopped ?? step.stopped, "stopped"),
      }),
      "terminalReason",
    ),
    ...opt(iso(status.startedAt ?? step.startedAt), "startedAt"),
    ...opt(iso(status.endedAt ?? step.endedAt), "endedAt"),
    ...(actions.length > 0 ? { actions } : {}),
    ...opt(status.error ?? step.error, "error"),
  };
}

function originOf(status: AsyncStatus): string {
  if (status.scheduleOrigin) return `schedule ${status.scheduleOrigin.name ?? status.scheduleOrigin.id ?? ""}`.trim();
  if (status.isNested) return "a parent agent (nested)";
  return "a parent agent";
}

/**
 * A nested child: a child that fanned out further. The capability matrix
 * (docs/ux-agent-work.md, confirmed against the package in
 * docs/research/findings.md) gives it two of the four controls — interrupt and
 * resume — and neither steer nor stop, because no control file addresses a
 * nested child by name.
 *
 * Both controls act on the *owning run*, which is the only thing that can
 * reach a nested child at all: interrupt writes the run's `interrupt.json`,
 * resume goes through the owning session's bus. That is stated in the confirm
 * text rather than implied, because a control that quietly does something
 * wider than its label is the failure R2 exists to prevent.
 */
export function nestedRunPanels(status: AsyncStatus, step: StatusStep, index: number, caps: Capabilities): RunPanel[] {
  return (step.children ?? []).map((child, i) => ({
    kind: "run" as const,
    id: `${PANEL_ID_PREFIX}nested:${status.runId}:${index}:${child.id ?? String(i)}`,
    source: PANEL_SOURCE,
    intent: "follow" as const,
    title: child.agent ?? `nested#${i + 1}`,
    ...opt(child.agent ? `@${child.agent}` : undefined, "handle"),
    lifecycle: LIFECYCLE_OF[child.state ?? "running"] ?? "running",
    origin: "a child agent that fanned out",
    parent: { id: childPanelId(status.runId, step, index), relation: "spawned-by" as const },
    ...opt(child.model, "model"),
    ...opt(iso(child.startedAt), "startedAt"),
    ...opt(iso(child.endedAt), "endedAt"),
    usage: child.totalTokens
      ? {
          ...opt(child.totalTokens.input, "input"),
          ...opt(child.totalTokens.output, "output"),
          costUsd: null,
          unavailableReason: NO_CACHE_READS,
        }
      : null,
    ...(child.sessionFile ? { artifacts: [{ label: "Child session", ref: `file:${child.sessionFile}` }] } : {}),
    ...(actionsForNested(LIFECYCLE_OF[child.state ?? "running"] ?? "running", caps).length > 0
      ? { actions: actionsForNested(LIFECYCLE_OF[child.state ?? "running"] ?? "running", caps) }
      : {}),
    ...opt(child.error, "error"),
  }));
}

/**
 * A foreground child: read-only by construction (D-19 §6). No status file, no
 * control inbox, no index — the transcript is the whole signal, so the panel
 * carries it as its output and offers nothing to press.
 */
export function foregroundRunPanel(child: ForegroundChild, options: Pick<MapOptions, "bytesOf">): RunPanel {
  const meta = child.meta;
  const failed = meta !== undefined && (meta.error !== undefined || (typeof meta.exitCode === "number" && meta.exitCode !== 0));
  const lifecycle: RunLifecycle = child.live ? "running" : failed ? "failed" : "done";
  const usage: PanelUsage | null = meta?.usage
    ? {
        ...opt(meta.usage.input, "input"),
        ...opt(meta.usage.output, "output"),
        ...opt(meta.usage.cacheRead, "cacheRead"),
        ...opt(meta.usage.cacheWrite, "cacheWrite"),
        costUsd: meta.usage.cost ?? null,
      }
    : child.live
      ? { costUsd: null, unavailableReason: "a foreground child reports nothing until it finishes" }
      : null;
  const requestedModel = meta?.attemptedModels?.[0];
  return {
    kind: "run",
    id: foregroundPanelId(child.runId, child.index),
    source: PANEL_SOURCE,
    intent: "follow",
    title: child.index === undefined ? child.agent : `${child.agent}#${child.index + 1}`,
    handle: `@${child.agent}`,
    lifecycle,
    ...(child.live
      ? {}
      : { terminalReason: failed ? "it exited with an error" : (acceptanceReason(meta?.acceptance) ?? "it finished") }),
    origin: "a parent agent (foreground)",
    ...opt(requestedModel !== undefined ? { model: requestedModel } : undefined, "requested"),
    ...opt(meta?.model, "model"),
    ...opt(iso(child.startedAt), "startedAt"),
    ...opt(iso(meta?.timestamp), "endedAt"),
    usage,
    output: { ref: `file:${child.transcriptPath}`, ...opt(options.bytesOf?.(child.transcriptPath), "bytes") },
    ...opt(meta?.error, "error"),
  };
}

// ---------------------------------------------------------------------------
// Plan panels
// ---------------------------------------------------------------------------

/**
 * The plan for a workflow, chain or parallel run.
 *
 * `workflowGraph` is used when pi-subagents persisted one (declarative
 * `chain` / `parallel` launches). Scripted workflows persist nothing, so the
 * plan is rebuilt from the preflight lanes (the intended shape, declared at
 * launch) joined to the live steps by `workflowKey`, and marked `inferred`.
 * Lanes with no step yet are `pending` rows: the plan shows what was *meant*
 * to happen, which is the whole reason a plan is not just a list of runs.
 */
export function planPanel(status: AsyncStatus, options: MapOptions): PlanPanel | undefined {
  if (status.steps.length <= 1 && !status.preflight && !status.workflowGraph) return undefined;
  const declared = status.workflowGraph !== undefined;
  const steps = declared ? stepsFromGraph(status) : stepsFromLanes(status);
  if (steps.length === 0) return undefined;
  return {
    kind: "plan",
    id: planPanelId(status.runId),
    source: PANEL_SOURCE,
    intent: "follow",
    title: planTitle(status),
    ...opt(objectiveOf(status), "objective"),
    ...(declared ? {} : { inferred: true }),
    steps,
    usage: usageOfRun(status),
    ...(actionsForRun(status.state, options.caps).length > 0 ? { actions: actionsForRun(status.state, options.caps) } : {}),
  };
}

function planTitle(status: AsyncStatus): string {
  const n = status.steps.length;
  switch (status.mode) {
    case "workflow":
      return `Workflow · ${n} ${n === 1 ? "lane" : "lanes"}`;
    case "chain":
      return `Chain · ${n} ${n === 1 ? "step" : "steps"}`;
    case "parallel":
      return `Parallel · ${n} ${n === 1 ? "agent" : "agents"}`;
    default:
      return `Run · ${status.runId.slice(0, 8)}`;
  }
}

function objectiveOf(status: AsyncStatus): string | undefined {
  const decisions = status.preflight?.lanes.map((l) => l.decision).filter((d): d is string => d !== undefined) ?? [];
  if (decisions.length > 0) return decisions.join(" · ");
  return status.steps[0]?.description;
}

function stepsFromGraph(status: AsyncStatus): PlanStep[] {
  const graph = status.workflowGraph;
  if (!graph?.nodes) return [];
  const phaseTitles = new Map<string, string>();
  for (const phase of graph.phases ?? []) {
    for (const nodeId of phase.nodeIds ?? []) if (phase.title) phaseTitles.set(nodeId, phase.title);
  }
  const byIndex = new Map<number, StatusStep>();
  status.steps.forEach((s, i) => byIndex.set(i, s));
  const out: PlanStep[] = [];
  const walk = (nodes: NonNullable<typeof graph.nodes>, inheritedPhase: string | undefined): void => {
    for (const node of nodes) {
      const phase = node.phase ?? phaseTitles.get(node.id) ?? inheritedPhase;
      if (node.children && node.children.length > 0) {
        walk(node.children, phase);
        continue;
      }
      const live = node.stepIndex !== undefined ? byIndex.get(node.stepIndex) : undefined;
      out.push({
        id: node.id,
        label: node.label ?? node.agent ?? node.id,
        ...opt(phase, "phase"),
        state: STEP_STATE_OF[(live?.status ?? (node.status as StepState)) ?? "pending"] ?? "pending",
        ...(live && node.stepIndex !== undefined ? { runId: childPanelId(status.runId, live, node.stepIndex) } : {}),
        ...opt(live?.model, "model"),
        ...(live ? { usage: usageOfStep(live) } : {}),
        ...opt(iso(live?.startedAt), "startedAt"),
        ...opt(iso(live?.endedAt), "endedAt"),
      });
    }
  };
  walk(graph.nodes, undefined);
  return out;
}

/**
 * The order the trace actually ran things in, as `key → position`.
 *
 * `subagent.workflow.trace` is cumulative and replaces the previous trace
 * (R10), and it carries no timestamps — the array order *is* the order, and it
 * is the only ordering a scripted workflow leaves behind. First mention wins,
 * because a key reappears every time its lane changes state.
 */
function traceOrder(status: AsyncStatus): Map<string, number> {
  const order = new Map<string, number>();
  for (const entry of status.workflowTrace ?? []) {
    if (entry.key === undefined || order.has(entry.key)) continue;
    order.set(entry.key, order.size);
  }
  return order;
}

/**
 * The inferred plan. Preflight lanes are the declared *intent* (they ship with
 * a `workflowScript` launch); the steps are what actually ran. Joining them by
 * `workflowKey` gives every lane a row even before its child starts, and the
 * trace supplies the ordering pi-subagents never persisted — lanes it has not
 * mentioned keep their declaration order, behind the ones it has.
 */
function stepsFromLanes(status: AsyncStatus): PlanStep[] {
  const byKey = new Map<string, { step: StatusStep; index: number }>();
  status.steps.forEach((step, index) => {
    const key = step.workflowKey ?? step.label;
    if (key !== undefined && !byKey.has(key)) byKey.set(key, { step, index });
  });
  const order = traceOrder(status);
  const declared = status.preflight?.lanes ?? [];
  // A stable sort by trace position: everything the trace never mentioned
  // stays where it was declared, after everything it did.
  const lanes = declared
    .map((lane, i) => ({ lane, i, at: order.get(lane.key) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((entry) => entry.lane);
  const out: PlanStep[] = [];
  const used = new Set<string>();
  for (const lane of lanes) {
    const match = byKey.get(lane.key);
    if (match) used.add(lane.key);
    out.push({
      id: lane.key,
      label: lane.decision ?? lane.key,
      ...opt(lane.mode ? `${lane.mode} lanes` : undefined, "phase"),
      state: match ? (STEP_STATE_OF[match.step.status] ?? "pending") : "pending",
      ...(match ? { runId: childPanelId(status.runId, match.step, match.index) } : {}),
      ...opt(match?.step.model, "model"),
      ...(match ? { usage: usageOfStep(match.step) } : {}),
      ...opt(iso(match?.step.startedAt), "startedAt"),
      ...opt(iso(match?.step.endedAt), "endedAt"),
    });
  }
  status.steps.forEach((step, index) => {
    const key = step.workflowKey ?? step.label;
    if (key !== undefined && used.has(key)) return;
    out.push({
      id: key ?? `step-${index}`,
      label: titleOfStep(step, index, status.steps.length),
      ...opt(step.phase, "phase"),
      state: STEP_STATE_OF[step.status] ?? "pending",
      runId: childPanelId(status.runId, step, index),
      ...opt(step.model, "model"),
      usage: usageOfStep(step),
      ...opt(iso(step.startedAt), "startedAt"),
      ...opt(iso(step.endedAt), "endedAt"),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Acceptance and watchdog (M3-T8)
// ---------------------------------------------------------------------------

const ACCEPTANCE_TROUBLE = new Set(["rejected", "failed", "unverified", "inconclusive"]);
/** Statuses that mean "there was nothing to check". Saying so is noise, not honesty. */
const ACCEPTANCE_QUIET = new Set(["not-required", "not-applicable", "none", "skipped", "auto"]);

function acceptanceReason(ledger: AcceptanceLedger | undefined): string | undefined {
  if (!ledger?.status || ACCEPTANCE_QUIET.has(ledger.status)) return undefined;
  if (!ACCEPTANCE_TROUBLE.has(ledger.status)) return `acceptance ${ledger.status}`;
  const failed = ledger.runtimeChecks?.find((c) => c.status === "failed");
  return failed?.message ? `acceptance ${ledger.status} — ${failed.message}` : `acceptance ${ledger.status}`;
}

/**
 * The acceptance ledger and watchdog for one child, as a `collection` — the
 * kind that exists for exactly this: a set of found things with generic rows
 * (R12a). It is emitted only when there is something to answer for; a run
 * that passed says so in one clause on the run panel instead of taking a
 * second island.
 */
export function checksPanel(parentId: string, title: string, step: Pick<StatusStep, "acceptance" | "watchdog">): CollectionPanel | undefined {
  const ledger = step.acceptance;
  const watch = step.watchdog;
  const trouble = ledger?.status !== undefined && ACCEPTANCE_TROUBLE.has(ledger.status);
  const watchTrouble = watch?.phase !== undefined && watch.phase !== "ok" && watch.phase !== "healthy";
  if (!trouble && !watchTrouble) return undefined;
  const items: CollectionItem[] = [];
  if (watchTrouble && watch) {
    items.push({
      id: "watchdog",
      primary: watch.reason ?? watch.phase ?? "watchdog",
      secondary: "watchdog",
      meta: [{ label: "phase", value: watch.phase ?? "unknown" }],
    });
  }
  for (const check of ledger?.runtimeChecks ?? []) {
    if (!check.id) continue;
    items.push({
      id: check.id,
      primary: check.message ?? check.id,
      secondary: check.id,
      meta: [{ label: "status", value: check.status ?? "unknown" }],
    });
  }
  if (items.length === 0) return undefined;
  return {
    kind: "collection",
    id: checkPanelId(parentId),
    source: PANEL_SOURCE,
    intent: "follow",
    title: `Acceptance · ${title}`,
    layout: "table",
    items,
    total: items.length,
  };
}

// ---------------------------------------------------------------------------
// Steering: the question "Steer" opens
// ---------------------------------------------------------------------------

/**
 * `Action` carries no input field, by design — a verb is an id and a label.
 * So steering a run is two moves: the verb opens this `decision`, and the
 * answer is what gets written to the control inbox. It blocks the turn, not
 * the session, so the conversation keeps going while you type.
 */
export function steerDecision(parentId: string, title: string): DecisionPanel {
  return {
    kind: "decision",
    id: steerDecisionId(parentId),
    source: PANEL_SOURCE,
    intent: "inspect",
    title: `Steer ${title}`,
    message: "The child reads this at its next turn boundary. It keeps working until then.",
    blocking: "turn",
    fields: [{ id: "message", label: "What should it do differently?", type: "longtext", required: true }],
  };
}

/**
 * Resume is the same two moves, and needs them more: pi-subagents refuses a
 * resume with no message, and the run being revived has no idea why it woke up.
 */
export function resumeDecision(parentId: string, title: string): DecisionPanel {
  return {
    kind: "decision",
    id: resumeDecisionId(parentId),
    source: PANEL_SOURCE,
    intent: "inspect",
    title: `Resume ${title}`,
    message: "It picks up its old conversation with this as the new instruction.",
    blocking: "turn",
    fields: [{ id: "message", label: "What should it pick up?", type: "longtext", required: true }],
  };
}

// ---------------------------------------------------------------------------
// The whole run, as panels
// ---------------------------------------------------------------------------

/**
 * Every panel one background run produces, in a stable order. Ids are derived
 * from pi-subagents' identities only, so re-reading the same `status.json`
 * produces byte-identical panels and the store's dedupe (R9) does the rest.
 */
export function panelsForStatus(status: AsyncStatus, options: MapOptions): Panel[] {
  const out: Panel[] = [];
  const plan = planPanel(status, options);
  if (plan) out.push(plan);
  if (status.steps.length <= 1 && !plan) {
    const run = singleRunPanel(status, options);
    out.push(run);
    const checks = checksPanel(run.id, run.title, status.steps[0] ?? {});
    if (checks) out.push(checks);
    return out;
  }
  status.steps.forEach((step, index) => {
    const child = childRunPanel(status, step, index, options);
    out.push(child);
    const checks = checksPanel(child.id, child.title, step);
    if (checks) out.push(checks);
    out.push(...nestedRunPanels(status, step, index, options.caps));
  });
  return out;
}
