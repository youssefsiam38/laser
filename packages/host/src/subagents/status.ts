/**
 * The pi-subagents 0.65 on-disk vocabulary, parsed defensively (M3-T2).
 *
 * This file is the *only* place that knows what `status.json` looks like. It
 * declares the subset piorbit reads, parses it without trusting a single field,
 * and exposes nothing that is not verified against the real files on disk. Its
 * shapes are a strict subset of `pi-subagents/src/shared/types.ts` `AsyncStatus`
 * (0.65.0, read 2026-09-05); every field below was seen in a real run under
 * `/tmp/pi-subagents-uid-*`.
 *
 * Rules that come from the format, not from us:
 *   - `status.json` is written atomically (temp + rename), so a parse failure
 *     is a foreign file, never a torn write. We treat it as "unknown", not as
 *     "finished" (reaping a live run is much worse than a stale card).
 *   - `events.jsonl` is append-only and carries NO text deltas. The richest
 *     per-child state is in `status.json`; events only tell us *when* to re-read
 *     and carry `subagent.workflow.trace`, which is cumulative and REPLACES the
 *     previous trace (R10: replace by index, never append).
 *   - Foreground children write no status file. They have
 *     `<agent-artifacts>/{runId}_{agent}[_{n}]_transcript.jsonl` from the first
 *     token and `..._meta.json` once they finish.
 */

/** pi-subagents run-level states. */
export type RunState = "queued" | "running" | "complete" | "failed" | "partial" | "paused" | "stopped" | "rejected";

/** pi-subagents step-level states. `completed` is an alias of `complete` in its own schema. */
export type StepState = RunState | "pending" | "completed" | "detached";

export interface TokenUsage {
  input?: number;
  output?: number;
  total?: number;
  window?: number;
  windowPeak?: number;
}

/** `modelAttempts[].usage` — the only place cache reads and cost are recorded. */
export interface AttemptUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  turns?: number;
}

export interface ModelAttempt {
  model?: string;
  success?: boolean;
  exitCode?: number | null;
  error?: string;
  usage?: AttemptUsage;
}

export interface CostSummary {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface WatchdogProgress {
  /** "stale", "blocked", … — pi-subagents' own word for the child's health. */
  phase?: string;
  reason?: string;
  lastUpdate?: number;
}

export interface AcceptanceCheck {
  id?: string;
  status?: string;
  message?: string;
}

export interface AcceptanceLedger {
  status?: string;
  evidenceStatus?: string;
  runtimeChecks?: AcceptanceCheck[];
}

export interface RecentTool {
  tool?: string;
  args?: string;
  endMs?: number;
}

export interface NestedRun {
  id?: string;
  agent?: string;
  state?: StepState;
  model?: string;
  startedAt?: number;
  endedAt?: number;
  sessionFile?: string;
  totalTokens?: TokenUsage;
  error?: string;
}

export interface StatusStep {
  /** Stable caller-facing child identity for status/stop/steer. */
  childId?: string;
  agent?: string;
  sessionName?: string;
  description?: string;
  phase?: string;
  label?: string;
  workflowKey?: string;
  runId?: string;
  async?: boolean;
  status: StepState;
  stopRequested?: boolean;
  children?: NestedRun[];
  sessionFile?: string;
  transcriptPath?: string;
  currentTool?: string;
  currentPath?: string;
  recentTools?: RecentTool[];
  recentOutput?: string[];
  turnCount?: number;
  toolCount?: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  stopped?: boolean;
  toolBudgetBlocked?: boolean;
  contextOverflow?: boolean;
  tokens?: TokenUsage;
  model?: string;
  thinking?: string;
  thinkingCeiling?: string;
  attemptedModels?: string[];
  modelAttempts?: ModelAttempt[];
  totalCost?: CostSummary;
  error?: string;
  structuredOutputPath?: string;
  acceptance?: AcceptanceLedger;
  watchdog?: WatchdogProgress;
}

export interface PreflightLane {
  key: string;
  mode?: string;
  decision?: string;
  claims?: string[];
  expectedOutput?: string;
  independence?: string;
}

export interface WorkflowTraceEntry {
  operation?: string;
  key?: string;
  state?: string;
  agent?: string;
  error?: string;
}

export interface WorkflowGraphNode {
  id: string;
  kind?: string;
  agent?: string;
  phase?: string;
  label?: string;
  status?: string;
  stepIndex?: number;
  children?: WorkflowGraphNode[];
}

export interface WorkflowGraph {
  runId?: string;
  phases?: Array<{ title?: string; nodeIds?: string[] }>;
  nodes?: WorkflowGraphNode[];
  currentNodeId?: string;
}

export interface AsyncStatus {
  runId: string;
  /** Absolute directory the run lives in. Not in the file; filled by the reader. */
  dir: string;
  /** Parent Pi session *file path*, which is piorbit's session `path`. */
  sessionId?: string;
  cwd?: string;
  mode: "single" | "parallel" | "chain" | "workflow";
  state: RunState;
  error?: string;
  pid?: number;
  startedAt?: number;
  endedAt?: number;
  lastUpdate?: number;
  lastActivityAt?: number;
  currentStep?: number;
  chainStepCount?: number;
  timedOut?: boolean;
  stopped?: boolean;
  isNested?: boolean;
  steps: StatusStep[];
  preflight?: { coverage?: string; lanes: PreflightLane[] };
  workflowGraph?: WorkflowGraph;
  workflowTrace?: WorkflowTraceEntry[];
  totalTokens?: TokenUsage;
  totalCost?: CostSummary;
  outputFile?: string;
  sessionFile?: string;
  /** A durable schedule launched this run. */
  scheduleOrigin?: { id?: string; name?: string };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const RUN_STATES = new Set<string>(["queued", "running", "complete", "failed", "partial", "paused", "stopped", "rejected"]);
const STEP_STATES = new Set<string>([...RUN_STATES, "pending", "completed", "detached"]);
const MODES = new Set<string>(["single", "parallel", "chain", "workflow"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Drop `undefined` so `exactOptionalPropertyTypes` stays happy on spread. */
const put = <T>(value: T | undefined, key: string): Record<string, T> =>
  value === undefined ? {} : ({ [key]: value } as Record<string, T>);

const strings = (v: unknown, cap = 32): string[] =>
  arr(v)
    .map(str)
    .filter((s): s is string => s !== undefined)
    .slice(0, cap);

function tokenUsage(v: unknown): TokenUsage | undefined {
  const o = rec(v);
  if (!o) return undefined;
  const usage: TokenUsage = {
    ...put(num(o.input), "input"),
    ...put(num(o.output), "output"),
    ...put(num(o.total), "total"),
    ...put(num(o.window), "window"),
    ...put(num(o.windowPeak), "windowPeak"),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function attemptUsage(v: unknown): AttemptUsage | undefined {
  const o = rec(v);
  if (!o) return undefined;
  const usage: AttemptUsage = {
    ...put(num(o.input), "input"),
    ...put(num(o.output), "output"),
    ...put(num(o.cacheRead), "cacheRead"),
    ...put(num(o.cacheWrite), "cacheWrite"),
    ...put(num(o.cost), "cost"),
    ...put(num(o.turns), "turns"),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function costSummary(v: unknown): CostSummary | undefined {
  const o = rec(v);
  if (!o) return undefined;
  const cost: CostSummary = {
    ...put(num(o.inputTokens), "inputTokens"),
    ...put(num(o.outputTokens), "outputTokens"),
    ...put(num(o.costUsd), "costUsd"),
  };
  return Object.keys(cost).length > 0 ? cost : undefined;
}

function modelAttempts(v: unknown): ModelAttempt[] | undefined {
  const out = arr(v)
    .slice(0, 8)
    .map((raw): ModelAttempt | undefined => {
      const o = rec(raw);
      if (!o) return undefined;
      return {
        ...put(str(o.model), "model"),
        ...put(bool(o.success), "success"),
        ...(typeof o.exitCode === "number" || o.exitCode === null ? { exitCode: o.exitCode as number | null } : {}),
        ...put(str(o.error), "error"),
        ...put(attemptUsage(o.usage), "usage"),
      };
    })
    .filter((a): a is ModelAttempt => a !== undefined);
  return out.length > 0 ? out : undefined;
}

function nestedRuns(v: unknown): NestedRun[] | undefined {
  const out = arr(v)
    .slice(0, 32)
    .map((raw): NestedRun | undefined => {
      const o = rec(raw);
      if (!o) return undefined;
      const state = str(o.state);
      return {
        ...put(str(o.id), "id"),
        ...put(str(o.agent), "agent"),
        ...(state && STEP_STATES.has(state) ? { state: state as StepState } : {}),
        ...put(str(o.model), "model"),
        ...put(num(o.startedAt), "startedAt"),
        ...put(num(o.endedAt), "endedAt"),
        ...put(str(o.sessionFile), "sessionFile"),
        ...put(tokenUsage(o.totalTokens), "totalTokens"),
        ...put(str(o.error), "error"),
      };
    })
    .filter((n): n is NestedRun => n !== undefined);
  return out.length > 0 ? out : undefined;
}

function recentTools(v: unknown): RecentTool[] | undefined {
  const out = arr(v)
    .slice(-8)
    .map((raw): RecentTool | undefined => {
      const o = rec(raw);
      if (!o) return undefined;
      return { ...put(str(o.tool), "tool"), ...put(str(o.args), "args"), ...put(num(o.endMs), "endMs") };
    })
    .filter((t): t is RecentTool => t !== undefined);
  return out.length > 0 ? out : undefined;
}

function acceptance(v: unknown): AcceptanceLedger | undefined {
  const o = rec(v);
  if (!o) return undefined;
  const checks = arr(o.runtimeChecks)
    .slice(0, 24)
    .map((raw): AcceptanceCheck | undefined => {
      const c = rec(raw);
      if (!c) return undefined;
      return { ...put(str(c.id), "id"), ...put(str(c.status), "status"), ...put(str(c.message), "message") };
    })
    .filter((c): c is AcceptanceCheck => c !== undefined);
  const ledger: AcceptanceLedger = {
    ...put(str(o.status), "status"),
    ...put(str(o.evidenceStatus), "evidenceStatus"),
    ...(checks.length > 0 ? { runtimeChecks: checks } : {}),
  };
  return Object.keys(ledger).length > 0 ? ledger : undefined;
}

function watchdog(v: unknown): WatchdogProgress | undefined {
  const o = rec(v);
  if (!o) return undefined;
  const w: WatchdogProgress = {
    ...put(str(o.phase), "phase"),
    ...put(str(o.reason), "reason"),
    ...put(num(o.lastUpdate), "lastUpdate"),
  };
  return Object.keys(w).length > 0 ? w : undefined;
}

function step(raw: unknown): StatusStep | undefined {
  const o = rec(raw);
  if (!o) return undefined;
  const status = str(o.status);
  return {
    status: status && STEP_STATES.has(status) ? (status as StepState) : "pending",
    ...put(str(o.childId), "childId"),
    ...put(str(o.agent), "agent"),
    ...put(str(o.sessionName), "sessionName"),
    ...put(str(o.description), "description"),
    ...put(str(o.phase), "phase"),
    ...put(str(o.label), "label"),
    ...put(str(o.workflowKey), "workflowKey"),
    ...put(str(o.runId), "runId"),
    ...put(bool(o.async), "async"),
    ...put(bool(o.stopRequested), "stopRequested"),
    ...put(nestedRuns(o.children), "children"),
    ...put(str(o.sessionFile), "sessionFile"),
    ...put(str(o.transcriptPath), "transcriptPath"),
    ...put(str(o.currentTool), "currentTool"),
    ...put(str(o.currentPath), "currentPath"),
    ...put(recentTools(o.recentTools), "recentTools"),
    ...(strings(o.recentOutput, 4).length > 0 ? { recentOutput: strings(o.recentOutput, 4) } : {}),
    ...put(num(o.turnCount), "turnCount"),
    ...put(num(o.toolCount), "toolCount"),
    ...put(num(o.startedAt), "startedAt"),
    ...put(num(o.endedAt), "endedAt"),
    ...put(num(o.durationMs), "durationMs"),
    ...(typeof o.exitCode === "number" || o.exitCode === null ? { exitCode: o.exitCode as number | null } : {}),
    ...put(bool(o.timedOut), "timedOut"),
    ...put(bool(o.stopped), "stopped"),
    ...put(bool(o.toolBudgetBlocked), "toolBudgetBlocked"),
    ...put(bool(o.contextOverflow), "contextOverflow"),
    ...put(tokenUsage(o.tokens), "tokens"),
    ...put(str(o.model), "model"),
    ...put(str(o.thinking), "thinking"),
    ...put(str(o.thinkingCeiling), "thinkingCeiling"),
    ...(strings(o.attemptedModels, 8).length > 0 ? { attemptedModels: strings(o.attemptedModels, 8) } : {}),
    ...put(modelAttempts(o.modelAttempts), "modelAttempts"),
    ...put(costSummary(o.totalCost), "totalCost"),
    ...put(str(o.error), "error"),
    ...put(str(o.structuredOutputPath), "structuredOutputPath"),
    ...put(acceptance(o.acceptance), "acceptance"),
    ...put(watchdog(o.watchdog), "watchdog"),
  };
}

function preflight(v: unknown): AsyncStatus["preflight"] {
  const o = rec(v);
  if (!o) return undefined;
  const lanes = arr(o.lanes)
    .slice(0, 64)
    .map((raw): PreflightLane | undefined => {
      const l = rec(raw);
      const key = l ? str(l.key) : undefined;
      if (!l || !key) return undefined;
      return {
        key,
        ...put(str(l.mode), "mode"),
        ...put(str(l.decision), "decision"),
        ...(strings(l.claims, 8).length > 0 ? { claims: strings(l.claims, 8) } : {}),
        ...put(str(l.expectedOutput), "expectedOutput"),
        ...put(str(l.independence), "independence"),
      };
    })
    .filter((l): l is PreflightLane => l !== undefined);
  if (lanes.length === 0) return undefined;
  return { ...put(str(o.coverage), "coverage"), lanes };
}

function graphNodes(v: unknown, depth = 0): WorkflowGraphNode[] | undefined {
  if (depth > 4) return undefined;
  const out = arr(v)
    .slice(0, 128)
    .map((raw): WorkflowGraphNode | undefined => {
      const o = rec(raw);
      const id = o ? str(o.id) : undefined;
      if (!o || !id) return undefined;
      return {
        id,
        ...put(str(o.kind), "kind"),
        ...put(str(o.agent), "agent"),
        ...put(str(o.phase), "phase"),
        ...put(str(o.label), "label"),
        ...put(str(o.status), "status"),
        ...put(num(o.stepIndex), "stepIndex"),
        ...put(graphNodes(o.children, depth + 1), "children"),
      };
    })
    .filter((n): n is WorkflowGraphNode => n !== undefined);
  return out.length > 0 ? out : undefined;
}

function workflowGraph(v: unknown): WorkflowGraph | undefined {
  const o = rec(v);
  if (!o) return undefined;
  const nodes = graphNodes(o.nodes);
  if (!nodes) return undefined;
  const phases = arr(o.phases)
    .slice(0, 32)
    .map((raw) => {
      const p = rec(raw);
      if (!p) return undefined;
      return { ...put(str(p.title), "title"), ...(strings(p.nodeIds, 128).length > 0 ? { nodeIds: strings(p.nodeIds, 128) } : {}) };
    })
    .filter((p): p is { title?: string; nodeIds?: string[] } => p !== undefined);
  return {
    ...put(str(o.runId), "runId"),
    ...(phases.length > 0 ? { phases } : {}),
    nodes,
    ...put(str(o.currentNodeId), "currentNodeId"),
  };
}

export function workflowTrace(v: unknown): WorkflowTraceEntry[] | undefined {
  const out = arr(v)
    .slice(0, 256)
    .map((raw): WorkflowTraceEntry | undefined => {
      const o = rec(raw);
      if (!o) return undefined;
      return {
        ...put(str(o.operation), "operation"),
        ...put(str(o.key), "key"),
        ...put(str(o.state), "state"),
        ...put(str(o.agent), "agent"),
        ...put(str(o.error), "error"),
      };
    })
    .filter((t): t is WorkflowTraceEntry => t !== undefined);
  return out.length > 0 ? out : undefined;
}

/**
 * Parse a `status.json` payload. Returns undefined for anything that is not a
 * pi-subagents run: a foreign file in the runs directory must not become a
 * panel, and a half-recognised one must not become a *wrong* panel.
 */
export function parseStatus(raw: unknown, dir: string, fallbackRunId: string): AsyncStatus | undefined {
  const o = rec(raw);
  if (!o) return undefined;
  const state = str(o.state);
  if (!state || !RUN_STATES.has(state)) return undefined;
  const mode = str(o.mode);
  const steps = arr(o.steps)
    .slice(0, 256)
    .map(step)
    .filter((s): s is StatusStep => s !== undefined);
  const workflow = rec(o.workflow);
  return {
    runId: str(o.runId) ?? fallbackRunId,
    dir,
    state: state as RunState,
    mode: mode && MODES.has(mode) ? (mode as AsyncStatus["mode"]) : "single",
    steps,
    ...put(str(o.sessionId), "sessionId"),
    ...put(str(o.cwd), "cwd"),
    ...put(str(o.error), "error"),
    ...put(num(o.pid), "pid"),
    ...put(num(o.startedAt), "startedAt"),
    ...put(num(o.endedAt), "endedAt"),
    ...put(num(o.lastUpdate), "lastUpdate"),
    ...put(num(o.lastActivityAt), "lastActivityAt"),
    ...put(num(o.currentStep), "currentStep"),
    ...put(num(o.chainStepCount), "chainStepCount"),
    ...put(bool(o.timedOut), "timedOut"),
    ...put(bool(o.stopped), "stopped"),
    ...put(bool(o.isNested), "isNested"),
    ...put(preflight(o.preflight), "preflight"),
    ...put(workflowGraph(o.workflowGraph), "workflowGraph"),
    ...put(workflow ? workflowTrace(workflow.trace) : undefined, "workflowTrace"),
    ...put(tokenUsage(o.totalTokens), "totalTokens"),
    ...put(costSummary(o.totalCost), "totalCost"),
    ...put(str(o.outputFile), "outputFile"),
    ...put(str(o.sessionFile), "sessionFile"),
    ...put(
      (() => {
        const origin = rec(o.scheduleOrigin);
        if (!origin) return undefined;
        const value = { ...put(str(origin.id), "id"), ...put(str(origin.name), "name") };
        return Object.keys(value).length > 0 ? value : undefined;
      })(),
      "scheduleOrigin",
    ),
  };
}

// ---------------------------------------------------------------------------
// Foreground children
// ---------------------------------------------------------------------------

/**
 * A foreground child, assembled from the two files it does leave behind. There
 * is no status file and no index (docs/research/findings.md), so `live` means
 * "a transcript exists and no `_meta.json` sits beside it yet".
 */
export interface ForegroundChild {
  runId: string;
  agent: string;
  /** Present when pi-subagents numbered the child (`_0_`); absent on single children. */
  index?: number;
  transcriptPath: string;
  /** The `subagent-artifacts` directory this came from. */
  artifactsDir: string;
  cwd?: string;
  startedAt?: number;
  live: boolean;
  meta?: ForegroundMeta;
}

export interface ForegroundMeta {
  exitCode?: number | null;
  model?: string;
  attemptedModels?: string[];
  modelAttempts?: ModelAttempt[];
  usage?: AttemptUsage;
  durationMs?: number;
  toolCount?: number;
  error?: string;
  timestamp?: number;
  acceptance?: AcceptanceLedger;
  outputPath?: string;
}

/**
 * `<runId>_<agent>[_<n>]_transcript.jsonl` — the only naming pi-subagents 0.65
 * uses. The run id is a uuid and carries no underscore, which is what lets an
 * agent name that does contain one still parse.
 */
const TRANSCRIPT_NAME = /^([^_]+)_(.+?)(?:_(\d+))?_transcript\.jsonl$/;

export function parseTranscriptName(fileName: string): { runId: string; agent: string; index?: number } | undefined {
  const match = TRANSCRIPT_NAME.exec(fileName);
  if (!match) return undefined;
  const [, runId, agent, index] = match;
  if (!runId || !agent) return undefined;
  return { runId, agent, ...(index !== undefined ? { index: Number(index) } : {}) };
}

/** The sibling of a transcript: `<prefix>_meta.json`, `<prefix>_output.md`. */
export function artifactSibling(transcriptFile: string, suffix: "meta.json" | "output.md" | "input.md"): string {
  return transcriptFile.replace(/_transcript\.jsonl$/, `_${suffix}`);
}

export function parseForegroundMeta(raw: unknown): ForegroundMeta | undefined {
  const o = rec(raw);
  if (!o) return undefined;
  return {
    ...(typeof o.exitCode === "number" || o.exitCode === null ? { exitCode: o.exitCode as number | null } : {}),
    ...put(str(o.model), "model"),
    ...(strings(o.attemptedModels, 8).length > 0 ? { attemptedModels: strings(o.attemptedModels, 8) } : {}),
    ...put(modelAttempts(o.modelAttempts), "modelAttempts"),
    ...put(attemptUsage(o.usage), "usage"),
    ...put(num(o.durationMs), "durationMs"),
    ...put(num(o.toolCount), "toolCount"),
    ...put(str(o.error), "error"),
    ...put(num(o.timestamp), "timestamp"),
    ...put(acceptance(o.acceptance), "acceptance"),
  };
}

/**
 * The first record of a foreground transcript carries the child's identity. It
 * is written with the first token, so a live child is discoverable from it
 * before anything else exists.
 */
export function parseTranscriptHeader(line: string): { runId?: string; agent?: string; cwd?: string; ts?: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const o = rec(parsed);
  if (!o) return undefined;
  return {
    ...put(str(o.runId), "runId"),
    ...put(str(o.agent), "agent"),
    ...put(str(o.cwd), "cwd"),
    ...put(num(o.ts), "ts"),
  };
}
