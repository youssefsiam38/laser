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
 *   - a user message is persisted right after its `message_end` listeners
 *     return (`AgentSession._handleAgentEvent`: emit, then
 *     `sessionManager.appendMessage`, synchronously), and the agent loop
 *     awaits that handler before the next event. So the entry id exists one
 *     microtask after the event and nothing can arrive in between; the
 *     driver holds the user `message_end` for exactly that long and sends it
 *     with `entry` — the transcript learns where a prompt landed before the
 *     provider request goes out, not when the turn ends (M13-T44);
 *   - `isStreaming` flips after `prompt()` yields, so "busy" is detected by
 *     catching Pi's error, not only by the pre-check.
 */

import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  resolveModelScopeWithDiagnostics,
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
import { ErrorCodes, ProtocolError, PRODUCT_NAME, PROJECT_DIR_NAME, SESSION_AGENT_ENTRY_TYPE, SESSION_FIRST_TURN_OVERRIDE_ENTRY_TYPE } from "@lasercode/protocol";
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
  SessionFirstTurnOverrides,
  SessionGoal,
  SessionState,
  SessionUpdate,
  StopReason,
  ThinkingLevel,
  UiDialogRequest,
  UiDialogResponse,
  Usage,
} from "@lasercode/protocol";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { supportedThinkingLevels } from "../packages.js";
import { disabledModelRefs, engineSettingsOnly, modelSwitchedOff, readEffectiveProductSettings, readLaserProjectSettings } from "../settings.js";
import { applyDurableOverrides, type EngineSettingsOverrides } from "../settings-overrides.js";
import { WebSearchService } from "../web-search.js";
import {
  DriverUnavailableError,
  type ClearedQueue,
  type DriverAgentOptions,
  type DriverEvent,
  type DriverListener,
  type DriverOpenOptions,
  type DriverInvocationRef,
  type ExtensionModelWorkHandler,
  type FirstTurnOptions,
  type PromptOptions,
  type SessionAdmissionLease,
  type SessionDriver,
} from "../driver.js";
import { createUiBridge, type UiBridge } from "../ui-bridge.js";
import { GOAL_TOOL_NAMES } from "@lasercode/pi-goal";
import { isGoalCommand } from "@lasercode/pi-extension";
import { ENGINE_BUILTIN_TOOLS, ensureWorkspaceSessionCwd, filterSkills } from "../agents/session-config.js";
import { defaultAgentInstructions } from "../agents/engine-instructions.js";
import { createInstructionTemplateExtension } from "../agents/instruction-templates.js";
import { modelUnavailableMessage } from "../agents/harness.js";
import { StableExtensionAdmission } from "./stable-extension-admission.js";

type PiModel = ReturnType<ModelRuntime["getModels"]>[number];

async function disposeRuntime(runtime: AgentSessionRuntime | undefined): Promise<void> {
  if (runtime) await runtime.dispose().catch(() => {});
}

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
  private runtimeFactory: CreateAgentSessionRuntimeFactory | undefined;
  private runtimeAgent: DriverAgentOptions | undefined;
  private runtimeModelOverride: ModelRef | undefined;
  private runtimeThinkingOverride: ThinkingLevel | undefined;
  /** Only a newly selected first-turn tuple is normalized; rollback is exact. */
  private runtimeNormalizeThinking = false;
  /** A model intent resets stale pristine thinking to the selected agent/model default. */
  private runtimeResetThinking = false;
  /** Person-selected values, distinct from Pi's automatic initial entries. */
  private explicitModelOverride: ModelRef | undefined;
  private explicitThinkingOverride: ThinkingLevel | undefined;
  private firstTurnRollback: {
    agent: DriverAgentOptions | undefined;
    modelOverride: ModelRef | undefined;
    thinkingOverride: ThinkingLevel | undefined;
  } | undefined;
  private preparedAgentRecord: DriverAgentOptions["record"] | undefined;
  /** Undefined preserves prior override provenance; null clears it on acceptance. */
  private preparedModelIntent: ModelRef | null | undefined;
  /** Undefined preserves provenance; null clears it; a level persists the accepted normalization. */
  private preparedThinkingIntent: ThinkingLevel | null | undefined;
  private unsubscribe: (() => void) | undefined;
  private cwd = "";
  private projectTrusted: boolean | undefined;
  /** A settings reload asked for mid-turn, owed once the session is idle (M13-T55). */
  private settingsReloadWanted = false;
  private agentDir = "";
  /**
   * A user `message_end` waiting one microtask for Pi to persist its message
   * (see the header). It leaves first if anything else arrives, so the order
   * of updates a client sees never changes.
   */
  private heldUserEnd: {
    update: Extract<SessionUpdate, { kind: "message_end" }>;
    message: unknown;
    invocation?: DriverInvocationRef;
  } | undefined;
  /**
   * The current engine preflight. Every invocation reserves this slot; queued
   * waiters re-check it after each await and claim it one at a time, so an idle
   * gap can never admit two prompts before `isStreaming` flips.
   */
  private promptPreflight: Promise<void> | undefined;
  private readonly extensionAdmission = new StableExtensionAdmission();

  /**
   * The prompt invocation each open dialog was raised under, by dialog id.
   * A dialog is raised from inside the tool that asks — inside the admission
   * helper's invocation context — but settles from whatever context closes
   * it (a timer, an abort, disposal), so the resolution reads the stamp its
   * request took rather than the context it fires in. Pruned against the
   * bridge's own pending list whenever a dialog is raised, so a closed
   * dialog never holds a stamp for long.
   */
  private readonly dialogInvocations = new Map<string, DriverInvocationRef>();

  constructor(private readonly extraExtensionFactories: InlineExtension[] = []) {
    this.ui = createUiBridge(
      {
        onRequest: (request) => {
          const open = new Set(this.ui.pending().map((pending) => pending.id));
          for (const id of [...this.dialogInvocations.keys()]) if (!open.has(id)) this.dialogInvocations.delete(id);
          const invocation = this.extensionAdmission.eventInvocation()?.ref;
          if (invocation) this.dialogInvocations.set(request.id, invocation);
          this.emit({ type: "ui_request", request, ...(invocation ? { invocation } : {}) });
        },
        onEvent: (event) => {
          const invocation = event.method === "dialogResolved" ? this.dialogInvocations.get(event.id) : undefined;
          if (event.method === "dialogResolved") this.dialogInvocations.delete(event.id);
          this.emit({ type: "ui_event", event, ...(invocation ? { invocation } : {}) });
        },
      },
      // Lazy: the bridge outlives every session, and no session exists yet here.
      { pendingToolCallId: () => this.currentToolCallId() },
    );
  }

  // ---------------------------------------------------------------- lifecycle

  async open(options: DriverOpenOptions): Promise<SessionState> {
    if (this.runtime) throw new DriverUnavailableError(this.kind, "session already open");
    this.cwd = options.cwd;
    this.projectTrusted = options.projectTrusted;

    const agentDir = options.agentDir ?? getAgentDir();
    this.agentDir = agentDir;
    const enabled = new Set<FeatureId>(options.features ?? ["subagents", "goals"]);
    this.runtimeAgent = options.agent;
    // Web search is an extension tool: offered whenever its feature is on.
    // Every agent has every tool (D-144), so no definition narrows this.
    const searchWanted = enabled.has("web-search");
    const search = searchWanted ? new WebSearchService(agentDir) : undefined;
    const createCompanion = (
      requestProvenance: ReturnType<typeof createPromptProvenanceObserver>,
      agent: DriverAgentOptions | undefined,
    ) => {
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
          // A safety guard over the engine's own file tools, not a feature:
          // on in every session, with nothing to enable (M13-T33).
          "file-freshness",
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
      const agent = this.runtimeAgent;
      const modelOverride = this.runtimeModelOverride;
      const thinkingOverride = this.runtimeThinkingOverride;
      const normalizeThinking = this.runtimeNormalizeThinking;
      const resetThinking = this.runtimeResetThinking;
      const requestProvenance = createPromptProvenanceObserver();
      const laser = createCompanion(requestProvenance, agent);
      let liveSession: AgentSession | undefined;
      const settingsManager = SettingsManager.create(cwd, agentDir, {
        // Laser never asks the engine to discover `<cwd>/.pi`. Project
        // settings arrive from `.laser` as curated in-memory overrides below.
        projectTrusted: false,
      });
      // Durable, not `applyOverrides`: the engine recomputes settings from the
      // two files on every reload, and `createAgentSessionServices()` below
      // reloads the resource loader — which reloads settings — before the
      // session exists. A plain override would be gone by then, taking this
      // project's `.laser` values and the discovery switches with it (M13-T12).
      applyDurableOverrides(settingsManager, this.engineOverrides(cwd));

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
      if (agent) {
        extensionFactories.push(
          createInstructionTemplateExtension({
            agent,
            agentDir,
            ...(options.stateDir ? { stateDir: options.stateDir } : {}),
            session: () => liveSession,
          }),
        );
      }
      extensionFactories.push(...this.extraExtensionFactories, laser);

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
          ...(agent ? agentResourceOptions(agent, cwd) : {}),
        },
      });
      requestProvenance.setResourceLoader(services.resourceLoader);
      const selected = modelOverride
        ? services.modelRuntime.getModels().find((model) => model.provider === modelOverride.provider && model.id === modelOverride.id)
        : agent ? await resolveAgentModel(services.modelRuntime, agent) : undefined;
      if (modelOverride && !selected) {
        throw new DriverUnavailableError(this.kind, `unknown model ${modelOverride.provider}/${modelOverride.id}`);
      }
      const defaultProvider = settingsManager.getDefaultProvider();
      const defaultModel = settingsManager.getDefaultModel();
      const effectiveModel = selected ?? (defaultProvider && defaultModel
        ? services.modelRuntime.getModel(defaultProvider, defaultModel)
        : undefined);
      const modelThinking = effectiveModel
        ? settingsManager.getModelThinkingLevel(effectiveModel.provider, effectiveModel.id)
        : undefined;
      const requestedThinking = thinkingOverride
        ?? agent?.definition.thinkingLevel
        ?? (resetThinking ? modelThinking ?? settingsManager.getDefaultThinkingLevel() : undefined);
      const supportedThinking = effectiveModel
        ? supportedThinkingLevels(effectiveModel.reasoning, effectiveModel.thinkingLevelMap)
        : undefined;
      const selectedThinking = normalizeThinking && requestedThinking && supportedThinking && !supportedThinking.includes(requestedThinking)
        ? [
            agent?.definition.thinkingLevel,
            modelThinking,
            settingsManager.getDefaultThinkingLevel(),
            "off" as const,
            supportedThinking[0],
          ].find((level): level is ThinkingLevel => level !== null && level !== undefined && supportedThinking.includes(level))
        : requestedThinking;
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        ...(sessionStartEvent ? { sessionStartEvent } : {}),
        // The built-in tools a definition leaves out are denied outright, so
        // nothing inside the session can switch them back on. `tools:` is not
        // used: it is an allowlist that would also deny every extension tool
        // (the harness's, background work's, the goal's, web search's).
        ...(selected ? { model: selected } : {}),
        ...(selectedThinking ? { thinkingLevel: selectedThinking } : {}),
      });
      // The definition's built-ins beyond the engine's default four (grep,
      // find, ls) are switched on here, not through a `defaultTools` setting:
      // that setting names built-ins only, and D-144 gives every agent every
      // tool — the harness's, background work's, the goal's, web search's.
      if (agent) activateEveryTool(created.session);
      liveSession = created.session;
      return { ...created, services, diagnostics: services.diagnostics };
    };

    const agent = this.runtimeAgent;
    // Beam and Chat run in the app's own workspace. The engine records the
    // directory in the session header and refuses to build a runtime whose
    // stored directory is gone, so a workspace that vanished (a moved state
    // directory, an older layout) is recreated here — before the runtime is
    // built — rather than costing the person every chat in it.
    if (agent) await ensureWorkspaceSessionCwd(agent.role.kind, options.cwd, options.sessionPath);

    // A load is not a create. Pi's open() deliberately accepts a missing or
    // empty file and invents a new session using process.cwd(). After a worker
    // restart that used to replace an unwritten conversation with an unrelated
    // one under the host's state directory. Validate before the engine gets it,
    // and build the saved runtime directly instead of creating then switching.
    if (options.sessionPath) {
      let saved = false;
      try {
        const file = statSync(options.sessionPath);
        saved = file.isFile() && file.size > 0;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
      if (!saved) {
        throw new ProtocolError(ErrorCodes.SessionNotFound, "This conversation has no saved transcript to reopen. Start a new session.");
      }
    }
    const sessionManager = options.sessionPath
      ? SessionManager.open(options.sessionPath)
      : SessionManager.create(options.cwd, options.sessionDir);
    const openingEntries = sessionManager.getEntries() as Array<{ type?: unknown; customType?: unknown; data?: unknown }>;
    const savedOverrides = openingEntries.findLast((entry) => entry.type === "custom" && entry.customType === SESSION_FIRST_TURN_OVERRIDE_ENTRY_TYPE)?.data;
    const overrides = savedOverrides && typeof savedOverrides === "object" ? savedOverrides as SessionFirstTurnOverrides : undefined;
    this.explicitModelOverride = overrides?.model;
    this.explicitThinkingOverride = overrides?.thinkingLevel;
    this.runtimeFactory = createRuntime;
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: sessionManager.getCwd(),
      agentDir,
      sessionManager,
      ...(options.sessionPath ? { sessionStartEvent: { type: "session_start" as const, reason: "resume" as const } } : {}),
    });
    this.runtime = runtime;

    if (!options.sessionPath && options.parentSessionPath) {
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
    this.flushHeldUserEnd();
    this.unsubscribe?.();
    // A replaced runtime carries none of the old session's in-flight tool calls.
    this.toolCalls.clear();
    const generation = this.extensionAdmission.install(session);
    await session.bindExtensions({
      mode: "rpc",
      uiContext: this.ui.context,
      abortHandler: () => void session.abort(),
      onError: (error: ExtensionError) => {
        // Attribution comes only from the async context the error was raised
        // in — the causal invocation the extension called from, if any —
        // never from the error text. The engine's own send-rejection
        // diagnostic runs in the sender's context, so a refused top-level
        // send arrives unowned; the harness leaves unowned Stable
        // diagnostics alone because the completion promise already carries
        // that failure. The update itself is always pushed, so the error
        // stays visible in the transcript.
        const invocation = this.extensionAdmission.diagnosticInvocation(generation);
        this.push(
          { kind: "extension_error", extension: error.extensionPath, message: error.error },
          invocation,
        );
      },
    });
    this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event, generation));
  }

  /** Rebuild this runtime around the same manager; never two live writers. */
  private async replaceRuntime(
    agent: DriverAgentOptions | undefined,
    modelOverride: ModelRef | undefined,
    thinkingOverride: ThinkingLevel | undefined,
    normalizeThinking = false,
    resetThinking = false,
  ): Promise<void> {
    const current = this.runtime;
    const factory = this.runtimeFactory;
    if (!current || !factory) throw new DriverUnavailableError(this.kind, "no session open");
    const manager = current.session.sessionManager;
    const effective = this.state();
    const previous = {
      agent: this.runtimeAgent,
      modelOverride: effective.model ?? undefined,
      thinkingOverride: effective.thinkingLevel,
      normalizeThinking: this.runtimeNormalizeThinking,
      resetThinking: this.runtimeResetThinking,
    };
    const previousSessionFile = manager.getSessionFile();
    const create = () => createAgentSessionRuntime(factory, {
      cwd: manager.getCwd(),
      agentDir: this.agentDir,
      sessionManager: manager,
      sessionStartEvent: {
        type: "session_start" as const,
        reason: "resume" as const,
        ...(previousSessionFile ? { previousSessionFile } : {}),
      },
    });

    this.flushHeldUserEnd();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.extensionAdmission.invalidate();
    await current.dispose();
    this.runtime = undefined;
    this.runtimeAgent = agent;
    this.runtimeModelOverride = modelOverride;
    this.runtimeThinkingOverride = thinkingOverride;
    this.runtimeNormalizeThinking = normalizeThinking;
    this.runtimeResetThinking = resetThinking;
    let replacement: AgentSessionRuntime | undefined;
    try {
      replacement = await create();
      this.runtime = replacement;
      await this.applySession();
    } catch (error) {
      const failedUnsubscribe = this.unsubscribe as (() => void) | undefined;
      failedUnsubscribe?.();
      this.unsubscribe = undefined;
      await disposeRuntime(this.runtime);
      this.runtime = undefined;
      this.runtimeAgent = previous.agent;
      this.runtimeModelOverride = previous.modelOverride;
      this.runtimeThinkingOverride = previous.thinkingOverride;
      this.runtimeNormalizeThinking = previous.normalizeThinking;
      this.runtimeResetThinking = previous.resetThinking;
      try {
        this.runtime = await create();
        await this.applySession();
      } catch (rollbackError) {
        this.runtime = undefined;
        throw new AggregateError([error, rollbackError], "Could not prepare the selected agent or restore this conversation.");
      }
      throw error;
    }
  }

  async prepareFirstTurn(options: FirstTurnOptions): Promise<void> {
    if (this.promptPreflight) {
      throw new ProtocolError(ErrorCodes.InvalidParams, "This conversation is already accepting its first prompt.");
    }
    if (this.firstTurnRollback || this.preparedAgentRecord) {
      throw new ProtocolError(ErrorCodes.InvalidParams, "A first-turn agent choice is already being prepared for this conversation.");
    }
    // Restoration is an exact effective-state snapshot, not another default
    // resolution. A model intent resets stale thinking; an absent one preserves it.
    const effective = this.state();
    const previous = {
      agent: this.runtimeAgent,
      modelOverride: effective.model ?? undefined,
      thinkingOverride: effective.thinkingLevel,
    };
    const hasModelIntent = Object.hasOwn(options, "model");
    await this.replaceRuntime(
      options.agent,
      hasModelIntent ? (options.model ?? undefined) : this.explicitModelOverride,
      options.thinkingLevel ?? (hasModelIntent ? undefined : this.explicitThinkingOverride),
      true,
      hasModelIntent,
    );
    this.firstTurnRollback = previous;
    this.preparedAgentRecord = options.agent.record;
    this.preparedModelIntent = options.model;
    this.preparedThinkingIntent = options.thinkingLevel !== undefined
      ? (this.state().thinkingLevel ?? options.thinkingLevel)
      : hasModelIntent ? null : undefined;
  }

  async rollbackFirstTurn(): Promise<void> {
    const previous = this.firstTurnRollback;
    if (!previous) return;
    await this.replaceRuntime(previous.agent, previous.modelOverride, previous.thinkingOverride);
    this.firstTurnRollback = undefined;
    this.preparedAgentRecord = undefined;
    this.preparedModelIntent = undefined;
    this.preparedThinkingIntent = undefined;
  }

  /** Persist the replacement identity and accepted intent at Pi's exact prompt-acceptance boundary. */
  private commitPreparedFirstTurn(): void {
    const record = this.preparedAgentRecord;
    if (!record) return;
    const modelIntent = this.preparedModelIntent;
    const thinkingIntent = this.preparedThinkingIntent;
    // Acceptance is monotonic even if persistence reports an I/O error: never
    // leave a rollback armed for a prompt the engine already owns.
    this.preparedAgentRecord = undefined;
    this.preparedModelIntent = undefined;
    this.preparedThinkingIntent = undefined;
    this.firstTurnRollback = undefined;
    this.session().sessionManager.appendCustomEntry(SESSION_AGENT_ENTRY_TYPE, record);
    if (modelIntent !== undefined) this.explicitModelOverride = modelIntent ?? undefined;
    if (thinkingIntent !== undefined) {
      this.explicitThinkingOverride = thinkingIntent ?? undefined;
      this.runtimeThinkingOverride = thinkingIntent ?? undefined;
    }
    this.runtimeNormalizeThinking = false;
    this.runtimeResetThinking = false;
    if (modelIntent !== undefined || thinkingIntent !== undefined) this.persistExplicitOverrides();
  }

  async dispose(): Promise<void> {
    this.flushHeldUserEnd();
    this.unsubscribe?.();
    this.extensionAdmission.invalidate();
    this.unsubscribe = undefined;
    this.toolCalls.clear();
    this.ui.dispose();
    await this.runtime?.dispose();
    this.runtime = undefined;
    this.runtimeFactory = undefined;
    this.runtimeAgent = undefined;
    this.runtimeModelOverride = undefined;
    this.runtimeThinkingOverride = undefined;
    this.runtimeNormalizeThinking = false;
    this.runtimeResetThinking = false;
    this.explicitModelOverride = undefined;
    this.explicitThinkingOverride = undefined;
    this.firstTurnRollback = undefined;
    this.preparedAgentRecord = undefined;
    this.preparedModelIntent = undefined;
    this.preparedThinkingIntent = undefined;
    this.emit({ type: "closed", reason: "disposed" });
    this.listeners.clear();
  }

  subscribe(listener: DriverListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setExtensionModelWorkHandler(handler: ExtensionModelWorkHandler | undefined): void {
    this.extensionAdmission.setHandler(handler);
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

  async entries(): Promise<{ entries: unknown[]; leafId: string | null }> {
    const manager = this.session().sessionManager;
    // Every branch, plus the pointer that says which one is the conversation.
    // The leaf is in-memory only — the engine rebuilds it as the last entry in
    // the file — so a navigation that has appended nothing yet is visible here
    // and nowhere else.
    return { entries: manager.getEntries(), leafId: manager.getLeafId() };
  }

  async goalState(): Promise<SessionGoal | null> {
    return toSessionGoal(goalStateFromEntries(this.session().sessionManager.getBranch()));
  }

  async goalAction(action: GoalAction, options?: { admissionLease?: SessionAdmissionLease; onAccepted?: () => void }): Promise<SessionGoal | null> {
    const session = this.session();
    const nativePrompt = this.extensionAdmission.nativePrompt(session);
    activateGoalTools(session);
    let accepted = false;
    const context = this.extensionAdmission.createInvocation({
      origin: "user",
      task: goalActionTask(action),
      ...(options?.admissionLease ? { admissionLease: options.admissionLease } : {}),
      accept: () => {
        if (accepted) return;
        accepted = true;
        options?.onAccepted?.();
      },
    });
    await this.extensionAdmission.runInvocation(
      context,
      () => nativePrompt(goalCommand(action), { preflightResult: () => context.accept() }),
      false,
    );
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
    // A bare concurrent prompt is refused immediately. Explicit queue waiters
    // pass every preceding preflight fence in admission order; after each await
    // they re-check because another waiter may have claimed the newly idle slot.
    while (this.promptPreflight) {
      if (!options?.streamingBehavior) return { accepted: false, queued: false };
      await this.promptPreflight;
    }

    let release = () => {};
    const reservation = new Promise<void>((resolve) => { release = resolve; });
    this.promptPreflight = reservation;
    const finishPreflight = () => {
      if (this.promptPreflight !== reservation) return;
      this.promptPreflight = undefined;
      release();
    };
    const streaming = session.isStreaming;
    let accepted = false;
    const accept = () => {
      if (accepted) return;
      accepted = true;
      finishPreflight();
      try {
        // The replacement record must precede Pi's user-message append.
        // Like every acceptance observer, a disk failure is reported but
        // cannot revoke a prompt the engine already owns.
        this.commitPreparedFirstTurn();
      } catch (error) {
        console.error(`${PRODUCT_NAME} worker: could not persist the accepted agent choice:`, error instanceof Error ? error.message : error);
      }
      if (!options?.onAccepted) return;
      try {
        // Observing acceptance must never prevent the accepted engine run.
        options.onAccepted();
      } catch (error) {
        console.error(`${PRODUCT_NAME} worker: could not publish an accepted prompt:`, error instanceof Error ? error.message : error);
      }
    };
    const context = this.extensionAdmission.createInvocation({
      ...(options?.ownerRunId ? { ownerRunId: options.ownerRunId } : {}),
      // The run record's word, handed down by the harness: a send made from
      // inside this turn inherits it, so a parent-started run's extension
      // work never reads as the person's.
      origin: options?.origin ?? "user",
      task: text,
      ...(options?.admissionLease ? { admissionLease: options.admissionLease } : {}),
      accept,
    });
    options?.onInvocation?.(context.ref);
    try {
      if (streaming && !options?.streamingBehavior) {
        return { accepted: false, queued: false };
      }
      await this.extensionAdmission.runInvocation(context, () => session.prompt(text, {
        ...(images.length > 0 ? { images } : {}),
        ...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
        ...(options?.expandPromptTemplates !== undefined ? { expandPromptTemplates: options.expandPromptTemplates } : {}),
        // Pi's per-invocation preflight is the exact boundary between a prompt
        // we still own and a user message the engine owns. `session.prompt()`
        // itself resolves only after the whole turn, including retries.
        preflightResult: (preflightAccepted: boolean) => {
          if (preflightAccepted) accept();
          else finishPreflight();
        },
      }), true);
    } catch (error) {
      // Pi can throw the same busy-shaped error after reporting true. Acceptance
      // is monotonic: only a busy error from before acknowledgement is refusal.
      if (!accepted && isBusyError(error)) return { accepted: false, queued: false };
      throw error;
    } finally {
      // Defensive for an engine failure that bypassed its documented callback.
      finishPreflight();
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

  /**
   * Empty both of the engine's lanes and say what they held. The session's
   * own `clearQueue()` lists only the user texts it queued itself
   * (`_steeringMessages` / `_followUpMessages`); an extension's `sendMessage`
   * with `deliverAs` behind a running turn goes straight to agent-core
   * (`agent.steer()` / `agent.followUp()`, agent-session.js `sendCustomMessage`)
   * and is dropped by `agent.clearAllQueues()` without ever being listed. Those
   * are read here first, from agent-core's queues (`Agent.steeringQueue` /
   * `followUpQueue`, each a `PendingMessageQueue` with a public `messages`
   * array in the installed dist; declared private in its typings), and
   * reported as `custom` so the harness can carry them to a successor.
   */
  async clearQueue(): Promise<ClearedQueue> {
    const session = this.session();
    const queues = session.agent as unknown as { steeringQueue?: { messages?: unknown[] }; followUpQueue?: { messages?: unknown[] } };
    const custom = {
      steering: customQueueTexts(queues.steeringQueue?.messages),
      followUp: customQueueTexts(queues.followUpQueue?.messages),
    };
    const cleared = session.clearQueue();
    return custom.steering.length > 0 || custom.followUp.length > 0 ? { ...cleared, custom } : cleared;
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
    const session = this.session();
    const runtime = session.modelRuntime;
    try {
      const available = await runtime.getAvailable();
      if (available.length > 0) return (await this.offeredModels(available)).map(toModelRef);
    } catch {
      // Fall through: a picker with every model beats a picker with none.
    }
    return runtime.getModels().map(toModelRef);
  }

  /**
   * The same narrowing the catalogue applies (M13-T49): the `enabledModels`
   * allow-list when it matches anything, then the product's own
   * `disabledModels` switches. Without it a session's picker would keep
   * offering what Settings → Providers and models says is hidden. Both lists
   * are read from the files, not the session, even now that a Settings write
   * reloads live sessions (M13-T55): `disabledModels` is a product key that
   * never enters the engine's settings, so the session's manager cannot
   * answer it, and a write the reload does not reach — a worktree session's
   * own `.laser`, a file edited by hand — must still show on the picker's
   * next open. A file read is the one source that covers all of them.
   */
  private async offeredModels(available: readonly PiModel[]): Promise<PiModel[]> {
    const effective = readEffectiveProductSettings(this.cwd, this.agentDir, this.projectTrusted);
    const patterns = Array.isArray(effective["enabledModels"])
      ? (effective["enabledModels"] as unknown[]).filter((p): p is string => typeof p === "string")
      : [];
    let offered: PiModel[] = [...available];
    if (patterns.length > 0) {
      const scope = await resolveModelScopeWithDiagnostics(patterns, this.session().modelRuntime);
      const allowed = new Set(scope.scopedModels.map((s) => `${s.model.provider}/${s.model.id}`));
      // The engine itself falls back to every model when the list matches
      // nothing, warning rather than offering an empty picker.
      if (allowed.size > 0) offered = offered.filter((model) => allowed.has(`${model.provider}/${model.id}`));
    }
    const disabled = disabledModelRefs(effective["disabledModels"]);
    return disabled.size === 0 ? offered : offered.filter((model) => !modelSwitchedOff(model, disabled));
  }

  async setModel(model: ModelRef): Promise<SessionState> {
    const session = this.session();
    const match = session.modelRuntime
      .getModels()
      .find((m) => m.provider === model.provider && m.id === model.id);
    if (!match) throw new DriverUnavailableError(this.kind, `unknown model ${model.provider}/${model.id}`);
    await session.setModel(match);
    this.explicitModelOverride = { ...model };
    this.persistExplicitOverrides();
    return this.state();
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<SessionState> {
    this.session().setThinkingLevel(level);
    this.explicitThinkingOverride = level;
    this.persistExplicitOverrides();
    return this.state();
  }

  private persistExplicitOverrides(): void {
    const data: SessionFirstTurnOverrides = {
      ...(this.explicitModelOverride ? { model: this.explicitModelOverride } : {}),
      ...(this.explicitThinkingOverride ? { thinkingLevel: this.explicitThinkingOverride } : {}),
    };
    this.session().sessionManager.appendCustomEntry(SESSION_FIRST_TURN_OVERRIDE_ENTRY_TYPE, data);
  }

  // ------------------------------------------------------------------ session

  async rename(name: string): Promise<void> {
    this.session().setSessionName(name);
  }

  async compact(instructions?: string): Promise<void> {
    await this.session().compact(instructions);
  }

  /**
   * Move the leaf. The engine refuses this outright while a turn streams
   * (`navigateTree` throws "Wait for the current response to finish"), so a
   * person who edits or jumps mid-turn has asked for the turn to stop first:
   * `stopFirst` does the same `abort()` the Stop button does — the partial
   * reply settles with `stopReason: "aborted"`, on the branch being left —
   * and only then moves. The stop is not undone when the move fails: the
   * session is then idle, unmoved, and honest about why (M13-T46).
   */
  async navigateTree(
    entryId: string,
    options?: { summarize?: boolean; label?: string; stopFirst?: boolean },
  ): Promise<{ editorText?: string; cancelled: boolean }> {
    if (options?.stopFirst) await this.abort();
    const result = await this.session().navigateTree(entryId, {
      ...(options?.summarize !== undefined ? { summarize: options.summarize } : {}),
      ...(options?.label !== undefined ? { label: options.label } : {}),
    });
    return {
      ...(result.editorText !== undefined ? { editorText: result.editorText } : {}),
      cancelled: result.cancelled,
    };
  }

  /**
   * Fork before `entryId` into a new session file. The engine's own `fork`
   * tears the current session down, and its teardown aborts a streaming turn
   * itself, so the original never keeps streaming into a runtime nothing is
   * attached to — but that abort comes *after* its validation, and a session
   * whose first reply is still streaming has no file yet, so such a fork is
   * refused ("not been saved yet") while the turn runs on. `stopFirst` stops
   * before anything else: the aborted reply is written (which is what creates
   * the file), the transcript records the stop, and a fork that then fails
   * leaves the original stopped and untouched (M13-T46).
   */
  async fork(entryId: string, options?: { stopFirst?: boolean }): Promise<{ state: SessionState; editorText?: string }> {
    if (!this.runtime) throw new DriverUnavailableError(this.kind, "no open session");
    if (options?.stopFirst) await this.abort();
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

  // --------------------------------------------------------- settings reload

  /**
   * A Settings write reached the files; make this session read them (M13-T55).
   *
   * The path is the engine's own settings reload — `SettingsManager.reload()`,
   * which `applyDurableOverrides` wraps so the `.laser` values survive it —
   * with the `.laser` file re-read first, because a project-scope write is
   * exactly a change to those durable values. The queue modes are then synced
   * into the agent the way `AgentSession.reload()` does it, and a `state`
   * update carries the new values to the UI. The full `AgentSession.reload()`
   * is not used: it also shuts down and restarts every extension, which would
   * end the background work and harness state the companion holds.
   *
   * Never mid-turn. The engine reads compaction, retry and queue settings while
   * a turn runs, so a turn finishes under the settings it started with; a
   * reload asked for meanwhile runs when the session is next idle.
   */
  async reloadSettings(): Promise<{ deferred: boolean }> {
    const session = this.session();
    if (!session.isIdle) {
      this.settingsReloadWanted = true;
      return { deferred: true };
    }
    await this.applySettingsReload();
    return { deferred: false };
  }

  private async applySettingsReload(): Promise<void> {
    this.settingsReloadWanted = false;
    const session = this.session();
    const manager = session.settingsManager;
    // Fresh `.laser` values replace the durable set (never stack), and the
    // wrapped reload re-applies them over the re-read global file.
    applyDurableOverrides(manager, this.engineOverrides(session.sessionManager.getCwd()));
    await manager.reload();
    // What `AgentSession.reload()` does after its settings reload: the agent
    // holds its own copy of the two queue modes.
    session.agent.steeringMode = manager.getSteeringMode();
    session.agent.followUpMode = manager.getFollowUpMode();
    this.push({ kind: "state", state: this.state() });
  }

  /** A reload that arrived mid-turn, run once the turn has settled. */
  private runDeferredSettingsReload(): void {
    if (!this.settingsReloadWanted || !this.runtime || !this.runtime.session.isIdle) return;
    void this.applySettingsReload().catch((error: unknown) => {
      console.error(`${PRODUCT_NAME} worker: could not reload settings after the turn:`, error instanceof Error ? error.message : error);
    });
  }

  /**
   * The engine's in-memory overrides for a session in `cwd`: the project's
   * `.laser` values when the project is trusted, and the switches that keep
   * engine-owned discovery off. Packages and loose resources are an engine
   * implementation detail; the features are the only reviewed extensions in
   * the runtime.
   */
  private engineOverrides(cwd: string): EngineSettingsOverrides {
    return {
      ...(this.projectTrusted === false ? {} : engineSettingsOnly(readLaserProjectSettings(cwd))),
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    };
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

  private push(update: SessionUpdate, invocation?: DriverInvocationRef): void {
    this.emit({ type: "update", update, ...(invocation ? { invocation } : {}) });
  }

  private onSessionEvent(event: AgentSessionEvent, generation: number): void {
    const invocation = this.extensionAdmission.eventInvocation(generation);
    if (event.type === "agent_start" && invocation) invocation.started = true;
    this.toolCalls.note(event);
    this.flushHeldUserEnd();
    const update = mapEvent(event);
    if (update?.kind === "message_end" && update.role === "user" && event.type === "message_end") {
      // Pi writes the entry right after this listener returns; the id is
      // readable one microtask from now (header). Nothing else is pushed for
      // a user message_end, so holding it changes no order.
      this.heldUserEnd = {
        update,
        message: event.message,
        ...(invocation ? { invocation: invocation.ref } : {}),
      };
      queueMicrotask(() => this.flushHeldUserEnd());
      return;
    }
    if (update) this.emit({ type: "update", update, ...(invocation ? { invocation: invocation.ref } : {}) });
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
    if (event.type === "agent_settled" || event.type === "compaction_end") this.runDeferredSettingsReload();
  }

  /** Send the held user `message_end`, with its entry when Pi has written it. */
  private flushHeldUserEnd(): void {
    const held = this.heldUserEnd;
    if (!held) return;
    this.heldUserEnd = undefined;
    const entry = this.persistedEntryOf(held.message);
    this.push(entry ? { ...held.update, entry } : held.update, held.invocation);
  }

  /**
   * The entry holding exactly this message object — `appendMessage` stores
   * the reference — or undefined when Pi did not persist it. The leaf first,
   * because that is where a fresh append lands; the branch only when
   * something else was written after it.
   */
  private persistedEntryOf(message: unknown): { id: string; parentId: string | null } | undefined {
    try {
      const manager = this.session().sessionManager;
      const leaf = manager.getLeafEntry();
      if (leaf?.type === "message" && leaf.message === message) return { id: leaf.id, parentId: leaf.parentId };
      const branch = manager.getBranch();
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i]!;
        if (entry.type === "message" && entry.message === message) return { id: entry.id, parentId: entry.parentId };
      }
      return undefined;
    } catch {
      return undefined;
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
 * instructions (or Laser's default), and which discovered skills it is offered.
 */
function agentResourceOptions(agent: DriverAgentOptions, cwd: string): {
  systemPromptOverride?: () => string | undefined;
  skillsOverride: <T extends { skills: Array<{ name: string }>; diagnostics: unknown[] }>(base: T) => T;
} {
  const { definition, role } = agent;
  return {
    systemPromptOverride: () => (definition.engineInstructions ? defaultAgentInstructions(cwd) : definition.instructions),
    skillsOverride: (base) => ({ ...base, skills: filterSkills(base.skills, { definition, role }) }),
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

function goalActionTask(action: GoalAction): string {
  switch (action.action) {
    case "start":
    case "edit":
      return action.objective;
    case "resume":
      return "Resume goal";
    case "pause":
      return "Pause goal";
    case "clear":
      return "Clear goal";
  }
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

/**
 * The text of every custom message in one of agent-core's queues, in queue
 * order. User messages there are the session's own queued texts, already
 * reported by its `clearQueue()`; only `role: "custom"` entries (an
 * extension's `sendMessage` while a turn ran) are invisible to it. A custom
 * message carries a string or content blocks; images have no text and are
 * left out — nothing shipped queues one.
 */
function customQueueTexts(messages: unknown[] | undefined): string[] {
  if (!Array.isArray(messages)) return [];
  const texts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "custom") continue;
    const content = (message as { content?: unknown }).content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((block): block is { type: "text"; text: string } => !!block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
            .map((block) => block.text)
            .join("\n")
        : "";
    if (text.trim() !== "") texts.push(text);
  }
  return texts;
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
