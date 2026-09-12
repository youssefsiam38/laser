/**
 * WorkerServer (M0-T6) — JSON-RPC dispatch for one worker process (one cwd).
 *
 * Transport-agnostic: the caller feeds raw inbound values into `handle()` and
 * receives outbound messages through `send`. `main.ts` wires this to a pipe.
 *
 * Sessions are keyed by session file path. Each carries a monotonically
 * increasing `seq` and a bounded replay buffer so a client can `session/load`
 * with `fromSeq` after a reconnect and miss nothing that is still buffered.
 * Pending extension dialogs are re-emitted on load for the same reason.
 */

import { AGENT_MAX_DEPTH_LIMIT, ENV, ErrorCodes, PRODUCT_NAME, ProtocolError, parseClientRequest, type AgentDefinition, type AgentModelChoice, type ClientRequests, type CommandInfo, type ContentBlock, type FeatureId, type HostNotifications, type JsonRpcMessage, type JsonRpcResponse, type PiExtensionModuleName, type SessionAgentRecord, type SessionState, type SessionUpdateParams, type ProjectEnvStatus, type ProjectEnvWorkerConfig, type SettingsScope, type TypedClientRequest } from "@lasercode/protocol";
import { join, resolve } from "node:path";
import type {
  DriverAgentOptions,
  DriverEvent,
  ExtensionModelAdmission,
  ExtensionModelExecution,
  ExtensionModelWorkRequest,
  SessionAdmissionLease,
  SessionDriver,
} from "./driver.js";
import { ProjectFilesService } from "./files.js";
import { ReplayBuffer } from "./replay-buffer.js";
import { assertFirstTurnAdmission, FirstTurnLock } from "./first-turn.js";
import { PendingTray } from "./pending.js";
import { GitService } from "./git.js";
import { KeybindingsAdapter } from "./keybindings.js";
import { ModelsAdapter, PackagesAdapter } from "./packages.js";
import { SettingsAdapter } from "./settings.js";
import { WebSearchService } from "./web-search.js";
import { McpService } from "./mcp/service.js";
import { TranscribeService } from "./transcribe.js";
import { ProjectEnvironment } from "./project-env.js";
import type { HarnessSessionRole } from "./agents/bridge.js";
import type { ProjectEnvironmentBridge } from "@lasercode/pi-extension";
import { DefinitionsCache } from "./agents/definitions.js";
import { defaultAgentInstructions } from "./agents/engine-instructions.js";
import { AgentHarness, modelUnavailableMessage, type SessionHandle, type SessionHost } from "./agents/harness.js";
import { NamerService, type NamerModelRuntime } from "./agents/namer.js";
import { readSessionAgentRecord, rootRecord, rootRole, removedWorktreeCwd } from "./agents/session-config.js";
import { listAgentSkills } from "./agents/skills.js";
import { TaskIndex } from "./agents/tasks.js";
import { WorktreeManager } from "./agents/worktrees.js";

export interface WorkerServerOptions {
  cwd: string;
  createDriver: () => SessionDriver;
  send: (message: JsonRpcMessage) => void;
  agentDir?: string;
  sessionDir?: string;
  /** The host's state directory (agents, runs, prefs). Defaults to `<agentDir>/../state`. */
  stateDir?: string;
  /** Host-resolved Pi project trust for `cwd`; see `DriverOpenOptions.projectTrusted`. */
  projectTrusted?: boolean;
  features?: FeatureId[];
  /** Updates kept per session for `fromSeq` replay. */
  replayBuffer?: number;
  /** Serialized-byte ceiling per replay suffix, independent of live state. */
  replayBytes?: number;
  /** The package manager to run when settings name none (M10-T5): the one the host bundles. */
  npmCommand?: string[];
  /** Test seam: the model runtime Namer completes through. Defaults to the engine's. */
  namerModels?: () => Promise<NamerModelRuntime>;
}

/** Sessions whose first prompt may wait for a Namer model; a worker holds few at once. */
const UNNAMED_MAX = 32;

interface PreAcceptanceHydration {
  /** Genuine accepted baseline captured before candidate runtime preparation. */
  state: SessionState;
  entries: unknown[];
  leafId: string | null;
  goal: Awaited<ReturnType<NonNullable<SessionDriver["goalState"]>>>;
}

interface Live {
  driver: SessionDriver;
  seq: number;
  buffer: ReplayBuffer;
  /** Read-only hydration baseline while a first turn is speculative/restoring. */
  preAcceptance?: PreAcceptanceHydration;
  unsubscribe: () => void;
  path: string;
  /** The harness's view of this session, once attached. */
  handle?: SessionHandle;
  /**
   * Messages the person wrote while the agent was working. Laser's own list,
   * not the engine's: see `packages/worker/src/pending.ts`. Attached once the
   * session's path is known, because every publication names it.
   */
  pending?: PendingTray;
}

type Result<M extends keyof ClientRequests> = ClientRequests[M]["result"];

export class WorkerServer {
  private readonly sessions = new Map<string, Live>();
  /**
   * Opens in flight, keyed by session path. `handle()` dispatches concurrently,
   * so two `session/load`s for one path used to miss the `sessions` map, build
   * two drivers on one Pi session file (AGENTS.md invariant 8) and orphan the
   * first — its subscription still emitting, its runtime leaked. Nothing above
   * can dedupe this: a desktop and a phone are two clients, and the pool's
   * crash recovery can race a client's own reconnect.
   */
  private readonly opening = new Map<string, Promise<Live>>();
  private readonly replayBuffer: number;
  /**
   * M4 adapters. Built on first use: constructing a `SettingsManager` reads two
   * files and `ModelRuntime.create` touches the network-free catalogue, and a
   * worker that never opens the settings screen should pay for neither.
   */
  private settingsAdapter: SettingsAdapter | undefined;
  private packagesAdapter: PackagesAdapter | undefined;
  private modelsAdapter: ModelsAdapter | undefined;
  /** M2-T6 git line. Built on first use like the adapters above. */
  private gitService: GitService | undefined;
  /** M4-T7 keybindings, and the `@` popover's file list. Both built on first use. */
  private keybindingsAdapter: KeybindingsAdapter | undefined;
  private filesService: ProjectFilesService | undefined;
  /** M8-T2 dictation. Built on first use; `register()` publishes drain() in-process. */
  private transcribeService: TranscribeService | undefined;
  /** M14 MCP servers: configuration, the inspector and per-session status. */
  private mcpService: McpService | undefined;
  /** The companion extension's last capability report; features gate on it (M8-T1). */
  private activeModules = new Set<PiExtensionModuleName>();
  /** Coalesce simultaneous new-chat command requests into one read-only runtime. */
  private commandCatalogInFlight: Promise<CommandInfo[]> | undefined;
  /**
   * The project's environment command (M16-T17). One worker serves one project
   * directory, so this is the project's environment, held in memory and never
   * written into `process.env` — the worker's own environment is what the
   * engine authenticates a model with.
   */
  private readonly projectEnv: ProjectEnvironment | undefined;
  /** M13 · agents: the host's definitions, the harness that runs them, and Namer. */
  private readonly definitions: DefinitionsCache;
  private readonly harness: AgentHarness;
  private readonly namer: NamerService;
  /**
   * Every background command a session of this worker published, kept beside
   * the runs so the harness can hand an agent the same tree the fleet shows
   * (`inspect_fleet`, D-163). Fed from the `lasercode/task/update` messages
   * forwarded to the host below; the host keeps its own copy for clients.
   */
  private readonly tasks = new TaskIndex();
  /**
   * First prompts still waiting for a Namer model, by session path. A prompt
   * that arrives before the host's `agents/sync` (or before qualification
   * finishes) would otherwise be the one prompt that never names its session.
   * Bounded, because a run with naming off must not grow this for ever.
   */
  private readonly unnamed = new Map<string, string>();
  /** Tool calls currently running, by session path: a label for a finished call is never shown. */
  private readonly runningTools = new Map<string, Set<string>>();
  /** Held only through prompt preflight; prevents runtime replacement races. */
  private readonly firstTurnLock = new FirstTurnLock();

  constructor(private readonly options: WorkerServerOptions) {
    this.replayBuffer = options.replayBuffer ?? 5000;
    // Configured by the host, machine-local and non-secret: the executable, its
    // arguments, and whether a person approved exactly that pair.
    const projectEnvConfig = readProjectEnvConfig();
    this.projectEnv = projectEnvConfig
      ? new ProjectEnvironment({ cwd: options.cwd, config: projectEnvConfig })
      : undefined;
    this.definitions = new DefinitionsCache();
    const host: SessionHost = {
      openChild: (open) => this.openChild(open),
      driver: (path) => this.sessions.get(path)?.driver,
      notify: (method, params) => this.notify(method, params),
      modelAvailable: (model) => this.modelAvailable(model),
      tasks: (path) => this.tasks.tasksOf(path),
    };
    this.harness = new AgentHarness({
      host,
      definitions: this.definitions,
      worktrees: new WorktreeManager(),
      ...(options.projectTrusted !== undefined ? { projectTrusted: options.projectTrusted } : {}),
      backgroundWork: (cwd) => ({
        cwd,
        foregroundCommandSeconds: this.definitions.policy().foregroundCommandSeconds,
        // Every child agent and every worktree of this project runs in this
        // worker, so they share the project's environment by construction.
        ...(this.projectEnv ? { projectEnv: this.projectEnvBridge() } : {}),
      }),
    });
    this.namer = new NamerService({
      models: options.namerModels ?? (() => this.modelCatalog().modelRuntime()),
      model: () => this.definitions.namerModel(),
      instructions: () => this.definitions.namerInstructions(),
      catalog: async () => {
        const [catalog, providers] = await Promise.all([this.modelCatalog().catalog(false), this.modelCatalog().providers()]);
        return { models: catalog.models, configuredProviders: new Set(providers.providers.filter((p) => p.configured).map((p) => p.id)) };
      },
    });
    // The host's first `agents/sync` (and every later one) can be what turns
    // naming on: until it lands the cache answers `namer.model === null`, and
    // qualification itself finishes seconds after the first prompt. A session
    // whose first prompt found no model is named the moment one appears.
    this.definitions.onChange(() => this.nameWaitingSessions());
  }

  /** The harness, for tests and for the packaged probe. */
  agents(): AgentHarness {
    return this.harness;
  }

  /** Paths of sessions currently open in this worker. */
  openSessions(): string[] {
    return [...this.sessions.keys()];
  }

  notify<M extends keyof HostNotifications>(method: M, params: HostNotifications[M]): void {
    this.options.send({ jsonrpc: "2.0", method, params });
  }

  /** Handle one inbound raw JSON-RPC value. Never throws; errors become responses. */
  async handle(raw: unknown): Promise<void> {
    let req: TypedClientRequest;
    try {
      req = parseClientRequest(raw);
    } catch (error) {
      const id = (raw as { id?: string | number } | null)?.id ?? null;
      this.respondError(id, error);
      return;
    }
    try {
      const result = await this.dispatch(req);
      this.options.send({ jsonrpc: "2.0", id: req.id, result });
    } catch (error) {
      this.respondError(req.id, error);
    }
  }

  async dispose(): Promise<void> {
    this.transcribeService?.dispose();
    this.transcribeService = undefined;
    await this.mcpService?.dispose().catch(() => {});
    this.mcpService = undefined;
    for (const live of this.sessions.values()) {
      live.unsubscribe();
      await this.firstTurnLock.run(live.path, () => live.driver.dispose()).catch(() => {});
    }
    this.sessions.clear();
    this.runningTools.clear();
    this.unnamed.clear();
  }

  // ------------------------------------------------------------- dispatch

  private async dispatch(req: TypedClientRequest): Promise<unknown> {
    switch (req.method) {
      case "session/new":
        return this.sessionNew(req.params);
      case "session/load":
        return this.sessionLoad(req.params);
      case "session/prompt":
        return (await this.promptRequest(this.live(req.params.path), req.params)) satisfies Result<"session/prompt">;
      case "session/cancel": {
        const live = this.live(req.params.path);
        // A first-turn lease spans runtime replacement and engine preflight.
        // Cancellation must reach that candidate rather than wait until after
        // acceptance; Stable records it safely even in the replacement gap.
        if (this.firstTurnLock.busy(live.path)) await live.driver.abort();
        else await this.firstTurnLock.run(live.path, () => live.driver.abort());
        return {};
      }
      case "session/set_mode":
        throw new ProtocolError(ErrorCodes.Unsupported, "session/set_mode is not supported by this worker yet");

      case "pi/session/list":
        throw new ProtocolError(ErrorCodes.Unsupported, "pi/session/list is answered by the host catalog, not a worker");
      case "pi/session/detach":
        throw new ProtocolError(
          ErrorCodes.Unsupported,
          "pi/session/detach is host bookkeeping; a worker has nothing to detach from",
        );
      case "pi/session/steer": {
        // steer/follow_up call the runtime directly and so bypass Pi's `input`
        // hook, where the companion extension folds in a phrase still being
        // transcribed. Doing it here keeps the three send paths identical.
        const live = this.live(req.params.path);
        const content = await this.withDictation(req.params.path, req.params.content);
        if (this.harness.roleOf(live.path)?.kind === "child") await this.queueIntoChild(live, content, "steer");
        else await this.firstTurnLock.run(live.path, () => live.driver.steer(content));
        return {};
      }
      case "pi/session/follow_up": {
        const live = this.live(req.params.path);
        const content = await this.withDictation(req.params.path, req.params.content);
        if (this.harness.roleOf(live.path)?.kind === "child") await this.queueIntoChild(live, content, "followUp");
        else await this.firstTurnLock.run(live.path, () => live.driver.followUp(content));
        return {};
      }
      case "pi/session/clear_queue": {
        // A child's queue is emptied through the harness, which also forgets
        // its engine-owned twins of the cleared texts (else a later transfer
        // at completion could replay onto a successor what the person removed).
        const live = this.live(req.params.path);
        if (this.harness.roleOf(live.path)?.kind === "child") return this.harness.clearQueue(live.path);
        // The wire result is the composer's two lanes; an extension's custom
        // messages the driver also reports are not the person's to see.
        const { steering, followUp } = await this.firstTurnLock.run(live.path, () => live.driver.clearQueue());
        return { steering, followUp } satisfies Result<"pi/session/clear_queue">;
      }
      case "pi/session/close": {
        // The host is about to move the file (M13-T58): it must have no writer
        // while that happens (AGENTS.md invariant 8). Disposing the driver
        // emits `closed`, which drops the session from every table here.
        const live = this.sessions.get(req.params.path);
        if (!live) return { closed: false } satisfies Result<"pi/session/close">;
        return this.firstTurnLock.run(live.path, async () => {
          if (live.driver.state().isStreaming) {
            throw new ProtocolError(ErrorCodes.SessionBusy, "This chat is still answering. Wait for it to finish, or stop it, then move it.");
          }
          await live.driver.dispose();
          this.sessions.delete(live.path);
          return { closed: true } satisfies Result<"pi/session/close">;
        });
      }

      // --- the pending tray (pending.ts) ---
      case "session/pending/list":
        // The tray is candidate-independent and its mutations are intentionally
        // unfenced. A fresh view must see adds/removes that settled during a
        // long first-turn preflight, not a frozen preparation-time copy.
        return { messages: this.tray(req.params.path).list() } satisfies Result<"session/pending/list">;
      case "session/pending/add":
        return {
          message: this.tray(req.params.path).add(await this.withDictation(req.params.path, req.params.content)),
        } satisfies Result<"session/pending/add">;
      case "session/pending/edit":
        return { message: this.tray(req.params.path).edit(req.params.id, req.params.content) } satisfies Result<"session/pending/edit">;
      case "session/pending/remove":
        return { message: this.tray(req.params.path).remove(req.params.id) } satisfies Result<"session/pending/remove">;
      case "session/pending/steer":
        return { steered: await this.tray(req.params.path).steer(req.params.id) } satisfies Result<"session/pending/steer">;
      case "session/pending/clear":
        return { messages: this.tray(req.params.path).clear() } satisfies Result<"session/pending/clear">;
      case "pi/session/fork": {
        const live = this.live(req.params.path);
        return this.firstTurnLock.run(live.path, async () => {
          // `stopFirst` is the driver's sequence, not two requests: the stop is
          // recorded on the original before the runtime is replaced, and a fork
          // that fails leaves the session stopped and served here unchanged.
          const forked = await live.driver.fork(req.params.entryId, { ...(req.params.stopFirst !== undefined ? { stopFirst: req.params.stopFirst } : {}) });
          const { state } = forked;
          if (state.path !== live.path) {
            // The driver now serves the forked session file; re-key it so later
            // requests by the new path find it. Clients learn the new path from
            // the result and from the state update that follows.
            this.sessions.delete(live.path);
            this.harness.rekeySession(live.path, state.path);
            live.path = state.path;
            this.sessions.set(state.path, live);
          }
          this.onDriverEvent(live, { type: "update", update: { kind: "state", state } });
          return { ...forked, state: this.decorate(live, forked.state) } satisfies Result<"pi/session/fork">;
        });
      }
      case "pi/session/navigate": {
        const live = this.live(req.params.path);
        return this.firstTurnLock.run(live.path, () => live.driver.navigateTree(req.params.entryId, {
          ...(req.params.summarize !== undefined ? { summarize: req.params.summarize } : {}),
          ...(req.params.label !== undefined ? { label: req.params.label } : {}),
          ...(req.params.stopFirst !== undefined ? { stopFirst: req.params.stopFirst } : {}),
        }));
      }
      case "pi/session/rename": {
        const live = this.live(req.params.path);
        await this.firstTurnLock.run(live.path, () => live.driver.rename(req.params.name));
        return {};
      }
      case "pi/session/entries": {
        const live = this.live(req.params.path);
        const baseline = live.preAcceptance;
        if (baseline) return { entries: baseline.entries, leafId: baseline.leafId } satisfies Result<"pi/session/entries">;
        // A normal prompt holds the admission lease through engine preflight but
        // does not replace the runtime. Its live canonical reads must remain
        // available so a no-signal question can be answered after reconnect.
        return (await live.driver.entries()) satisfies Result<"pi/session/entries">;
      }
      case "pi/session/compact": {
        const live = this.live(req.params.path);
        await this.firstTurnLock.run(live.path, () => live.driver.compact(req.params.instructions));
        return {};
      }
      case "pi/model/list": {
        const live = this.live(req.params.path);
        return { models: await this.firstTurnLock.run(live.path, () => live.driver.listModels()) } satisfies Result<"pi/model/list">;
      }
      case "pi/model/set": {
        const live = this.live(req.params.path);
        return this.firstTurnLock.run(live.path, async () => ({ state: await live.driver.setModel(req.params.model) } satisfies Result<"pi/model/set">));
      }
      case "pi/thinking/set": {
        const live = this.live(req.params.path);
        return this.firstTurnLock.run(live.path, async () => ({ state: await live.driver.setThinkingLevel(req.params.level) } satisfies Result<"pi/thinking/set">));
      }
      case "pi/account-usage/refresh": {
        const live = this.live(req.params.path);
        const delivered = await this.firstTurnLock.run(live.path, async () => live.driver.deliverExtensionCommand?.({
          type: "lasercode/account-usage/refresh",
        }) ?? false);
        return { delivered } satisfies Result<"pi/account-usage/refresh">;
      }
      case "session/goal/get": {
        const live = this.live(req.params.path);
        const goal = live.preAcceptance
          ? live.preAcceptance.goal
          : await live.driver.goalState?.() ?? null;
        return { goal: goal ?? null } satisfies Result<"session/goal/get">;
      }
      case "session/goal/action": {
        const live = this.live(req.params.path);
        if (!live.driver.goalAction) throw new ProtocolError(ErrorCodes.Unsupported, "Goals are not available in this session.");
        const lease = (await this.firstTurnLock.acquireLease(live.path, true))!;
        try {
          return {
            goal: await live.driver.goalAction(req.params.action, {
              admissionLease: lease,
              onAccepted: () => lease.release(),
            }),
          } satisfies Result<"session/goal/action">;
        } finally {
          lease.release();
        }
      }
      case "pi/ui/response": {
        // Answer only the session that raised the dialog: ids are minted per
        // UI bridge, so broadcasting could settle another session's dialog with
        // an answer the user never gave it.
        const owner = this.ownerOfDialog(req.params.id);
        if (!owner) return { delivered: false } satisfies Result<"pi/ui/response">;
        owner.driver.respondToUi(req.params);
        return { delivered: true } satisfies Result<"pi/ui/response">;
      }

      // ------------------------------------------- background tasks ---
      case "pi/task/stop": {
        // The companion extension owns the process, so Stop is a command to
        // the session that started it. `delivered: false` means nobody in
        // this session holds that id any more, which the host turns into a
        // sentence rather than a silent no-op.
        const { driver } = this.live(req.params.path);
        const delivered = driver.deliverExtensionCommand?.({ type: "lasercode/task/stop", id: req.params.id }) ?? false;
        return { delivered } satisfies Result<"pi/task/stop">;
      }

      // ---------------------------------------------------- M8 dictation ---
      case "pi/transcribe/status":
        this.assertCwd(req.params.cwd);
        return (await this.transcribe().status()) satisfies Result<"pi/transcribe/status">;
      case "pi/transcribe/begin":
        this.assertCwd(req.params.cwd);
        return this.transcribe().begin({
          mimeType: req.params.mimeType,
          ...(req.params.language !== undefined ? { language: req.params.language } : {}),
          ...(req.params.path !== undefined ? { sessionPath: req.params.path } : {}),
        }) satisfies Result<"pi/transcribe/begin">;
      case "pi/transcribe/chunk":
        this.transcribe().chunk(req.params.id, req.params.data);
        return {};
      case "pi/transcribe/end":
        return (await this.transcribe().end(req.params.id)) satisfies Result<"pi/transcribe/end">;
      case "pi/transcribe/cancel":
        this.transcribe().cancel(req.params.id);
        return {};

      // ------------------------------------------------------ host-only ---
      case "pi/push/config":
      case "pi/push/subscribe":
      case "pi/push/unsubscribe":
      case "pi/push/test":
        throw new ProtocolError(ErrorCodes.Unsupported, `${req.method} is answered by the host, not a worker`);

      // -------------------------------------------------------- M2-T6 ---
      case "pi/project/git": {
        this.assertCwd(req.params.cwd);
        const git = this.git();
        // A session loaded before this worker knew about git lines (or a
        // caller naming a session this worker never opened) still gets a
        // baseline from now on, so the numbers start counting at first ask.
        if (req.params.path !== undefined && this.sessions.has(req.params.path)) await git.baseline(req.params.path);
        return (await git.status(req.params.path)) satisfies Result<"pi/project/git">;
      }

      // ------------------------------------------- M16-T17 project env ---
      case "pi/project/env/status": {
        this.assertCwd(req.params.cwd);
        return { status: this.projectEnvStatus() } satisfies Result<"pi/project/env/status">;
      }
      case "pi/project/env/test":
      case "pi/project/env/refresh": {
        this.assertCwd(req.params.cwd);
        if (!this.projectEnv) return { status: this.projectEnvStatus() } satisfies Result<"pi/project/env/refresh">;
        // Both re-run the hook. The difference is only that a refresh is meant
        // to change what later commands see; a test is a person checking. Work
        // already running keeps the environment it started with either way,
        // because a live process's environment cannot be rewritten.
        await this.projectEnv.refresh();
        const status = this.projectEnvStatus();
        this.notify("pi/project/env/changed", { status });
        return { status } satisfies Result<"pi/project/env/refresh">;
      }

      // -------------------------------------------------- M4-T7 keys ---
      case "pi/keybindings/get":
        this.assertCwd(req.params.cwd);
        return { keybindings: await this.keybindings().snapshot() } satisfies Result<"pi/keybindings/get">;
      case "pi/keybindings/set":
        this.assertCwd(req.params.cwd);
        return {
          keybindings: await this.keybindings().apply(req.params.changes),
        } satisfies Result<"pi/keybindings/set">;

      // ------------------------------------------- composer sources ---
      case "pi/commands/list":
        if ("cwd" in req.params) {
          const { cwd } = req.params as { cwd: string };
          this.assertCwd(cwd);
          return { commands: await this.projectCommands() } satisfies Result<"pi/commands/list">;
        }
        return { commands: await this.live(req.params.path).driver.commands() } satisfies Result<"pi/commands/list">;
      case "pi/prompts/list":
        return { prompts: await this.live(req.params.path).driver.prompts() } satisfies Result<"pi/prompts/list">;
      case "pi/project/read":
        this.assertCwd(req.params.cwd);
        return (await this.files().read(req.params.path)) satisfies Result<"pi/project/read">;
      case "pi/project/files": {
        this.assertCwd(req.params.cwd);
        return (await this.files().list({
          ...(req.params.query !== undefined ? { query: req.params.query } : {}),
          ...(req.params.limit !== undefined ? { limit: req.params.limit } : {}),
        })) satisfies Result<"pi/project/files">;
      }

      // ----------------------------------------------------------- M4 ---
      case "pi/settings/list":
        this.assertCwd(req.params.cwd);
        return { catalog: this.settings().catalog() } satisfies Result<"pi/settings/list">;
      case "pi/settings/get": {
        this.assertCwd(req.params.cwd);
        const settings = this.settings();
        await settings.refresh();
        return { snapshot: settings.snapshot() } satisfies Result<"pi/settings/get">;
      }
      case "pi/settings/set": {
        this.assertCwd(req.params.cwd);
        const snapshot = await this.settings().apply(req.params.scope, req.params.changes);
        await this.reloadLiveSettings(req.params.scope);
        return { snapshot } satisfies Result<"pi/settings/set">;
      }

      case "pi/packages/list":
        this.assertCwd(req.params.cwd);
        return { packages: this.packages().list() } satisfies Result<"pi/packages/list">;
      case "pi/packages/install":
        this.assertCwd(req.params.cwd);
        return {
          packages: await this.packages().install(req.params.source, req.params.scope),
        } satisfies Result<"pi/packages/install">;
      case "pi/packages/remove":
        this.assertCwd(req.params.cwd);
        return (await this.packages().remove(req.params.source, req.params.scope)) satisfies Result<"pi/packages/remove">;
      case "pi/packages/update":
        this.assertCwd(req.params.cwd);
        return { packages: await this.packages().update(req.params.source) } satisfies Result<"pi/packages/update">;
      case "pi/packages/check_updates":
        this.assertCwd(req.params.cwd);
        return { updates: await this.packages().checkUpdates() } satisfies Result<"pi/packages/check_updates">;

      case "pi/providers/list":
        this.assertCwd(req.params.cwd);
        return (await this.modelCatalog().providers()) satisfies Result<"pi/providers/list">;
      case "web-search/status":
        this.assertCwd(req.params.cwd);
        return new WebSearchService(this.options.agentDir).status();
      case "web-search/configure":
        this.assertCwd(req.params.cwd);
        return new WebSearchService(this.options.agentDir).configure(req.params.change);

      // ------------------------------------------------- M14 MCP servers ---
      case "mcp/list":
        this.assertCwd(req.params.cwd);
        return (await this.mcp().list()) satisfies Result<"mcp/list">;
      case "mcp/save":
        this.assertCwd(req.params.cwd);
        return (await this.mcp().save(req.params)) satisfies Result<"mcp/save">;
      case "mcp/remove":
        this.assertCwd(req.params.cwd);
        return (await this.mcp().remove(req.params)) satisfies Result<"mcp/remove">;
      case "mcp/inspect":
        this.assertCwd(req.params.cwd);
        return (await this.mcp().inspect(req.params)) satisfies Result<"mcp/inspect">;
      case "mcp/ping":
        this.assertCwd(req.params.cwd);
        return (await this.mcp().ping(req.params)) satisfies Result<"mcp/ping">;
      case "mcp/call":
        this.assertCwd(req.params.cwd);
        return (await this.mcp().call(req.params)) satisfies Result<"mcp/call">;
      case "mcp/disconnect":
        this.assertCwd(req.params.cwd);
        return (await this.mcp().disconnect(req.params)) satisfies Result<"mcp/disconnect">;
      case "mcp/auth/start":
        this.assertCwd(req.params.cwd);
        return (await this.mcp().authStart(req.params)) satisfies Result<"mcp/auth/start">;
      case "mcp/auth/complete":
        this.assertCwd(req.params.cwd);
        return (await this.mcp().authComplete(req.params)) satisfies Result<"mcp/auth/complete">;
      case "mcp/auth/logout":
        this.assertCwd(req.params.cwd);
        return (await this.mcp().authLogout(req.params)) satisfies Result<"mcp/auth/logout">;
      case "mcp/import/detect":
        this.assertCwd(req.params.cwd);
        return (await this.mcp().importDetect()) satisfies Result<"mcp/import/detect">;
      case "mcp/import/apply":
        this.assertCwd(req.params.cwd);
        return (await this.mcp().importApply(req.params)) satisfies Result<"mcp/import/apply">;
      case "pi/providers/login/start": {
        this.assertCwd(req.params.cwd);
        const provider = req.params.provider;
        const id = await this.modelCatalog().loginStart(provider, req.params.method, (loginId, event) =>
          this.notify("pi/providers/login/event", { cwd: this.options.cwd, id: loginId, provider, event }),
        );
        return { id } satisfies Result<"pi/providers/login/start">;
      }
      case "pi/providers/login/answer":
        this.assertCwd(req.params.cwd);
        this.modelCatalog().loginAnswer(req.params.id, req.params.promptId, req.params.value);
        return {} satisfies Result<"pi/providers/login/answer">;
      case "pi/providers/login/cancel":
        this.assertCwd(req.params.cwd);
        this.modelCatalog().loginCancel(req.params.id);
        return {} satisfies Result<"pi/providers/login/cancel">;
      case "pi/providers/logout":
        this.assertCwd(req.params.cwd);
        return { providers: await this.modelCatalog().logout(req.params.provider) } satisfies Result<"pi/providers/logout">;
      case "pi/models/catalog":
        this.assertCwd(req.params.cwd);
        return (await this.modelCatalog().catalog(req.params.refresh ?? false)) satisfies Result<"pi/models/catalog">;

      // ------------------------------------------------------ M13 agents ---
      case "agents/sync":
        this.definitions.sync(req.params.snapshot);
        return {} satisfies Result<"agents/sync">;
      case "agents/skills":
        this.assertCwd(req.params.cwd);
        return listAgentSkills({
          cwd: this.options.cwd,
          agentDir: this.settings().agentDir,
          ...(this.options.projectTrusted !== undefined ? { projectTrusted: this.options.projectTrusted } : {}),
        }) satisfies Result<"agents/skills">;
      case "agents/engine-instructions":
        this.assertCwd(req.params.cwd);
        return { text: defaultAgentInstructions(this.options.cwd) } satisfies Result<"agents/engine-instructions">;
      case "agents/namer/qualify":
        this.assertCwd(req.params.cwd);
        return (await this.namer.qualify()) satisfies Result<"agents/namer/qualify">;
      case "agents/runs/stop": {
        const reason = req.params.reason?.trim();
        const run = await this.harness.stopRun(req.params.runId, { initiator: "user", ...(reason ? { reason } : {}) });
        return { run } satisfies Result<"agents/runs/stop">;
      }
      case "agents/list":
      case "agents/validate":
      case "agents/save":
      case "agents/delete":
      case "agents/set-default":
      case "agents/set-policy":
      case "agents/runs/list":
      case "agents/builtin/set-model":
      case "agents/builtin/set-instructions":
        throw new ProtocolError(ErrorCodes.Unsupported, `${req.method} is answered by the host's agent store, not a worker`);

      case "pi/logs/query":
      case "pi/logs/content":
      case "pi/logs/stats":
      case "pi/logs/clear":
        throw new ProtocolError(
          ErrorCodes.Unsupported,
          `${req.method} is answered by the host's log store, not a worker`,
        );

      case "pi/prefs/get":
      case "pi/prefs/set":
        throw new ProtocolError(
          ErrorCodes.Unsupported,
          `${req.method} is answered by the host: ${PRODUCT_NAME}'s own preferences are not per project and must outlive a sleeping worker`,
        );
    }
  }

  // ------------------------------------------------------------- M4 adapters

  private assertCwd(cwd: string): void {
    if (resolve(cwd) !== resolve(this.options.cwd)) {
      throw new ProtocolError(ErrorCodes.InvalidParams, `this worker serves ${this.options.cwd}, not ${cwd}`);
    }
  }

  /**
   * The project's environment as a person may see it: names, counts, state and
   * a sanitised failure. No value is ever put in this object, because this one
   * crosses the protocol to a renderer and possibly to a phone.
   */
  private projectEnvStatus(): ProjectEnvStatus {
    const cwd = this.options.cwd;
    if (!this.projectEnv) return { cwd, state: "not-configured", approved: false };
    const snapshot = this.projectEnv.status();
    return {
      cwd,
      state: snapshot.state,
      approved: snapshot.state !== "needs-approval",
      names: snapshot.names,
      unsetNames: snapshot.unsetNames,
      ...(snapshot.resolvedAt ? { resolvedAt: snapshot.resolvedAt } : {}),
      ...(snapshot.error ? { error: snapshot.error } : {}),
    };
  }

  /** What the companion extension is given: decoration and a refusal, no values. */
  private projectEnvBridge(): ProjectEnvironmentBridge {
    const projectEnv = this.projectEnv;
    return {
      apply: (env) => projectEnv?.apply(env) ?? env,
      blocking: () => projectEnv?.blocking ?? false,
      reason: () => projectEnv?.blockingReason() ?? "",
    };
  }

  /**
   * Resolve the project's environment before the first command can run.
   *
   * Called when a session's runtime is built, so the hook runs once per worker
   * lifetime rather than once per command, and a tool never has to wait for a
   * network round trip in the middle of a turn.
   */
  private async ensureProjectEnv(): Promise<void> {
    if (!this.projectEnv) return;
    const before = this.projectEnv.status().state;
    await this.projectEnv.ensure();
    const status = this.projectEnvStatus();
    if (status.state !== before) this.notify("pi/project/env/changed", { status });
  }

  /**
   * A settings write reached the files; the sessions it touches read them
   * again (M13-T55). A global write reaches every open session; a project
   * write only those running in this project's own checkout, because a
   * worktree session or a workspace session reads its own `.laser` file. The
   * write has already happened, so a session that cannot reload keeps the
   * request from failing: it is reported, not thrown.
   */
  private async reloadLiveSettings(scope: SettingsScope): Promise<void> {
    const cwd = resolve(this.options.cwd);
    await Promise.all(
      [...this.sessions.values()].map(async (live) => {
        const driver = live.driver;
        if (!driver.reloadSettings) return;
        try {
          if (scope === "project" && resolve(driver.state().cwd) !== cwd) return;
          await driver.reloadSettings();
        } catch (error) {
          console.error(`${PRODUCT_NAME} worker: could not reload settings in ${live.path}:`, error instanceof Error ? error.message : error);
        }
      }),
    );
  }

  private settings(): SettingsAdapter {
    this.settingsAdapter ??= new SettingsAdapter({
      cwd: this.options.cwd,
      ...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
      ...(this.options.projectTrusted !== undefined ? { hostTrusted: this.options.projectTrusted } : {}),
    });
    return this.settingsAdapter;
  }

  private packages(): PackagesAdapter {
    this.packagesAdapter ??= new PackagesAdapter({
      cwd: this.options.cwd,
      ...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
      settings: this.settings(),
      onProgress: (event) => this.notify("pi/packages/progress", { cwd: this.options.cwd, ...event }),
      ...(this.options.npmCommand ? { npmCommand: this.options.npmCommand } : {}),
    });
    return this.packagesAdapter;
  }

  private git(): GitService {
    this.gitService ??= new GitService({ cwd: this.options.cwd });
    return this.gitService;
  }

  private keybindings(): KeybindingsAdapter {
    this.keybindingsAdapter ??= new KeybindingsAdapter({
      ...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
    });
    return this.keybindingsAdapter;
  }

  /**
   * MCP servers for this project (docs/mcp.md). Built on first use: a worker
   * whose project has no MCP server never loads the engine at all.
   */
  private mcp(): McpService {
    this.mcpService ??= new McpService({
      cwd: this.options.cwd,
      agentDir: this.settings().agentDir,
      ...(this.options.projectTrusted !== undefined ? { projectTrusted: this.options.projectTrusted } : {}),
      changed: () => this.notify("mcp/changed", { cwd: this.options.cwd }),
    });
    return this.mcpService;
  }

  private files(): ProjectFilesService {
    this.filesService ??= new ProjectFilesService({ cwd: this.options.cwd });
    return this.filesService;
  }

  private transcribe(): TranscribeService {
    if (!this.transcribeService) {
      const service = new TranscribeService({
        keys: {
          providerKey: (provider) => this.modelCatalog().apiKeyForProvider(provider),
          providers: async () => (await this.modelCatalog().providers()).providers,
        },
      });
      // Publishes drain() to the companion extension in this process, so Pi's
      // own `input` hook can pick up a phrase still in flight.
      service.register();
      this.transcribeService = service;
    }
    return this.transcribeService;
  }

  /**
   * Append a phrase the microphone was still transcribing to the text being
   * sent, so pressing Enter mid-sentence does not lose the tail.
   */
  private async withDictation(path: string, content: ContentBlock[]): Promise<ContentBlock[]> {
    if (!this.transcribeService?.isActive(path)) return content;
    const tail = await this.transcribeService.drain(path);
    if (tail === "") return content;
    const last = content.at(-1);
    if (last?.type !== "text") return [...content, { type: "text", text: tail }];
    const joined = last.text === "" || /\s$/.test(last.text) ? `${last.text}${tail}` : `${last.text} ${tail}`;
    return [...content.slice(0, -1), { type: "text", text: joined }];
  }

  private modelCatalog(): ModelsAdapter {
    this.modelsAdapter ??= new ModelsAdapter({
      cwd: this.options.cwd,
      ...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
      settings: this.settings(),
    });
    return this.modelsAdapter;
  }

  private async sessionNew(params: ClientRequests["session/new"]["params"]): Promise<Result<"session/new">> {
    if (params.cwd !== this.options.cwd) {
      throw new ProtocolError(ErrorCodes.InvalidParams, `this worker serves ${this.options.cwd}, not ${params.cwd}`);
    }
    const agentName = params.agentName ?? this.definitions.defaultAgent().name;
    if (agentName === "namer") throw new ProtocolError(ErrorCodes.InvalidParams, "Namer names things; it does not run sessions.");
    const definition = this.definitions.definition(agentName);
    if (!definition) throw new ProtocolError(ErrorCodes.InvalidParams, `No agent is called "${agentName}".`);
    if (definition.model && !(await this.modelAvailable(definition.model))) {
      throw new ProtocolError(
        ErrorCodes.InvalidParams,
        `The model ${definition.model.provider}/${definition.model.id} is not available: connect ${definition.model.provider} in Settings → Providers and models, or choose another model for ${definition.name}.`,
      );
    }
    const handle = this.harness.prepareSession({ role: rootRole(agentName), definition, record: rootRecord(agentName), projectCwd: this.options.cwd });
    const live = await this.openAndAttach(
      {
        cwd: this.options.cwd,
        ...(params.parentPath ? { parentSessionPath: params.parentPath } : {}),
        ...this.commonOpen(),
        agent: this.agentOptions(definition, handle),
      },
      handle,
    );
    return { state: this.decorate(live, live.driver.state()) };
  }

  private async sessionLoad(params: ClientRequests["session/load"]["params"]): Promise<Result<"session/load">> {
    const existing = this.sessions.get(params.path);
    if (existing) {
      // A no-signal extension question may be holding prompt preflight. Never
      // queue reconnect hydration behind the lease that only its answer can
      // release. Only candidate replacement needs a state baseline; ordinary
      // prompts keep exposing their live canonical runtime.
      const state = existing.preAcceptance?.state ?? existing.driver.state();
      // Numbered diagnostics are accepted live control even during candidate
      // preparation. Replay through the current watermark so reconnect cannot
      // omit one that arrived after the state baseline was captured.
      this.replay(existing, params.fromSeq);
      return {
        state: this.decorate(existing, state),
        replayFrom: this.replayFloor(existing, params.fromSeq),
        seq: existing.seq,
      };
    }
    const inFlight = this.opening.get(params.path);
    if (inFlight) {
      const live = await inFlight;
      const state = live.driver.state();
      this.replay(live, params.fromSeq);
      return { state: this.decorate(live, state), replayFrom: this.replayFloor(live, params.fromSeq), seq: live.seq };
    }
    // Registered synchronously, before `open()` gets a chance to yield.
    const promise = (async () => {
      // Which agent this stored session runs as: its own record, else the
      // synced default. Read from the file only; the engine is not open yet.
      const { definition, role, record } = await this.recoverAgent(params.path);
      const handle = this.harness.prepareSession({ role, definition, record, projectCwd: this.options.cwd });
      return this.openAndAttach({ cwd: this.options.cwd, sessionPath: params.path, ...this.commonOpen(), agent: this.agentOptions(definition, handle) }, handle);
    })();
    this.opening.set(params.path, promise);
    try {
      const live = await promise;
      // Opening the session already emitted updates (the companion's
      // `session_start` report, the first state); the reply carries the state
      // they produced and the transcript snapshot that follows covers them, so
      // the client is told the watermark it may safely stamp.
      return { state: this.decorate(live, live.driver.state()), replayFrom: 0, seq: live.seq };
    } finally {
      this.opening.delete(params.path);
    }
  }

  /** The capability report and the agent this session runs as, on every state a client sees. */
  private decorate(live: Live, state: SessionState): SessionState {
    const agent = this.harness.sessionInfo(live.path);
    return { ...state, capabilities: [...this.activeModules], ...(agent ? { agent } : {}) };
  }

  private agentOptions(definition: AgentDefinition, handle: SessionHandle): DriverAgentOptions {
    return {
      definition,
      role: handle.role,
      record: handle.record,
      bridge: handle.bridge,
      policy: this.definitions.policy(),
      // Bound to the session, so `task_output` can read a command of an agent
      // under it (D-163); the harness builds the same options for a child.
      backgroundWork: handle.backgroundWork(this.options.cwd) ?? {
        cwd: this.options.cwd,
        foregroundCommandSeconds: this.definitions.policy().foregroundCommandSeconds,
        ...(this.projectEnv ? { projectEnv: this.projectEnvBridge() } : {}),
      },
    };
  }

  /**
   * Which agent a stored session runs as. A child's depth is not in its
   * record, so it is counted up the parent chain (bounded, and every hop is a
   * file read, never an engine).
   */
  private async recoverAgent(path: string): Promise<{ definition: AgentDefinition; role: HarnessSessionRole; record: SessionAgentRecord }> {
    const record = (await readSessionAgentRecord(path)) ?? rootRecord(this.definitions.defaultAgent().name);
    const definition = this.definitions.definition(record.agentName) ?? this.definitions.defaultAgent();
    if (record.kind !== "child" || !record.parentPath) {
      return { definition, role: rootRole(record.agentName), record };
    }
    let depth = 1;
    let parent = await readSessionAgentRecord(record.parentPath);
    while (parent?.kind === "child" && parent.parentPath && depth < AGENT_MAX_DEPTH_LIMIT) {
      depth += 1;
      parent = await readSessionAgentRecord(parent.parentPath);
    }
    const role: HarnessSessionRole = {
      agentName: record.agentName,
      kind: "child",
      ...(record.subagentName !== undefined ? { subagentName: record.subagentName } : {}),
      depth,
      // The record is the only evidence after a restart: no worktree recorded
      // means the child was started to work in its parent's checkout, and its
      // role block must keep saying so. A worktree the parent has since
      // removed is the same case — the driver reopens the child in the project
      // checkout (`removedWorktreeCwd`), so it must be told it is not isolated
      // there (D-156), never "your own worktree" pointing at the live checkout.
      isolated: record.worktree !== undefined && (await removedWorktreeCwd(this.options.cwd, path, record.worktree)) === undefined,
      parent: {
        sessionPath: record.parentPath,
        sessionId: record.parentSessionId ?? "",
        agentName: parent?.agentName ?? this.definitions.defaultAgent().name,
        ...(parent?.subagentName !== undefined ? { subagentName: parent.subagentName } : {}),
      },
    };
    return { definition, role, record };
  }

  /** The harness opens a child session here: same worker, the child's own directory as cwd. */
  private async openChild(open: { cwd: string; parentSessionPath: string; agent: DriverAgentOptions }): Promise<SessionState> {
    const live = await this.openAndAttach({ cwd: open.cwd, parentSessionPath: open.parentSessionPath, ...this.commonOpen(), agent: open.agent });
    return live.driver.state();
  }

  private async modelAvailable(model: AgentModelChoice): Promise<boolean> {
    try {
      const runtime = await this.modelCatalog().modelRuntime();
      if (!runtime.getModel(model.provider, model.id)) return false;
      if (runtime.hasConfiguredAuth(model.provider)) return true;
      return (await runtime.checkAuth(model.provider)) !== undefined;
    } catch {
      return false;
    }
  }

  /** Namer names a session after its first prompt, unless the person got there first. */
  private async nameSession(live: Live, text: string): Promise<void> {
    if (!this.namer.enabled()) {
      this.waitToName(live.path, text);
      return;
    }
    const name = await this.namer.nameSession(text);
    if (!name || !this.sessions.has(live.path) || live.driver.state().name) return;
    await live.driver.rename(name).catch(() => undefined);
  }

  /** Hold a first prompt until a Namer model exists, oldest dropped past the cap. */
  private waitToName(path: string, text: string): void {
    this.unnamed.delete(path);
    this.unnamed.set(path, text);
    while (this.unnamed.size > UNNAMED_MAX) {
      const oldest = this.unnamed.keys().next();
      if (oldest.done) break;
      this.unnamed.delete(oldest.value);
    }
  }

  /** A model just appeared: name every session whose first prompt was waiting for one. */
  private nameWaitingSessions(): void {
    if (!this.namer.enabled() || this.unnamed.size === 0) return;
    for (const [path, text] of [...this.unnamed]) {
      this.unnamed.delete(path);
      const live = this.sessions.get(path);
      // Gone, or named since — by the person, or by the harness after its
      // `subagent_name`. Namer never renames over either.
      if (!live || live.driver.state().name) continue;
      void this.nameSession(live, text);
    }
  }

  /**
   * The earliest seq this reply actually covers.
   *
   * Answering with the `fromSeq` the client asked for is a lie once the replay
   * buffer no longer reaches that far — every token delta consumes a seq, so a
   * few thousand tokens is one buffer. The client would believe it missed
   * nothing and render a transcript with a hole in it. Reporting the real floor
   * lets it notice the mismatch and re-hydrate.
   */
  private replayFloor(live: Live, fromSeq: number | undefined): number {
    return this.replayFloorFrom(live.buffer, live.seq, fromSeq);
  }

  private replayFloorFrom(buffer: ReplayBuffer, seq: number, fromSeq: number | undefined): number {
    const asked = fromSeq ?? 0;
    // A restarted worker numbers from 1 again, so a client holding seq 40 is
    // asking about an epoch this process never had. Answering `asked` would
    // tell it "you missed nothing" and every update we then send would be
    // deduped away as a replay: alive-looking, rendering nothing. Checked
    // before the buffer, because the buffer is usually non-empty already.
    if (asked > seq) return seq;
    const oldest = buffer.first?.seq;
    // Nothing buffered: nothing after `seq` can be replayed either.
    if (oldest === undefined) return seq;
    return asked >= oldest - 1 ? asked : oldest - 1;
  }

  /**
   * Subscribe before opening: extensions emit (e.g. the companion's capability
   * report at `session_start`) while `open()` is still running. Those events
   * are queued and flushed once the session path is known.
   */
  private async openAndAttach(openOptions: Parameters<SessionDriver["open"]>[0], handle?: SessionHandle): Promise<Live> {
    // Resolve the project's environment before a session exists to run anything
    // in. Failing here never blocks opening the conversation: the refusal, if
    // the project requires its environment, belongs to the command that would
    // have used it, where a person can read it.
    await this.ensureProjectEnv().catch(() => {});
    const driver = this.options.createDriver();
    const live: Live = { driver, seq: 0, buffer: new ReplayBuffer(this.replayBuffer, this.options.replayBytes ?? 16 * 1024 * 1024), unsubscribe: () => {}, path: "" };
    driver.setExtensionModelWorkHandler?.((request) => this.admitExtensionModelWork(live, request));
    const queued: DriverEvent[] = [];
    let ready = false;
    live.unsubscribe = driver.subscribe((event) => (ready ? this.onDriverEvent(live, event) : queued.push(event)));
    try {
      const state = await driver.open(openOptions);
      const already = this.sessions.get(state.path);
      if (already && already !== live) {
        // Someone else got there first (a `session/new` that landed on an
        // existing path, say). One writer per session file, always.
        live.unsubscribe();
        handle?.discard();
        await driver.dispose().catch(() => {});
        return already;
      }
      live.path = state.path;
      this.sessions.set(state.path, live);
      if (handle) {
        handle.attach(state.path, state.id);
        live.handle = handle;
      }
      ready = true;
      for (const event of queued) this.onDriverEvent(live, event);
      // Capture "since the session started" for the git line. Fire and forget:
      // a failure here means the line shows nothing, never that the open fails.
      void this.git().baseline(state.path);
      return live;
    } catch (error) {
      live.unsubscribe();
      handle?.discard();
      await driver.dispose().catch(() => {});
      throw error;
    }
  }

  private commonOpen() {
    return {
      ...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
      ...(this.options.sessionDir ? { sessionDir: this.options.sessionDir } : {}),
      ...(this.options.stateDir ? { stateDir: this.options.stateDir } : {}),
      ...(this.options.projectTrusted !== undefined ? { projectTrusted: this.options.projectTrusted } : {}),
      ...(this.options.features ? { features: this.options.features } : {}),
      // Every open goes through here, so an MCP server started for any session
      // of this project sees the project's environment (M16-T17).
      ...(this.projectEnv ? { projectEnv: (base: NodeJS.ProcessEnv) => this.projectEnv!.apply(base) } : {}),
    };
  }

  /**
   * Load the same Pi resources a first session will use, without attaching the
   * ephemeral session or writing a transcript. This makes skills available in
   * the composer before the first message creates the real session.
   */
  private projectCommands(): Promise<CommandInfo[]> {
    if (this.commandCatalogInFlight) return this.commandCatalogInFlight;
    const pending = (async () => {
      const driver = this.options.createDriver();
      try {
        await driver.open({ cwd: this.options.cwd, ...this.commonOpen() });
        return await driver.commands();
      } finally {
        await driver.dispose().catch(() => {});
      }
    })();
    this.commandCatalogInFlight = pending;
    void pending.finally(() => {
      if (this.commandCatalogInFlight === pending) this.commandCatalogInFlight = undefined;
    }).catch(() => {});
    return pending;
  }

  // ------------------------------------------------------------- sessions

  private live(path: string): Live {
    const live = this.sessions.get(path);
    if (!live) throw new ProtocolError(ErrorCodes.SessionNotFound, `session ${path} is not open in this worker`);
    return live;
  }

  /** The session's pending tray, made on first use so an idle session pays nothing. */
  private tray(path: string): PendingTray {
    const live = this.live(path);
    if (!live.pending) {
      live.pending = new PendingTray({
        // A child's tray row goes through the harness fence like the chat's own
        // steer (M13-T98): during a declared completion it waits on the
        // successor instead of entering a queue the engine is about to drop.
        steer: (content) => this.harness.roleOf(live.path)?.kind === "child"
          ? this.queueIntoChild(live, content, "steer")
          : this.firstTurnLock.run(live.path, () => live.driver.steer(content)),
        prompt: (content, onAccepted) => this.promptWithFence(live, content, undefined, onAccepted, true),
        streaming: () => live.driver.state().isStreaming,
        publish: (pending) => this.onDriverEvent(live, { type: "update", update: { kind: "pending_update", pending } }),
      });
    }
    return live.pending;
  }

  /** One extension transaction: register ownership first, then take/borrow preflight admission. */
  private admitExtensionModelWork(live: Live, request: ExtensionModelWorkRequest): ExtensionModelAdmission {
    let path = live.path;
    if (!path) {
      try {
        path = live.driver.state().path;
      } catch {
        path = "";
      }
    }
    const start = (
      ownerRunId?: string,
      onInvocation?: Parameters<ExtensionModelWorkRequest["start"]>[1],
    ): ExtensionModelExecution | Promise<ExtensionModelExecution> => {
      const borrowed = request.admissionLease;
      if (borrowed?.active) return request.start(ownerRunId, onInvocation);
      if (!path) return request.start(ownerRunId, onInvocation);
      return this.firstTurnLock.acquireLease(path, true).then((lease) => {
        if (!lease) return request.start(ownerRunId, onInvocation);
        let execution: ExtensionModelExecution;
        try {
          execution = request.start(ownerRunId, onInvocation);
        } catch (error) {
          lease.release();
          throw error;
        }
        // Positive acceptance releases before the model turn. Refusal and any
        // defensive no-callback path release without waiting for completion.
        void execution.admission.then(() => lease.release(), () => lease.release());
        void execution.completion.then(() => lease.release(), () => lease.release());
        return execution;
      });
    };
    return this.harness.admitExtensionModelWork(path, request, start);
  }

  /** A public prompt's preflight lease and optional same-identity agent bind. */
  private async promptRequest(
    live: Live,
    params: ClientRequests["session/prompt"]["params"],
  ): Promise<Result<"session/prompt">> {
    const firstTurn = params.firstTurn;
    if (!firstTurn) {
      // A bare concurrent prompt keeps its refusal semantics. The lease closes
      // the check/use race with a first-turn runtime replacement.
      return this.promptWithFence(live, params.content, params.streamingBehavior, undefined, false);
    }
    const lease = (await this.firstTurnLock.acquireLease(live.path, true))!;

    const definition = this.definitions.definition(firstTurn.agentName);
    if (!definition || definition.kind !== "custom") {
      lease.release();
      throw new ProtocolError(ErrorCodes.InvalidParams, `No custom agent is called "${firstTurn.agentName}".`);
    }
    let hydration: PreAcceptanceHydration;
    try {
      const pendingUi = (live.driver as { pendingUi?: () => unknown[] }).pendingUi?.call(live.driver) ?? [];
      const { entries, leafId } = await live.driver.entries();
      const goal = await live.driver.goalState?.() ?? null;
      const state = live.driver.state();
      const pending = this.tray(live.path).list();
      assertFirstTurnAdmission({
        state,
        entries,
        roleKind: this.harness.roleOf(live.path)?.kind,
        pendingTrayCount: pending.length,
        dialogCount: pendingUi.length,
        hasGoal: goal !== null,
        hasLiveWork: this.harness.runs().some((run) => run.rootSessionPath === live.path || run.parent?.sessionPath === live.path),
        runningToolCount: this.runningTools.get(live.path)?.size ?? 0,
      });
      hydration = {
        state,
        entries: [...entries],
        leafId,
        goal,
      };
      live.preAcceptance = hydration;
    } catch (error) {
      lease.release();
      throw error;
    }

    const previousHandle = live.handle;
    if (!previousHandle || !live.driver.prepareFirstTurn || !live.driver.rollbackFirstTurn) {
      if (live.preAcceptance === hydration) delete live.preAcceptance;
      lease.release();
      throw new ProtocolError(ErrorCodes.Unsupported, "This runtime cannot apply a first-turn agent choice safely.");
    }
    const nextHandle = this.harness.prepareSession({
      role: rootRole(definition.name),
      definition,
      record: rootRecord(definition.name),
      projectCwd: this.options.cwd,
    });
    let accepted = false;
    try {
      await live.driver.prepareFirstTurn({
        agent: this.agentOptions(definition, nextHandle),
        ...(Object.hasOwn(firstTurn, "model") ? { model: firstTurn.model } : {}),
        ...(firstTurn.thinkingLevel ? { thinkingLevel: firstTurn.thinkingLevel } : {}),
      });
      // Preparation is the only canonical resolution boundary: it preserves
      // an absent intent, follows a null intent, and applies an explicit ref.
      // Validate exactly the runtime that would receive the prompt, while the
      // rollback guard is still armed and before the engine can accept it.
      const effectiveModel = live.driver.state().model;
      if (effectiveModel && !(await this.modelAvailable(effectiveModel))) {
        throw new ProtocolError(ErrorCodes.InvalidParams, modelUnavailableMessage(effectiveModel));
      }
      const result = await this.promptLive(live, params.content, params.streamingBehavior, () => {
        accepted = true;
        if (live.preAcceptance === hydration) delete live.preAcceptance;
        previousHandle.discard();
        nextHandle.attach(live.path, live.driver.state().id);
        live.handle = nextHandle;
        lease.release();
      }, lease);
      if (!accepted) {
        await live.driver.rollbackFirstTurn();
        nextHandle.discard();
      }
      return result;
    } catch (error) {
      if (!accepted) {
        try {
          await live.driver.rollbackFirstTurn();
        } catch (rollbackError) {
          nextHandle.discard();
          throw new AggregateError([error, rollbackError], "The first prompt failed and its previous runtime could not be restored.");
        }
        nextHandle.discard();
      }
      throw error;
    } finally {
      if (live.preAcceptance === hydration) delete live.preAcceptance;
      lease.release();
    }
  }

  /** Hold one prompt at a single runtime generation through engine preflight. */
  private async promptWithFence(
    live: Live,
    content: ContentBlock[],
    streamingBehavior: "steer" | "followUp" | undefined,
    onAccepted: (() => void) | undefined,
    wait: boolean,
  ): Promise<{ accepted: boolean; queued: boolean }> {
    // Preserve the bare concurrent refusal before a fake/alternate driver can
    // turn it into a never-settling call. Stable re-checks under its own slot.
    if (!streamingBehavior && live.driver.state().isStreaming) return { accepted: false, queued: false };
    const lease = await this.firstTurnLock.acquireLease(live.path, wait);
    if (!lease) return { accepted: false, queued: false };
    const finish = () => lease.release();
    try {
      return await this.promptLive(live, content, streamingBehavior, () => {
        finish();
        onAccepted?.();
      }, lease);
    } finally {
      finish();
    }
  }

  /**
   * One turn from one message, whoever asked: a client's `session/prompt`, or
   * the pending tray delivering what was written while the agent worked. Both
   * start a user run and both can name an unnamed session, because from the
   * person's side they are the same act — they wrote it and it went in.
   *
   * Naming starts before the driver is asked, not after it answers: the
   * driver's `prompt()` resolves when the whole turn is over (the engine
   * awaits its agent loop), and the words are all Namer needs. Acceptance is
   * judged the way the driver judges it — idle, or queued behind a running
   * turn when the caller asked for that — so a first turn that runs for
   * minutes is named while the person is looking at the sidebar, not after
   * (M13-T43). `nameSession` re-checks the name before renaming, so a person
   * who names the session mid-turn still wins.
   */
  private async promptLive(
    live: Live,
    content: ContentBlock[],
    streamingBehavior?: "steer" | "followUp",
    onAccepted?: () => void,
    admissionLease?: SessionAdmissionLease,
  ): Promise<{ accepted: boolean; queued: boolean }> {
    const text = textOf(content);
    const idle = !live.driver.state().isStreaming;
    if ((idle || streamingBehavior) && !live.driver.state().name && text.trim() !== "") void this.nameSession(live, text);
    return this.harness.promptUser(live.path, content, {
      ...(streamingBehavior ? { streamingBehavior } : {}),
      ...(onAccepted ? { onAccepted } : {}),
      ...(admissionLease ? { admissionLease } : {}),
    });
  }

  /**
   * A person's steer or follow-up typed in a child agent's own chat goes
   * through the harness fence, never straight into the engine (M13-T98 §8.4):
   * during a declared completion the engine's queues were already emptied
   * into the successor, and a text put there now would run under the ended
   * run. The harness queues it in the engine while the run demonstrably
   * streams — tracked as an engine-owned twin, so a terminal declaration can
   * take it back — and holds it for the successor otherwise. The request
   * answers once the engine holds the message, the moment the direct verb
   * answered, never after the turn it may start; a message that can never
   * start (a cancelled successor, a closed session) answers with the
   * harness's sentence. Root sessions keep the driver's direct verbs: the
   * harness owns no run there.
   */
  private queueIntoChild(live: Live, content: ContentBlock[], lane: "steer" | "followUp"): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let accepted = false;
      const onAccepted = () => {
        accepted = true;
        resolve();
      };
      this.harness.promptUser(live.path, content, { streamingBehavior: lane, expandPromptTemplates: true, onAccepted }).then(
        (result) => {
          if (accepted || result.accepted) resolve();
          else reject(new ProtocolError(ErrorCodes.SessionBusy, "The agent's chat could not take this message right now. Try again in a moment."));
        },
        reject,
      );
    });
  }

  /**
   * The session whose UI bridge is holding `id`. Drivers that cannot report
   * their pending dialogs (the stub) fall back to the only open session, so a
   * single-session worker keeps working.
   */
  private ownerOfDialog(id: string): Live | undefined {
    let blind: Live | undefined;
    let blindCount = 0;
    for (const live of this.sessions.values()) {
      const pendingUi = (live.driver as { pendingUi?: () => Array<{ id: string }> }).pendingUi;
      if (typeof pendingUi === "function") {
        if (pendingUi.call(live.driver).some((request) => request.id === id)) return live;
        continue;
      }
      // A driver that cannot report its pending dialogs (the stub).
      blind = live;
      blindCount += 1;
    }
    // Guessing is only safe when exactly one session could not be asked. A
    // driver that *can* be asked and does not claim the id genuinely does not
    // have it, and the caller is told so rather than answering into the void.
    return blindCount === 1 ? blind : undefined;
  }

  private onDriverEvent(live: Live, event: DriverEvent): void {
    // The harness sees every event of every session; it ignores paths it
    // does not know. Before `closed` removes the session, so a live run is
    // recorded as failed rather than left running.
    this.harness.onDriverEvent(live.path, event);
    switch (event.type) {
      case "update": {
        const update = event.update.kind === "state" ? { kind: "state" as const, state: this.decorate(live, event.update.state) } : event.update;
        const params: SessionUpdateParams = {
          sessionPath: live.path,
          seq: ++live.seq,
          update,
          at: new Date().toISOString(),
        };
        live.buffer.push(params);
        this.notify("session/update", params);
        if (update.kind === "tool_execution_start") {
          this.running(live.path).add(update.toolCallId);
          void this.labelTool(live, update.toolCallId, update.toolName, update.args);
        } else if (update.kind === "tool_execution_end") this.running(live.path).delete(update.toolCallId);
        // The run is over: whatever the person wrote while it ran goes in now,
        // in the order they wrote it. Fire and forget — a delivery that fails
        // keeps its message and its reason in the tray, and says so there.
        else if (update.kind === "agent_settled" && live.pending) void live.pending.drain();
        return;
      }
      case "ui_request": {
        // The harness answers a question it cannot route — a dialog raised by
        // an invocation the session no longer owns — synchronously, before this
        // forwarder runs; a person must never be shown a dialog nobody can
        // answer. Drivers that cannot list their open dialogs forward as before.
        const pendingUi = (live.driver as { pendingUi?: () => Array<{ id: string }> }).pendingUi;
        if (typeof pendingUi === "function" && !pendingUi.call(live.driver).some((request) => request.id === event.request.id)) return;
        this.notify("pi/ui/request", { path: live.path, ...event.request });
        return;
      }
      case "ui_event":
        this.notify("pi/ui/event", { path: live.path, ...event.event });
        return;
      case "extension":
        // The capability report is what gates the microphone and everything
        // else that is only offered where its package is (M8-T1).
        if (event.message.type === "lasercode/capabilities") this.activeModules = new Set(event.message.active);
        // The newest MCP status any session of this project reported answers
        // `mcp/list`. A shutdown snapshot is empty and carries no information,
        // so a closing session never blanks a live one (docs/mcp.md).
        if (event.message.type === "lasercode/mcp/status") this.mcp().observeSnapshot(live.path, event.message.snapshot);
        // A background command going past is indexed here, so the harness
        // can show it in an agent's fleet (D-163); the host indexes it too.
        this.tasks.observe(live.path, event.message);
        this.notify("pi/extension/message", { path: live.path, message: event.message });
        return;
      case "closed":
        live.unsubscribe();
        this.sessions.delete(live.path);
        this.mcpService?.sessionClosed(live.path);
        this.tasks.sessionClosed(live.path);
        this.gitService?.forget(live.path);
        this.runningTools.delete(live.path);
        this.unnamed.delete(live.path);
        this.namer.forget(live.path);
        return;
    }
  }

  /** Tool calls running in one session; the set is dropped when the session closes. */
  private running(path: string): Set<string> {
    let ids = this.runningTools.get(path);
    if (!ids) {
      ids = new Set();
      this.runningTools.set(path, ids);
    }
    return ids;
  }

  /**
   * Namer labels a tool call the moment it starts, so the aggregate row says
   * what is happening without being opened. Every call in a burst is labelled
   * at once; one that ends before its label arrives is dropped rather than
   * shown late. Only a top-level session's calls are labelled: a child agent's
   * rows are read by its parent and, rarely, by a person who opened its chat,
   * and a label per call across a fleet of children is spend nobody is
   * looking at.
   */
  private async labelTool(live: Live, toolCallId: string, toolName: string, args: unknown): Promise<void> {
    if (!this.namer.enabled()) return;
    if (this.harness.sessionInfo(live.path)?.kind === "child") return;
    const label = await this.namer.labelTool(live.path, toolCallId, toolName, args, {
      stillRunning: () => this.runningTools.get(live.path)?.has(toolCallId) === true,
    });
    if (!label || !this.sessions.has(live.path)) return;
    this.notify("pi/extension/message", { path: live.path, message: { type: "lasercode/namer/label", toolCallId, label } });
  }

  /** Re-send accepted updates after `fromSeq`, then any dialogs still waiting. */
  private replay(live: Live, fromSeq: number | undefined): void {
    if (fromSeq !== undefined) {
      for (const params of live.buffer) if (params.seq > fromSeq && params.seq <= live.seq) this.notify("session/update", params);
    }
    // Pending dialogs are owned by the driver's UI bridge; the driver re-emits
    // them through `ui_request` events when asked. Drivers that expose
    // `pendingUi()` get replayed here (StableSdkDriver does).
    const pendingUi = (live.driver as { pendingUi?: () => Array<HostNotifications["pi/ui/request"]> }).pendingUi;
    if (typeof pendingUi === "function") {
      for (const request of pendingUi.call(live.driver)) this.notify("pi/ui/request", { ...request, path: live.path });
    }
  }

  private respondError(id: string | number | null, error: unknown): void {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: id ?? 0,
      error:
        error instanceof ProtocolError
          ? { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) }
          : { code: ErrorCodes.Internal, message: error instanceof Error ? error.message : String(error) },
    };
    this.options.send(response);
  }
}

/**
 * The project's environment configuration, as the host supplied it.
 *
 * It arrives as non-secret JSON in the worker's own environment, the same way
 * the enabled features and the bundled package manager do. Malformed input
 * means "no environment command" rather than a crash: a worker that cannot
 * read this must still serve the project.
 */
function readProjectEnvConfig(): ProjectEnvWorkerConfig | undefined {
  try {
    const parsed: unknown = JSON.parse(process.env[ENV.projectEnv] ?? "null");
    if (!parsed || typeof parsed !== "object") return undefined;
    const candidate = parsed as Partial<ProjectEnvWorkerConfig>;
    if (candidate.enabled !== true) return undefined;
    if (typeof candidate.command !== "string" || !candidate.command) return undefined;
    const args = Array.isArray(candidate.args) ? candidate.args.filter((a): a is string => typeof a === "string") : [];
    const allow = Array.isArray(candidate.allowProviderKeys)
      ? candidate.allowProviderKeys.filter((a): a is string => typeof a === "string")
      : [];
    return {
      enabled: true,
      command: candidate.command,
      args,
      required: candidate.required !== false,
      allowProviderKeys: allow,
      approved: candidate.approved === true,
    };
  } catch {
    return undefined;
  }
}

/** The text blocks of a prompt, joined; images contribute nothing to a name. */
function textOf(content: ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
