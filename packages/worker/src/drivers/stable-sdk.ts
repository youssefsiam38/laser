/**
 * StableSdkDriver (M0-T4) — the real driver, on the pinned stable Pi SDK.
 *
 * Owns one `AgentSessionRuntime` for one project directory. Loads the laser
 * companion extension inline, binds the UI bridge in "rpc" mode, and maps Pi's
 * `AgentSessionEvent` stream onto protocol `SessionUpdate`s.
 *
 * Runtime replacement (new/switch/fork) swaps `runtime.session`, so every such
 * operation re-subscribes and re-binds extensions — see `applySession()`.
 *
 * Verified against Pi 0.85.0 (test/stable-sdk.prompt.test.ts):
 *   - the user message emits message_start/message_end before the assistant
 *     stream begins; anchor transcript logic on the first text_delta;
 *   - `entry_appended` fires only for extension custom entries, never for
 *     message persistence — build transcript state from the message and tool
 *     execution events and hydrate from `entries()`;
 *   - `isStreaming` flips after `prompt()` yields, so "busy" is detected by
 *     catching Pi's error, not only by the pre-check.
 */

import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionError,
  type InlineExtension,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { goalExtensionPath, goalStateFromEntries } from "@lasercode/pi-goal";
import { createCommandBus, createLaserExtension, createPromptProvenanceObserver, toSessionGoal, type LaserExtensionOptions } from "@lasercode/pi-extension";
import { PROJECT_DIR_NAME, SESSION_AGENT_ENTRY_TYPE } from "@lasercode/protocol";
import type {
  CommandInfo,
  ContentBlock,
  FeatureId,
  GoalAction,
  ImageContent,
  MessageSpeaker,
  ModelRef,
  PiExtensionCommand,
  PromptInfo,
  SessionGoal,
  SessionState,
  SessionUpdate,
  StopReason,
  ThinkingLevel,
  UiDialogRequest,
  UiDialogResponse,
  Usage,
} from "@lasercode/protocol";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readLaserProjectSettings } from "../settings.js";
import { WebSearchService } from "../web-search.js";
import {
  DriverUnavailableError,
  type DriverAgentOptions,
  type DriverEvent,
  type DriverListener,
  type DriverOpenOptions,
  type PromptOptions,
  type SessionDriver,
} from "../driver.js";
import { createUiBridge, type UiBridge } from "../ui-bridge.js";
import { GOAL_TOOL_NAMES } from "@lasercode/pi-goal";
import { isGoalCommand } from "@lasercode/pi-extension";
import { ENGINE_BUILTIN_TOOLS, ensureWorkspaceSessionCwd, filterSkills } from "../agents/session-config.js";
import { modelUnavailableMessage } from "../agents/harness.js";

type PiModel = ReturnType<ModelRuntime["getModels"]>[number];

export class StableSdkDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;

  private readonly listeners = new Set<DriverListener>();
  private readonly ui: UiBridge;
  /** Fallback for `AgentState.pendingToolCalls`, derived from the event stream. */
  private readonly toolCalls = new PendingToolCallTracker();
  /** Worker → companion extension. `deliver` answers whether a module took it. */
  private readonly extensionBus = createCommandBus();
  private accountUsage: SessionState["accountUsage"];
  private runtime: AgentSessionRuntime | undefined;
  private unsubscribe: (() => void) | undefined;
  private cwd = "";

  constructor() {
    this.ui = createUiBridge(
      {
        onRequest: (request) => this.emit({ type: "ui_request", request }),
        onEvent: (event) => this.emit({ type: "ui_event", event }),
      },
      // Lazy: the bridge outlives every session, and no session exists yet here.
      { pendingToolCallId: () => this.currentToolCallId() },
    );
  }

  // ---------------------------------------------------------------- lifecycle

  async open(options: DriverOpenOptions): Promise<SessionState> {
    if (this.runtime) throw new DriverUnavailableError(this.kind, "session already open");
    this.cwd = options.cwd;
    // Kept for the retired file layer's sake: harmless when nothing reads it.
    if (options.subagentsTempRoot) process.env["PI_SUBAGENTS_TEMP_ROOT"] = options.subagentsTempRoot;

    const agentDir = options.agentDir ?? getAgentDir();
    const enabled = new Set<FeatureId>(options.features ?? ["subagents", "goals"]);
    const agent = options.agent;
    // Web search is an extension tool: offered whenever its feature is on.
    // Every agent has every tool (D-144), so no definition narrows this.
    const searchWanted = enabled.has("web-search");
    const search = searchWanted ? new WebSearchService(agentDir) : undefined;
    const createCompanion = (requestProvenance: ReturnType<typeof createPromptProvenanceObserver>) => {
      const companion: LaserExtensionOptions = {
        requestProvenance,
        ...(search ? { webSearch: search.search.bind(search) } : {}),
        send: (message) => {
          if (message.type === "lasercode/account-usage/state") this.accountUsage = message.state;
          this.emit({ type: "extension", message });
        },
        commands: this.extensionBus,
        only: [
          "provider-log",
          "account-usage",
          "panels",
          "transcribe",
          ...(search ? ["web-access" as const] : []),
          ...(enabled.has("subagents") ? ["subagents" as const, "background-work" as const] : []),
          ...(enabled.has("goals") ? ["goal" as const] : []),
        ],
        ...(agent?.bridge ? { agents: agent.bridge } : {}),
        ...(agent?.backgroundWork ? { backgroundWork: agent.backgroundWork } : {}),
      };
      return createLaserExtension(companion);
    };

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
      const requestProvenance = createPromptProvenanceObserver();
      const laser = createCompanion(requestProvenance);
      const settingsManager = SettingsManager.create(cwd, agentDir, {
        // Laser never asks the engine to discover `<cwd>/.pi`. Project
        // settings arrive from `.laser` as curated in-memory overrides below.
        projectTrusted: false,
      });
      settingsManager.applyOverrides({
        ...(options.projectTrusted === false ? {} : readLaserProjectSettings(cwd)),
        // Packages and loose resources are an engine implementation detail.
        // Features below are the only reviewed extensions in the runtime.
        packages: [],
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      });

      const extensionFactories: InlineExtension[] = [];
      const additionalExtensionPaths: string[] = [];
      // Keep Pi's parser, validation, collision handling and invocation
      // semantics, but give it Laser-owned and Agent Skills standard roots
      // explicitly. `noSkills`/`noPromptTemplates` remain true below so the
      // engine never falls back to `<cwd>/.pi` discovery.
      const additionalSkillPaths = existingResourceRoots([
        join(agentDir, "skills"),
        join(homedir(), ".agents", "skills"),
        ...(options.projectTrusted === false
          ? []
          : [join(cwd, PROJECT_DIR_NAME, "skills"), join(cwd, ".agents", "skills")]),
      ]);
      const additionalPromptTemplatePaths = existingResourceRoots([
        join(agentDir, "prompts"),
        ...(options.projectTrusted === false ? [] : [join(cwd, PROJECT_DIR_NAME, "prompts")]),
      ]);
      if (enabled.has("goals")) {
        additionalExtensionPaths.push(goalExtensionPath());
      }
      extensionFactories.push(laser);

      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager,
        resourceLoaderOptions: {
          extensionFactories,
          extensionsOverride: requestProvenance.extensionsOverride,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          agentsFilesOverride: ({ agentsFiles }) => ({
            agentsFiles: agentsFiles.filter(({ path }) => !path.split(/[\\/]/).includes(".pi")),
          }),
          ...(additionalExtensionPaths.length > 0 ? { additionalExtensionPaths } : {}),
          ...(additionalSkillPaths.length > 0 ? { additionalSkillPaths } : {}),
          ...(additionalPromptTemplatePaths.length > 0 ? { additionalPromptTemplatePaths } : {}),
          ...(agent ? agentResourceOptions(agent) : {}),
        },
      });
      requestProvenance.setResourceLoader(services.resourceLoader);
      const selected = agent ? await resolveAgentModel(services.modelRuntime, agent) : undefined;
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        ...(sessionStartEvent ? { sessionStartEvent } : {}),
        // The built-in tools a definition leaves out are denied outright, so
        // nothing inside the session can switch them back on. `tools:` is not
        // used: it is an allowlist that would also deny every extension tool
        // (the harness's, background work's, the goal's, web search's).
        ...(selected ? { model: selected } : {}),
        ...(agent?.definition.thinkingLevel ? { thinkingLevel: agent.definition.thinkingLevel } : {}),
      });
      // The definition's built-ins beyond the engine's default four (grep,
      // find, ls) are switched on here. A settings override would be the
      // natural place, but the resource loader's reload re-reads settings
      // from disk during service creation and drops every override.
      if (agent) activateEveryTool(created.session);
      return { ...created, services, diagnostics: services.diagnostics };
    };

    // Beam and Chat run in the app's own workspace. The engine records the
    // directory in the session header and refuses to build a runtime whose
    // stored directory is gone, so a workspace that vanished (a moved state
    // directory, an older layout) is recreated here — before the runtime is
    // built — rather than costing the person every chat in it.
    if (agent) await ensureWorkspaceSessionCwd(agent.role.kind, options.cwd, options.sessionPath);

    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: options.cwd,
      agentDir,
      sessionManager: SessionManager.create(options.cwd, options.sessionDir),
    });
    this.runtime = runtime;

    if (options.sessionPath) {
      const { cancelled } = await runtime.switchSession(options.sessionPath);
      if (cancelled) throw new DriverUnavailableError(this.kind, `switch to ${options.sessionPath} was cancelled`);
    } else if (options.parentSessionPath) {
      await runtime.newSession({ parentSession: options.parentSessionPath });
    }

    await this.applySession();
    // A new agent-defined session carries its record as the first custom
    // entry, so a catalog that only reads files can attribute it. A resumed
    // session already has one.
    if (agent && !options.sessionPath) {
      this.session().sessionManager.appendCustomEntry(SESSION_AGENT_ENTRY_TYPE, agent.record);
    }
    return this.state();
  }

  /** Bind extensions and subscribe to the current `runtime.session`. */
  private async applySession(): Promise<void> {
    const session = this.session();
    this.unsubscribe?.();
    // A replaced runtime carries none of the old session's in-flight tool calls.
    this.toolCalls.clear();
    await session.bindExtensions({
      mode: "rpc",
      uiContext: this.ui.context,
      abortHandler: () => void session.abort(),
      onError: (error: ExtensionError) =>
        this.push({ kind: "extension_error", extension: error.extensionPath, message: error.error }),
    });
    this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event));
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.toolCalls.clear();
    this.ui.dispose();
    await this.runtime?.dispose();
    this.runtime = undefined;
    this.emit({ type: "closed", reason: "disposed" });
    this.listeners.clear();
  }

  subscribe(listener: DriverListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -------------------------------------------------------------------- state

  state(): SessionState {
    const session = this.session();
    const usage = session.getContextUsage();
    return {
      path: session.sessionFile ?? "",
      id: session.sessionId,
      cwd: this.cwd,
      ...(session.sessionName !== undefined ? { name: session.sessionName } : {}),
      // With no configured auth Pi substitutes an "unknown/unknown" placeholder; report it as no model.
      model: session.model && session.model.provider !== "unknown" ? toModelRef(session.model) : null,
      thinkingLevel: session.thinkingLevel as ThinkingLevel,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      steeringMode: session.steeringMode,
      followUpMode: session.followUpMode,
      autoCompactionEnabled: session.autoCompactionEnabled,
      messageCount: session.messages.length,
      pendingMessageCount: session.pendingMessageCount,
      ...(usage
        ? {
            contextUsage: {
              tokens: usage.tokens,
              contextWindow: usage.contextWindow,
              percent: usage.percent,
            },
          }
        : {}),
      ...(this.accountUsage ? { accountUsage: this.accountUsage } : {}),
    };
  }

  async entries(): Promise<unknown[]> {
    return this.session().sessionManager.getEntries();
  }

  async goalState(): Promise<SessionGoal | null> {
    return toSessionGoal(goalStateFromEntries(this.session().sessionManager.getBranch()));
  }

  async goalAction(action: GoalAction): Promise<SessionGoal | null> {
    activateGoalTools(this.session());
    await this.session().prompt(goalCommand(action));
    const goal = await this.goalState();
    this.emit({ type: "extension", message: { type: "lasercode/goal/state", goal } });
    return goal;
  }

  async appendEntry(customType: string, data: unknown): Promise<string> {
    return this.session().sessionManager.appendCustomEntry(customType, data);
  }

  lastAssistantText(): string | undefined {
    return this.session().getLastAssistantText();
  }

  // ----------------------------------------------------------------- prompting

  async prompt(content: ContentBlock[], options?: PromptOptions): Promise<{ accepted: boolean; queued: boolean }> {
    const session = this.session();
    const { text, images } = split(content);
    // A goal command needs the goal tools before it dispatches (see below).
    if (isGoalCommand(text)) activateGoalTools(session);
    const streaming = session.isStreaming;
    if (streaming && !options?.streamingBehavior) {
      return { accepted: false, queued: false };
    }
    try {
      await session.prompt(text, {
        ...(images.length > 0 ? { images } : {}),
        ...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
        ...(options?.expandPromptTemplates !== undefined ? { expandPromptTemplates: options.expandPromptTemplates } : {}),
      });
    } catch (error) {
      // `isStreaming` flips only after the agent loop starts, so a prompt sent in
      // the same tick as another can pass the pre-check and still be refused by
      // Pi. "Busy" is a normal outcome for the protocol, not an exception.
      if (isBusyError(error)) return { accepted: false, queued: false };
      throw error;
    }
    return { accepted: true, queued: streaming };
  }

  async steer(content: ContentBlock[]): Promise<void> {
    const { text, images } = split(content);
    await this.session().steer(text, images.length > 0 ? images : undefined);
  }

  async followUp(content: ContentBlock[]): Promise<void> {
    const { text, images } = split(content);
    await this.session().followUp(text, images.length > 0 ? images : undefined);
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return this.session().clearQueue();
  }

  async abort(): Promise<void> {
    await this.session().abort();
  }

  // -------------------------------------------------------------------- model

  /**
   * The models this session can actually switch to: only providers with a
   * credential (D-145). `setModel` refuses the rest, so offering them is
   * offering a choice that cannot be made. The engine answers from its own
   * auth state; a failure falls back to the full list rather than an empty
   * picker.
   */
  async listModels(): Promise<ModelRef[]> {
    const runtime = this.session().modelRuntime;
    try {
      const available = await runtime.getAvailable();
      if (available.length > 0) return available.map(toModelRef);
    } catch {
      // Fall through: a picker with every model beats a picker with none.
    }
    return runtime.getModels().map(toModelRef);
  }

  async setModel(model: ModelRef): Promise<SessionState> {
    const session = this.session();
    const match = session.modelRuntime
      .getModels()
      .find((m) => m.provider === model.provider && m.id === model.id);
    if (!match) throw new DriverUnavailableError(this.kind, `unknown model ${model.provider}/${model.id}`);
    await session.setModel(match);
    return this.state();
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<SessionState> {
    this.session().setThinkingLevel(level);
    return this.state();
  }

  // ------------------------------------------------------------------ session

  async rename(name: string): Promise<void> {
    this.session().setSessionName(name);
  }

  async compact(instructions?: string): Promise<void> {
    await this.session().compact(instructions);
  }

  async navigateTree(
    entryId: string,
    options?: { summarize?: boolean; label?: string },
  ): Promise<{ editorText?: string; cancelled: boolean }> {
    const result = await this.session().navigateTree(entryId, {
      ...(options?.summarize !== undefined ? { summarize: options.summarize } : {}),
      ...(options?.label !== undefined ? { label: options.label } : {}),
    });
    return {
      ...(result.editorText !== undefined ? { editorText: result.editorText } : {}),
      cancelled: result.cancelled,
    };
  }

  async fork(entryId: string): Promise<{ state: SessionState; editorText?: string }> {
    if (!this.runtime) throw new DriverUnavailableError(this.kind, "no open session");
    const { cancelled, selectedText } = await this.runtime.fork(entryId);
    if (cancelled) throw new DriverUnavailableError(this.kind, "fork was cancelled by an extension");
    // Runtime replacement swapped `runtime.session`; re-bind and re-subscribe.
    await this.applySession();
    return { state: this.state(), ...(selectedText !== undefined ? { editorText: selectedText } : {}) };
  }

  respondToUi(response: UiDialogResponse): void {
    this.ui.respond(response);
  }

  /**
   * Everything Pi's headless command catalogue can run here: registered
   * commands, prompt templates and skills. Terminal-only commands are handled
   * by Laser's own controls instead of being advertised as inert rows.
   *
   * Pi's own `BUILTIN_SLASH_COMMANDS` (`/model`, `/settings`, `/tree`,
   * `/thinking`) are deliberately not here: they open Pi's terminal pickers,
   * which this app never runs. laser has its own controls for every one of
   * them and offers those instead, rather than a row that would do nothing.
   */
  async commands(): Promise<CommandInfo[]> {
    const session = this.session();
    const commands: CommandInfo[] = [];
    for (const command of session.extensionRunner.getRegisteredCommands()) {
      // Only reviewed, bundled features are loaded into this runtime. Expose
      // their complete registered command surface; filtering by two names made
      // valid Subagents commands disappear from autocomplete.
      const feature = command.invocationName === "goal" ? "Goals" : "Agents";
      commands.push({
        name: command.invocationName,
        source: "feature",
        ...(command.description ? { description: command.description } : {}),
        origin: feature,
      });
    }
    for (const prompt of session.promptTemplates) {
      commands.push({
        name: prompt.name,
        source: "prompt",
        filePath: prompt.filePath,
        ...(prompt.description ? { description: prompt.description } : {}),
        ...(prompt.argumentHint ? { argumentHint: prompt.argumentHint } : {}),
        ...(originOf(prompt.sourceInfo) ? { origin: originOf(prompt.sourceInfo)! } : {}),
      });
    }
    for (const skill of session.resourceLoader.getSkills().skills) {
      // Pi invokes a skill as `/skill:<name>`; the popover shows exactly what
      // gets typed, so what a person reads is what the agent receives.
      // `disable-model-invocation` only hides a skill from the model's system
      // prompt. Pi deliberately keeps explicit `/skill:name` invocation.
      commands.push({
        name: `skill:${skill.name}`,
        source: "skill",
        filePath: skill.filePath,
        ...(skill.description ? { description: skill.description } : {}),
        ...(originOf(skill.sourceInfo) ? { origin: originOf(skill.sourceInfo)! } : {}),
      });
    }
    return commands;
  }

  /** The prompt library: the markdown templates Pi loaded for this session. */
  async prompts(): Promise<PromptInfo[]> {
    return this.session().promptTemplates.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      ...(prompt.argumentHint ? { argumentHint: prompt.argumentHint } : {}),
      filePath: prompt.filePath,
      origin: originOf(prompt.sourceInfo) ?? "prompt",
      preview: preview(prompt.content),
    }));
  }

  deliverExtensionCommand(command: PiExtensionCommand): boolean {
    return this.extensionBus.deliver(command);
  }

  /** Dialogs still waiting for an answer, for replay after a client reconnect. */
  pendingUi(): UiDialogRequest[] {
    return this.ui.pending();
  }

  // ------------------------------------------------------------------ internals

  private session(): AgentSession {
    if (!this.runtime) throw new DriverUnavailableError(this.kind, "no open session");
    return this.runtime.session;
  }

  /**
   * The tool call a dialog raised right now belongs to, or undefined.
   *
   * Single-tool causality (react-pi's rule): Pi hands extension dialogs no tool
   * call id, so the only sound attribution is "exactly one tool call is
   * executing". Zero or several running tools ⇒ free-standing dialog.
   *
   * Source of truth is Pi's own `AgentState.pendingToolCalls`
   * (pi-agent-core types.d.ts: `readonly pendingToolCalls: ReadonlySet<string>`).
   * If a Pi release stops exposing it, the tracker fed from
   * `tool_execution_start` / `tool_execution_end` answers instead.
   */
  private currentToolCallId(): string | undefined {
    let live: ReadonlySet<string> | undefined;
    try {
      live = asIdSet(this.runtime?.session.state.pendingToolCalls);
    } catch {
      live = undefined;
    }
    return singleId(live ?? this.toolCalls.ids());
  }

  private emit(event: DriverEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private push(update: SessionUpdate): void {
    this.emit({ type: "update", update });
  }

  private onSessionEvent(event: AgentSessionEvent): void {
    this.toolCalls.note(event);
    const update = mapEvent(event);
    if (update) this.push(update);
    // These change visible session state, so follow them with a state snapshot.
    if (
      event.type === "agent_end" ||
      event.type === "agent_settled" ||
      event.type === "session_info_changed" ||
      event.type === "thinking_level_changed" ||
      event.type === "compaction_end"
    ) {
      this.push({ kind: "state", state: this.state() });
    }
  }
}

/** De-duplicate existing resource roots while preserving precedence. */
function existingResourceRoots(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    if (!existsSync(path) || seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

/**
 * What an agent definition changes in the resource loader: its own
 * instructions in place of the engine's (unless it keeps the built-in ones),
 * and which discovered skills it is offered.
 */
function agentResourceOptions(agent: DriverAgentOptions): {
  systemPromptOverride?: () => string | undefined;
  skillsOverride: <T extends { skills: Array<{ name: string }>; diagnostics: unknown[] }>(base: T) => T;
} {
  const { definition, role } = agent;
  const filter = { definition, role, ...(agent.beamSkillName !== undefined ? { beamSkillName: agent.beamSkillName } : {}) };
  return {
    ...(definition.engineInstructions ? {} : { systemPromptOverride: () => definition.instructions }),
    skillsOverride: (base) => ({ ...base, skills: filterSkills(base.skills, filter) }),
  };
}

/**
 * The goal engine's tools, on before its command runs.
 *
 * They are attached only while a goal is in play (D-146), and the engine
 * refuses to start or resume a goal whose tools are not already in the active
 * allowlist. Its command dispatches before any extension hook the companion
 * could use — `input` does not fire for a command — so the one place early
 * enough is here, where the text about to become a command is still in hand.
 */
function activateGoalTools(session: AgentSession): void {
  try {
    const known = new Set(session.getAllTools().map((tool) => tool.name));
    const active = session.getActiveToolNames();
    const missing = GOAL_TOOL_NAMES.filter((name) => known.has(name) && !active.includes(name));
    if (missing.length > 0) session.setActiveToolsByName([...active, ...missing]);
  } catch {
    // No goal engine in this session: nothing to switch on.
  }
}

/**
 * Switch on every engine tool beside the extension tools already active. The
 * engine starts a session with four of its own (read, bash, edit, write); the
 * rest are enabled here, because every agent has every tool (D-144).
 */
function activateEveryTool(session: AgentSession): void {
  const active = new Set(session.getActiveToolNames());
  for (const name of ENGINE_BUILTIN_TOOLS) active.add(name);
  session.setActiveToolsByName([...active]);
}

/**
 * The definition's model, resolved against the engine's catalogue, or a
 * refusal a person can act on. `null` on the definition follows the
 * configured default, which the engine picks itself.
 */
async function resolveAgentModel(runtime: ModelRuntime, agent: DriverAgentOptions): Promise<PiModel | undefined> {
  const choice = agent.definition.model;
  if (!choice) return undefined;
  const model = runtime.getModel(choice.provider, choice.id);
  if (!model) throw new DriverUnavailableError("stable-sdk", modelUnavailableMessage(choice));
  let authorized = runtime.hasConfiguredAuth(choice.provider);
  if (!authorized) {
    try {
      authorized = (await runtime.checkAuth(choice.provider)) !== undefined;
    } catch {
      authorized = false;
    }
  }
  if (!authorized) throw new DriverUnavailableError("stable-sdk", modelUnavailableMessage(choice));
  return model;
}

// -------------------------------------------------------- pending tool calls

/**
 * Tool call ids in flight, derived from the session event stream.
 *
 * Pi 0.85 already publishes this as `AgentState.pendingToolCalls`, which the
 * driver prefers. This tracker exists so dialog↔tool attribution keeps working
 * if a future Pi drops or renames that state, and so the rule is unit-testable
 * without a live agent. Exported for tests.
 */
export class PendingToolCallTracker {
  private readonly running = new Set<string>();

  /** Feed every `AgentSessionEvent` the driver sees. Unknown events are ignored. */
  note(event: AgentSessionEvent): void {
    switch (event.type) {
      case "tool_execution_start":
        this.running.add(event.toolCallId);
        return;
      case "tool_execution_end":
        this.running.delete(event.toolCallId);
        return;
      // Pi's own `finishRun()` empties `pendingToolCalls` when the run ends, so
      // mirror that: drop ids whose `tool_execution_end` never arrived (abort,
      // crash, retry). Nothing can be executing once the run is over.
      case "agent_end":
      case "agent_settled":
        this.running.clear();
        return;
      default:
        return;
    }
  }

  ids(): ReadonlySet<string> {
    return this.running;
  }

  /** The id when exactly one tool call is executing, else undefined. */
  single(): string | undefined {
    return singleId(this.running);
  }

  clear(): void {
    this.running.clear();
  }
}

/** The only member of a one-element set; undefined for zero or many. */
function singleId(ids: ReadonlySet<string>): string | undefined {
  if (ids.size !== 1) return undefined;
  for (const id of ids) return id;
  return undefined;
}

/** Duck-typed `ReadonlySet<string>` check — Pi may hand back a Set-like view. */
function asIdSet(value: unknown): ReadonlySet<string> | undefined {
  const candidate = value as { size?: unknown; [Symbol.iterator]?: unknown } | null | undefined;
  if (!candidate || typeof candidate.size !== "number") return undefined;
  if (typeof candidate[Symbol.iterator] !== "function") return undefined;
  return value as ReadonlySet<string>;
}

// ------------------------------------------------------------------- mapping

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already processing|streamingBehavior/i.test(message);
}

function toModelRef(model: PiModel): ModelRef {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
    vision: model.input.includes("image"),
  };
}

function split(content: ContentBlock[]): { text: string; images: ImageContent[] } {
  const text = content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const images = content.filter((b): b is ImageContent => b.type === "image");
  return { text, images };
}

function roleOf(message: unknown): "user" | "assistant" | "tool" | "custom" {
  const role = (message as { role?: string } | null)?.role;
  if (role === "user" || role === "assistant") return role;
  if (role === "toolResult" || role === "tool") return "tool";
  return "custom";
}

/**
 * Where a command, prompt or skill came from, in words a person can read.
 *
 * Pi's `SourceInfo` is built for Pi: `source` is the package name for a
 * package and an internal marker ("auto") otherwise, and `scope` is
 * user/project/temporary. A row in a popover wants the package's name when
 * there is one and "yours" or "this project" when there is not — never
 * "auto", which tells the reader nothing.
 */
function originOf(sourceInfo: unknown): string | undefined {
  const info = sourceInfo as { source?: unknown; scope?: unknown; origin?: unknown } | null;
  const source = typeof info?.source === "string" ? info.source.trim() : "";
  if (info?.origin === "package" && source !== "") return "Built in";
  if (info?.scope === "project") return "this project";
  if (info?.scope === "user") return "yours";
  return undefined;
}

/** The first few lines of a template, for the row's second line. Never the file. */
function preview(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 300);
}

function goalCommand(action: GoalAction): string {
  switch (action.action) {
    case "pause":
      return "/goal pause";
    case "resume":
      return "/goal resume";
    case "clear":
      return "/goal clear";
    case "edit":
      return `/goal edit ${action.objective}`;
    case "start":
      return `/goal ${action.objective}`;
  }
}

/**
 * Why an assistant turn ended, straight off Pi's `AssistantMessage`.
 *
 * `stopReason` is Pi's own vocabulary and the protocol mirrors it name for
 * name, so the only work here is refusing a value we do not recognise rather
 * than putting a string on the wire that the schema never promised.
 */
const STOP_REASONS = new Set<StopReason>(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]);

function stopReasonOf(message: unknown): StopReason | undefined {
  const reason = (message as { stopReason?: unknown } | null)?.stopReason;
  return typeof reason === "string" && STOP_REASONS.has(reason as StopReason) ? (reason as StopReason) : undefined;
}

/**
 * This turn's token counts. Pi's `Usage` is a superset of the protocol's, so
 * the extra fields (`reasoning`, `cacheWrite1h`) are dropped rather than
 * smuggled through as unknown keys.
 */
function usageOf(message: unknown): Usage | undefined {
  const usage = (message as { usage?: unknown } | null)?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Partial<Usage> & { cost?: Usage["cost"] };
  const n = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    input: n(u.input),
    output: n(u.output),
    cacheRead: n(u.cacheRead),
    cacheWrite: n(u.cacheWrite),
    totalTokens: n(u.totalTokens),
    ...(u.cost ? { cost: u.cost } : {}),
  };
}

/**
 * Who is speaking, when it is not this session's own agent.
 *
 * Pi 0.85 has exactly one way for a child run to put words into a session it
 * did not start: `pi.sendMessage()`, which lands as a `CustomMessage` carrying
 * a `customType` and free-form `details`. pi-subagents names the child agent in
 * there, so that is what this reads. An assistant or user message is the
 * session's own voice and carries no speaker at all — the transcript draws no
 * header for it, which is the behaviour `speaker-identity` documents.
 */
function speakerOf(message: unknown): MessageSpeaker | undefined {
  const m = message as { role?: string; customType?: string; details?: unknown } | null;
  if (m?.role !== "custom") return undefined;
  const details = (m.details ?? {}) as Record<string, unknown>;
  const str = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  const name = str(details["agent"]) ?? str(details["handle"]) ?? str(details["subagent"]) ?? str(details["name"]);
  if (!name) return undefined;
  const detail = str(details["model"]) ?? str(details["role"]) ?? str(details["runId"]);
  return { kind: "subagent", name, ...(detail !== undefined ? { detail } : {}) };
}

/** Pi event → protocol update. Returns undefined for events with no wire form. Exported for tests. */
export function mapEvent(event: AgentSessionEvent): SessionUpdate | undefined {
  switch (event.type) {
    case "agent_start":
      return { kind: "agent_start" };
    case "agent_end":
      return { kind: "agent_end", willRetry: event.willRetry };
    case "agent_settled":
      return { kind: "agent_settled" };
    case "turn_start":
      return { kind: "turn_start" };
    case "turn_end":
      return { kind: "turn_end" };
    case "message_start": {
      const speaker = speakerOf(event.message);
      return { kind: "message_start", role: roleOf(event.message), ...(speaker ? { speaker } : {}) };
    }
    case "message_end": {
      // The named fields are the ones the UI must not have to dig for: why the
      // turn stopped (the stopped-run row), what it cost (the turn's usage) and
      // who said it. `message` still carries Pi's whole entry beside them.
      const speaker = speakerOf(event.message);
      const stopReason = stopReasonOf(event.message);
      const usage = usageOf(event.message);
      const errorMessage = (event.message as { errorMessage?: unknown }).errorMessage;
      return {
        kind: "message_end",
        message: event.message,
        role: roleOf(event.message),
        ...(speaker ? { speaker } : {}),
        ...(stopReason !== undefined ? { stopReason } : {}),
        ...(typeof errorMessage === "string" && errorMessage !== "" ? { errorMessage } : {}),
        ...(usage ? { usage } : {}),
      };
    }
    case "message_update": {
      // Serialized updates carry deltas only; clients assemble text themselves.
      const inner = event.assistantMessageEvent;
      switch (inner.type) {
        case "text_delta":
          return { kind: "text_delta", delta: inner.delta, contentIndex: inner.contentIndex };
        case "thinking_delta":
          return { kind: "thinking_delta", delta: inner.delta, contentIndex: inner.contentIndex };
        case "toolcall_delta":
          return { kind: "toolcall_delta", delta: inner.delta, contentIndex: inner.contentIndex };
        default:
          return undefined;
      }
    }
    case "tool_execution_start":
      return { kind: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
    case "tool_execution_update":
      return { kind: "tool_execution_update", toolCallId: event.toolCallId, partial: event.partialResult };
    case "tool_execution_end":
      return {
        kind: "tool_execution_end",
        toolCallId: event.toolCallId,
        result: event.result,
        isError: event.isError,
      };
    case "bash_execution_update":
      return { kind: "bash_execution_update", ...(event.id !== undefined ? { id: event.id } : {}), delta: event.delta };
    case "queue_update":
      return { kind: "queue_update", steering: [...event.steering], followUp: [...event.followUp] };
    case "compaction_start":
      return { kind: "compaction_start" };
    case "compaction_end":
      return { kind: "compaction_end", ok: !event.aborted && event.result !== undefined };
    case "auto_retry_start":
      return { kind: "auto_retry_start", attempt: event.attempt, maxAttempts: event.maxAttempts };
    case "auto_retry_end":
      return { kind: "auto_retry_end", ok: event.success };
    case "entry_appended":
      return { kind: "entry_appended", entry: event.entry };
    default:
      return undefined;
  }
}
