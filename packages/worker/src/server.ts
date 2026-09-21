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

import { AGENT_MAX_DEPTH_LIMIT, EDITABLE_TEXT_MAX_BYTES, ENV, ErrorCodes, isVerificationFleetTaskId, createBodyRangeReader, entryRegionsPage, utf8ByteLength, PRODUCT_NAME, ProtocolError, SESSION_SAFETY_MAX, isSessionWorkPin, boundedHistoryWindow, isLiveEdgeWindow, methodStartsWork, parseClientRequest, projectEnvFingerprint, projectEnvWorkerConfig, WIRE_NAMESPACE, AGENT_ISOLATION_DEFAULT, type AgentDefinition, type AgentRun, type SessionPin, type SessionSafety, type WorkerRetireMode, type WorkerRetireRefusal, type ModelIdentity, type ModelProfile, type ModelProfileInput, type ProfileAssignments, type SettingChange, validateModelProfiles, MODEL_PROFILES_SETTING, DEFAULT_PROFILE_SETTING, type ClientRequests, type CommandInfo, type ContentBlock, type FeatureId, type HostNotifications, type JsonRpcMessage, type JsonRpcResponse, type PiExtensionModuleName, type SessionAgentRecord, type SessionState, type MemoryPressureStores, type SessionUpdateParams, type ProjectEnvStatus, type ProjectEnvWorkerConfig, type ProviderCaptureLink, type SettingsScope, type TelemetryContext, type TelemetrySection, type TypedClientRequest, type WorkerActivationState, type AgentIsolationDefault } from "@lasercode/protocol";
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
import { RevisionCanonicalisationError, type ProjectWorkMentionProjection, type SessionRevisionHeader } from "@lasercode/protocol";
import { SessionRevisionTracker } from "./history-revision.js";
import { ChildTelemetryCache, computeLiveTelemetry, liveOverlay, telemetryUpdateKind } from "./telemetry.js";
import { TelemetryFold } from "@lasercode/protocol";
import { ReplayBudget, ReplayBuffer } from "./replay-buffer.js";
import { sessionPins, type SessionSafetySnapshot } from "./session-safety.js";
import { SessionRuntimes } from "./session-runtimes.js";
import { WorkerLifetime } from "./worker-lifetime.js";
import { assertFirstTurnAdmission, FirstTurnLock } from "./first-turn.js";
import { PendingTray } from "./pending.js";
import { GitService } from "./git.js";
import { SourceControlService } from "./source-control/index.js";
import { excerptFromEntries, GitActionError, GitActionsService, type GitActionsFetcher, type GitProseRuntime, type ProcessRunner } from "./git-actions/index.js";
import { KeybindingsAdapter } from "./keybindings.js";
import { ModelsAdapter, PackagesAdapter } from "./packages.js";
import { SettingsAdapter, readEffectiveProductSettings, readProfileSettings, researchSourcesFrom, resolveProfile } from "./settings.js";
import { ProjectHostGrounding } from "./design/host/ground.js";
import { ProjectDesignIndex } from "./design/index/bridge.js";
import type { DesignIndexBridge } from "./design/index/tools.js";
import { designModelAccess, type DesignModelAccess } from "./design/profile.js";
import { DesignWorkspace, isDesignCommandTaskId } from "./design/workspace.js";
import { ProjectResearch } from "./research/bridge.js";
import { enabledResearchAdapters, type ResearchAdapterId } from "@lasercode/protocol";
import type { ResearchBridge } from "./research/tools.js";
import { createProcessRunner } from "./git-actions/index.js";
import {
  HostProjectWorkBridge,
  ProjectWorkSession,
  VerificationService,
  type ProjectWorkBridge,
  type ProjectWorkExecutionShape,
} from "./project-work/index.js";
import { SessionMentionContext } from "./project-work/mentions.js";
import { bridgeResearchStore } from "./project-work/research-store.js";
import { projectInstructions } from "./project-work/instructions.js";
import { migrateModelProfiles } from "./profiles/migrate.js";
import { WebSearchService } from "./web-search.js";
import { McpService } from "./mcp/service.js";
import { TranscribeService } from "./transcribe.js";
import { parseWorkerProjectEnvConfig, ProjectEnvironment } from "./project-env.js";
import type { HarnessSessionRole } from "./agents/bridge.js";
import type { ProjectEnvironmentBridge } from "@lasercode/pi-extension";
import { DefinitionsCache } from "./agents/definitions.js";
import { defaultAgentInstructions } from "./agents/engine-instructions.js";
import { AgentHarness, modelUnavailableMessage, type SessionHandle, type SessionHost } from "./agents/harness.js";
import { canNameSessions, nameSession, type CompletionRuntime } from "./agents/session-naming.js";
import { chatRecord, chatRole, readSessionAgentRecord, rootRecord, rootRole, removedWorktreeCwd } from "./agents/session-config.js";
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
   * True when this worker's host answers the project-work bridge (M21-T17).
   * Without it the whole project-work tool surface is absent: a worker with
   * nobody to ask registers no tool that would have to ask.
   */
  projectWork?: boolean;
  /** Per-project isolation default for `start_agent`. */
  agentIsolation?: AgentIsolationDefault;
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
  /** Test seam: the model runtime a naming request completes through. Defaults to the engine's. */
  namingModels?: () => Promise<CompletionRuntime>;
  /** Test seam: the model runtime design work completes through. Defaults to the engine's. */
  designModels?: () => Promise<CompletionRuntime>;
  /** Test seam for git actions (L6). */
  gitActions?: {
    run?: ProcessRunner;
    fetch?: GitActionsFetcher;
    env?: NodeJS.ProcessEnv;
    viewedFile?: string;
    proseRuntime?: () => Promise<GitProseRuntime>;
  };
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

/**
 * How long a session open waits for the host to say which project it is in
 * (M21-T17). One local request over a pipe; past this the session opens with
 * the read-only project-work surface rather than waiting on the app.
 */
const PROJECT_WORK_RESOLVE_MS = 2_000;

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
  /**
   * What this conversation's messages mentioned (M21-T9), for as long as the
   * engine is still holding those messages. Ephemeral, per session, and given
   * to every session rather than only to one with project work: a projectless
   * chat may mention another project's work and must be able to read it.
   */
  mentions: SessionMentionContext;
  /** Incremental whole-session telemetry fold (L3). */
  telemetry: TelemetryFold;
  /** True after this session has been asked for `pi/session/telemetry`. */
  telemetryWanted?: boolean;
  /** Last live-request composition observed from provider-log. */
  contextComposition?: TelemetryContext["composition"];
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

function compositionOfCapture(message: { type: string; summary?: { composition?: TelemetryContext["composition"] } }): TelemetryContext["composition"] | undefined {
  if (message.type !== "lasercode/provider/request" && message.type !== "lasercode/provider/request/begin" && message.type !== "lasercode/provider/request/omitted") {
    return undefined;
  }
  const composition = message.summary?.composition;
  if (!composition) return undefined;
  if ([composition.tools, composition.chat, composition.thinking, composition.system].some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    return undefined;
  }
  return composition;
}

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
  /** Incremental child-session telemetry folds, keyed by child path. */
  private readonly childTelemetry = new ChildTelemetryCache();
  private packagesAdapter: PackagesAdapter | undefined;
  private modelsAdapter: ModelsAdapter | undefined;
  /** M2-T6 git line. Built on first use like the adapters above. */
  private gitService: GitService | undefined;
  private sourceControlService: SourceControlService | undefined;
  private gitActionsService: GitActionsService | undefined;
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
  /** M13 · agents: the host's definitions and the harness that runs them. */
  private readonly definitions: DefinitionsCache;
  private readonly harness: AgentHarness;
  /** RP-5b: one body at a time, so slicing a large one stays linear. */
  private readonly bodyRanges = createBodyRangeReader();
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
   * Naming actually under way: **one** attempt per session, by path, holding
   * that attempt's token (RP-4).
   *
   * This is the state safety reads: a session is pinned while a naming
   * completion for it is in flight, because that completion ends in a rename
   * **through this runtime** and nothing else can finish it. The entry is made
   * before the await and removed in a `finally`, so it is bounded by the
   * request's own 8 s ceiling — no timer, lease or queue of ours.
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
  /** Held only through prompt preflight; prevents runtime replacement races. */
  private readonly firstTurnLock = new FirstTurnLock();
  /** This worker's own memory-pressure controller (RP-8). One per process. */
  private readonly pressure: WorkerPressureController;
  /** Exact update fence; absent until this worker acknowledges park. */
  private activationGate: { updateId: string; generationId: string } | undefined;
  /** Requests this worker has asked the host and not yet had answered (M21-T17). */
  private readonly hostPending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private hostRequestSeq = 0;
  /** The verification runs this worker holds, once one has been started. */
  private verificationRuns: VerificationService | undefined;
  /** This project's design index (M21-T10), built once and read on demand. */
  private projectHostGrounding: ProjectHostGrounding | undefined;
  private projectDesignIndex: ProjectDesignIndex | undefined;
  /** The design workspace's six methods over those two engines (M21-T13). */
  private projectDesignWorkspace: DesignWorkspace | undefined;
  /** This worker's research run, with the adapters the person left on. */
  private researchSession: { bridge: ResearchBridge; adapters: ResearchAdapterId[] } | undefined;

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
      detachedWork: () => this.detachedWork(),
    });
    // Configured by the host, machine-local and non-secret: the executable, its
    // arguments, and whether a person approved exactly that pair.
    const projectEnvConfig = readProjectEnvConfig();
    this.projectEnv = projectEnvConfig
      ? new ProjectEnvironment({ cwd: options.cwd, config: projectEnvConfig })
      : undefined;
    this.definitions = new DefinitionsCache(options.cwd);
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
      resolveProfile: (profileId) => this.resolveAgentProfile(profileId),
      tasks: (path) => this.tasks.tasksOf(path),
      taskLogRoot: () => this.taskLogRoot(),
    };
    this.harness = new AgentHarness({
      host,
      definitions: this.definitions,
      worktrees: new WorktreeManager(),
      isolationDefault: options.agentIsolation ?? AGENT_ISOLATION_DEFAULT,
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

  /**
   * Ask the host something (M21-T17, D-356.b).
   *
   * The fd-3 link used to go one way for requests: the host asked, the worker
   * answered. A model tool that reads or writes project work needs the other
   * direction, because the authority is the host's and nothing above the
   * worker may be bypassed. Ids are strings (`w1`, `w2`, …) so a worker's own
   * request can never be confused with a host request id, which is a number.
   *
   * A pending call is rejected if the host answers with an error, and simply
   * never settles if the link dies — the process goes with it.
   */
  hostRequest<R = unknown>(method: string, params: unknown): Promise<R> {
    const id = `w${String(++this.hostRequestSeq)}`;
    return new Promise<R>((resolve_, reject) => {
      this.hostPending.set(id, { resolve: resolve_ as (value: unknown) => void, reject });
      this.options.send({ jsonrpc: "2.0", id, method, params } as unknown as JsonRpcMessage);
    });
  }

  /**
   * One inbound response to a {@link hostRequest}. Returns false when the id
   * is not one of ours, so the transport can fall through to the request path.
   */
  hostResponse(raw: unknown): boolean {
    const message = raw as { id?: unknown; result?: unknown; error?: { code?: number; message?: string } };
    if (typeof message.id !== "string") return false;
    const entry = this.hostPending.get(message.id);
    if (!entry) return false;
    this.hostPending.delete(message.id);
    if (message.error) entry.reject(new ProtocolError(message.error.code ?? ErrorCodes.Internal, message.error.message ?? "the app refused that"));
    else entry.resolve(message.result);
    return true;
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
    // Every runtime this worker could have renamed is gone, so no attempt can
    // still be holding one. A completion that lands after this finds its
    // record already removed and its `finally` is a no-op.
    this.namingInFlight.clear();
  }

  // ------------------------------------------------------------- dispatch

  private async dispatch(req: TypedClientRequest): Promise<unknown> {
    if (methodStartsWork(req.method)) this.admitNewWork();
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
        // A person's mention means the same whichever key they pressed, so the
        // host's projection reaches the model on this verb too — refused here,
        // before the engine is told anything, when too many already wait.
        const projectWork = req.params.projectWork;
        live.mentions.refuseIfFull(projectWork);
        const options = projectWork?.length ? { projectWork } : undefined;
        if (this.harness.roleOf(live.path)?.kind === "child") await this.queueIntoChild(live, content, "steer", options);
        else await this.firstTurnLock.run(live.path, () => live.driver.steer(content, options));
        return {} satisfies Result<"pi/session/steer">;
      }
      case "pi/session/follow_up": {
        const live = this.live(req.params.path);
        const content = await this.withDictation(req.params.path, req.params.content);
        const projectWork = req.params.projectWork;
        live.mentions.refuseIfFull(projectWork);
        const options = projectWork?.length ? { projectWork } : undefined;
        if (this.harness.roleOf(live.path)?.kind === "child") await this.queueIntoChild(live, content, "followUp", options);
        else await this.firstTurnLock.run(live.path, () => live.driver.followUp(content, options));
        return {} satisfies Result<"pi/session/follow_up">;
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
          // Work this conversation owns is still running. Closing here means
          // the file is about to move, and a command runs against the
          // checkout and publishes rows under this exact path: disposing now
          // would either lose its ending or re-create the row under a path
          // nobody serves. The same running-command count `unload` and
          // `pi/worker/safety` already pin on, read under the same lock that
          // serializes the move, plus verification runs that are winding up
          // and have not published their ending yet.
          const running = this.tasks.tasksOf(live.path).filter((task) => task.status === "running").length;
          if (running > 0 || this.verificationRuns?.hasUnsettled(live.path) === true) {
            throw new ProtocolError(
              ErrorCodes.SessionBusy,
              "This chat still has work running in it. Stop it and wait for it to finish, then move it.",
            );
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
        // The row keeps what the host read for it; it is handed to the engine
        // with this row's own message when the tray delivers it, and it is
        // never part of the row a client sees.
        return {
          message: this.tray(req.params.path).add(
            await this.withDictation(req.params.path, req.params.content),
            req.params.projectWork,
          ),
        } satisfies Result<"session/pending/add">;
      case "session/pending/edit":
        return {
          message: this.tray(req.params.path).edit(req.params.id, req.params.content, req.params.projectWork),
        } satisfies Result<"session/pending/edit">;
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
            const snapshot = baseline ?? await live.driver.entries({ live: !("before" in req.params.window) && !("beforeEntry" in req.params.window) });
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
              ...("before" in req.params.window || "beforeEntry" in req.params.window ? {} : { live: active ?? { running: baseline?.state.isStreaming ?? live.driver.state().isStreaming, tools: [] } }),
            };
            const resolved = req.params.baseRevision === undefined
              ? undefined
              : live.revisions.resolve(req.params.baseRevision, this.revisionHeader(live), snapshot.entries, snapshot.leafId);
            // Older pages merge into rows the client already holds. Require the
            // existing revision service to prove those rows are still the
            // current state or a byte-identical prefix; cursor/entry identity
            // alone cannot detect a same-id rewrite or compaction barrier.
            if (("before" in req.params.window || "beforeEntry" in req.params.window)
              && !resolved?.state) {
              throw new ProtocolError(
                ErrorCodes.RevisionUnavailable,
                "This conversation changed since that page was read. Reload it and try again.",
              );
            }
            // Only a live-edge tail can be spliced onto a cached revision.
            // Older-page, search-anchor and all-history requests retain their
            // exact tree semantics even when the base is current or a prefix.
            // RP-5b: a caller that cannot hold a large body asks for the page
            // without it; the record is listed in `elided` instead of rewritten.
            // The digest travels even when no body limit was asked for, so a
            // record too large for any page is still elided rather than
            // refused: no page is unreachable because one record is too large
            // (M16-T88).
            const bodies = { ...(req.params.bodyLimit === undefined ? {} : { limit: req.params.bodyLimit }), digest: sha256Hex };
            // A newest-page read, counted in turns or in entries alike (M16-T90).
            if (isLiveEdgeWindow(req.params.window) && resolved?.base !== "stale" && resolved?.state) {
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
            // Only an indivisible request reaches here: `all` and `from` name
            // an exact projection, so they are refused rather than shortened
            // into an answer to a different question. A bounded page is always
            // served: oversized records travel as identity (M16-T88).
            throw new ProtocolError(
              ErrorCodes.RevisionUnavailable,
              "all" in req.params.window || "from" in req.params.window
                ? "That part of this conversation is too large to send at once. Open it and read it a page at a time."
                : "Part of this conversation is too large to show.",
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
      case "pi/session/telemetry": {
        const live = this.live(req.params.path);
        const snapshot = live.preAcceptance ?? await live.driver.entries();
        if (this.runtimes.get(live.path) !== live) throw new ProtocolError(ErrorCodes.SessionNotFound, "This conversation was closed. Open it again.");
        const { revision, environmentKey } = this.revisionOf(live, snapshot);
        if (req.params.environmentKey !== undefined && req.params.environmentKey !== environmentKey) {
          throw new ProtocolError(ErrorCodes.InvalidParams, "That conversation belongs to a different connection.");
        }
        if (req.params.revision !== undefined && req.params.revision !== revision) {
          throw new ProtocolError(
            ErrorCodes.RevisionUnavailable,
            "This conversation moved on since that reading. Open it again to see the rest.",
          );
        }
        try {
          live.telemetryWanted = true;
          return this.sessionTelemetry(live, snapshot, {
            revision,
            environmentKey,
            ...(req.params.include ? { include: req.params.include } : {}),
            ...(req.params.scope ? { scope: req.params.scope } : {}),
            ...(req.params.turnId ? { turnId: req.params.turnId } : {}),
          }) satisfies Result<"pi/session/telemetry">;
        } catch (error) {
          if (error instanceof Error && error.message === "turn") {
            throw new ProtocolError(ErrorCodes.InvalidParams, "A turn-scoped telemetry read names the turn.");
          }
          if (error instanceof Error && error.message === "turn-missing") {
            throw new ProtocolError(ErrorCodes.InvalidParams, "That turn is not part of this conversation any more.");
          }
          throw error;
        }
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
      // Choosing one model for a session pins it: it leaves its profile and
      // has nothing standing in for it (docs/model-profiles.md, D-346).
      // `session/model/pin` is the same act under its own name.
      case "pi/model/set": {
        const live = this.live(req.params.path);
        return this.settingsLane(live, async () => ({ state: await live.driver.setModel(req.params.model) } satisfies Result<"pi/model/set">));
      }
      case "session/model/pin": {
        const live = this.live(req.params.path);
        return this.settingsLane(live, async () => ({ state: await live.driver.setModel(req.params.model) } satisfies Result<"session/model/pin">));
      }
      case "session/profile/set": {
        const live = this.live(req.params.path);
        const profileId = req.params.profileId;
        return this.settingsLane(live, async () => ({
          state: await live.driver.setProfile(profileId),
        } satisfies Result<"session/profile/set">));
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
        // A verification run is a Command with no companion process behind it
        // (M21-T19): it is this worker's own loop, so Stop from the fleet row
        // is answered here rather than delivered to the extension. The id is
        // namespaced, so it can never be mistaken for a shell command's.
        if (isVerificationFleetTaskId(req.params.id)) {
          return { delivered: this.verification().stopByTaskId(req.params.id) } satisfies Result<"pi/task/stop">;
        }
        // An index build is a Command with no process (D-353): it is this
        // worker's own loop, so Stop from the fleet row is answered here
        // rather than delivered to the companion extension.
        if (isDesignCommandTaskId(req.params.id)) {
          return { delivered: this.designWorkspace().stopByTaskId(req.params.id) } satisfies Result<"pi/task/stop">;
        }
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
      case "pi/project/changes": {
        this.assertCwd(req.params.cwd);
        return (await this.sourceControl().changes(req.params)) satisfies Result<"pi/project/changes">;
      }
      case "pi/project/file_diff": {
        this.assertCwd(req.params.cwd);
        return (await this.sourceControl().fileDiff(req.params)) satisfies Result<"pi/project/file_diff">;
      }
      case "pi/project/file_source": {
        this.assertCwd(req.params.cwd);
        return (await this.sourceControl().fileSource(req.params)) satisfies Result<"pi/project/file_source">;
      }
      case "pi/project/file_blob": {
        this.assertCwd(req.params.cwd);
        return (await this.sourceControl().fileBlob(req.params)) satisfies Result<"pi/project/file_blob">;
      }
      case "pi/project/checkpoint/list": {
        this.assertCwd(req.params.cwd);
        return (await this.sourceControl().list(req.params.path, req.params.cwd)) satisfies Result<"pi/project/checkpoint/list">;
      }
      case "pi/project/restore": {
        this.assertCwd(req.params.cwd);
        return (await this.sourceControl().restore(req.params)) satisfies Result<"pi/project/restore">;
      }
      case "pi/project/workspace":
        throw new ProtocolError(ErrorCodes.Unsupported, `${req.method} is answered by the host, not a worker`);
      case "pi/project/isolation/set": {
        this.assertCwd(req.params.cwd);
        this.harness.setIsolationDefault(req.params.isolation);
        return { ok: true } satisfies Result<"pi/project/isolation/set">;
      }
      case "pi/project/git/hosts":
      case "pi/project/git/commit":
      case "pi/project/git/push":
      case "pi/project/git/branch":
      case "pi/project/git/prose":
      case "pi/project/pr/create":
      case "pi/project/pr/read":
      case "pi/project/pr/checkout":
      case "pi/project/pr/merge":
      case "pi/project/pr/viewed":
        return await this.dispatchGitAction(req);

      // ------------------------------------- M21-T19 verification runs ---
      // Run control only: a verification run executes the Task's own declared
      // commands, which needs the checkout this worker owns. Which criteria
      // exist and what each one came out as is the host's, over the bridge.
      case "pi/project/verify/start": {
        this.assertCwd(req.params.cwd);
        try {
          return { run: this.verification().start(req.params) } satisfies Result<"pi/project/verify/start">;
        } catch (error) {
          // A refusal is a sentence a person can act on — which conversation
          // to run it in, and how to get one — never a bare failure.
          throw new ProtocolError(
            ErrorCodes.InvalidParams,
            error instanceof Error ? error.message : "That task could not be verified from here.",
          );
        }
      }
      case "pi/project/verify/state": {
        this.assertCwd(req.params.cwd);
        return { runs: this.verification().state(req.params) } satisfies Result<"pi/project/verify/state">;
      }
      case "pi/project/verify/stop": {
        this.assertCwd(req.params.cwd);
        return this.verification().stop(req.params) satisfies Result<"pi/project/verify/stop">;
      }
      // --------------------------------- M21-T13 the design workspace ---
      // The index, its review, its builds and the grounding of a page are
      // files inside this project directory, and this process is the one that
      // owns it. The host resolved the project and forwarded; the `cwd` it
      // added has to be this worker's own.
      case "design/index/get":
      case "design/index/build":
      case "design/index/stop":
      case "design/index/review":
      case "design/host/ground":
      case "design/sketch/ground":
        return await this.dispatchDesignWorkspace(req);

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
      // Model profiles are product-owned settings: one list, one file, one
      // writer (docs/model-profiles.md, "Bounds and policy").
      case "models/profiles/list": {
        await this.settings().refresh();
        return this.profilesResult() satisfies Result<"models/profiles/list">;
      }
      case "models/profiles/save": {
        await this.saveModelProfile(req.params.profile);
        return this.profilesResult() satisfies Result<"models/profiles/save">;
      }
      case "models/profiles/delete": {
        await this.deleteModelProfile(req.params.id, req.params.replacementId);
        return this.profilesResult() satisfies Result<"models/profiles/delete">;
      }
      case "models/profiles/migrate": {
        this.assertCwd(req.params.cwd);
        const catalog = await this.modelCatalog().catalog(false, "global").catch(() => undefined);
        const providers = await this.modelCatalog().providers().catch(() => undefined);
        const report = await migrateModelProfiles(this.settings(), {
          at: new Date().toISOString(),
          // The host's own pre-M22 choices: each built-in's model and each
          // agent file's `model:`. Only this process writes the settings file,
          // so they are resolved to profiles here, in the same write.
          ...(req.params.legacyChoices ? { legacyChoices: req.params.legacyChoices } : {}),
          ...(catalog ? { models: catalog.models } : {}),
          ...(providers
            ? { configuredProviders: new Set(providers.providers.filter((provider) => provider.configured).map((provider) => provider.id)) }
            : {}),
          modelName: (model) => catalog?.models.find((entry) => entry.provider === model.provider && entry.id === model.id)?.name,
        });
        if (report.ran) await this.reloadLiveSettings("global");
        return { report } satisfies Result<"models/profiles/migrate">;
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
        return (await this.mcp().list(req.params.view)) satisfies Result<"mcp/list">;
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
        return (await this.mcp().importDetect(req.params.scope)) satisfies Result<"mcp/import/detect">;
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
        return (await this.modelCatalog().catalog(req.params.refresh ?? false, req.params.settingsView)) satisfies Result<"pi/models/catalog">;

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

  private sourceControl(): SourceControlService {
    this.sourceControlService ??= new SourceControlService({
      projectCwd: this.options.cwd,
      sessionWorkdir: (path) => this.runtimes.get(path)?.driver.state().cwd,
      sessionStreaming: (path) => this.runtimes.get(path)?.driver.state().isStreaming === true,
      agentRun: (runId) => this.harness.runs().find((run) => run.runId === runId),
      navigate: async (path, entryId) => {
        const live = this.live(path);
        return this.firstTurnLock.run(live.path, () => live.driver.navigateTree(entryId));
      },
    });
    return this.sourceControlService;
  }

  private gitActions(): GitActionsService {
    this.gitActionsService ??= new GitActionsService({
      projectCwd: this.options.cwd,
      ...(this.options.gitActions?.run ? { run: this.options.gitActions.run } : {}),
      ...(this.options.gitActions?.fetch ? { fetch: this.options.gitActions.fetch } : {}),
      envProvider: () => this.options.gitActions?.env ?? this.projectEnv?.apply({ ...process.env }) ?? process.env,
      viewedFile:
        this.options.gitActions?.viewedFile ??
        join(this.options.stateDir ?? join(this.options.agentDir ?? this.options.cwd, "..", "state"), "git-viewed.json"),
      proseRuntime: this.options.gitActions?.proseRuntime ?? (() => this.modelCatalog().modelRuntime()),
      agentRun: (runId) => this.harness.runs().find((run) => run.runId === runId),
      sessionContext: async (path) => {
        if (!this.runtimes.has(path)) {
          throw new GitActionError("Open the conversation first so the current model can write this.");
        }
        const live = this.live(path);
        const model = live.driver.state().model;
        const { entries } = await live.driver.entries({ tail: 30 });
        return {
          model: model ? { provider: model.provider, id: model.id } : null,
          excerpt: excerptFromEntries(entries),
        };
      },
    });
    return this.gitActionsService;
  }

  private async dispatchGitAction(
    req: Extract<
      TypedClientRequest,
      {
        method:
          | "pi/project/git/hosts"
          | "pi/project/git/commit"
          | "pi/project/git/push"
          | "pi/project/git/branch"
          | "pi/project/git/prose"
          | "pi/project/pr/create"
          | "pi/project/pr/read"
          | "pi/project/pr/checkout"
          | "pi/project/pr/merge"
          | "pi/project/pr/viewed";
      }
    >,
  ): Promise<Result<(typeof req)["method"]>> {
    this.assertCwd(req.params.cwd);
    const svc = this.gitActions();
    switch (req.method) {
      case "pi/project/git/hosts":
        return (await this.gitAction(() => svc.hosts(req.params))) satisfies Result<"pi/project/git/hosts">;
      case "pi/project/git/commit":
        return (await this.gitAction(() => svc.commit(req.params))) satisfies Result<"pi/project/git/commit">;
      case "pi/project/git/push":
        return (await this.gitAction(() => svc.push(req.params))) satisfies Result<"pi/project/git/push">;
      case "pi/project/git/branch":
        return (await this.gitAction(() => svc.branch(req.params))) satisfies Result<"pi/project/git/branch">;
      case "pi/project/git/prose":
        return (await this.gitAction(() => svc.prose(req.params))) satisfies Result<"pi/project/git/prose">;
      case "pi/project/pr/create":
        return (await this.gitAction(() => svc.createPr(req.params))) satisfies Result<"pi/project/pr/create">;
      case "pi/project/pr/read":
        return (await this.gitAction(() => svc.readPr(req.params))) satisfies Result<"pi/project/pr/read">;
      case "pi/project/pr/checkout":
        return (await this.gitAction(() => svc.checkoutPr(req.params))) satisfies Result<"pi/project/pr/checkout">;
      case "pi/project/pr/merge":
        return (await this.gitAction(() => svc.mergePr(req.params))) satisfies Result<"pi/project/pr/merge">;
      case "pi/project/pr/viewed":
        return (await this.gitAction(() => svc.viewed(req.params))) satisfies Result<"pi/project/pr/viewed">;
    }
  }

  private async gitAction<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof GitActionError) {
        if (error.outcome === "needs_copy") {
          return {
            outcome: "needs_copy",
            message: error.message,
            confirmation: { repo: this.options.cwd, branch: "", summary: error.message },
            ...(error.copyable ? { copyable: error.copyable } : {}),
          } as T;
        }
        throw new ProtocolError(ErrorCodes.InvalidParams, error.message);
      }
      throw error;
    }
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
    // A plain Chat runs no definition at all (`docs/plain-chat.md`): no
    // persona, no project instructions, and the three live fields as its whole
    // prompt. Everything else is a session of an agent.
    const chat = params.sessionKind === "chat";
    const agentName = chat ? undefined : params.agentName ?? this.definitions.defaultAgent().name;
    const definition = agentName === undefined ? undefined : this.definitions.definition(agentName);
    if (agentName !== undefined && !definition) {
      throw new ProtocolError(ErrorCodes.InvalidParams, `No agent is called "${agentName}".`);
    }
    // A definition naming a profile that is gone opens the session anyway, on
    // the profile assigned to new sessions; the substitution is a warning on
    // the definition, not a closed door (docs/model-profiles.md).
    const handle = this.harness.prepareSession({
      role: definition ? rootRole(definition.name) : chatRole(),
      ...(definition ? { definition } : {}),
      record: definition ? rootRecord(definition.name) : chatRecord(),
      projectCwd: this.options.cwd,
    });
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
      const handle = this.harness.prepareSession({ role, ...(definition ? { definition } : {}), record, projectCwd: this.options.cwd });
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

  private sessionTelemetry(
    live: Live,
    snapshot: { entries: unknown[]; leafId: string | null },
    options: { revision: string; environmentKey: string; include?: TelemetrySection[]; scope?: "session" | "turn"; turnId?: string },
  ) {
    const state = this.decorate(live, live.driver.state());
    return computeLiveTelemetry(live.telemetry, snapshot.entries, snapshot.leafId, {
      revision: options.revision,
      environmentKey: options.environmentKey,
    }, {
      ...(options.include ? { include: options.include } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.turnId ? { turnId: options.turnId } : {}),
      overlay: liveOverlay(state, {
        ...(live.contextComposition ? { composition: live.contextComposition } : {}),
        reserveTokens: this.compactionReserveTokens(),
      }),
      children: this.childTelemetry.sources(live.path, this.harness.runs(), (path) => this.runtimes.get(path)?.driver.entriesNow?.()?.entries),
    });
  }

  private compactionReserveTokens(): number {
    if (!this.settingsAdapter) return 16_384;
    const value = (this.settingsAdapter.snapshot().effective as { compaction?: { reserveTokens?: unknown } }).compaction?.reserveTokens;
    return typeof value === "number" && Number.isFinite(value) ? value : 16_384;
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

  /** `definition` is absent for a plain Chat, which runs none (`docs/plain-chat.md`). */
  private agentOptions(definition: AgentDefinition | undefined, handle: SessionHandle): DriverAgentOptions {
    return {
      ...(definition ? { definition } : {}),
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
   * Which agent a stored session runs as, or that it runs none at all. A
   * child's depth is not in its record, so it is counted up the parent chain
   * (bounded, and every hop is a file read, never an engine).
   *
   * A record whose kind is `chat` — including one written as `beam` before
   * M23 — recovers as the plain conversation of `docs/plain-chat.md`: no
   * definition, whatever name the old record still carries.
   */
  private async recoverAgent(path: string): Promise<{ definition: AgentDefinition | undefined; role: HarnessSessionRole; record: SessionAgentRecord }> {
    const record = (await readSessionAgentRecord(path)) ?? rootRecord(this.definitions.defaultAgent().name);
    if (record.kind === "chat") return { definition: undefined, role: chatRole(), record };
    const agentName = record.agentName ?? this.definitions.defaultAgent().name;
    const definition = this.definitions.definition(agentName) ?? this.definitions.defaultAgent();
    if (record.kind !== "child" || !record.parentPath) {
      return { definition, role: rootRole(agentName), record };
    }
    let depth = 1;
    let parent = await readSessionAgentRecord(record.parentPath);
    while (parent?.kind === "child" && parent.parentPath && depth < AGENT_MAX_DEPTH_LIMIT) {
      depth += 1;
      parent = await readSessionAgentRecord(parent.parentPath);
    }
    const role: HarnessSessionRole = {
      agentName,
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

  /** Every profile and every assignment, as the methods answer with them. */
  private profilesResult(): { profiles: ModelProfile[]; assignments: ProfileAssignments } {
    return readProfileSettings(this.settings().agentDir);
  }

  /**
   * Create or replace one profile.
   *
   * The whole list is validated before anything is written, with the same
   * function the Settings screen draws its messages from, so a refusal reads
   * the same in both places. The first profile a person ever saves also
   * becomes the one new conversations start on: a profile nothing uses is a
   * list nobody asked for.
   */
  private async saveModelProfile(input: ModelProfileInput): Promise<void> {
    const { profiles, assignments } = readProfileSettings(this.settings().agentDir);
    const at = new Date().toISOString();
    const saved: ModelProfile = { ...input, models: input.models.map((model) => ({ ...model })), updatedAt: at };
    const index = profiles.findIndex((profile) => profile.id === saved.id);
    const next = index >= 0 ? profiles.map((profile, i) => (i === index ? saved : profile)) : [...profiles, saved];
    const issue = validateModelProfiles(next)[0];
    if (issue) throw new ProtocolError(ErrorCodes.InvalidParams, issue.message);
    const changes: SettingChange[] = [{ path: MODEL_PROFILES_SETTING, op: "set", value: next }];
    if (!assignments.defaultProfileId) changes.push({ path: DEFAULT_PROFILE_SETTING, op: "set", value: saved.id });
    await this.settings().apply("global", changes);
    await this.reloadLiveSettings("global");
  }

  /**
   * Delete one profile, moving everything that pointed at it to a replacement.
   *
   * A profile something still uses cannot simply disappear: the caller names
   * what takes its place, and every assignment moves in the same write. There
   * is no path here that leaves an id pointing at nothing.
   */
  private async deleteModelProfile(id: string, replacementId: string | undefined): Promise<void> {
    const { profiles, assignments } = readProfileSettings(this.settings().agentDir);
    const target = profiles.find((profile) => profile.id === id);
    if (!target) throw new ProtocolError(ErrorCodes.InvalidParams, "That profile is already gone.");
    if (profiles.length === 1) {
      throw new ProtocolError(
        ErrorCodes.InvalidParams,
        `“${target.name}” is your only model profile. Add another one before deleting this one.`,
      );
    }
    const used = (Object.keys(assignments) as Array<keyof ProfileAssignments>).filter((key) => assignments[key] === id);
    const replacement = replacementId ? profiles.find((profile) => profile.id === replacementId) : undefined;
    if (replacementId && !replacement) {
      throw new ProtocolError(ErrorCodes.InvalidParams, "The profile chosen to take its place is no longer there.");
    }
    if (replacement && replacement.id === id) {
      throw new ProtocolError(ErrorCodes.InvalidParams, "Choose a different profile to take its place.");
    }
    if (used.length > 0 && !replacement) {
      throw new ProtocolError(
        ErrorCodes.InvalidParams,
        `“${target.name}” is still in use. Choose the profile that should take its place, then delete it.`,
      );
    }
    const next = profiles.filter((profile) => profile.id !== id);
    const changes: SettingChange[] = [{ path: MODEL_PROFILES_SETTING, op: "set", value: next }];
    for (const key of used) changes.push({ path: key, op: "set", value: replacement!.id });
    await this.settings().apply("global", changes);
    await this.reloadLiveSettings("global");
  }

  /** The profile assigned to session naming (`docs/model-profiles.md`). */
  private namingProfile(): ModelProfile | null {
    const { profiles, assignments } = readProfileSettings(this.settings().agentDir);
    // Only an explicit assignment turns naming on. Falling through to the
    // profile new sessions use would spend the person's best model on titles,
    // which is the opposite of what the naming assignment is for.
    const id = assignments.namingProfileId;
    return (id ? profiles.find((profile) => profile.id === id) : undefined) ?? null;
  }

  /**
   * The profile an agent definition runs on, and whether that is the one it
   * asked for. An id nothing answers to is substituted, never refused.
   */
  private resolveAgentProfile(profileId: string | null): { profileId: string | null; substituted?: { requested: string; used: string | null } } {
    const { profiles, assignments } = readProfileSettings(this.settings().agentDir);
    if (profileId && profiles.some((profile) => profile.id === profileId)) return { profileId };
    const used = resolveProfile(profiles, assignments)?.id ?? null;
    if (!profileId) return { profileId: used };
    return { profileId: used, substituted: { requested: profileId, used } };
  }

  private async modelAvailable(model: ModelIdentity): Promise<boolean> {
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
   * Name a conversation after its first prompt, unless the person got there
   * first.
   *
   * Never rejects, and that is load-bearing: every caller floats this promise
   * (naming must not delay the turn), and the reads after the await are not
   * safe — a driver whose runtime is being replaced throws
   * `DriverUnavailableError` out of `state()`. An unhandled rejection would
   * end the worker process, and with it every conversation in this project
   * (AGENTS.md invariant 5), because a session could not be given a title.
   *
   * A request that cannot start simply does not run (`docs/plain-chat.md`):
   * with no profile assigned to naming there is nothing to walk, nothing is
   * parked and the conversation keeps the name it has. When the request does
   * run it is bounded, answered through this runtime and registered in
   * {@link namingInFlight} for exactly as long as it takes — including the
   * rename, which is the part that needs the runtime. One attempt at a time
   * per session: a message that arrives while that one is running is not a
   * second naming request.
   */
  private async nameSession(live: Live, text: string): Promise<void> {
    try {
      const profile = this.namingProfile();
      if (!canNameSessions(profile)) return;
      // This conversation is already being named. Naming is for its first
      // prompt, so a second request would spend a second completion to answer
      // the same question, and nothing would show the result: naming never
      // renames over a name.
      const path = live.path;
      if (this.namingInFlight.has(path)) return;
      // Registered before the await, so there is no moment in which the work
      // is running without being visible. The token says which attempt this
      // entry belongs to, so a late completion cannot clear a successor's.
      const token = Symbol("naming");
      this.namingInFlight.set(path, token);
      try {
        const name = await nameSession(text, {
          models: this.options.namingModels ?? (() => this.modelCatalog().modelRuntime()),
          profile,
        });
        const current = this.namingPath(token) ?? path;
        // The whole profile was spent — no credential yet, every model
        // failing. The conversation keeps the name it has.
        if (!name) return;
        if (!this.runtimes.has(current) || live.driver.state().name) return;
        await live.driver.rename(name).catch(() => undefined);
      } finally {
        this.forgetNaming(token);
      }
    } catch (error) {
      console.error(`${PRODUCT_NAME} worker: could not name ${live.path}:`, error instanceof Error ? error.message : error);
    }
  }

  /** Whether a naming completion for this session is in flight right now. */
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
  /**
   * This session's project-work surface (M21-T17).
   *
   * One per session, because the tools it registers depend on what this
   * session is: which project it belongs to (the host's answer, not ours),
   * whether it has a design index, which research adapters the person left
   * on, and whether it was opened to work on a Task.
   */
  /**
   * This worker's verification runs (M21-T19).
   *
   * One registry for the whole worker, so a run a person started from the
   * Task detail and a run a model started with `verify_project_task` are the
   * same run: watchable and stoppable from either side. Each run reaches the
   * host authority over a bridge for its own checkout, with no session behind
   * it — a person verifying a Task is not a conversation.
   */
  private verification(): VerificationService {
    this.verificationRuns ??= new VerificationService({
      bridgeFor: (cwd, sessionPath) =>
        new HostProjectWorkBridge({
          link: (method, params) => this.hostRequest(method, params),
          identity: () => ({ label: "Verification" }),
          // The conversation that admitted this run, at the address it lives
          // at now: what the host records about a verification write names
          // the owner it was actually started by, never "whatever session is
          // current" and never nothing at all.
          execution: () => this.executionShape(cwd, undefined, sessionPath),
        }),
      // A run belongs to a conversation this worker is actually holding: a
      // path nobody here has open could not be watched or stopped, and a row
      // under it would be a row nobody can find.
      holdsSession: (path) => this.runtimes.get(path) !== undefined,
      // The row travels the road every Command row already travels: an
      // extension message the host's task register folds into its own. A
      // person stops it from the fleet exactly as they stop a shell command.
      publishTask: (path, task) => {
        const { logPath: _logPath, ...rest } = task as typeof task & { logPath?: string };
        const message = { type: "lasercode/task/update", task: rest } as const;
        // This worker's own fleet index first, then the host's. A verification
        // run is a Command of that session like any other: an agent reading
        // `inspect_fleet` sees it, and — because a session with a running
        // command is pinned (`session-safety.ts`) — the conversation that owns
        // it cannot be released, and therefore cannot be unloaded or retired
        // out from under it, while it runs. That is how "no invisible running
        // work" is kept: through the rules that already exist, not a second
        // set for verification.
        this.tasks.observe(path, message);
        this.notify("pi/extension/message", { path, message });
      },
    });
    return this.verificationRuns;
  }

  private projectWorkSession(live: Live, openOptions: Parameters<SessionDriver["open"]>[0]): ProjectWorkSession | undefined {
    if (this.options.projectWork !== true) return undefined;
    const agent = openOptions.agent;
    const label = agent?.role.subagentName ?? agent?.role.agentName ?? agent?.definition?.name ?? "Agent";
    const bridge = new HostProjectWorkBridge({
      link: (method, params) => this.hostRequest(method, params),
      // Resolved at call time: a new session learns its own id while it
      // opens, and a run exists only once the harness has started one.
      identity: () => ({
        label,
        ...(live.path ? { sessionId: this.sessionIdOf(live) } : {}),
        ...(agent?.role.runId !== undefined ? { runId: agent.role.runId } : {}),
      }),
      // The attempt records the Model Profile as *intent* (leap, "Execution
      // and convergence"): an agent run started for a Task runs on the
      // session's own profile, and the link says which one, never a model.
      execution: () => this.executionShape(openOptions.cwd, () => live.driver.state().profile?.id, () => live.path),
    });
    return new ProjectWorkSession({
      bridge,
      cwd: openOptions.cwd,
      // Bound to *this* session: the model never names an owner for a build,
      // and the one it gets is the conversation it is speaking in, read when
      // the tool is called rather than when the session was opened.
      design: this.designSurface(live),
      hostGrounding: this.hostGrounding(),
      // Foundation mode proposes on the Design profile (`docs/design-phase.md`,
      // "Model profiles"), read per call so a profile assigned while this
      // session is open counts.
      foundationModels: () => this.designModels(),
      ...(this.researchRun(bridge, openOptions.cwd) ? { research: this.researchRun(bridge, openOptions.cwd) } : {}),
      projectInstructions: () => projectInstructions(this.options.cwd),
      // A run a model starts belongs to the conversation it ran in, and shows
      // in the fleet under it (M21-T19).
      sessionPath: () => live.path,
      reviewActor: { kind: "agent", label },
      // The same registry the person's own verify surface uses, so one run is
      // one run whoever started it (M21-T19).
      verification: this.verification(),
    });
  }

  /**
   * What an attempt started in this session would be running in: its shape,
   * its checkout, the branch it is on and the commit it started from. Read
   * from git rather than remembered, and never fatal: an attempt in a
   * directory that is not a repository records its shape and no branch.
   */
  private async executionShape(cwd: string, profileId?: () => string | undefined, sessionPath?: () => string | undefined): Promise<ProjectWorkExecutionShape> {
    let profile: string | undefined;
    try {
      profile = profileId?.();
    } catch {
      // A session that is not open yet has no profile; the attempt records none
      // rather than a guess.
      profile = undefined;
    }
    const shape: ProjectWorkExecutionShape = {
      // A session whose directory is not the worker's own project directory
      // is working in a worktree of it (AGENTS.md invariant 5).
      workspace: cwd === this.options.cwd ? "shared" : "worktree",
      checkout: cwd,
      ...(profile !== undefined ? { profileId: profile } : {}),
      // The session file names the checkpoints this attempt made (M21-T18):
      // by session key, not by a clock, so two sessions in one checkout stay apart.
      ...(sessionPath?.() ? { sessionPath: sessionPath()! } : {}),
    };
    try {
      const run = createProcessRunner();
      const [branch, head] = await Promise.all([
        run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 5_000 }),
        run("git", ["rev-parse", "HEAD"], { cwd, timeoutMs: 5_000 }),
      ]);
      const branchName = branch.code === 0 ? branch.stdout.trim() : "";
      const commit = head.code === 0 ? head.stdout.trim() : "";
      return {
        ...shape,
        ...(branchName && branchName !== "HEAD" ? { branch: branchName } : {}),
        ...(/^[0-9a-f]{7,64}$/.test(commit) ? { baseCommitObjectId: commit } : {}),
      };
    } catch {
      return shape;
    }
  }

  /**
   * Laser's own state directory for this installation: where the design
   * index's parse cache and the research cache live. The host passes its own;
   * a worker run by hand derives one beside the agent directory.
   */
  private stateDir(): string {
    return this.options.stateDir ?? join(this.options.agentDir ?? this.options.cwd, "..", "state");
  }

  /** Static grounding of this project's pages (M21-T12), sharing the index's eras. */
  private hostGrounding(): ProjectHostGrounding {
    this.projectHostGrounding ??= new ProjectHostGrounding({
      projectCwd: this.options.cwd,
      index: async () => (await this.designIndex().index()) ?? undefined,
    });
    return this.projectHostGrounding;
  }

  /**
   * The design workspace (M21-T13): the six `design/*` methods over the index
   * and the grounding engines, with the fleet row an index build takes.
   */
  private designWorkspace(): DesignWorkspace {
    this.projectDesignWorkspace ??= new DesignWorkspace({
      projectCwd: this.options.cwd,
      index: () => this.designIndex(),
      grounding: () => this.hostGrounding(),
      // The row travels the road every Command row already travels: an
      // extension message the host's task register folds into `tasks/update`.
      // Nothing new is invented for it, and a person stops it from the fleet
      // exactly as they stop a shell command.
      publishTask: (path, task) => {
        const { logPath: _logPath, ...rest } = task as typeof task & { logPath?: string };
        const message = { type: "lasercode/task/update", task: rest } as const;
        // This worker's own fleet index first, then the host's. An index build
        // is a Command of that session like any other: an agent reading
        // `inspect_fleet` sees it, and — because a session with a running
        // command is pinned (`session-safety.ts`) — the conversation that owns
        // it cannot be released, and therefore cannot be deleted, while it
        // runs. That is how "no invisible running work" is kept: through the
        // rules that already exist, not a second set for design.
        this.tasks.observe(path, message);
        this.notify("pi/extension/message", { path, message });
      },
      // A build may only be owned by a conversation this worker holds open.
      // The worker opens sessions of its own project and nothing else
      // (`session/new` and `session/load` refuse another directory; a child is
      // opened by the harness in a worktree of this project), so this is also
      // the check that a session of another project can never own a build
      // here.
      holdsSession: (path) => this.runtimes.has(path),
    });
    return this.projectDesignWorkspace;
  }

  /** One `design/*` call, after the host resolved the project it belongs to. */
  private async dispatchDesignWorkspace(
    req: Extract<TypedClientRequest, { method: "design/index/get" | "design/index/build" | "design/index/stop" | "design/index/review" | "design/host/ground" | "design/sketch/ground" }>,
  ): Promise<Result<(typeof req)["method"]>> {
    if (req.params.cwd !== undefined) this.assertCwd(req.params.cwd);
    const workspace = this.designWorkspace();
    switch (req.method) {
      case "design/index/get":
        return (await workspace.get(req.params)) satisfies Result<"design/index/get">;
      case "design/index/build":
        return (await workspace.build(req.params)) satisfies Result<"design/index/build">;
      case "design/index/stop":
        return workspace.stop(req.params) satisfies Result<"design/index/stop">;
      case "design/index/review":
        // A `design/*` call arrives from a client connection, which the host
        // proves is a person (M21-T3); a model reviews through its own tool,
        // and the review document records which of the two decided.
        return (await workspace.review(req.params, { kind: "person", label: "You" })) satisfies Result<"design/index/review">;
      case "design/host/ground":
        return (await workspace.ground(req.params)) satisfies Result<"design/host/ground">;
      case "design/sketch/ground":
        return (await workspace.groundSketchDocument(req.params)) satisfies Result<"design/sketch/ground">;
    }
  }

  /**
   * The models and the profile design work runs on right now
   * (`designIndexProfileId`, `docs/model-profiles.md`).
   *
   * Read per use, exactly like the naming profile, and never substituted: an
   * explicitly assigned profile with nothing in it leaves design work on the
   * parse and the neutral foundation with the reason, rather than quietly
   * spending a profile the person did not choose for this.
   */
  private designModels(): DesignModelAccess {
    return designModelAccess({
      agentDir: this.settings().agentDir,
      models: this.options.designModels ?? (() => this.modelCatalog().modelRuntime()),
    });
  }

  /**
   * This session's design surface: the project's one index, with builds bound
   * to this conversation (M21-T10/T13 follow-up).
   *
   * Reading and reviewing are the project's, so they go straight to the index.
   * Starting a build is not: it is admitted by the design workspace, which
   * decides whether this session may own one and publishes the Command row
   * before the first file is opened. The person's `design/index/build` and the
   * model's `build_design_index` therefore reach the same admission, and
   * neither can start work nobody can see.
   */
  private designSurface(live: Live): DesignIndexBridge {
    return {
      index: () => this.designIndex().index(),
      review: (input) => this.designIndex().review(input),
      startBuild: async (input) => {
        // At invocation, not at construction: a session learns its path while
        // it opens, and this is the conversation the tool call is happening in.
        const started = await this.designWorkspace().startBuild({
          sessionPath: this.sessionPathOf(live),
          rebuild: input.rebuild,
          ...(input.appRoot !== undefined ? { appRoot: input.appRoot } : {}),
          ...(input.maxFiles !== undefined ? { maxFiles: input.maxFiles } : {}),
        });
        return { commandId: started.command.commandId, title: started.command.title, appRoot: started.appRoot };
      },
    };
  }

  /** This session's file path, from the driver when the record has not landed yet. */
  private sessionPathOf(live: Live): string {
    if (live.path) return live.path;
    try {
      return live.driver.state().path;
    } catch {
      return "";
    }
  }

  /** This project's design index, built once per worker and read on demand. */
  private designIndex(): ProjectDesignIndex {
    this.projectDesignIndex ??= new ProjectDesignIndex({
      projectCwd: this.options.cwd,
      stateDir: this.stateDir(),
      projectKey: createHash("sha256").update(this.options.cwd).digest("hex").slice(0, 16),
      // A build is a Command a person can watch and stop (M21-T13): the
      // workspace turns these two reports into the fleet row. A build a model
      // started through `build_design_index` takes the same road.
      // L1 synthesis runs on the Design profile, read when a build starts.
      synthesis: () => {
        const access = this.designModels();
        return {
          models: access.models,
          profile: access.profile,
          ...(access.unavailable !== undefined ? { unavailable: access.unavailable } : {}),
          ...(access.profile ? { profileId: access.profile.id } : {}),
        };
      },
      // The one thing the index cannot report through a row: a settlement
      // observer that threw, which loses a build's terminal row. Bounded,
      // content-free, and on the channel every other worker diagnostic uses.
      log: (line) => console.error(`${PRODUCT_NAME} worker: ${line}`),
      onCommand: (command, owner) => this.designWorkspace().observeCommand(command, owner),
      onProgress: (commandId, progress) => this.designWorkspace().observeProgress(commandId, progress),
      // How a build ended, published as its last row before the index lets go
      // of it: the fleet learns *failed*, *stopped* or *completed* from the one
      // answer the engine gave, and never from a phase that arrived first.
      onSettled: (command, owner, outcome) => this.designWorkspace().observeSettled(command, owner, outcome),
    });
    return this.projectDesignIndex;
  }

  /**
   * The research run this session may use, or nothing.
   *
   * The adapters come from Settings → Research sources, merged global then
   * project, so a source the person switched off is not a tool the model can
   * pick; with every source off, the research tools are simply absent.
   */
  private researchRun(bridge: ProjectWorkBridge, cwd: string): { bridge: ResearchBridge; adapters: ResearchAdapterId[] } | undefined {
    if (this.researchSession) return this.researchSession;
    let sources;
    try {
      sources = researchSourcesFrom(readEffectiveProductSettings(this.options.cwd, this.settings().agentDir, this.options.projectTrusted));
    } catch {
      return undefined;
    }
    const adapters = enabledResearchAdapters(sources);
    if (adapters.length === 0) return undefined;
    const search = new WebSearchService(this.settings().agentDir);
    const research = new ProjectResearch({
      projectCwd: cwd,
      stateDir: this.stateDir(),
      projectKey: createHash("sha256").update(this.options.cwd).digest("hex").slice(0, 16),
      sources,
      store: bridgeResearchStore(bridge),
      webSearch: (query) => search.search(query),
    });
    this.researchSession = { bridge: research, adapters };
    return this.researchSession;
  }

  private async openAndAttach(openOptions: Parameters<SessionDriver["open"]>[0], handle?: SessionHandle): Promise<Live> {
    // Resolve the project's environment before a session exists to run anything
    // in. Failing here never blocks opening the conversation: the refusal, if
    // the project requires its environment, belongs to the command that would
    // have used it, where a person can read it.
    await this.ensureProjectEnv().catch(() => {});
    const driver = this.options.createDriver();
    const live: Live = { driver, historyEpoch: randomUUID(), revisions: new SessionRevisionTracker(this.environmentId), mentions: new SessionMentionContext(), telemetry: TelemetryFold.create(), seq: 0, touchedAtMs: Date.now(), buffer: new ReplayBuffer(this.replayBuffer, this.options.replayBytes ?? REPLAY_BYTES_PER_SESSION, this.replayBudget), unsubscribe: () => {}, path: "" };
    driver.setExtensionModelWorkHandler?.((request) => this.admitExtensionModelWork(live, request));
    // The project this session belongs to is the host's answer, and the tools
    // it registers depend on it, so it is asked for before the engine starts
    // collecting tool definitions. Bounded and never fatal: a host that has
    // no project work for this folder leaves the session with the read-only
    // surface a projectless chat has.
    const projectWork = this.projectWorkSession(live, openOptions);
    if (projectWork) {
      await Promise.race([
        projectWork.resolveProject().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, PROJECT_WORK_RESOLVE_MS)),
      ]);
    }
    const queued: DriverEvent[] = [];
    let ready = false;
    live.unsubscribe = driver.subscribe((event) => (ready ? this.onDriverEvent(live, event) : queued.push(event)));
    try {
      const state = await driver.open({ ...openOptions, mentionContext: live.mentions, ...(projectWork ? { projectWork } : {}) });
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
      // Open-time checkpoint: do not await — session/new must stay fast.
      // The first prompt waits on awaitBaseline so the snapshot cannot land
      // after that turn has already written files.
      void this.sourceControl().captureBaseline(state.path, state.cwd).catch(() => {});
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

  private admitNewWork(): void {
    if (this.activationGate) {
      throw new ProtocolError(ErrorCodes.SessionBusy, "An update is waiting for current work to finish. Keep working by cancelling update preparation first.");
    }
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
      trayMessages: live.pending
        ? Math.max(live.pending.list().length, live.pending.deliveryInFlight() ? 1 : 0)
        : 0,
      runningTasks: this.tasks.tasksOf(live.path).filter((task) => task.status === "running").length,
      // Naming this session is under way: a bounded completion is in flight
      // and it ends in a rename through this runtime, which nothing else can
      // do. A request that could not start is not a pin, because there is no
      // such state: with no profile assigned to naming, nothing runs at all.
      naming: this.naming(live.path),
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
   * Work this worker still owes under a conversation it no longer holds
   * (M21-T19, RP-4).
   *
   * A driver that closed unexpectedly takes its runtime out of every
   * per-session table here, and a verification run it owned is detached so
   * nothing republishes a path nobody serves. The run itself does not stop
   * existing: its command is still draining and the report it owes may be
   * mid-flight to the host. Ending this process there would cut a project's
   * own record in half, so the lifetime hears about it as a pin, in the one
   * vocabulary that decides both release and retirement. Nothing is published,
   * reopened or re-created to say it: the registry is read, and a run whose
   * conversation is still loaded is left to that session's own pins.
   */
  private detachedWork(): SessionSafety[] {
    return (this.verificationRuns?.unsettledWork() ?? []).map((owed) => ({
      path: owed.sessionPath,
      pins: [{ kind: "task" as const, detail: `${String(owed.runs)} verification run(s) still settling` }],
    }));
  }

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
    let records = this.namingInFlight.size;
    for (const live of this.runtimes.values()) records += live.pending?.list().length ?? 0;
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
        steer: (content, extras) => this.harness.roleOf(live.path)?.kind === "child"
          ? this.queueIntoChild(live, content, "steer", extras)
          : this.firstTurnLock.run(live.path, () => live.driver.steer(content, extras)),
        prompt: (content, onAccepted, extras) =>
          this.promptWithFence(live, content, undefined, onAccepted, true, extras?.projectWork),
        admitNewWork: () => this.admitNewWork(),
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
    // A message that mentions project work is refused before the engine is
    // asked anything, never accepted with its context quietly dropped.
    live.mentions.refuseIfFull(params.projectWork);
    if (!firstTurn) {
      // A bare concurrent prompt keeps its refusal semantics. The lease closes
      // the check/use race with a first-turn runtime replacement.
      return this.promptWithFence(live, params.content, params.streamingBehavior, undefined, false, params.projectWork);
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
      const result = await this.promptLive(live, params.content, params.streamingBehavior, params.projectWork, () => {
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
    projectWork?: readonly ProjectWorkMentionProjection[],
  ): Promise<{ accepted: boolean; queued: boolean }> {
    // Preserve the bare concurrent refusal before a fake/alternate driver can
    // turn it into a never-settling call. Stable re-checks under its own slot.
    if (!streamingBehavior && live.driver.state().isStreaming) return { accepted: false, queued: false };
    const lease = await this.firstTurnLock.acquireLease(live.path, wait);
    if (!lease) return { accepted: false, queued: false };
    const finish = () => lease.release();
    try {
      return await this.promptLive(live, content, streamingBehavior, projectWork, () => {
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
   * awaits its agent loop), and the words are all a title needs. Acceptance is
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
    projectWork?: readonly ProjectWorkMentionProjection[],
    onAccepted?: () => void,
    admissionLease?: SessionAdmissionLease,
  ): Promise<{ accepted: boolean; queued: boolean }> {
    const text = textOf(content);
    const idle = !live.driver.state().isStreaming;
    if ((idle || streamingBehavior) && !live.driver.state().name && text.trim() !== "") void this.nameSession(live, text);
    // Steer/follow-up are not the open-time turn: waiting here would hold the
    // first-turn lock across a still-running baseline and miss close/fence races.
    if (!streamingBehavior && idle) await this.sourceControl().awaitBaseline(live.path);
    return this.harness.promptUser(live.path, content, {
      ...(streamingBehavior ? { streamingBehavior } : {}),
      // Carried on the options the harness parks and replays, so a message
      // held for a child's successor reaches the model with what it mentioned.
      ...(projectWork?.length ? { projectWork } : {}),
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
  private queueIntoChild(
    live: Live,
    content: ContentBlock[],
    lane: "steer" | "followUp",
    extras?: { projectWork?: readonly ProjectWorkMentionProjection[] },
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let accepted = false;
      const onAccepted = () => {
        accepted = true;
        resolve();
      };
      this.harness.promptUser(live.path, content, {
        streamingBehavior: lane,
        expandPromptTemplates: true,
        ...(extras?.projectWork?.length ? { projectWork: extras.projectWork } : {}),
        onAccepted,
      }).then(
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
        if (live.telemetryWanted && telemetryUpdateKind(update.kind)) {
          const snapshot = live.driver.entriesNow?.() ?? live.preAcceptance;
          if (snapshot) {
            try {
              const { revision, environmentKey } = this.revisionOf(live, snapshot);
              params.telemetry = this.sessionTelemetry(live, snapshot, { revision, environmentKey });
            } catch { /* a turn still streams; the next fold will carry numbers */ }
          }
        }
        live.buffer.push(params);
        this.notify("session/update", params);
        // The run is over: whatever the person wrote while it ran goes in now,
        // in the order they wrote it. Fire and forget — a delivery that fails
        // keeps its message and its reason in the tray, and says so there.
        if (update.kind === "agent_settled" && live.pending) void live.pending.drain();
        // Snapshot at Send, keyed by this prompt's id. Settles (including extra
        // wakes from children) must not mint another numbered checkpoint.
        if (update.kind === "message_end" && update.entry?.id) {
          const role = update.role ?? (update.message as { role?: string } | undefined)?.role;
          if (role === "user") {
            void this.sourceControl()
              .captureForPrompt(live.path, live.driver.state().cwd, update.entry.id)
              .catch(() => {});
          }
        }
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
        const composition = compositionOfCapture(event.message);
        if (composition) live.contextComposition = composition;
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
        // Before the index is swept: a verification run of this conversation
        // stops and publishes nothing further, so its own settlement cannot
        // re-create the row the sweep below is about to close — or the closed
        // session itself. The field, not the getter: a conversation that
        // never verified must not acquire a service because it closed.
        this.verificationRuns?.sessionClosed(live.path);
        this.tasks.sessionClosed(live.path);
        // One holder fewer: the rest of this worker's sessions may keep more.
        this.applyLogBudgets();
        this.gitService?.forget(live.path);
        // RP-5b: the range reader holds at most one body, and that body belongs
        // to a session that is open. A closed session leaves none behind, so
        // nothing can serve its bytes afterwards and nothing keeps its memory.
        this.bodyRanges.forget();
        // The runtime a naming attempt would have renamed is gone, so the
        // attempt can no longer finish its work: its entry goes with the
        // session rather than being left to pin whatever opens this path next.
        // Its own `finally` then finds the entry no longer its own and removes
        // nothing.
        this.namingInFlight.delete(live.path);
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
    // A naming completion already in flight is naming *this* conversation,
    // which now lives at the new path: the entry moves with it, token and all,
    // so the fork's runtime is the one held until the rename it is about to
    // attempt lands, and the attempt still recognises its own entry.
    const naming = this.namingInFlight.get(oldPath);
    if (naming !== undefined) {
      this.namingInFlight.delete(oldPath);
      this.namingInFlight.set(newPath, naming);
    }
    // An index build is a Command of the conversation that started it, so it
    // moves with the conversation exactly like a shell command's row does.
    // Its *owner* is unchanged and is never re-derived here: the same
    // conversation still owns the same builds, and only the file it lives in
    // has moved. Without this the workspace would keep publishing under a path
    // no runtime serves, and the row the task index just moved to the new path
    // would stay `running` for ever — pinning the moved conversation against
    // an unload that should have been allowed.
    //
    // The fields, deliberately, and not the getters: a conversation that never
    // asked for anything about design must not acquire an index and a
    // workspace because its file moved. After `tasks.rekeySession` above, so
    // the republished row lands in the moved task index rather than under it.
    this.projectDesignIndex?.rekeySession(oldPath, newPath);
    this.projectDesignWorkspace?.rekeySession(oldPath, newPath);
    // A verification run is a Command of the conversation that started it, on
    // the same terms: its owner is unchanged and never re-derived, its rows
    // follow the conversation, and the host requests it makes from here on
    // name the address it now lives at. The field, not the getter.
    this.verificationRuns?.rekeySession(oldPath, newPath);
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
