/**
 * One fixture, on one profile, through the real engine.
 *
 * The run is the product's own path end to end: the worker's driver opens a
 * real session in a temporary project, the companion extension registers the
 * real Laser tools (so the schemas the model sees are the registered ones and
 * every refusal is a real `ToolError`), the engine drives the turn, and the
 * only substitutions are the two that must be substituted — the provider,
 * which replays the fixture's recorded responses instead of asking a model,
 * and the harness bridge, which answers from the fixture's world instead of
 * starting real agents. A live run keeps the bridge and drops the recorded
 * provider: the person's own profile, provider and model choose the calls.
 *
 * What the run produces is evidence, not a verdict: every tool call with its
 * arguments and its result, the tokens the turn cost, whether it settled.
 * `measures.ts` turns that into pass or fail.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT_NAME, RESEARCH_ADAPTER_IDS, defaultResearchSources, isRecord, parseToolError, type ModelProfile, type ResearchAdapterId, type ResearchSources, type SessionUpdate, type ToolError } from "@lasercode/protocol";
import { fallbackDefaultAgent, fallbackPolicy } from "../agents/definitions.js";
import { rootRecord } from "../agents/session-config.js";
import { StableSdkDriver } from "../drivers/stable-sdk.js";
import type { DriverAgentOptions, DriverEvent } from "../driver.js";
import type { RecordedStep, ToolEvalFixture } from "./fixture.js";
import { CHARACTERS_PER_TOKEN, estimateTokens, startRecordedProvider, type RecordedProvider } from "./recorded-provider.js";
import { ScriptedWorld } from "./world.js";
import { ScriptedDesignWorld } from "./design-world.js";
import { ProjectHostGrounding } from "../design/host/ground.js";
import { ScriptedResearchWorld } from "./research-world.js";
import { ScriptedProjectWorkWorld } from "./project-work-world.js";
import { ProjectWorkSession } from "../project-work/session.js";
import type { ProjectWorkBridge } from "../project-work/bridge.js";

/** One profile of the matrix, as a run needs it. */
export interface ToolEvalProfile {
  id: string;
  name: string;
  /** The model the profile prefers: the id the recorded provider answers as. */
  model: string;
  provider: string;
}

/** The profile matrix, read from the settings file the runner was pointed at. */
export function profileMatrix(profiles: ModelProfile[]): ToolEvalProfile[] {
  return profiles.flatMap((profile) => {
    const model = profile.models[0];
    return model ? [{ id: profile.id, name: profile.name, model: model.id, provider: model.provider }] : [];
  });
}

/** One executed tool call, with what the tool answered. */
export interface ObservedCall {
  /** Position in the run, from zero. */
  index: number;
  tool: string;
  /** Exactly what the model sent, D-277's injected label included. */
  args: Record<string, unknown>;
  isError: boolean;
  /** The result as text: the tool's own rendering, or its error. */
  text: string;
  /** The parsed contract error, when the failure was a Laser tool's. */
  error?: ToolError;
}

export interface ToolEvalRun {
  fixture: ToolEvalFixture;
  profile: ToolEvalProfile;
  /** Recorded (a stub provider) or live (the person's own provider). */
  mode: "recorded" | "live";
  calls: ObservedCall[];
  /** Provider requests the turn needed. */
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** The model that actually answered, as the session reports it. */
  model: string | undefined;
  /** Whether the turn ended by itself. */
  settled: boolean;
  /** Responses the engine asked for past the end of the recording. */
  overruns: number;
  /** Set when the run itself failed (a timeout, a driver refusal). */
  failure?: string;
}

export interface RunFixtureOptions {
  fixture: ToolEvalFixture;
  profile: ToolEvalProfile;
  /**
   * The agent directory a live run reads providers and profiles from. Absent
   * in a recorded run, which builds a sandbox one pointing at the replay
   * provider.
   */
  liveAgentDir?: string;
  /** How long one turn may take before the run is called failed. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** The id the fixtures use when a call has to name a task the run started. */
const TASK_ID_PLACEHOLDER = "{{taskId}}";

/** Run one fixture on one profile and report what happened. */
export async function runFixture(options: RunFixtureOptions): Promise<ToolEvalRun> {
  const { fixture, profile } = options;
  const live = options.liveAgentDir !== undefined;
  const base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-tool-eval-`));
  const project = join(base, "project");
  const sessions = join(base, "sessions");
  mkdirSync(project, { recursive: true });
  mkdirSync(sessions, { recursive: true });

  const world = new ScriptedWorld(fixture);
  // The three project-work worlds, each built only for the fixture that
  // declares it, so a harness fixture pays for none of them (M21-T17).
  const design = fixture.world.designIndex
    ? new ScriptedDesignWorld({ projectSource: join(designFixtureRoot(), fixture.world.designIndex.project), built: fixture.world.designIndex.built === true })
    : undefined;
  const research = fixture.world.research
    ? new ScriptedResearchWorld({
        fixtureRoot: researchFixtureRoot(),
        ...(fixture.world.research.project !== undefined ? { project: fixture.world.research.project } : {}),
        ...(fixture.world.research.searchConnected !== undefined ? { searchConnected: fixture.world.research.searchConnected } : {}),
        ...(fixture.world.research.disabledAdapters
          ? { sources: disabledAdapterSources(fixture.world.research.disabledAdapters) }
          : {}),
      })
    : undefined;
  const lifecycle = fixture.world.projectWork
    ? new ScriptedProjectWorkWorld({
        ...(fixture.world.projectWork.items ? { items: fixture.world.projectWork.items } : {}),
        ...(fixture.world.projectWork.hasProject !== undefined ? { hasProject: fixture.world.projectWork.hasProject } : {}),
      })
    : undefined;
  const taskIds: string[] = [];
  let provider: RecordedProvider | undefined;
  let driver: StableSdkDriver | undefined;
  const search = fixture.world.search === "unconnected";
  const calls = new Map<string, { tool: string; args: Record<string, unknown>; index: number }>();
  const observed: ObservedCall[] = [];
  const captureBytes: number[] = [];
  let failure: string | undefined;
  let settled = false;
  let model: string | undefined;

  try {
    const agentDir = live ? options.liveAgentDir! : sandboxAgentDir(base, search);

    driver = new StableSdkDriver();
    const done = new Promise<void>((resolve) => {
      driver!.subscribe((event: DriverEvent) => {
        if (event.type === "extension") {
          const message = event.message as { type: string; payload?: unknown; bytes?: number };
          if (message.type === "lasercode/provider/request" && message.payload !== undefined) captureBytes.push(JSON.stringify(message.payload).length);
          else if (message.type === "lasercode/provider/request/begin" && typeof message.bytes === "number") captureBytes.push(message.bytes);
          return;
        }
        if (event.type !== "update") return;
        const update: SessionUpdate = event.update;
        if (update.kind === "tool_execution_start") {
          calls.set(update.toolCallId, { tool: update.toolName, args: isRecord(update.args) ? update.args : {}, index: calls.size });
        } else if (update.kind === "tool_execution_end") {
          const started = calls.get(update.toolCallId);
          if (started) {
            const text = resultText(update.result);
            observed.push({
              index: started.index,
              tool: started.tool,
              args: started.args,
              isError: update.isError,
              text,
              ...(update.isError ? withError(text) : {}),
            });
            noteTask(started, update.result, world, taskIds);
          }
        } else if (update.kind === "agent_settled") {
          settled = true;
          resolve();
        }
      });
    });

    if (!live) {
      provider = await startRecordedProvider({
        model: profile.model,
        steps: fixture.steps,
        resolve: (step) =>
          substitute(step, {
            taskIds,
            design,
            research,
            lifecycle,
            finding: () => lastFinding(observed),
          }),
      });
      // The sandbox agent dir names the replay provider's address, which only
      // exists once it is listening.
      writeSandboxModels(agentDir, provider.url, profile);
    }

    if (design) await design.prepare();
    const projectWork = projectWorkSession(fixture, { design, research, lifecycle });
    await driver.open({
      cwd: project,
      agentDir,
      sessionDir: sessions,
      projectTrusted: true,
      features: search ? ["subagents", "web-search"] : ["subagents"],
      agent: agentOptions(fixture, world, project),
      ...(projectWork ? { projectWork } : {}),
    });
    await driver.setProfile(profile.id);
    await driver.prompt([{ type: "text", text: fixture.task }]);
    await Promise.race([
      done,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("the turn did not settle")), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
    ]);
    // Results are published just after the engine settles in some paths; a
    // short drain keeps the last tool result from being missed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    model = driver.state().model?.id;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    await driver?.dispose().catch(() => {});
    await provider?.close();
    design?.dispose();
    research?.dispose();
    rmSync(base, { recursive: true, force: true });
  }

  const requests = provider ? provider.requests.length : captureBytes.length;
  const inputBytes = provider ? provider.requests.reduce((total, request) => total + request.bytes, 0) : captureBytes.reduce((total, bytes) => total + bytes, 0);
  return {
    fixture,
    profile,
    mode: live ? "live" : "recorded",
    calls: observed.sort((left, right) => left.index - right.index),
    requests,
    inputTokens: tokensFromBytes(inputBytes),
    outputTokens: outputTokens(observed, provider ? fixture.steps.slice(0, requests) : undefined),
    model,
    settled,
    overruns: provider?.overruns ?? 0,
    ...(failure !== undefined ? { failure } : {}),
  };
}

/** The design fixtures a design world copies its project from. */
function designFixtureRoot(): string {
  return join(import.meta.dirname, "..", "..", "test", "fixtures", "design");
}

/** The recordings a research world replays its network, search and git from. */
function researchFixtureRoot(): string {
  return join(import.meta.dirname, "..", "..", "test", "fixtures", "research");
}

/** A research world with some adapters switched off, to exercise the gate. */
function disabledAdapterSources(disabled: readonly string[]): Partial<ResearchSources> {
  const adapters = { ...defaultResearchSources().adapters };
  for (const id of disabled) {
    if ((RESEARCH_ADAPTER_IDS as readonly string[]).includes(id)) adapters[id as ResearchAdapterId] = false;
  }
  return { adapters };
}

/**
 * The project-work surface this fixture's session gets (M21-T17).
 *
 * Exactly the tools its world declares: a design fixture registers the three
 * Design Index tools and nothing else, a research fixture the four Research
 * tools, a lifecycle fixture the four lifecycle ones. That is the contract's
 * capability gating, evaluated rather than asserted.
 */
function projectWorkSession(
  fixture: ToolEvalFixture,
  worlds: { design?: ScriptedDesignWorld | undefined; research?: ScriptedResearchWorld | undefined; lifecycle?: ScriptedProjectWorkWorld | undefined },
): ProjectWorkSession | undefined {
  const { design, research, lifecycle } = worlds;
  if (!design && !research && !lifecycle) return undefined;
  const bridge: ProjectWorkBridge | undefined = lifecycle;
  const task = lifecycle && fixture.world.projectWork?.taskKey
    ? lifecycle.entity(fixture.world.projectWork.taskKey)
    : undefined;
  return new ProjectWorkSession({
    ...(bridge ? { bridge } : {}),
    ...(design ? { design, hostGrounding: new ProjectHostGrounding({ projectCwd: design.projectCwd, index: () => design.index() }) } : {}),
    ...(research ? { research: { bridge: research, adapters: research.adapters() } } : {}),
    ...(task ? { task: { entityId: task.entity.entityId, key: task.entity.key } } : {}),
    reviewActor: { kind: "agent", label: "Evaluation run" },
  });
}

/** What the session runs as: an agent at the top, or one agent's own run. */
function agentOptions(fixture: ToolEvalFixture, world: ScriptedWorld, project: string): DriverAgentOptions {
  const definition = fallbackDefaultAgent();
  const role = world.role();
  return {
    definition,
    role,
    record: role.kind === "child"
      ? { agentName: role.agentName ?? definition.name, kind: "child", ...(role.subagentName !== undefined ? { subagentName: role.subagentName } : {}), ...(role.runId !== undefined ? { runId: role.runId } : {}) }
      : rootRecord(definition.name),
    policy: fallbackPolicy(),
    bridge: world,
    backgroundWork: { cwd: project, foregroundCommandSeconds: 120 },
  };
}

/**
 * The agent directory a recorded run uses: this profile, and nothing else a
 * person owns. No credential of the person's is read, written or needed.
 */
function sandboxAgentDir(base: string, search: boolean): string {
  const agentDir = join(base, "agent");
  mkdirSync(agentDir, { recursive: true });
  if (search) {
    // A provider that needs a key, with no key: `web_search` is registered —
    // the feature is on — and every call is refused before anything leaves
    // this process. It is the refusal a person with no connected provider
    // gets, and it is the only way to evaluate the one external tool without
    // a network and without spending someone's search quota. A live run uses
    // the person's own connection and really searches.
    writeFileSync(
      join(agentDir, "search-connections.json"),
      JSON.stringify({ selectedProvider: "brave", connections: { brave: { source: "none" } }, keys: {} }),
      { mode: 0o600 },
    );
  }
  return agentDir;
}

/** The provider and profile files, written once the replay provider is listening. */
function writeSandboxModels(agentDir: string, url: string, profile: ToolEvalProfile): void {
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [profile.provider]: {
          baseUrl: url,
          api: "openai-completions",
          apiKey: "recorded",
          models: [{ id: profile.model, name: profile.name, contextWindow: 200_000, maxTokens: 8_000 }],
        },
      },
    }),
  );
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: profile.provider,
      defaultModel: profile.model,
      // A recorded answer is never a failure, so nothing should be retried;
      // an unexpected retry would show up as an extra request instead.
      retry: { enabled: false },
      modelProfiles: [{ id: profile.id, name: profile.name, models: [{ provider: profile.provider, id: profile.model }], origin: "person", updatedAt: "2026-01-01T00:00:00.000Z" }],
      defaultProfileId: profile.id,
    }),
  );
}

/**
 * What a recorded call may not know when it was written.
 *
 * A fixture names things the run itself mints — the id of a command it
 * started, the revision an artifact is at now, the id of the entry the
 * builder produced — so those are written as placeholders and resolved here,
 * against the world this run is really using. The same placeholders the
 * design and research replay tests resolve, so one recording serves both.
 */
interface Placeholders {
  taskIds: string[];
  design?: ScriptedDesignWorld | undefined;
  research?: ScriptedResearchWorld | undefined;
  lifecycle?: ScriptedProjectWorkWorld | undefined;
  /** The last finding a `record_finding` call in this run produced. */
  finding: () => string | undefined;
}

async function substitute(step: RecordedStep, context: Placeholders): Promise<RecordedStep> {
  if (!("toolCall" in step)) return step;
  const entries = await Promise.all(
    Object.entries(step.toolCall.args).map(async ([name, value]) => [name, await resolvePlaceholder(value, context)] as const),
  );
  return { ...step, toolCall: { ...step.toolCall, args: Object.fromEntries(entries) } };
}

async function resolvePlaceholder(value: unknown, context: Placeholders): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((entry) => resolvePlaceholder(entry, context)));
  if (typeof value !== "string") return value;
  if (value.includes(TASK_ID_PLACEHOLDER)) return value.replace(TASK_ID_PLACEHOLDER, context.taskIds.at(-1) ?? "task-not-started");
  if (value === "{{revision}}") return context.research?.store.revisionId ?? value;
  if (value === "{{stale}}") return context.design ? "0".repeat(64) : "rev0";
  if (value === "{{finding}}") return context.finding() ?? value;
  const revision = /^\{\{revision:([A-Z]+-\d+)\}\}$/.exec(value);
  if (revision?.[1] && context.lifecycle) {
    return context.lifecycle.entity(revision[1])?.entity.currentRevisionId ?? value;
  }
  const entry = /^\{\{entry:([a-z]+):([^:]+):(id|digest)\}\}$/.exec(value);
  if (entry && context.design) {
    const found = await context.design.entry(entry[1] as never, entry[2] ?? "");
    if (!found) return value;
    return entry[3] === "id" ? found.id : found.factsDigest;
  }
  return value;
}

/** A background command the run started: the world lists it, so a model can find it. */
function noteTask(started: { tool: string; args: Record<string, unknown> }, result: unknown, world: ScriptedWorld, taskIds: string[]): void {
  const details = isRecord(result) ? result["details"] : undefined;
  const taskId = isRecord(details) ? details["taskId"] : undefined;
  if (typeof taskId !== "string" || taskIds.includes(taskId)) return;
  taskIds.push(taskId);
  const command = started.args["command"];
  world.noteCommand({ taskId, command: typeof command === "string" ? command : started.tool });
}

/** The finding id the last `record_finding` of this run produced, if any. */
function lastFinding(observed: ObservedCall[]): string | undefined {
  for (const call of [...observed].reverse()) {
    if (call.tool !== "record_finding" || call.isError) continue;
    try {
      const parsed: unknown = JSON.parse(call.text);
      const id = isRecord(parsed) ? parsed["findingId"] : undefined;
      if (typeof id === "string") return id;
    } catch {
      // The answer was not JSON; nothing to cite from it.
    }
  }
  return undefined;
}

/** The text of a tool result, whichever way the engine carried it. */
function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!isRecord(result)) return "";
  const content = result["content"];
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isRecord(part) && typeof part["text"] === "string" ? part["text"] : ""))
    .join("\n");
}

function withError(text: string): { error?: ToolError } {
  const error = parseToolError(text);
  return error ? { error } : {};
}

/**
 * The prompt's cost, from the bytes the requests really carried: the same
 * four-characters-to-a-token estimate {@link estimateTokens} makes, done as
 * arithmetic rather than by building a request-sized string to measure.
 */
function tokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / CHARACTERS_PER_TOKEN);
}

/**
 * What the model produced: its tool-call arguments and its answers. Estimated
 * the same way in both modes so a recorded run and a live one are comparable.
 */
function outputTokens(calls: ObservedCall[], steps: RecordedStep[] | undefined): number {
  if (steps) {
    return steps.reduce((total, step) => total + estimateTokens("text" in step ? step.text : `${step.toolCall.name}${JSON.stringify(step.toolCall.args)}`), 0);
  }
  return calls.reduce((total, call) => total + estimateTokens(`${call.tool}${JSON.stringify(call.args)}`), 0);
}
