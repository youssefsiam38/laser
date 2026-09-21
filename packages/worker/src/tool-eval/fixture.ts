/**
 * What one conformance fixture says (M26-T3, `docs/agent-tool-contract.md` §4).
 *
 * A fixture is one task given to one tool, plus the provider responses a model
 * gave for it: the sequence of tool calls and the final answer. The runner
 * replays those responses through the real engine and the real tool
 * registrations, so the schema validation, the label stripping and the
 * `ToolError` path a measure reads are the product's own, not a simulation of
 * them.
 *
 * The format is deliberately small and declarative, because every tool that
 * lands after this one has to write one: a task, the tools the task may use,
 * a budget, and the recorded steps. Everything else has a default.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isRecord, projectWorkBodySchema, type ProjectWorkBody, type ProjectWorkKind, type ProjectWorkState } from "@lasercode/protocol";
import type { ToolEvalProjectWorkItem } from "./project-work-world.js";

/** How many calls and how much context one task may cost. */
export interface ToolEvalBudget {
  /** Tool calls executed in the whole run, engine tools included. */
  calls: number;
  /** Estimated prompt tokens summed over every provider request of the run. */
  inputTokens: number;
  /** Estimated completion tokens summed over every recorded response. */
  outputTokens: number;
}

/**
 * The measures a fixture is judged by. `schema`, `selection` and `budget`
 * apply to every fixture; the other three are declared by the fixtures that
 * exercise them, because a tool with no destructive path cannot have an
 * unsafe attempt to recover from.
 */
export const TOOL_EVAL_MEASURES = ["schema", "selection", "budget", "retry", "unsafe", "truncation"] as const;
export type ToolEvalMeasureId = (typeof TOOL_EVAL_MEASURES)[number];
/** Applied to every fixture, declared or not. */
export const ALWAYS_MEASURED: readonly ToolEvalMeasureId[] = ["schema", "selection", "budget"];

/**
 * One recorded provider response: a tool call the model made, or its answer.
 *
 * `fails` records what the tool answered when the fixture was recorded. It is
 * not a wish: a recorded run checks every call against it, so a tool that
 * starts failing — or quietly stops refusing — breaks the fixture instead of
 * passing it with the following step answering a result that never came.
 */
export type RecordedStep =
  | { toolCall: { name: string; args: Record<string, unknown>; id?: string }; fails?: boolean; delayMs?: number }
  | { text: string; delayMs?: number };

/** One agent the fixture's world already has, as the scripted bridge answers for it. */
export interface ToolEvalWorldAgent {
  agentName: string;
  subagentName: string;
  sessionId: string;
  runId: string;
  /** running, needs_input, completed, blocked, failed or cancelled. */
  status: "running" | "needs_input" | "completed" | "blocked" | "failed" | "cancelled";
  task: string;
  /** How many assistant messages `inspect_agent` can hand back. */
  messageCount?: number;
  /** Whether it was started with a worktree of its own, and whether that branch still holds work. */
  worktree?: { branch: string; unmergedCommits?: number };
  /** The question it is paused on, when its status is needs_input. */
  question?: { text: string };
}

/**
 * The project a Design Index fixture is evaluated against (M21-T10).
 *
 * Unlike the fleet, this world is not scripted: it is a copy of one of the
 * design fixtures under `test/fixtures/design/`, indexed by the real builder.
 * A parse-only tool can be evaluated against the real thing.
 */
export interface ToolEvalDesignWorld {
  /** The directory name under `test/fixtures/design/`. */
  project: string;
  /** Whether the index has already been built when the run starts. */
  built?: boolean;
}

/**
 * The research run a Research fixture is evaluated against (M21-T26).
 *
 * Like the design world it is mostly real — real adapters, real cache, real
 * budget, real operation applier — with the three things a test may not do
 * replayed from recordings under `test/fixtures/research/`: the network, the
 * person's search provider and git.
 */
export interface ToolEvalResearchWorld {
  /** The project directory under `test/fixtures/research/`. */
  project?: string;
  /** Adapters switched off for this run, to exercise the capability gate. */
  disabledAdapters?: string[];
  /** False when no search provider is connected. */
  searchConnected?: boolean;
}

/**
 * The project work a lifecycle fixture is evaluated against (M21-T17).
 *
 * Real tools, real specs, real handlers; the one substitution is the host,
 * because an evaluation must not write into a person's own project work.
 * `hasProject: false` is the projectless chat, which gets the read tool only.
 */
export interface ToolEvalProjectWorkWorld {
  /** The items the project already has, with their typed bodies. */
  items?: ToolEvalProjectWorkItem[];
  /** False for a projectless chat. Default true. */
  hasProject?: boolean;
  /** The Task this session is an attempt on, by key. */
  taskKey?: string;
}

/** The state the scripted harness bridge answers from. No real agent is started. */
export interface ToolEvalWorld {
  /** root: the parent tools are registered. child: only `complete_agent_run` is. */
  role?: "root" | "child";
  /** The agents `start_agent` may start, as the catalog in its description. */
  catalog?: Array<{ agentName: string; description: string }>;
  agents?: ToolEvalWorldAgent[];
  /**
   * `unconnected` registers `web_search` with no usable search provider, which
   * is how the one external tool is evaluated without leaving the machine: the
   * refusal is the real one a person with no connected provider gets. `off`
   * (the default) does not offer the tool at all.
   */
  search?: "unconnected" | "off";
  /** Present for the Design Index tools; absent for every other fixture. */
  designIndex?: ToolEvalDesignWorld;
  /** Present for the Research tools; absent for every other fixture. */
  research?: ToolEvalResearchWorld;
  /** Present for the four lifecycle tools; absent for every other fixture. */
  projectWork?: ToolEvalProjectWorkWorld;
}

export interface ToolEvalFixture {
  /** The Laser tool this fixture is the conformance fixture for. */
  tool: string;
  /** The task, as a person would write it. Sent for real; the stub answers it from `steps`. */
  task: string;
  /** The tool that answers the task. */
  expectedTool: string;
  /** Every tool this task may legitimately use, the expected one included. */
  allowedTools: string[];
  /** The most calls outside `allowedTools`, as a share of all calls. 0 means none. */
  wrongToolThreshold: number;
  budget: ToolEvalBudget;
  measures: ToolEvalMeasureId[];
  /** A result longer than this counts as truncated for the truncation measure. */
  truncationBytes?: number;
  world: ToolEvalWorld;
  steps: RecordedStep[];
  /** Where it was read from, for the report. Filled in by the loader. */
  source?: string;
}

function fail(source: string, what: string): never {
  throw new Error(`${source} is not a usable tool-evaluation fixture: ${what}`);
}

function requireString(value: unknown, source: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(source, `${field} must be a non-empty string.`);
  return value;
}

function requireNumber(value: unknown, source: string, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(source, `${field} must be a number of zero or more.`);
  return value;
}

function parseStep(value: unknown, source: string, index: number): RecordedStep {
  if (!isRecord(value)) fail(source, `steps[${String(index)}] must be an object.`);
  const delay = value["delayMs"] === undefined ? {} : { delayMs: requireNumber(value["delayMs"], source, `steps[${String(index)}].delayMs`) };
  if (value["text"] !== undefined) return { text: requireString(value["text"], source, `steps[${String(index)}].text`), ...delay };
  const call = value["toolCall"];
  if (!isRecord(call)) fail(source, `steps[${String(index)}] must carry either text or toolCall.`);
  const args = call["args"];
  if (args !== undefined && !isRecord(args)) fail(source, `steps[${String(index)}].toolCall.args must be an object.`);
  if (value["fails"] !== undefined && typeof value["fails"] !== "boolean") fail(source, `steps[${String(index)}].fails must be true or false.`);
  return {
    toolCall: {
      name: requireString(call["name"], source, `steps[${String(index)}].toolCall.name`),
      args: isRecord(args) ? args : {},
      ...(call["id"] !== undefined ? { id: requireString(call["id"], source, `steps[${String(index)}].toolCall.id`) } : {}),
    },
    ...(value["fails"] === true ? { fails: true } : {}),
    ...delay,
  };
}

/** The statuses the scripted world knows an agent can be in. */
const WORLD_STATUSES = ["running", "needs_input", "completed", "blocked", "failed", "cancelled"] as const;

/**
 * The world, checked field by field like every other part of the fixture.
 *
 * It used to be cast: a typo in `agents[0].statuss` or a `role` of `"parent"`
 * reached `ScriptedWorld` as a shape it does not answer for, and the run
 * failed somewhere far from the file that caused it. A fixture is data a
 * person writes by hand, so the refusal names the field.
 */
function parseWorld(value: unknown, source: string): ToolEvalWorld {
  if (value === undefined) return {};
  if (!isRecord(value)) fail(source, "world must be an object.");
  const role = value["role"];
  if (role !== undefined && role !== "root" && role !== "child") fail(source, 'world.role must be "root" or "child".');
  const search = value["search"];
  if (search !== undefined && search !== "unconnected" && search !== "off") fail(source, 'world.search must be "unconnected" or "off".');
  const catalog = value["catalog"];
  if (catalog !== undefined && !Array.isArray(catalog)) fail(source, "world.catalog must be a list of agents.");
  const agents = value["agents"];
  if (agents !== undefined && !Array.isArray(agents)) fail(source, "world.agents must be a list of agents.");
  const designIndex = value["designIndex"];
  let design: ToolEvalDesignWorld | undefined;
  if (designIndex !== undefined) {
    if (!isRecord(designIndex)) fail(source, "world.designIndex must be an object.");
    const built = designIndex["built"];
    if (built !== undefined && typeof built !== "boolean") fail(source, "world.designIndex.built must be true or false.");
    design = { project: requireString(designIndex["project"], source, "world.designIndex.project"), ...(built !== undefined ? { built } : {}) };
  }
  const researchValue = value["research"];
  let research: ToolEvalResearchWorld | undefined;
  if (researchValue !== undefined) {
    if (!isRecord(researchValue)) fail(source, "world.research must be an object.");
    const project = researchValue["project"];
    if (project !== undefined && typeof project !== "string") fail(source, "world.research.project must be a directory name.");
    const disabled = researchValue["disabledAdapters"];
    if (disabled !== undefined && (!Array.isArray(disabled) || disabled.some((entry) => typeof entry !== "string"))) {
      fail(source, "world.research.disabledAdapters must be a list of adapter names.");
    }
    const connected = researchValue["searchConnected"];
    if (connected !== undefined && typeof connected !== "boolean") fail(source, "world.research.searchConnected must be true or false.");
    research = {
      ...(typeof project === "string" ? { project } : {}),
      ...(Array.isArray(disabled) ? { disabledAdapters: disabled as string[] } : {}),
      ...(typeof connected === "boolean" ? { searchConnected: connected } : {}),
    };
  }
  const projectWorkValue = value["projectWork"];
  let projectWork: ToolEvalProjectWorkWorld | undefined;
  if (projectWorkValue !== undefined) {
    if (!isRecord(projectWorkValue)) fail(source, "world.projectWork must be an object.");
    const items = projectWorkValue["items"];
    if (items !== undefined && !Array.isArray(items)) fail(source, "world.projectWork.items must be a list.");
    const hasProject = projectWorkValue["hasProject"];
    if (hasProject !== undefined && typeof hasProject !== "boolean") fail(source, "world.projectWork.hasProject must be true or false.");
    const taskKey = projectWorkValue["taskKey"];
    if (taskKey !== undefined && typeof taskKey !== "string") fail(source, "world.projectWork.taskKey must be a key like TASK-1.");
    projectWork = {
      ...(Array.isArray(items) ? { items: items.map((entry, index) => parseProjectWorkItem(entry, source, index)) } : {}),
      ...(typeof hasProject === "boolean" ? { hasProject } : {}),
      ...(typeof taskKey === "string" ? { taskKey } : {}),
    };
  }
  return {
    ...(design !== undefined ? { designIndex: design } : {}),
    ...(research !== undefined ? { research } : {}),
    ...(projectWork !== undefined ? { projectWork } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(search !== undefined ? { search } : {}),
    ...(catalog !== undefined
      ? {
          catalog: catalog.map((entry, index) => {
            if (!isRecord(entry)) fail(source, `world.catalog[${String(index)}] must be an object.`);
            return {
              agentName: requireString(entry["agentName"], source, `world.catalog[${String(index)}].agentName`),
              description: requireString(entry["description"], source, `world.catalog[${String(index)}].description`),
            };
          }),
        }
      : {}),
    ...(agents !== undefined ? { agents: agents.map((entry, index) => parseWorldAgent(entry, source, index)) } : {}),
  };
}

/**
 * One item of a lifecycle fixture's project. The body is validated against
 * the protocol's own schema here, so a fixture whose body is wrong fails at
 * the file that wrote it rather than inside a tool call.
 */
function parseProjectWorkItem(value: unknown, source: string, index: number): ToolEvalProjectWorkItem {
  const at = `world.projectWork.items[${String(index)}]`;
  if (!isRecord(value)) fail(source, `${at} must be an object.`);
  const parsed = projectWorkBodySchema.safeParse(value["body"]);
  if (!parsed.success) fail(source, `${at}.body is not a valid body: ${parsed.error.issues[0]?.message ?? "it does not match any kind"}.`);
  const comments = value["comments"];
  if (comments !== undefined && !Array.isArray(comments)) fail(source, `${at}.comments must be a list.`);
  const state = value["state"];
  if (state !== undefined && typeof state !== "string") fail(source, `${at}.state must be a state name.`);
  return {
    kind: requireString(value["kind"], source, `${at}.kind`) as ProjectWorkKind,
    title: requireString(value["title"], source, `${at}.title`),
    body: parsed.data as ProjectWorkBody,
    ...(typeof state === "string" ? { state: state as ProjectWorkState } : {}),
    ...(Array.isArray(comments)
      ? {
          comments: comments.map((entry, position) => {
            if (!isRecord(entry)) fail(source, `${at}.comments[${String(position)}] must be an object.`);
            return {
              text: requireString(entry["text"], source, `${at}.comments[${String(position)}].text`),
              ...(entry["blocking"] === true ? { blocking: true } : {}),
            };
          }),
        }
      : {}),
  };
}

function parseWorldAgent(value: unknown, source: string, index: number): ToolEvalWorldAgent {
  const at = `world.agents[${String(index)}]`;
  if (!isRecord(value)) fail(source, `${at} must be an object.`);
  const status = value["status"];
  if (typeof status !== "string" || !(WORLD_STATUSES as readonly string[]).includes(status)) {
    fail(source, `${at}.status must be one of ${WORLD_STATUSES.join(", ")}.`);
  }
  const worktree = value["worktree"];
  if (worktree !== undefined && !isRecord(worktree)) fail(source, `${at}.worktree must be an object.`);
  const question = value["question"];
  if (question !== undefined && !isRecord(question)) fail(source, `${at}.question must be an object.`);
  return {
    agentName: requireString(value["agentName"], source, `${at}.agentName`),
    subagentName: requireString(value["subagentName"], source, `${at}.subagentName`),
    sessionId: requireString(value["sessionId"], source, `${at}.sessionId`),
    runId: requireString(value["runId"], source, `${at}.runId`),
    status: status as ToolEvalWorldAgent["status"],
    task: requireString(value["task"], source, `${at}.task`),
    ...(value["messageCount"] !== undefined ? { messageCount: requireNumber(value["messageCount"], source, `${at}.messageCount`) } : {}),
    ...(isRecord(worktree)
      ? {
          worktree: {
            branch: requireString(worktree["branch"], source, `${at}.worktree.branch`),
            ...(worktree["unmergedCommits"] !== undefined ? { unmergedCommits: requireNumber(worktree["unmergedCommits"], source, `${at}.worktree.unmergedCommits`) } : {}),
          },
        }
      : {}),
    ...(isRecord(question) ? { question: { text: requireString(question["text"], source, `${at}.question.text`) } } : {}),
  };
}

/**
 * Read one fixture, refusing anything the runner could only half-understand.
 * A fixture is data a person writes by hand, so every refusal names the field.
 */
export function parseFixture(value: unknown, source: string): ToolEvalFixture {
  if (!isRecord(value)) fail(source, "the file must hold a JSON object.");
  const tool = requireString(value["tool"], source, "tool");
  const allowed = value["allowedTools"];
  if (!Array.isArray(allowed) || allowed.length === 0) fail(source, "allowedTools must list at least the expected tool.");
  const budget = value["budget"];
  if (!isRecord(budget)) fail(source, "budget must declare calls, inputTokens and outputTokens.");
  const steps = value["steps"];
  if (!Array.isArray(steps) || steps.length === 0) fail(source, "steps must hold at least one recorded response.");
  const declared = value["measures"];
  if (declared !== undefined && !Array.isArray(declared)) fail(source, "measures must be a list.");
  const measures = new Set<ToolEvalMeasureId>(ALWAYS_MEASURED);
  for (const measure of (declared ?? []) as unknown[]) {
    const name = requireString(measure, source, "measures[]");
    if (!(TOOL_EVAL_MEASURES as readonly string[]).includes(name)) fail(source, `"${name}" is not a measure; the measures are ${TOOL_EVAL_MEASURES.join(", ")}.`);
    measures.add(name as ToolEvalMeasureId);
  }
  const world = parseWorld(value["world"], source);
  const expected = requireString(value["expectedTool"], source, "expectedTool");
  const allowedTools = allowed.map((entry, index) => requireString(entry, source, `allowedTools[${String(index)}]`));
  if (!allowedTools.includes(expected)) fail(source, "allowedTools must contain expectedTool.");
  return {
    tool,
    task: requireString(value["task"], source, "task"),
    expectedTool: expected,
    allowedTools,
    wrongToolThreshold: value["wrongToolThreshold"] === undefined ? 0 : requireNumber(value["wrongToolThreshold"], source, "wrongToolThreshold"),
    budget: {
      calls: requireNumber(budget["calls"], source, "budget.calls"),
      inputTokens: requireNumber(budget["inputTokens"], source, "budget.inputTokens"),
      outputTokens: requireNumber(budget["outputTokens"], source, "budget.outputTokens"),
    },
    measures: TOOL_EVAL_MEASURES.filter((measure) => measures.has(measure)),
    ...(value["truncationBytes"] !== undefined ? { truncationBytes: requireNumber(value["truncationBytes"], source, "truncationBytes") } : {}),
    world,
    steps: steps.map((step, index) => parseStep(step, source, index)),
    source,
  };
}

/** Every fixture in a directory, in a stable order. */
export function loadFixtures(directory: string): ToolEvalFixture[] {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error(`No tool-evaluation fixtures were found in ${directory}.`);
  return files.map((name) => {
    const path = join(directory, name);
    return parseFixture(JSON.parse(readFileSync(path, "utf8")), path);
  });
}
