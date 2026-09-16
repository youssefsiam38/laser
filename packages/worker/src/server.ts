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
 *
 * A session's runtime is not kept for ever (RP-4). When nobody is following a
 * conversation the host may ask for it back with `pi/session/unload`, and this
 * process answers from one predicate (`session-safety.ts`): a turn, a question,
 * an approval, a run, a queued message or a running command refuses the
 * release, and the same answer is what `pi/worker/safety` reports to the pool
 * before it retires anything. Releasing disposes the driver, whose `closed`
 * event drops every per-session table in one place; the conversation itself is
 * untouched, and `session/load` opens it again from the canonical record on a
 * fresh epoch the client resyncs to. Replay has a worker-wide ceiling as well
 * as a per-session one, and reaching it raises a session's floor rather than
 * growing the process.
 */

import { AGENT_MAX_DEPTH_LIMIT, EDITABLE_TEXT_MAX_BYTES, ENV, ErrorCodes, createBodyRangeReader, entryRegionsPage, utf8ByteLength, PRODUCT_NAME, ProtocolError, SESSION_SAFETY_MAX, isSessionWorkPin, boundedHistoryWindow, parseClientRequest, projectEnvFingerprint, projectEnvWorkerConfig, type AgentDefinition, type AgentRun, type SessionPin, type SessionSafety, type WorkerRetireMode, type WorkerRetireRefusal, type AgentModelChoice, type ClientRequests, type CommandInfo, type ContentBlock, type FeatureId, type HostNotifications, type JsonRpcMessage, type JsonRpcResponse, type PiExtensionModuleName, type SessionAgentRecord, type SessionState, type MemoryPressureStores, type SessionUpdateParams, type ProjectEnvStatus, type ProjectEnvWorkerConfig, type ProviderCaptureLink, type SettingsScope, type TypedClientRequest, type WorkerActivationState, WIRE_NAMESPACE } from "@lasercode/protocol";
import { CaptureReservations } from "./capture-reservations.js";
import {
  PRESSURE_MAX_REPLAY_DROPS,
  PRESSURE_MAX_TASK_SESSIONS,
  createWorkerPressureController,
  type PressureActionOutcome,
  type WorkerPressureController,
} from "./pressure.js";
import { createPressureSampler } from "./pressure-sampler.js";

/** RP-5b body digests. The one hash both authorities sign a body with. */
const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const ACTIVATION_ROOT_METHODS = new Set([
  "session/new",
  "session/prompt",
  "session/goal/action",
  "pi/session/steer",
  "pi/session/follow_up",
]);

/**
 * A prompt handed back for editing, bounded before it is serialized (RP-5b B3).
 *
 * An edit puts the whole message in a renderer, so a message larger than a
 * composer may hold is not sent back at all: the answer says how large it is
 * and that it was left out, and the surface reads it deliberately, with room
 * reserved, or says plainly that it cannot be edited there.
 */
function boundedEditorText(text: string | undefined): { editorText?: string; editorTextBytes?: number; editorTextOmitted?: true } {
  if (text === undefined) return {};
  const bytes = utf8ByteLength(text);
  return bytes > EDITABLE_TEXT_MAX_BYTES
    ? { editorTextBytes: bytes, editorTextOmitted: true }
    : { editorText: text, editorTextBytes: bytes };
}
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
import { RevisionCanonicalisationError, type SessionRevisionHeader } from "@lasercode/protocol";
import { SessionRevisionTracker } from "./history-revision.js";
import { ReplayBudget, ReplayBuffer } from "./replay-buffer.js";
import { sessionPins, type SessionSafetySnapshot } from "./session-safety.js";
import { SessionRuntimes } from "./session-runtimes.js";
import { WorkerLifetime } from "./worker-lifetime.js";
import { assertFirstTurnAdmission, FirstTurnLock } from "./first-turn.js";
import { PendingTray } from "./pending.js";
import { GitService } from "./git.js";
import { KeybindingsAdapter } from "./keybindings.js";
import { ModelsAdapter, PackagesAdapter } from "./packages.js";
import { SettingsAdapter } from "./settings.js";
import { WebSearchService } from "./web-search.js";
import { McpService } from "./mcp/service.js";
import { TranscribeService } from "./transcribe.js";
import { parseWorkerProjectEnvConfig, ProjectEnvironment } from "./project-env.js";
import type { HarnessSessionRole } from "./agents/bridge.js";
import type { ProjectEnvironmentBridge } from "@lasercode/pi-extension";
import { DefinitionsCache } from "./agents/definitions.js";
import { defaultAgentInstructions } from "./agents/engine-instructions.js";
import { AgentHarness, modelUnavailableMessage, type SessionHandle, type SessionHost } from "./agents/harness.js";
import { NamerService, type NamerModelRuntime } from "./agents/namer.js";
import { readSessionAgentRecord, rootRecord, rootRole, removedWorktreeCwd } from "./agents/session-config.js";
import { listAgentSkills } from "./agents/skills.js";
import { TaskIndex } from "./agents/tasks.js";
import { setWorkerProcessObserver } from "./process-registry.js";
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
  /**
   * The environment durable revisions belong to (RP-9). The host always passes
   * its own; the default exists only so a worker constructed directly (a test,
   * a hand-run process) still produces self-consistent revisions rather than
   * none. It is never a secret and never leaves this process.
   */
  environmentId?: string;
  features?: FeatureId[];
  /** Updates kept per session for `fromSeq` replay. */
  replayBuffer?: number;
  /** Serialized-byte ceiling per replay suffix, independent of live state. */
  replayBytes?: number;
  /**
   * Serialized-byte ceiling for **every** replay suffix in this worker (RP-4).
   *
   * The per-session limit above is what one conversation may keep; this is what
   * the process may keep across all of them, and it is hard: when it is reached
   * the oldest replayable updates are dropped and those sessions' floors rise,
   * which `session/load` already turns into a snapshot resync.
   */
  replayBudgetBytes?: number;
  /**
   * How long an acknowledged retirement holds this worker's admission closed
   * before it goes back to work (RP-4). A test seam: the host ends the pipe as
   * soon as it hears the acknowledgement, so this only ever expires when that
   * answer was lost.
   */
  retireLeaseMs?: number;
  /** The package manager to run when settings name none (M10-T5): the one the host bundles. */
  npmCommand?: string[];
  /** Test seam: the model runtime Namer completes through. Defaults to the engine's. */
  namerModels?: () => Promise<NamerModelRuntime>;
  /**
   * Bytes accepted for the host and not yet written (RP-7). Read by the
   * capture producer: when the link is backed up, a provider capture is
   * recorded without its body rather than queued ahead of the session's own
   * updates. Work is never paused by this — only a diagnostic is.
   */
  transportPending?: () => number;
  /** Complete messages accepted for the app and not yet written (RP-7). */
  transportFrames?: () => number;
  /** Give that link a turn to write what it is holding (RP-7). */
  transportDrain?: () => Promise<void>;
  /**
   * False when the log store keeps request summaries only. The body is then
   * not serialized or sent at all, instead of crossing the link so the host
   * can drop it (RP-7).
   */
  retainProviderBodies?: boolean;
  /**
   * Which spawn this worker is, as the host minted it before starting the
   * process (RP-8). The worker stamps it on the reports it sends unasked and
   * checks it on every directive. Absent — a worker constructed directly in a
   * test, or a caller that minted none — it takes no part in memory pressure
   * at all rather than claiming an identity nobody gave it.
   */
  workerGeneration?: number;
  /** Explicit V8 old-space request parsed from this exact process's argv. */
  configuredOldSpaceBytes?: number;
}

/** Sessions whose first prompt may wait for a Namer model; a worker holds few at once. */
const UNNAMED_MAX = 32;

/** Bytes of replay one worker may hold across every session it serves (RP-4). */
const REPLAY_BYTES_PER_SESSION = 16 * 1024 * 1024;
const REPLAY_BUDGET_BYTES = 4 * REPLAY_BYTES_PER_SESSION;

/** The session named by a request, when it names one. */
function pathOf(req: TypedClientRequest): string | undefined {
  const path = (req.params as { path?: unknown } | undefined)?.path;
  return typeof path === "string" ? path : undefined;
}

interface PreAcceptanceHydration {
  /** Genuine accepted baseline captured before candidate runtime preparation. */
  state: SessionState;
  entries: unknown[];
  leafId: string | null;
  goal: Awaited<ReturnType<NonNullable<SessionDriver["goalState"]>>>;
}

interface Live {
  driver: SessionDriver;
  /**
   * When this conversation was last *used* — opened, or named by a request
   * this worker served (RP-8).
   *
   * Not the same as the replay buffer's last activity, which is when the
   * session last *produced* an update: a conversation somebody reopened and
   * read a minute ago is recently used even though nothing has streamed in it
   * since yesterday. Pressure asks each session's companion to keep less
   * starting with the ones nobody has touched, so it needs this one.
   */
  touchedAtMs: number;
  historyEpoch: string;
  /** Durable revision fold for this session (RP-9), kept across reads. */
  revisions: SessionRevisionTracker;
  seq: number;
  buffer: ReplayBuffer;
  /** Read-only hydration baseline while a first turn is speculative/restoring. */
  preAcceptance?: PreAcceptanceHydration;
  unsubscribe: () => void;
  path: string;
  /** The harness's view of this session, once attached. */
  handle?: SessionHandle;
  /**
   * Set when a release tried to close this runtime and could not: the
   * conversation is still being served by it, and nothing may end it.
   */
  closeFailed?: boolean;
  /**
   * Messages the person wrote while the agent was working. Laser's own list,
   * not the engine's: see `packages/worker/src/pending.ts`. Attached once the
   * session's path is known, because every publication names it.
   */
  pending?: PendingTray;
}

type Result<M extends keyof ClientRequests> = ClientRequests[M]["result"];

export class WorkerServer {
  /**
   * The sessions this worker holds and every fence around them (RP-4):
   * one open per file (AGENTS.md invariant 8), a per-path release fence so
   * nothing starts between a release's final check and its disposal, and the
   * worker-wide retirement fence. See `session-runtimes.ts`.
   */
  private readonly runtimes: SessionRuntimes<Live>;
  /** The two lifetime transitions over that table: release and retire (RP-4). */
  private readonly lifetime: WorkerLifetime<Live>;
  /** The environment every durable revision this worker mints belongs to (RP-9). */
  private readonly environmentId: string;
  private readonly replayBuffer: number;
  /** This worker's whole replay allowance (RP-4), shared by every session. */
  private readonly replayBudget: ReplayBudget;
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
  private projectEnv: ProjectEnvironment | undefined;
  /** M13 · agents: the host's definitions, the harness that runs them, and Namer. */
  private readonly definitions: DefinitionsCache;
  private readonly harness: AgentHarness;
  /** RP-5b: one body at a time, so slicing a large one stays linear. */
  private readonly bodyRanges = createBodyRangeReader();
  private readonly namer: NamerService;
  /**
   * Every background command a session of this worker published, kept beside
   * the runs so the harness can hand an agent the same tree the fleet shows
   * (`inspect_fleet`, D-163). Fed from the `lasercode/task/update` messages
   * forwarded to the host below; the host keeps its own copy for clients.
   */
  private readonly tasks = new TaskIndex();
  /** Resolved on first use; see `taskLogRoot`. */
  private logRoot: string | undefined;
  /**
   * First prompts still waiting for a Namer model, by session path. A prompt
   * that arrives before the host's `agents/sync` (or before qualification
   * finishes) would otherwise be the one prompt that never names its session.
   * Bounded, because a run with naming off must not grow this for ever.
   */
  private readonly unnamed = new Map<string, string>();
  /**
   * Naming actually under way: **one** attempt per session, by path, holding
   * that attempt's token (RP-4).
   *
   * This is the state safety reads: a session is pinned while a Namer
   * completion for it is in flight, because that completion ends in a rename
   * **through this runtime** and nothing else can finish it. The entry is made
   * before the await and removed in a `finally`, so it is bounded by Namer's
   * own 8 s completion ceiling — no timer, lease or queue of ours.
   *
   * One per session, not one per prompt: a session is named from its first
   * prompt, so while an attempt is running another eligible message starts no
   * second request — which also bounds what this holds and what naming spends
   * to one completion per conversation at a time, whatever a person types
   * during it.
   *
   * The token is what makes a late completion safe: `finally` removes the
   * entry only while it is still its own, so an attempt whose session was
   * closed (or rekeyed and started again) cannot clear a successor's record.
   */
  private readonly namingInFlight = new Map<string, symbol>();
  /** Tool calls currently running, by session path: a label for a finished call is never shown. */
  private readonly runningTools = new Map<string, Set<string>>();
  /** Held only through prompt preflight; prevents runtime replacement races. */
  private readonly firstTurnLock = new FirstTurnLock();
  /** This worker's own memory-pressure controller (RP-8). One per process. */
  private readonly pressure: WorkerPressureController;
  /** Exact update fence; absent until this worker acknowledges park. */
  private activationGate: { updateId: string; generationId: string } | undefined;

  constructor(private readonly options: WorkerServerOptions) {
    this.environmentId = options.environmentId ?? UNCONFIGURED_ENVIRONMENT;
    this.replayBuffer = options.replayBuffer ?? 5000;
    // Four times one session's suffix ceiling: enough that the handful of
    // conversations a person actually streams keep a full replay window, and
    // far below the per-session entitlement multiplied by every session a
    // worker can hold (RP-2 measured fifty of them in one worker).
    this.replayBudget = new ReplayBudget(options.replayBudgetBytes ?? REPLAY_BUDGET_BYTES);
    this.runtimes = new SessionRuntimes<Live>(options.retireLeaseMs !== undefined ? { retireLeaseMs: options.retireLeaseMs } : {});
    this.lifetime = new WorkerLifetime<Live>({
      runtimes: this.runtimes,
      safetySnapshot: (live, releasing) => this.safetySnapshot(live, releasing),
      withFirstTurnLease: (path, work) => this.firstTurnLock.run(path, work),
    });
    // Configured by the host, machine-local and non-secret: the executable, its
    // arguments, and whether a person approved exactly that pair.
    const projectEnvConfig = readProjectEnvConfig();
    this.projectEnv = projectEnvConfig
      ? new ProjectEnvironment({ cwd: options.cwd, config: projectEnvConfig })
      : undefined;
    this.definitions = new DefinitionsCache();
    // Processes this worker starts on purpose are named for the host's
    // inventory (RP-1). Pids only: the host proves `(pid, startToken)` and
    // ancestry itself before it believes any of it, and the notification is
    // consumed by the host rather than broadcast.
    // Registrations only: a pid this worker reports as *gone* would be a claim
    // about a number, and the next process to take that number could be
    // another worker's. The host's own table decides when a process ended.
    setWorkerProcessObserver({
      started: (registration) => this.notify("pi/resource/process", { registrations: [registration] }),
    });
    const host: SessionHost = {
      openChild: (open) => this.openChild(open),
      driver: (path) => this.runtimes.get(path)?.driver,
      notify: (method, params) => this.notify(method, params),
      modelAvailable: (model) => this.modelAvailable(model),
      tasks: (path) => this.tasks.tasksOf(path),
      taskLogRoot: () => this.taskLogRoot(),
    };
    this.harness = new AgentHarness({
      host,
      definitions: this.definitions,
      worktrees: new WorktreeManager(),
      ...(options.projectTrusted !== undefined ? { projectTrusted: options.projectTrusted } : {}),
      admitNewWork: () => this.activationGate === undefined,
      backgroundWork: (cwd) => ({
        cwd,
        // The private directory command logs live in: the host's, when it gave
        // us one, and otherwise this process's own (RP-6). Never a shared,
        // guessable path under the system temp directory.
        logRoot: this.taskLogRoot(),
        foregroundCommandSeconds: this.definitions.policy().foregroundCommandSeconds,
        admitCommand: () => this.activationGate === undefined,
        // Resolved when each Bash call starts, so a Settings save takes effect
        // without ending an open parent or child session.
        commandPrefix: () => this.projectEnv?.preface,
        // Every child agent and every worktree of this project runs in this
        // worker, so they share the project's environment by construction.
        projectEnv: this.projectEnvBridge(),
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
    // This worker answers for its own memory (RP-8): it samples itself, runs
    // the three steps it owns, and tells the host what it found. It takes part
    // only when the host gave it a generation it can prove; without one it
    // neither reports nor acts on a directive.
    this.pressure = createWorkerPressureController(
      {
        sample: createPressureSampler(),
        actions: {
          ephemeralCaches: () => this.releaseEphemeralCaches(),
          replaySuffixes: (level) => this.releaseReplaySuffixes(level),
          taskRecords: (level) => this.releaseTaskRecords(level),
        },
        stores: () => this.retainedStores(),
        report: (report) => this.notify("pi/resource/pressure", report),
        log: (line) => console.error(`${PRODUCT_NAME} worker: ${line}`),
      },
      {
        ...(options.workerGeneration !== undefined ? { generation: options.workerGeneration } : {}),
        ...(options.configuredOldSpaceBytes !== undefined ? { configuredOldSpaceBytes: options.configuredOldSpaceBytes } : {}),
      },
    );
    if (options.workerGeneration !== undefined) this.pressure.start();
  }

  /**
   * Where this worker's command logs live, created once, privately.
   *
   * The host passes its own root down as environment; without one (a test, a
   * standalone worker) this makes an unpredictable one with `mkdtemp` and
   * `0700`. It is also the only directory anything in this process will read a
   * command log from.
   */
  taskLogRoot(): string {
    if (this.logRoot) return this.logRoot;
    const configured = process.env[ENV.taskLogRoot];
    if (configured && isAbsolute(configured)) {
      mkdirSync(configured, { recursive: true, mode: 0o700 });
      this.logRoot = configured;
      return this.logRoot;
    }
    this.logRoot = mkdtempSync(join(tmpdir(), `${WIRE_NAMESPACE}-tasks-`));
    chmodSync(this.logRoot, 0o700);
    return this.logRoot;
  }

  /** The harness, for tests and for the packaged probe. */
  agents(): AgentHarness {
    return this.harness;
  }

  /** Paths of sessions currently open in this worker. */
  openSessions(): string[] {
    return this.runtimes.paths();
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
    // Admission, before anything runs (RP-4).
    //
    // A request naming a session is counted against that session while it is
    // served, so a release cannot start under a read in flight; a request that
    // arrives while that session is being released, or while this worker is
    // retiring, is refused with a sentence rather than queued — a queue would
    // be memory a peer controls, and the refusal is what makes both fences
    // fail closed. The two lifetime verbs are privileged: they are the fences.
    const privileged = req.method === "pi/session/unload" || req.method === "pi/worker/retire";
    let release: () => void;
    try {
      release = this.runtimes.admit(privileged ? undefined : pathOf(req), { privileged });
    } catch (error) {
      this.respondError(req.id, error);
      return;
    }
    try {
      const result = await this.dispatch(req);
      this.options.send({ jsonrpc: "2.0", id: req.id, result });
    } catch (error) {
      this.respondError(req.id, error);
    } finally {
      release();
    }
  }

  /** Accepted handlers have settled (RP-4). False means the bound passed first. */
  drain(timeoutMs?: number): Promise<boolean> {
    return this.runtimes.drain(timeoutMs);
  }

  async dispose(): Promise<void> {
    // Before anything is torn down: a pass in flight stops at its next step and
    // nothing is reported afterwards (RP-8).
    this.pressure.dispose();
    this.runtimes.clearLease();
    // Nothing of a body outlives this worker's service (RP-5b, RP-4).
    this.bodyRanges.forget();
    this.transcribeService?.dispose();
    this.transcribeService = undefined;
    await this.mcpService?.dispose().catch(() => {});
    this.mcpService = undefined;
    for (const live of this.runtimes.values()) {
      live.unsubscribe();
      await this.firstTurnLock.run(live.path, () => live.driver.dispose()).catch(() => {});
    }
    this.runtimes.clear();
    this.runningTools.clear();
    this.unnamed.clear();
    // Every runtime this worker could have renamed is gone, so no attempt can
    // still be holding one. A completion that lands after this finds its
    // record already removed and its `finally` is a no-op.
    this.namingInFlight.clear();
  }

  // ------------------------------------------------------------- dispatch

  private async dispatch(req: TypedClientRequest): Promise<unknown> {
    if (this.activationGate && ACTIVATION_ROOT_METHODS.has(req.method)) {
      throw new ProtocolError(ErrorCodes.SessionBusy, "An update is waiting for current work to finish. Keep working by cancelling update preparation first.");
    }
    switch (req.method) {
      case "session/new":
        return this.sessionNew(req.params);
      case "session/load":
        return this.sessionLoad(req.params);
      case "session/prompt":
        return (await this.promptRequest(this.live(req.params.path), req.params)) satisfies Result<"session/prompt">;
      case "session/cancel": {
        const live = this.live(req.params.path);
        this.notify("pi/extension/message", {
          path: live.path,
          message: {
            type: "lasercode/module/log",
            module: "worker",
            level: "info",
            message: `lifecycle abort-request initiator=user source=session/cancel at=${new Date().toISOString()}`,
          },
        });
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
      case "pi/session/unload":
        // The app releasing an idle runtime (RP-4). Deliberately not `close`:
        // close is the file-move fence and refuses only a streaming turn, while
        // this refuses everything a release would destroy and says what.
        return (await this.lifetime.unload(req.params.path)) satisfies Result<"pi/session/unload">;

      case "pi/worker/safety":
        // The same predicate, read-only, for diagnostics and tests. The
        // retirement *decision* is `pi/worker/retire` below, which takes it
        // under a fence rather than from a snapshot.
        return this.sessionSafety() satisfies Result<"pi/worker/safety">;

      case "pi/worker/activation/park":
        if (this.activationGate && (this.activationGate.updateId !== req.params.updateId
          || this.activationGate.generationId !== req.params.generationId)) {
          throw new ProtocolError(ErrorCodes.SessionBusy, "Another update is already waiting for current work to finish.");
        }
        this.activationGate = { ...req.params };
        return this.activationState(req.params.updateId) satisfies Result<"pi/worker/activation/park">;
      case "pi/worker/activation/status":
        return this.activationState(req.params.updateId) satisfies Result<"pi/worker/activation/status">;
      case "pi/worker/activation/cancel": {
        const state = this.activationState(req.params.updateId);
        this.activationGate = undefined;
        return { ...state, parked: false } satisfies Result<"pi/worker/activation/cancel">;
      }

      case "pi/worker/retire":
        return await this.lifetime.retire(req.params.mode);

      case "pi/session/close": {
        // The host is about to move the file (M13-T58): it must have no writer
        // while that happens (AGENTS.md invariant 8). Disposing the driver
        // emits `closed`, which drops the session from every table here.
        const live = this.runtimes.get(req.params.path);
        if (!live) return { closed: false } satisfies Result<"pi/session/close">;
        return this.firstTurnLock.run(live.path, async () => {
          if (live.driver.state().isStreaming) {
            throw new ProtocolError(ErrorCodes.SessionBusy, "This chat is still answering. Wait for it to finish, or stop it, then move it.");
          }
          await live.driver.dispose();
          this.runtimes.drop(live.path);
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
            const previous = live.path;
            live.path = state.path;
            this.runtimes.rekey(previous, state.path);
            this.rekeySessionState(previous, state.path);
          }
          this.onDriverEvent(live, { type: "update", update: { kind: "state", state } });
          // Strip the driver's raw handback before adding the bounded form. A
          // spread cannot remove a property, so spreading `forked` verbatim
          // would put an oversized editorText on the wire beside `omitted`.
          const { editorText: _editorText, ...boundedFork } = forked;
          return { ...boundedFork, ...boundedEditorText(forked.editorText), state: this.decorate(live, forked.state) } satisfies Result<"pi/session/fork">;
        });
      }
      case "pi/session/navigate": {
        const live = this.live(req.params.path);
        const moved = await this.firstTurnLock.run(live.path, () => live.driver.navigateTree(req.params.entryId, {
          ...(req.params.summarize !== undefined ? { summarize: req.params.summarize } : {}),
          ...(req.params.label !== undefined ? { label: req.params.label } : {}),
          ...(req.params.stopFirst !== undefined ? { stopFirst: req.params.stopFirst } : {}),
        }));
        const { editorText: _editorText, ...boundedMove } = moved;
        return { ...boundedMove, ...boundedEditorText(moved.editorText) } satisfies Result<"pi/session/navigate">;
      }
      case "pi/session/rename": {
        const live = this.live(req.params.path);
        await this.firstTurnLock.run(live.path, () => live.driver.rename(req.params.name));
        return {};
      }
      case "session/revision": {
        // The worker that owns a session is the authority for it: its leaf can
        // sit where no reader of the file could know (a navigation that has
        // appended nothing yet), so a disk answer would be behind.
        const live = this.live(req.params.path);
        const snapshot = live.preAcceptance ?? await live.driver.entries();
        const header = this.revisionHeader(live);
        try {
          const { revision, environmentKey } = live.revisions.compute(header, snapshot.entries, snapshot.leafId);
          const base = req.params.baseRevision === undefined
            ? undefined
            : live.revisions.classify(req.params.baseRevision, header, snapshot.entries, snapshot.leafId);
          return { revision, environmentKey, authority: "live", ...(base ? { base } : {}) } satisfies Result<"session/revision">;
        } catch (error) {
          throw revisionUnavailable(error);
        }
      }
      case "pi/session/entries": {
        const live = this.live(req.params.path);
        if (req.params.window) {
          // The driver captures persisted entries and current partial work in
          // one synchronous read. If an awaited driver yields to an update,
          // retry rather than assigning that update an incorrect watermark.
          for (;;) {
            const seq = live.seq;
            const baseline = live.preAcceptance;
            const snapshot = baseline ?? await live.driver.entries({ live: !("before" in req.params.window) });
            if (this.runtimes.get(live.path) !== live) throw new ProtocolError(ErrorCodes.SessionNotFound, "This conversation was closed. Open it again.");
            if (seq !== live.seq || baseline !== live.preAcceptance) continue;
            const active = "live" in snapshot ? snapshot.live : undefined;
            // Computed from the very snapshot being returned, inside the same
            // retry fence, so the revision and the rows can never describe two
            // different states. A record this cannot canonicalise refuses the
            // read; it never answers with a window that has no revision.
            const { revision, environmentKey } = this.revisionOf(live, snapshot);
            const common = {
              sessionId: this.sessionIdOf(live), epoch: live.historyEpoch, seq, revision, environmentKey,
              authority: "live" as const,
              ...("before" in req.params.window ? {} : { live: active ?? { running: baseline?.state.isStreaming ?? live.driver.state().isStreaming, tools: [] } }),
            };
            const resolved = req.params.baseRevision === undefined
              ? undefined
              : live.revisions.resolve(req.params.baseRevision, this.revisionHeader(live), snapshot.entries, snapshot.leafId);
            // Only a live-edge tail can be spliced onto a cached revision.
            // Older-page, search-anchor and all-history requests retain their
            // exact tree semantics even when the base is current or a prefix.
            // RP-5b: a caller that cannot hold a large body asks for the page
            // without it; the record is listed in `elided` instead of rewritten.
            const bodies = req.params.bodyLimit === undefined ? undefined : { limit: req.params.bodyLimit, digest: sha256Hex };
            if ("tail" in req.params.window && resolved?.base !== "stale" && resolved?.state) {
              const delta = boundedHistoryWindow(snapshot, req.params.window, {
                ...common,
                selection: { kind: "delta", after: resolved.state.leafId },
              }, bodies);
              if (delta) return delta;
            }
            const replacement = boundedHistoryWindow(snapshot, req.params.window, {
              ...common,
              selection: { kind: "replace" },
            }, bodies);
            if (replacement) return replacement;
            throw new ProtocolError(
              ErrorCodes.RevisionUnavailable,
              "The requested history range cannot be transferred without splitting a complete turn. Ask for a smaller page.",
            );
          }
        }
        const baseline = live.preAcceptance;
        if (baseline) return { entries: baseline.entries, leafId: baseline.leafId } satisfies Result<"pi/session/entries">;
        // A normal prompt holds the admission lease through engine preflight but
        // does not replace the runtime. Its live canonical reads must remain
        // available so a no-signal question can be answered after reconnect.
        return (await live.driver.entries()) satisfies Result<"pi/session/entries">;
      }
      // RP-5b: one body of one entry, from the authority that owns this
      // session right now. The revision is computed from the very snapshot the
      // bytes come from, so a caller reading at an older state is refused
      // rather than handed another state's offsets.
      case "session/entry_range": {
        const live = this.live(req.params.path);
        const snapshot = await live.driver.entries();
        if (this.runtimes.get(live.path) !== live) throw new ProtocolError(ErrorCodes.SessionNotFound, "This conversation was closed. Open it again.");
        const { revision, environmentKey } = this.revisionOf(live, snapshot);
        if (environmentKey !== req.params.environmentKey) {
          throw new ProtocolError(ErrorCodes.InvalidParams, "That conversation belongs to a different connection.");
        }
        if (revision !== req.params.revision) {
          throw new ProtocolError(
            ErrorCodes.RevisionUnavailable,
            "This conversation moved on since that message was read. Open it again to see the rest.",
          );
        }
        const entry = snapshot.entries.find((row) => (row as { id?: unknown } | null)?.id === req.params.entryId);
        if (entry === undefined) {
          throw new ProtocolError(ErrorCodes.InvalidParams, "That message is not part of this conversation any more.");
        }
        // One body at a time, keyed by the exact snapshot it came from, so a
        // large body read in slices is walked and hashed once, not per slice.
        const sliced = this.bodyRanges.read(
          { path: live.path, revision, entryId: req.params.entryId, component: req.params.component },
          () => entry,
          { ...req.params, entryId: req.params.entryId },
          "live",
          sha256Hex,
        );
        if (!sliced.ok) {
          if (sliced.refusal.reason === "bad-range") {
            throw new ProtocolError(ErrorCodes.InvalidParams, "That is not a readable part of this message. Open it again from the start.");
          }
          if (sliced.refusal.reason === "bad-region") {
            throw new ProtocolError(ErrorCodes.InvalidParams, "That is not a part of this message. Open the message again to see what it holds.");
          }
          throw new ProtocolError(ErrorCodes.InvalidParams, `That message has no ${req.params.component.kind.replaceAll("_", " ")} to read.`, { available: sliced.refusal.available });
        }
        return sliced.result satisfies Result<"session/entry_range">;
      }
      // RP-5b §2: the same page of attachments, from the session this worker
      // owns, at the revision computed from its own entries.
      case "session/entry_regions": {
        const live = this.live(req.params.path);
        const snapshot = await live.driver.entries();
        if (this.runtimes.get(live.path) !== live) throw new ProtocolError(ErrorCodes.SessionNotFound, "This conversation was closed. Open it again.");
        const { revision, environmentKey } = this.revisionOf(live, snapshot);
        if (environmentKey !== req.params.environmentKey) {
          throw new ProtocolError(ErrorCodes.InvalidParams, "That conversation belongs to a different connection.");
        }
        if (revision !== req.params.revision) {
          throw new ProtocolError(
            ErrorCodes.RevisionUnavailable,
            "This conversation moved on since that message was read. Open it again to see the rest.",
          );
        }
        const entry = snapshot.entries.find((row) => (row as { id?: unknown } | null)?.id === req.params.entryId);
        if (entry === undefined) {
          throw new ProtocolError(ErrorCodes.InvalidParams, "That message is not part of this conversation any more.");
        }
        const page = entryRegionsPage(
          entry,
          { component: req.params.component, ...(req.params.from !== undefined ? { from: req.params.from } : {}), ...(req.params.limit !== undefined ? { limit: req.params.limit } : {}) },
          revision,
          "live",
          () => { const hash = createHash("sha256"); return { update: (chunk: string) => { hash.update(chunk, "utf8"); }, digest: () => hash.digest("hex") }; },
        );
        if (!page.ok) {
          throw page.refusal.reason === "unknown-component"
            ? new ProtocolError(ErrorCodes.InvalidParams, `That message has no ${req.params.component.kind.replaceAll("_", " ")} to read.`, { available: page.refusal.available })
            : new ProtocolError(ErrorCodes.InvalidParams, "That is not a part of this message. Open the message again to see what it holds.");
        }
        return page.result satisfies Result<"session/entry_regions">;
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
        return this.settingsLane(live, async () => ({ state: await live.driver.setModel(req.params.model) } satisfies Result<"pi/model/set">));
      }
      case "pi/thinking/set": {
        const live = this.live(req.params.path);
        return this.settingsLane(live, async () => ({ state: await live.driver.setThinkingLevel(req.params.level) } satisfies Result<"pi/thinking/set">));
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
      case "pi/worker/retained-stores": {
        // The app asking its own worker what it is holding (RP-3/RP-6). Read
        // from state this process already has: nothing is collected, nothing
        // is opened and no session is touched to answer it.
        return { stores: this.retainedStores() } satisfies Result<"pi/worker/retained-stores">;
      }

      case "pi/worker/pressure":
        // The host asking this worker to give memory back at a level (RP-8).
        // Never a client's call: the router refuses it before anything is
        // forwarded. The controller owns the fences and the bounds; nothing
        // here can cancel work.
        return (await this.pressure.directive(req.params)) satisfies Result<"pi/worker/pressure">;

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
        if (req.params.path !== undefined && this.runtimes.has(req.params.path)) await git.baseline(req.params.path);
        return (await git.status(req.params.path)) satisfies Result<"pi/project/git">;
      }

      // ------------------------------------------- M16-T17 project env ---
      case "pi/project/env/status": {
        this.assertCwd(req.params.cwd);
        return { status: this.projectEnvStatus() } satisfies Result<"pi/project/env/status">;
      }
      case "pi/project/env/set": {
        this.assertCwd(req.params.cwd);
        const input = req.params.config;
        const args = input?.args ?? [];
        const stored = input
          ? {
              ...input,
              args,
              required: input.required ?? true,
              approvedFingerprint: projectEnvFingerprint({
                ...(input.preface ? { preface: input.preface } : {}),
                command: input.command,
                args,
              }),
            }
          : undefined;
        const config = projectEnvWorkerConfig(stored);
        if (this.projectEnv) this.projectEnv.reconfigure(config);
        else if (config) this.projectEnv = new ProjectEnvironment({ cwd: this.options.cwd, config });
        const status = this.projectEnvStatus();
        this.notify("pi/project/env/changed", { status });
        return { status } satisfies Result<"pi/project/env/set">;
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
      case "pi/worker/recover-agent-failures": {
        const runs = req.params.runs as AgentRun[];
        for (const run of runs) {
          if (run.projectCwd !== this.options.cwd || run.status !== "failed" || run.endedBy?.initiator !== "harness" || !run.parent) {
            throw new ProtocolError(ErrorCodes.InvalidParams, "The recovery batch contains a run this worker cannot recover.");
          }
        }
        await this.harness.recoverFailures(runs);
        return { delivered: runs.map((run) => run.runId) } satisfies Result<"pi/worker/recover-agent-failures">;
      }
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
    return {
      // Resolve through the server each time: a live save can add, replace or
      // remove configuration after this session's bridge was created.
      apply: (env) => this.projectEnv?.apply(env) ?? env,
      blocking: () => this.projectEnv?.blocking ?? false,
      reason: () => this.projectEnv?.blockingReason() ?? "",
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
      [...this.runtimes.values()].map(async (live) => {
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
    // A release of this exact session may have been in flight when this load
    // was admitted (the admission fence refuses one that arrives later). Wait
    // for it and then open again: answering from a runtime that is about to be
    // disposed is the one thing these fences exist to stop.
    await this.runtimes.settled(params.path);
    const existing = this.runtimes.get(params.path);
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
        ...(await this.loadRevision(existing)),
      };
    }
    const inFlight = this.runtimes.opening(params.path);
    if (inFlight) {
      const live = await inFlight;
      const state = live.driver.state();
      this.replay(live, params.fromSeq);
      return { state: this.decorate(live, state), replayFrom: this.replayFloor(live, params.fromSeq), seq: live.seq, ...(await this.loadRevision(live)) };
    }
    // Registered synchronously, before `open()` gets a chance to yield.
    const live = await this.runtimes.withLoad(params.path, async () => {
      // Which agent this stored session runs as: its own record, else the
      // synced default. Read from the file only; the engine is not open yet.
      const { definition, role, record } = await this.recoverAgent(params.path);
      const handle = this.harness.prepareSession({ role, definition, record, projectCwd: this.options.cwd });
      return this.openAndAttach({ cwd: this.options.cwd, sessionPath: params.path, ...this.commonOpen(), agent: this.agentOptions(definition, handle) }, handle);
    });
    // Opening the session already emitted updates (the companion's
    // `session_start` report, the first state); the reply carries the state
    // they produced and the transcript snapshot that follows covers them, so
    // the client is told the watermark it may safely stamp.
    return { state: this.decorate(live, live.driver.state()), replayFrom: 0, seq: live.seq, ...(await this.loadRevision(live)) };
  }

  /**
   * The revision a `session/load` reply carries, when there is one.
   *
   * Unlike a window, a load must still succeed for a session whose records
   * this cannot canonicalise or whose driver keeps no entries: refusing to
   * open a conversation because its revision could not be computed would be a
   * worse failure than opening it without one. Every reader that needs the
   * revision asks for it explicitly and is refused properly there.
   */
  private async loadRevision(live: Live): Promise<{ revision?: string; environmentKey?: string }> {
    try {
      const snapshot = live.preAcceptance ?? await live.driver.entries();
      const { revision, environmentKey } = live.revisions.compute(this.revisionHeader(live), snapshot.entries, snapshot.leafId);
      return { revision, environmentKey };
    } catch {
      return {};
    }
  }

  /**
   * The session identity a durable revision binds to: the stored header when
   * there is a file, else the engine's own session id. Both readers of a real
   * session file see the same header, which is what lets a live revision and a
   * worker-free one be compared at all.
   */
  private revisionHeader(live: Live): SessionRevisionHeader {
    return live.driver.sessionHeader?.() ?? { id: live.driver.state().id, cwd: this.options.cwd };
  }

  private sessionIdOf(live: Live): string {
    return this.revisionHeader(live).id;
  }

  /** The revision for one snapshot, or a refusal that says the read is unavailable. */
  private revisionOf(live: Live, snapshot: { entries: unknown[]; leafId: string | null }): { revision: string; environmentKey: string } {
    try {
      const { revision, environmentKey } = live.revisions.compute(this.revisionHeader(live), snapshot.entries, snapshot.leafId);
      return { revision, environmentKey };
    } catch (error) {
      throw revisionUnavailable(error);
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
        commandPrefix: () => this.projectEnv?.preface,
        projectEnv: this.projectEnvBridge(),
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

  /**
   * Namer names a session after its first prompt, unless the person got there
   * first.
   *
   * Never rejects, and that is load-bearing: every caller floats this promise
   * (naming must not delay the turn), and the reads after the await are not
   * safe — a driver whose runtime is being replaced throws
   * `DriverUnavailableError` out of `state()`. An unhandled rejection would
   * end the worker process, and with it every conversation in this project
   * (AGENTS.md invariant 5), because a session could not be given a title.
   *
   * With no model this parks the words instead (`waitToName`), which is not a
   * pin: nothing can perform that intent, so a runtime kept for it would be
   * kept for the life of the worker. Once a model is there the attempt is
   * real, bounded and answered through this runtime, and it is registered in
   * {@link namingInFlight} for exactly as long as it runs — including the
   * rename, which is the part that needs the runtime. One attempt at a time
   * per session: a message that arrives while that one is running is not a
   * second naming request.
   */
  private async nameSession(live: Live, text: string): Promise<void> {
    try {
      if (!this.namer.enabled()) {
        this.waitToName(live.path, text);
        return;
      }
      // This conversation is already being named. Naming is for its first
      // prompt, so a second request would spend a second completion to answer
      // the same question, and nothing would show the result: Namer never
      // renames over a name. Not parked either — the attempt that is running
      // is the one that names this session.
      const path = live.path;
      if (this.namingInFlight.has(path)) return;
      // Registered before the await, so there is no moment in which the work is
      // neither parked nor in flight. The token says which attempt this entry
      // belongs to, so a model taken away mid-completion cannot erase it and a
      // late completion cannot clear a successor's.
      const token = Symbol("naming");
      this.namingInFlight.set(path, token);
      try {
        const name = await this.namer.nameSession(text);
        const current = this.namingPath(token) ?? path;
        if (!name || !this.runtimes.has(current) || live.driver.state().name) return;
        await live.driver.rename(name).catch(() => undefined);
      } finally {
        this.forgetNaming(token);
      }
    } catch (error) {
      console.error(`${PRODUCT_NAME} worker: could not name ${live.path}:`, error instanceof Error ? error.message : error);
    }
  }

  /** Whether a Namer completion for this session is in flight right now. */
  private naming(path: string): boolean {
    return this.namingInFlight.has(path);
  }

  /** Where this attempt's session lives now, or undefined once it is no longer held. */
  private namingPath(token: symbol): string | undefined {
    for (const [path, held] of this.namingInFlight) if (held === token) return path;
    return undefined;
  }

  /** Drop this attempt's entry, and only ever its own (a successor's stays). */
  private forgetNaming(token: symbol): void {
    const path = this.namingPath(token);
    if (path !== undefined) this.namingInFlight.delete(path);
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
      const live = this.runtimes.get(path);
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
    const live: Live = { driver, historyEpoch: randomUUID(), revisions: new SessionRevisionTracker(this.environmentId), seq: 0, touchedAtMs: Date.now(), buffer: new ReplayBuffer(this.replayBuffer, this.options.replayBytes ?? REPLAY_BYTES_PER_SESSION, this.replayBudget), unsubscribe: () => {}, path: "" };
    driver.setExtensionModelWorkHandler?.((request) => this.admitExtensionModelWork(live, request));
    const queued: DriverEvent[] = [];
    let ready = false;
    live.unsubscribe = driver.subscribe((event) => (ready ? this.onDriverEvent(live, event) : queued.push(event)));
    try {
      const state = await driver.open(openOptions);
      const already = this.runtimes.get(state.path);
      if (already && already !== live) {
        // Someone else got there first (a `session/new` that landed on an
        // existing path, say). One writer per session file, always.
        live.unsubscribe();
        handle?.discard();
        await driver.dispose().catch(() => {});
        return already;
      }
      live.path = state.path;
      this.runtimes.attach(live);
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
      // What the capture producer may know about its link (RP-7): how far
      // behind the app is, and whether this installation keeps bodies at all.
      captureLink: this.captureLink,
    };
  }

  /**
   * The link facts a provider capture answers to. Bounded and read-only: a
   * capture may be recorded without its body because the link is busy or
   * because bodies are not kept here, and nothing else ever waits for either.
   */
  private readonly captureLink: ProviderCaptureLink = {
    pendingBytes: () => this.options.transportPending?.() ?? 0,
    retainBodies: () => this.options.retainProviderBodies !== false,
    drain: () => this.options.transportDrain?.() ?? Promise.resolve(),
    // One authority for every session in this process (RP-7): what all of
    // their captures may hold at once, not what each of them may.
    reserve: (bytes) => this.captureReservations.reserve(bytes),
  };

  /** What provider captures may hold in this worker while they are sent. */
  private readonly captureReservations = new CaptureReservations();

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

  // ------------------------------------------------------- session lifetime

  /** What each session is holding, and whether that list is the whole truth. */
  sessionSafety(): { sessions: SessionSafety[]; complete: boolean } {
    return this.lifetime.safety();
  }

  private activationState(updateId: string): WorkerActivationState {
    const gate = this.activationGate;
    if (!gate || gate.updateId !== updateId) {
      throw new ProtocolError(ErrorCodes.InvalidParams, "That update does not own this worker's preparation gate.");
    }
    const safety = this.sessionSafety();
    const blockers = { conversations: 0, agents: 0, questions: 0, approvals: 0, commands: 0 };
    for (const session of safety.sessions) {
      for (const pin of session.pins) {
        if (pin.kind === "agent_run" || pin.kind === "child_run") blockers.agents += 1;
        else if (pin.kind === "question") blockers.questions += 1;
        else if (pin.kind === "approval") blockers.approvals += 1;
        else if (pin.kind === "task") blockers.commands += 1;
        else if (pin.kind !== "no_record") blockers.conversations += 1;
      }
    }
    return {
      ...gate,
      complete: safety.complete,
      parked: safety.complete && Object.values(blockers).every((count) => count === 0),
      blockers,
    };
  }

  /**
   * Everything a release of this session would destroy, read from state
   * already held.
   *
   * `releasing` is set by the release itself when it re-checks inside the
   * first-turn fence: the lease it is holding and the fence entry it just made
   * are its own, and a release that counted them would refuse itself for ever.
   * Every other pin is evaluated exactly as it is from outside.
   */
  private safetySnapshot(live: Live, releasing = false): SessionSafetySnapshot {
    let streaming = false;
    let compacting = false;
    let hasRecord = false;
    try {
      const state = live.preAcceptance?.state ?? live.driver.state();
      streaming = state.isStreaming;
      compacting = state.isCompacting;
      // The engine writes a durable file when it opens a session, so a state
      // with a path is a conversation `session/load` can bring back. A driver
      // without one (an ephemeral or alternate runtime) is pinned instead.
      hasRecord = Boolean(live.driver.sessionHeader?.()?.id ?? state.path);
    } catch {
      // No readable runtime: a replacement is in flight, which is a first-turn
      // pin of its own below. Nothing is assumed safe from a failed read.
    }
    const pendingUi = (live.driver as { pendingUi?: () => Array<{ toolCallId?: string }> }).pendingUi;
    const dialogs = typeof pendingUi === "function" ? pendingUi.call(live.driver) : [];
    const work = this.harness.retainedWork(live.path);
    let queued = work.queued;
    try {
      queued += (live.preAcceptance?.state ?? live.driver.state()).pendingMessageCount;
    } catch {
      // Same as above: an unreadable runtime contributes no false zero here,
      // because `first_turn` already pins it.
    }
    return {
      opening: this.runtimes.opening(live.path) !== undefined,
      inFlightRequests: this.runtimes.inFlightFor(live.path),
      streaming,
      compacting,
      firstTurn: (!releasing && this.firstTurnLock.busy(live.path)) || live.preAcceptance !== undefined,
      questions: dialogs.filter((request) => !request.toolCallId).length,
      approvals: dialogs.filter((request) => Boolean(request.toolCallId)).length,
      liveRuns: work.liveRuns,
      liveChildRuns: work.liveChildRuns,
      queuedWork: queued,
      trayMessages: live.pending?.list().length ?? 0,
      runningTasks: this.tasks.tasksOf(live.path).filter((task) => task.status === "running").length,
      // Naming this session is under way: a bounded Namer completion is in
      // flight and it ends in a rename through this runtime, which nothing
      // else can do. A first prompt merely *parked* for want of a model is
      // not a pin — nothing can perform that intent, so a refusal for it
      // would have no end and would hold this runtime, and the whole
      // worker's automatic retirement, for the life of the process. The words
      // stay in `unnamed` regardless, so a model that appears later still
      // names the session; that is the moment this becomes a pin.
      naming: this.naming(live.path),
      runningTools: this.runningTools.get(live.path)?.size ?? 0,
      hasRecord,
      ...(live.closeFailed ? { closeFailed: true } : {}),
    };
  }

  /** Replay counters for this worker, for tests and the retained-store report. */
  replayStats(): { sessions: number; updates: number; bytes: number; limitBytes: number; evictions: number; floorAdvances: number } {
    let updates = 0;
    for (const live of this.runtimes.values()) updates += live.buffer.size;
    return {
      sessions: this.runtimes.size,
      updates,
      bytes: this.replayBudget.bytes,
      limitBytes: this.replayBudget.limitBytes,
      evictions: this.replayBudget.evictions,
      floorAdvances: this.replayBudget.floorAdvances,
    };
  }

  /**
   * Per-session tables this worker keeps beside a runtime (RP-3/RP-4): the
   * person's tray, tool labels in flight, first prompts waiting to be named and
   * the one naming attempt a session may have running.
   * Counts of records, never a claim about bytes of memory.
   */
  /**
   * What this worker is holding, for the host's diagnostics (RP-3) and for its
   * own pressure reports (RP-8).
   *
   * One expression, read by both, so the two can never say different things
   * about the same moment. Nothing is collected and no session is touched to
   * answer it.
   */
  private retainedStores(): MemoryPressureStores {
    const replay = this.replayStats();
    return {
      ...this.tasks.retainedStores(),
      // RP-4's own rows: the runtimes this worker holds, the replay it is
      // keeping for them against its own ceiling, and the per-session tables
      // beside them. Counts of state, never a share of memory.
      workerSessions: { count: this.runtimes.size },
      workerReplay: { count: replay.updates, bytes: replay.bytes },
      workerCaches: { count: this.cacheRecords() },
      // What this worker's link to the app is holding right now (RP-7): bytes
      // accepted and not yet written, plus a partial frame being read. Numbers
      // only; never a payload and never a path. A frame count is the host's to
      // report: what is here is a byte backlog, and saying "one frame" for it
      // would be a different number's name.
      providerQueues: {
        count: (this.options.transportFrames?.() ?? 0) + this.captureReservations.held().open,
        bytes: (this.options.transportPending?.() ?? 0) + this.captureReservations.held().bytes,
      },
    };
  }

  /**
   * Step 1 of the pressure pass: memos this process can rebuild (RP-8).
   *
   * The body memo holds one body and is re-read from the file on the next
   * slice. A session's `git status` answer is a 1.5-second memo over a command
   * that can simply be run again — and only for a session holding nothing: the
   * one safety authority decides that, and a session whose safety cannot be
   * read keeps its memo rather than losing it on a guess. Baselines, the agent
   * definitions the host pushed, canonical history and durable logs are not
   * caches and are never touched here.
   */
  private releaseEphemeralCaches(): PressureActionOutcome {
    let count = this.bodyRanges.forget() ? 1 : 0;
    let held = false;
    let safetyIncomplete = false;
    const free: string[] = [];
    for (const live of this.runtimes.values()) {
      try {
        if (sessionPins(this.safetySnapshot(live)).length === 0) free.push(live.path);
        else held = true;
      } catch {
        // An unreadable safety answer is not permission: this session keeps
        // everything it has.
        safetyIncomplete = true;
      }
    }
    if (this.gitService && free.length > 0) count += this.gitService.releaseStatusCache(free);
    if (count > 0) return { released: { count } };
    if (safetyIncomplete) return { safetyIncomplete: true };
    if (held) return { held: true };
    return {};
  }

  /**
   * Step 3: replay suffixes (RP-8/RP-4).
   *
   * Half the worker's allowance at `warning`, a quarter at `critical`, taken
   * from the least recently active conversation first. Each drop advances that
   * session's floor, which `session/load` already turns into a resync, so a
   * client re-reads rather than missing anything. No entry, question or
   * terminal update lives only in a replay suffix.
   */
  private releaseReplaySuffixes(level: "warning" | "critical"): PressureActionOutcome {
    const target = Math.floor(this.replayBudget.limitBytes / (level === "critical" ? 4 : 2));
    const trimmed = this.replayBudget.trimTo(target, { maxDrops: PRESSURE_MAX_REPLAY_DROPS });
    if (trimmed.dropped > 0) {
      return {
        released: { count: trimmed.dropped, bytes: trimmed.bytes },
        ...(trimmed.boundReached ? { boundReached: true } : {}),
      };
    }
    return trimmed.boundReached ? { boundReached: true } : {};
  }

  /**
   * Step 4: finished commands' records (RP-8/RP-6).
   *
   * A level, delivered to each session's own companion, which decides what its
   * *terminal* records keep. Nothing here pauses a command, shortens a live
   * tail or deletes a durable log.
   *
   * What it released is read, not assumed: the companion publishes what it is
   * holding on the way out of the same call, so this compares the session's
   * retention on either side and reports the difference. A session that was
   * asked and changed nothing had nothing to give; one whose answer could not
   * be compared is unavailable, which is a different sentence. Bounded to the
   * sessions least recently used; the rest wait for the next pass.
   */
  private releaseTaskRecords(level: "warning" | "critical"): PressureActionOutcome {
    // Least recently used first, where "used" is the later of somebody asking
    // for this conversation and the conversation itself producing something:
    // a session read a minute ago is not the one to ask, even if it has
    // streamed nothing since yesterday.
    const usedAt = (live: Live): number => Math.max(live.touchedAtMs, live.buffer.lastActivity);
    const candidates = [...this.runtimes.values()].sort((a, b) => usedAt(a) - usedAt(b));
    const told = candidates.slice(0, PRESSURE_MAX_TASK_SESSIONS);
    let count = 0;
    let bytes = 0;
    let unobservable = false;
    for (const live of told) {
      // What this session said it was holding, on either side of the ask. The
      // companion publishes synchronously, so the second read is the answer to
      // the first — and when there is no pair to compare, this step says it
      // could not see rather than guessing.
      const before = this.tasks.retentionOf(live.path);
      const handled = live.driver.deliverExtensionCommand?.({ type: "lasercode/task/pressure", level }) === true;
      if (!handled) continue;
      const after = this.tasks.retentionOf(live.path);
      if (!before || !after) {
        unobservable = true;
        continue;
      }
      // Only what pressure itself releases: records that are gone and the
      // excerpt bytes they held. Live tails and durable logs are somebody
      // else's work and are never counted here.
      count += Math.max(0, before.terminal - after.terminal);
      bytes += Math.max(0, before.excerptBytes - after.excerptBytes);
    }
    // Work left over outranks what was done with the rest: the host should see
    // that this worker did not finish, not that it had nothing to do.
    if (candidates.length > told.length) return { boundReached: true };
    if (count > 0 || bytes > 0) return { released: { count, bytes } };
    // An accepted ask whose result could not be read is unavailable; one that
    // was read and changed nothing is a session with nothing to give, and so
    // is a session whose companion does not answer at all.
    if (unobservable) return { unobservable: true };
    return {};
  }

  private cacheRecords(): number {
    let records = this.unnamed.size + this.namingInFlight.size;
    for (const live of this.runtimes.values()) records += live.pending?.list().length ?? 0;
    for (const ids of this.runningTools.values()) records += ids.size;
    return records;
  }

  // ------------------------------------------------------------- sessions

  private live(path: string): Live {
    const live = this.runtimes.get(path);
    if (!live) throw new ProtocolError(ErrorCodes.SessionNotFound, `session ${path} is not open in this worker`);
    // Every path-routed request comes through here, so this is where "somebody
    // is using this conversation" is known (RP-8).
    live.touchedAtMs = Date.now();
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

  /**
   * A model or thinking change on a conversation that has already started
   * applies at once: the engine takes it for the next turn (a steer in the
   * queue, not a stop). Only a pristine session waits its turn behind the
   * first-turn fence, because there the choice can replace the runtime. The
   * admission lease is otherwise held by a queued steer for as long as the
   * running turn lasts, and a settings change waiting on it left every
   * composer disabled until that turn ended.
   */
  private settingsLane<T>(live: Live, work: () => Promise<T>): Promise<T> {
    let started = false;
    try {
      const state = live.driver.state();
      started = state.messageCount > 0 || state.pendingMessageCount > 0 || state.isStreaming;
    } catch {
      // No runtime to read: a replacement is in flight, so wait for it.
    }
    return started ? work() : this.firstTurnLock.run(live.path, work);
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
    for (const live of this.runtimes.values()) {
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
        let update = event.update.kind === "state" ? { kind: "state" as const, state: this.decorate(live, event.update.state) } : event.update;
        // A body a client cannot hold is shown as an excerpt and read back by
        // reference, and a reference is only trustworthy at a named revision.
        // The engine has just written this entry, so the revision of the state
        // it belongs to is the one computed from the entries as they are in
        // this very tick — no await, so nothing is reordered (RP-5b).
        if (update.kind === "message_end" && update.entry && update.entry.revision === undefined && update.entry.bodies) {
          const snapshot = live.driver.entriesNow?.();
          if (snapshot) {
            try {
              const { revision } = live.revisions.compute(this.revisionHeader(live), snapshot.entries, snapshot.leafId);
              update = { ...update, entry: { ...update.entry, revision } };
            } catch { /* an identity without a revision is still refused safely by the client */ }
          }
        }
        const params: SessionUpdateParams = {
          sessionPath: live.path,
          epoch: live.historyEpoch,
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
        // A pid the module knows the meaning of goes to the host's process
        // inventory (RP-1) and nowhere else: it is a number about this
        // machine, not conversation state, so it never joins the extension
        // message stream a client can hear.
        if (event.message.type === "lasercode/process/registration") {
          const { pid, taskId } = event.message;
          this.notify("pi/resource/process", {
            path: live.path,
            registrations: [{ pid, role: "background_command", sessionPath: live.path, taskId }],
          });
          return;
        }
        // A background command going past is indexed here, so the harness
        // can show it in an agent's fleet (D-163); the host indexes it too.
        if (this.tasks.observe(live.path, event.message)) this.applyLogBudgets();
        // What a session's commands are holding is this worker's business and
        // the host's diagnostics; it is not transcript state.
        if (event.message.type === "lasercode/task/retention") return;
        this.notify("pi/extension/message", { path: live.path, message: event.message });
        return;
      case "closed":
        live.unsubscribe();
        this.runtimes.drop(live.path);
        // The suffix this session was entitled to returns to the worker's
        // allowance (RP-4); a released session keeps no replay.
        live.buffer.dispose();
        this.mcpService?.sessionClosed(live.path);
        this.tasks.sessionClosed(live.path);
        // One holder fewer: the rest of this worker's sessions may keep more.
        this.applyLogBudgets();
        this.gitService?.forget(live.path);
        // RP-5b: the range reader holds at most one body, and that body belongs
        // to a session that is open. A closed session leaves none behind, so
        // nothing can serve its bytes afterwards and nothing keeps its memory.
        this.bodyRanges.forget();
        this.runningTools.delete(live.path);
        this.unnamed.delete(live.path);
        // The runtime a naming attempt would have renamed is gone, so the
        // attempt can no longer finish its work: its entry goes with the
        // session rather than being left to pin whatever opens this path next.
        // Its own `finally` then finds the entry no longer its own and removes
        // nothing.
        this.namingInFlight.delete(live.path);
        this.namer.forget(live.path);
        return;
    }
  }

  /**
   * Keep this worker's command logs inside their budget (RP-6).
   *
   * The worker sees every session; the sessions own their files. So it divides
   * the budget and tells each session that is over its share how much it may
   * keep, and that session releases its own oldest bytes. Nothing here deletes
   * a file, nothing touches bytes another runtime wrote, and no command is
   * paused, throttled or ended: only bytes already written are released, and
   * the exact byte count and digest of every command survive it.
   */
  private applyLogBudgets(): void {
    for (const { path, bytes } of this.tasks.logBudgets()) {
      this.runtimes.get(path)?.driver.deliverExtensionCommand?.({ type: "lasercode/task/log-budget", bytes });
    }
  }

  /**
   * A fork moved a session's file: everything this worker holds under the old
   * path follows it, here, in one place.
   *
   * This list is the list the `closed` case above drops, in the same order,
   * and that is the point: a per-session structure added to one and not the
   * other is a session that half exists. What was missing cost the fleet a
   * child's background commands (left "running" for ever under a path nobody
   * serves), its git baseline, its MCP snapshot, the first prompt still
   * waiting to be named, and the run itself — `stopRun` then cancelled a
   * child that was still working, because it could not find its session.
   *
   * `sessions`, `live.pending` and `live.buffer` move with the `Live` record
   * itself; `firstTurnLock` is held on the old path for exactly this call and
   * released by it.
   */
  private rekeySessionState(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    this.harness.rekeySession(oldPath, newPath);
    this.tasks.rekeySession(oldPath, newPath);
    this.mcpService?.rekeySession(oldPath, newPath);
    this.gitService?.rekey(oldPath, newPath);
    this.namer.rekey(oldPath, newPath);
    const tools = this.runningTools.get(oldPath);
    if (tools) {
      this.runningTools.delete(oldPath);
      this.runningTools.set(newPath, tools);
    }
    const waiting = this.unnamed.get(oldPath);
    if (waiting !== undefined) {
      this.unnamed.delete(oldPath);
      this.unnamed.set(newPath, waiting);
    }
    // A naming completion already in flight is naming *this* conversation,
    // which now lives at the new path: the entry moves with it, token and all,
    // so the fork's runtime is the one held until the rename it is about to
    // attempt lands, and the attempt still recognises its own entry.
    const naming = this.namingInFlight.get(oldPath);
    if (naming !== undefined) {
      this.namingInFlight.delete(oldPath);
      this.namingInFlight.set(newPath, naming);
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
    if (!label || !this.runtimes.has(live.path)) return;
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
    return parseWorkerProjectEnvConfig(parsed);
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

/**
 * A worker that was constructed without the host's environment identity. The
 * host always supplies one (`--environment-id`), so this only ever binds the
 * revisions of a hand-run or test worker, keeping them self-consistent instead
 * of absent.
 */
const UNCONFIGURED_ENVIRONMENT = "unconfigured-environment";

/**
 * A read that cannot be answered with a revision is refused as unavailable,
 * with words a person can act on — never answered with a window that silently
 * has no revision for a cache to check.
 */
function revisionUnavailable(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) return error;
  const why = error instanceof RevisionCanonicalisationError ? ` (${error.message})` : "";
  return new ProtocolError(
    ErrorCodes.RevisionUnavailable,
    `This conversation could not be read as it is stored right now${why}. Open it again, and restart the app if it keeps happening.`,
  );
}
