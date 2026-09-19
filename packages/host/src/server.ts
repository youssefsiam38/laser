/**
 * HostServer (M1-T1, M2) — HTTP + WebSocket on 127.0.0.1.
 *   GET /           → the UI bundle (SPA fallback), or a placeholder if not built
 *   GET /healthz    → { status: "ok", launchId }
 *   WS  /ws         → JSON-RPC: client requests in, responses + worker notifications out
 *
 * This is where the host's pieces are wired together:
 *   WorkerPool       one worker per project, lifecycle and retirement (M2-T1)
 *   AttentionTracker who needs you, fed from the worker event stream (M2-T2)
 *   ViewCache        last N hydrated transcripts (M2-T3)
 *   ProjectRegistry  the project list and the trust gate (M2-T4)
 *   AgentStore       the agent definitions, pushed to every worker (docs/agents-leap)
 *   AgentRunRegistry every agent run a worker reported, kept past the worker
 *   SkillsCheck      periodic validation of what definitions point at
 *
 * Clients can opt into transcripts for their loaded caches; small lifecycle
 * notifications remain global and raw provider captures stay in LogStore.
 * Binding is loopback
 * only; remote access goes through the relay, never by opening this port.
 *
 * Loopback is **not** on its own a defence against a browser. The same-origin
 * policy does not apply to WebSockets, so without a gate any page the user
 * visits could open `ws://127.0.0.1:<port>/ws` and drive their agent. Upgrades
 * therefore carry an Origin allowlist (`isAllowedOrigin`): a browser always
 * sends `Origin`, so refusing an unknown one closes that vector, while the CLI
 * and tests (which send none) keep working.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { totalmem } from "node:os";
import { basename, dirname, extname, join, normalize, relative, resolve as resolvePath, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { channelIdFor, type KeyPair } from "@lasercode/crypto";
import { ENV, ErrorCodes, FRAME_MAX_BYTES, PRODUCT_NAME, WIRE_NAMESPACE, decisionPushPayload, isProviderCaptureMessage, isTerminalRunStatus, projectEnvWorkerConfig, type AgentRun, type ClientRequests, type DeviceGrants, type EnvironmentPolicyInput, type HostNotifications, type JsonRpcNotification, type LogEntry, type MemoryPressurePublish, type NamerState, type ProviderCaptureMeta, type ProviderCaptureOmission, type ResourceRetainedStores, type SessionAgentInfo, type SessionUpdateParams } from "@lasercode/protocol";
import { AccessControl, isLoopbackAddress, localActor, pairedActor, type ActorIdentity } from "./access.js";
import { AccessAudit } from "./access-audit.js";
import { loadEnvironmentPolicy } from "./environment-policy.js";
import { AgentFailureRecoveryQueue } from "./agents/failure-recovery.js";
import { suggestBeamModel } from "./agents/models.js";
import { AgentRunRegistry } from "./agents/runs.js";
import { SkillsCheck } from "./agents/skills-check.js";
import { AgentStore } from "./agents/store.js";
import { AttentionTracker } from "./attention.js";
import { FeatureService } from "./features.js";
import { PrefsStore } from "./prefs.js";
import { SessionCatalog, defaultSessionDir } from "./catalog.js";
import { LogStore } from "./logstore.js";
import { CaptureAccumulator, type CaptureActor } from "./provider-capture.js";
import { collectTransportQueues, type TransportQueueSource, type TransportQueues } from "./transport-snapshot.js";
import { observeCapture } from "./capture-ingress.js";
import { OutboundPressure, fenceReasonText } from "./transport-pressure.js";
import { PackageService, SetupService } from "./packages.js";
import { ResourceService } from "./resources/index.js";
import { TaskRegister } from "./tasks/register.js";
import { defaultAgentDir, defaultStateDir, ensureWorkspace, projectRootOf, workspaceAgentFor, workspacesDir } from "./paths.js";
import { canonical } from "./trust.js";
import { createHostPressureController, createHostPressureSampler, type HostPressureController, type HostPressureSample } from "./pressure/index.js";
import { ProjectEnvStore, projectEnvTrustAllows } from "./project-env.js";
import { ProjectRegistry } from "./projects.js";
import { PushService } from "./push.js";
import { RelayClient, type RelayClientState, type RelayClientStats } from "./relay-client.js";
import { Router } from "./router.js";
import { SessionLoadDelivery } from "./session-load-delivery.js";
import { TranscriptDelivery, type SessionMembershipView } from "./transcript-delivery.js";
import { SessionLifetime, type SessionLifetimeOptions } from "./session-lifetime.js";
import { SessionRouteLeases } from "./session-route-lease.js";
import { cleanupTaskLogsBeforeWorkers } from "./tasks/cleanup.js";
import { SearchCancellation } from "./search-cancellation.js";
import { SessionIndexCache } from "./session-index.js";
import { SessionProjection } from "./session-projection.js";
import { SessionBodyRange } from "./session-body-range.js";
import { SessionTelemetryReader } from "./session-telemetry.js";
import { SessionRevisions } from "./session-revision.js";
import { environmentIdentity, type EnvironmentIdentity } from "./environment-identity.js";
import { ViewCache } from "./views.js";
import { configuredOldSpaceBytes } from "./heap-ceiling.js";
import { WorkerRetiredError, type WorkerClient } from "./worker-client.js";
import { WorkerPool, type WorkerPoolOptions } from "./worker-pool.js";
import { RuntimeRepairLedger } from "./runtime-repair.js";
import { RuntimeActivationGate } from "./runtime-activation.js";
import {
  FeatureGenerationStore,
  RuntimeGenerationGuard,
  type RuntimeGenerationReference,
} from "./runtime-generation.js";

export interface HostServerOptions {
  host?: string;
  port?: number;
  /** Launcher-minted identity echoed by health; production always supplies it. */
  launchId?: string;
  /** Immutable install generation bound by the launcher before this process existed. */
  runtimeGeneration?: RuntimeGenerationReference;
  agentDir?: string;
  sessionDir?: string;
  workerMain?: string;
  nodeBinary?: string;
  /** Directory of the built UI; defaults to the workspace `@lasercode/ui/dist` if present. */
  uiDir?: string;
  /** Where laser keeps its own state (projects, attention). Default `~/.laser`. */
  stateDir?: string;
  /**
   * Where the Beam and Chat workspace containers live (`<workspacesDir>/beam`,
   * `<workspacesDir>/chat`). Defaults to `<stateDir>/workspaces`: the host
   * creates and owns its state directory in every layout, whereas a parent
   * of it may belong to someone else (a review container sets the state
   * directory to an XDG root whose parent is not writable).
   */
  workspacesDir?: string;
  /** Idle time before an unused worker is retired; 0 disables retirement. */
  workerIdleMs?: number;
  /** Test seam for the pool's idle sweep cadence. */
  workerSweepMs?: number;
  /** Test-only worker old-space ceiling; production derives it from capacity. */
  workerOldSpaceMiB?: number;
  /**
   * Internal seam for the session-lifetime policy (RP-4).
   *
   * Only so a test can drive the real policy on a real host instead of a
   * stand-in. It is not configuration: nothing on the wire carries it, no
   * settings file names it, and leaving it out gives the shipped behaviour,
   * derived from `workerIdleMs`.
   */
  sessionLifetime?: SessionLifetimeOptions;
  /** Test seam for RP-8; production always uses the self-only sampler. */
  pressureSample?: () => Promise<HostPressureSample>;
  /**
   * Extra browser origins allowed to open the WebSocket, on top of this host's
   * own `http://127.0.0.1:<port>` / `http://localhost:<port>`. Only add one you
   * control: an allowed page can drive every session on this machine.
   */
  allowedOrigins?: readonly string[];
  /** How long a project-trust prompt stays open before it declines for that run. */
  trustTimeoutMs?: number;
  /** Transcripts kept hydrated in the host for instant switching. */
  hydratedViews?: number;
  /** M4 log store file. Defaults to `<stateDir>/logs.db`; `false` disables logging. */
  logFile?: string | false;
  /** Retention for the log store, and how much of a provider round-trip it keeps. */
  logRetention?: {
    maxRows?: number;
    maxAgeDays?: number;
    providerPayloads?: "full" | "summary";
    /** Bytes of retained request bodies before the oldest are released (D-245). */
    bodyBudgetBytes?: number;
    /** Provider requests per session whose body is kept in full (D-245). */
    bodiesPerSession?: number;
  };
  /**
   * Remote access through a relay (M6). **Absent means off**, which is the
   * default: with no `relay` the host makes no outbound connection and is
   * reachable only on 127.0.0.1. Supplying it opens one outbound WebSocket per
   * paired device — the host still never listens publicly.
   *
   * The caller owns the identity: the desktop shell reads the root key from the
   * keychain (M5-T3) and the signed device list, and passes them here. This
   * package deliberately does not go looking for either, so a host cannot start
   * relaying because a file happened to exist.
   */
  relay?: HostRelayOptions;
  /**
   * The authoritative environment policy (RP-13), from whoever started this
   * host: the desktop shell, a hosted workspace's supervisor, an organisation's
   * deployment. Absent means the default policy, which narrows nothing. It can
   * only take authority away, and it is the only source that may name this
   * environment a hosted or managed one.
   *
   * A policy that cannot be honoured throws here, before the host listens.
   */
  policy?: EnvironmentPolicyInput;
  log?: (line: string) => void;
}

/** What the host needs to relay to already-paired devices. Pairing itself is M5/M7. */
export interface HostRelayOptions {
  /** Relay WebSocket URL, e.g. `wss://relay.example/ws`. */
  url: string;
  /** This desktop's durable X25519 static key. */
  staticKeyPair: KeyPair;
  /** Devices to connect for. Each gets its own channel and its own client. */
  devices: readonly HostRelayDevice[];
  /**
   * Re-checked on every reconnect, so revoking a device takes effect without a
   * restart. Default: the device is authorized (the caller already filtered).
   */
  isAuthorized?: (devicePublicKey: Uint8Array) => boolean;
  /** Pad and grid outbound frames. Off by default; see RelayClientOptions. */
  shapeTiming?: boolean;
  /**
   * The https origin a phone actually opens (the relay's device link). Push
   * notifications carry an absolute URL, so without this they point at
   * `http://127.0.0.1:<port>`, which only helps a browser on this machine.
   */
  publicOrigin?: string;
  onStateChange?: (device: HostRelayDevice, state: RelayClientState, detail?: string) => void;
}

export interface HostRelayDevice {
  /** base64url device id from the signed device list, for logs. */
  id: string;
  /**
   * What this device was granted (RP-13). Intersected with the environment's
   * own scopes and clamped against its cache policy, so a grant can only ever
   * narrow. Absent means "whatever the environment allows a paired device".
   */
  grants?: DeviceGrants;
  /** Untrusted label. Never rendered as markup by anything reading this. */
  name: string;
  /** Raw 32-byte X25519 static public key. */
  publicKey: Uint8Array;
}

/** Update kinds after which Pi may have appended to the session file. */
const PERSISTING_UPDATES = new Set(["message_end", "compaction_end", "entry_appended", "agent_end", "agent_settled"]);

/** New log rows are batched for this long before one notification goes out. */
const LOG_APPEND_FLUSH_MS = 120;

/**
 * How long the Advanced resource surface waits for one live worker to say what
 * it is retaining. A diagnostic never delays a person's answer: past this, the
 * worker's numbers are missing coverage rather than a slow reply.
 */
const RETAINED_STORES_TIMEOUT_MS = 750;

/** Vite's emitted `assets/<name>-<hash>.<ext>`; mirrors the service worker's `hashedAsset`. */
const HASHED_ASSET = /^assets[/\\][^/\\]+-[\w-]{8,}\.(?:m?js|css|woff2?)$/;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

export function defaultUiDir(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url).resolve("@lasercode/ui/package.json");
    const dir = join(pkg, "..", "dist");
    return existsSync(join(dir, "index.html")) ? dir : undefined;
  } catch {
    return undefined;
  }
}

export class HostServer {
  readonly pool: WorkerPool;
  readonly catalog: SessionCatalog;
  readonly attention: AttentionTracker;
  readonly projects: ProjectRegistry;
  /** The per-project environment command (M16-T17, docs/project-environment.md). */
  readonly projectEnv: ProjectEnvStore;
  /** Package policy (M10-T5) and first-run state (M10-T6). */
  readonly packages: PackageService;
  readonly setup: SetupService;
  readonly views: ViewCache;
  /**
   * What this host and this machine cost right now, what its workers reported,
   * and the one journal of everything memory pressure has done (RP-8).
   *
   * It observes and records; it releases nothing and refuses nothing yet.
   * Deliberately not called `pressure`: that name already belongs to this
   * server's per-socket outbound transport pressure (RP-7).
   */
  readonly memoryPressure: HostPressureController;
  /** Raw identity is trusted spawn wiring only; it is never part of HostServer's public surface. */
  private readonly environment: EnvironmentIdentity;
  /** Durable revisions read without starting a worker (RP-9). */
  readonly revisions: SessionRevisions;
  /** Bounded, read-only history pages over that same index (RP-12). */
  readonly projection: SessionProjection;
  /** Bounded, read-only slices of one body of one stored entry (RP-5b). */
  readonly bodyRange: SessionBodyRange;
  readonly telemetry: SessionTelemetryReader;
  /** M4 log store, or undefined when it could not be opened (see `logsUnavailable`). */
  readonly logs: LogStore | undefined;
  readonly logsUnavailable: string | undefined;
  /** Background commands the agent left running, per session (docs/ux-fleet.md). */
  readonly tasks: TaskRegister;
  /** Runs, plans and missions read off disk — including sessions with no worker (M3). */
  /** Web Push to paired phones (M7-T5). Inert until a device subscribes. */
  readonly push: PushService;
  /** laser's own preferences (M11-T6) — the theme among them. */
  readonly prefs: PrefsStore;
  /** Laser-owned capability policy; implementation packages stay hidden. */
  readonly features: FeatureService;
  /** Durable bounded launch repair and per-project effective safe mode. */
  readonly repair: RuntimeRepairLedger;
  /** Agent definitions (docs/agents-leap): the person's, the seeded default, the three built-ins. */
  readonly agents: AgentStore;
  /** Every agent run a worker reported, kept after the worker is gone. */
  readonly runs: AgentRunRegistry;
  /** Periodic validation of scoped skills and child lists. */
  readonly skillsCheck: SkillsCheck;
  /** Process inventory and resource snapshots (RP-1). Collects only on demand. */
  readonly resources: ResourceService;
  /** The boundary's authorization and the environment descriptor (RP-13). */
  readonly access: AccessControl;
  /** The bounded, redacted record of what the boundary decided (RP-13). */
  readonly audit: AccessAudit;
  readonly router: Router;
  /**
   * The bounded lifetime of the runtimes inside those workers (RP-4): idle and
   * over-set conversations nobody is following are released well before the
   * whole worker would be retired.
   */
  readonly sessionLifetime: SessionLifetime;
  /**
   * Per-session route leases (RP-4c): path-routed requests are readers, a
   * lifetime release is the writer. Shared by the router and the pool, so
   * releasing a runtime never releases the host's authority over that session.
   */
  readonly routeLeases: SessionRouteLeases;
  /**
   * Large provider captures, reassembled before they become one log row
   * (RP-7). Bounded per session, per worker generation and globally; a capture
   * that cannot complete is still recorded, with its size, digest and reason.
   */
  private readonly captures = new CaptureAccumulator({
    openBody: (meta) => this.logs?.openProviderBody(meta),
    onComplete: ({ cwd, sessionPath, meta, body, pieces, stored }) => {
      if (stored) this.logs?.recordProviderStored(cwd, sessionPath, meta, stored);
      else this.logs?.recordProviderCapture(cwd, sessionPath, meta, body, pieces);
    },
    onAbsent: ({ cwd, sessionPath, meta, reason }) => this.logs?.recordProviderAbsent(cwd, sessionPath, meta, reason),
    log: (message) => this.log(message),
  });
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  /** What the boundary proved about each local socket (RP-13). */
  private readonly actors = new Map<WebSocket, ActorIdentity>();
  /** Native sockets whose desktop report this host verified (RP-8). */
  private readonly verifiedDesktopReporters = new Set<WebSocket>();
  /** What each direct socket costs this host right now (RP-7). */
  private readonly pressure = new Map<WebSocket, OutboundPressure>();
  /** Session paths each client is following, for the retirement guard. */
  private readonly transcripts = new Map<WebSocket, TranscriptDelivery>();
  /** The private directory every command log this host will read must be inside. */
  private readonly taskLogRoot: string;
  /** Crash cleanup of that directory, started before any worker exists. */
  private taskLogCleanup: Promise<number> = Promise.resolve(0);
  private readonly searches = new Map<WebSocket, SearchCancellation>();
  /** Question-only response fences for concurrent session/load requests, per socket. */
  private readonly loadDeliveries = new Map<WebSocket, Set<SessionLoadDelivery>>();
  private readonly log: (line: string) => void;
  private readonly uiDir: string | undefined;
  /** Set by `listen()`; the port the Origin allowlist is built from. */
  private boundPort: number | undefined;
  /** Rows recorded since the last `pi/logs/append`, and its scheduled flush. */
  private pendingLogRows: LogEntry[] = [];
  private logFlush: ReturnType<typeof setTimeout> | undefined;
  /** One per paired device; empty unless `options.relay` was supplied. */
  private readonly relayClients: RelayClient[] = [];
  /** Listeners for host notifications, so a relayed device sees the same stream. */
  private readonly notificationListeners = new Set<(n: JsonRpcNotification) => void>();
  /** The Beam choose-model dialog is offered once per host run. */
  private beamPrompted = false;
  /** Set by `close()`: background work started behind a request must not outlive the host. */
  private closing = false;
  /** One Namer benchmark at a time for the whole host; it tests two small naming jobs per candidate. */
  private namerQualifying = false;
  /** Provider sets already benchmarked this run, so a failure is not retried on every worker. */
  private readonly namerQualified = new Set<string>();
  /** Bounded harness-failure handoff through exact successor workers. */
  private readonly agentFailureRecovery: AgentFailureRecoveryQueue;
  private readonly launchId: string;

  constructor(private readonly options: HostServerOptions = {}) {
    this.launchId = options.launchId ?? randomBytes(16).toString("hex");
    this.uiDir = options.uiDir ?? defaultUiDir();
    const agentDir = options.agentDir ?? defaultAgentDir();
    const stateDir = options.stateDir ?? defaultStateDir();
    // Command output is a person's own bytes: it lives in a private directory
    // of this host's state, not in a shared, guessable temporary path, and it
    // is the only place anything here will read a command log from (RP-6).
    this.taskLogRoot = join(stateDir, "task-logs");
    try {
      mkdirSync(this.taskLogRoot, { recursive: true, mode: 0o700 });
      chmodSync(this.taskLogRoot, 0o700);
      // Whatever is in there now is from a run that is gone: this host has not
      // spawned a worker yet, so nothing can be writing. That is the only
      // moment at which leftovers can be identified without guessing, which is
      // why no worker ever removes a directory it did not write
      // (`tasks/cleanup.ts`).
      this.taskLogCleanup = cleanupTaskLogsBeforeWorkers(this.taskLogRoot).catch(() => 0);
    } catch {
      // A state directory that cannot hold it is reported when a read fails,
      // never as a reason to refuse to start.
    }
    this.environment = environmentIdentity(stateDir);
    const log = options.log ?? (() => {});
    // Defense in depth: even a dependency echoing worker argv cannot put the
    // trusted identity into the host log (and therefore a log query/export).
    this.log = (line) => log(this.privateLogText(line));
    // The policy is resolved before anything is opened or served: a host that
    // was told to narrow and cannot understand the instruction must not come
    // up wider than it was asked to be. This throws out of the constructor,
    // which is before `listen()` and before any socket exists.
    const { policy, sources } = loadEnvironmentPolicy({
      stateDir,
      ...(options.policy !== undefined ? { configured: options.policy } : {}),
    });
    const workspacesRoot = options.workspacesDir ?? workspacesDir(stateDir);
    const workspaces = { beam: join(workspacesRoot, "beam"), chat: join(workspacesRoot, "chat") };
    // Created here and again when a session asks for one (router.ts refuses
    // the session with the reason when it still cannot be created).
    for (const dir of Object.values(workspaces)) {
      const problem = ensureWorkspace(dir);
      if (problem) this.log(`could not create the workspace ${dir}: ${problem}`);
    }

    // The log store is a nice-to-have: a host that cannot open SQLite still
    // runs sessions, and `pi/logs/*` explains itself instead of failing blank.
    if (options.logFile === false) {
      this.logs = undefined;
      this.logsUnavailable = "Logging is switched off for this host (logFile: false).";
    } else {
      try {
        this.logs = new LogStore({
          file: options.logFile ?? join(stateDir, "logs.db"),
          ...(options.logRetention?.maxRows !== undefined ? { maxRows: options.logRetention.maxRows } : {}),
          ...(options.logRetention?.maxAgeDays !== undefined ? { maxAgeDays: options.logRetention.maxAgeDays } : {}),
          ...(options.logRetention?.providerPayloads !== undefined
            ? { providerPayloads: options.logRetention.providerPayloads }
            : {}),
          ...(options.logRetention?.bodyBudgetBytes !== undefined ? { bodyBudgetBytes: options.logRetention.bodyBudgetBytes } : {}),
          ...(options.logRetention?.bodiesPerSession !== undefined ? { bodiesPerSession: options.logRetention.bodiesPerSession } : {}),
          onAppend: (entries) => this.queueLogAppend(entries),
          // A one-time compaction of an older store holds the host; the log is
          // where it says so, before and after.
          log: (message) => this.log(message),
        });
        this.logsUnavailable = undefined;
      } catch (error) {
        this.logs = undefined;
        this.logsUnavailable = error instanceof Error ? error.message : String(error);
        this.log(`log store unavailable: ${this.logsUnavailable}`);
      }
    }
    this.catalog = new SessionCatalog(options.sessionDir ?? defaultSessionDir(options.agentDir));
    this.views = new ViewCache(options.hydratedViews ?? 8);
    // The revision reader derives both its public key and private revision tag
    // from the same identity input, so those fields cannot disagree.
    const sessionIndex = new SessionIndexCache();
    this.revisions = new SessionRevisions({
      index: sessionIndex,
      environmentId: this.environment.id,
    });
    this.projection = new SessionProjection({ index: sessionIndex, revisions: this.revisions });
    this.bodyRange = new SessionBodyRange({ index: sessionIndex, revisions: this.revisions });
    // The memo holds one body so a sliced read walks it once; it is let go the
    // moment the conversation it belongs to changes underneath it (RP-5b), and
    // on a timer while nothing reads.
    sessionIndex.onInvalidate(() => this.bodyRange.forget());

    // Who may do what, and the record of it. Both are host-owned: a client
    // never carries its own authority, and an audit row never carries a
    // conversation.
    this.access = new AccessControl({
      policy,
      environmentKey: this.revisions.environmentKey,
      capabilities: {
        revisions: true,
        deltas: true,
        snapshots: true,
        durableReads: true,
        search: true,
        logs: this.logs !== undefined,
        diagnostics: true,
        push: true,
      },
    });
    this.audit = new AccessAudit({
      sink: this.logs,
      log: (line) => this.log(line),
      reads: policy.audit.reads,
    });
    this.log(
      `environment: ${policy.deployment}${sources.length > 0 ? ` policy from ${sources.join(" and ")}` : " policy default"}`,
    );

    this.attention = new AttentionTracker({
      storePath: join(stateDir, "attention.json"),
      modifiedAt: (path) => this.catalog.get(path)?.modifiedAt,
      onChange: ({ path, cwd, attention, at }) => {
        const agent = this.agentInfoOf(path);
        this.notify("pi/session/attention", { path, cwd, attention, at, ...(agent ? { agent } : {}) });
      },
      onSeen: (path) => this.notify("pi/session/seen", { path }),
    });

    let agentStore: AgentStore | undefined;
    this.projects = new ProjectRegistry({
      catalog: this.catalog,
      agentDir,
      storePath: join(stateDir, "projects.json"),
      // Internal storage is not a project, even if a broken resume once
      // recorded it in a transcript header. Include relocated workspaces.
      exclude: [stateDir, agentDir, workspaces.beam, workspaces.chat],
      ...(options.trustTimeoutMs !== undefined ? { trustTimeoutMs: options.trustTimeoutMs } : {}),
      onChange: (projects) => {
        this.notify("pi/project/updated", { projects });
        agentStore?.setTrustedProjects(
          projects.filter((project) => projectEnvTrustAllows(project.trust)).map((project) => project.cwd),
        );
      },
      onTrustRequest: (request) => {
        this.log(`project trust: asking about ${request.cwd} (${request.reasons.join(", ")})`);
        this.notify("pi/project/trust_request", request);
      },
      onTrustResolved: (resolved) => this.notify("pi/project/trust_resolved", resolved),
      hasClients: () => this.clients.size > 0,
    });

    // The project environment command (M16-T17). Machine-local and keyed by
    // project root, deliberately not read from inside a checkout: it names an
    // executable, and a file in a repository must not be able to choose one.
    this.projectEnv = new ProjectEnvStore({
      storePath: join(stateDir, "project-env.json"),
      onChange: (status) => this.notify("pi/project/env/changed", { status }),
    });

    this.tasks = new TaskRegister({ notify: (method, params) => this.notify(method, params), logRoot: this.taskLogRoot });

    this.push = new PushService({ agentDir, log: (line) => this.log(line) });

    // Host-owned, so a theme chosen on the desktop is the theme a paired phone
    // opens with. Every client hears the change, including the one that made it.
    this.prefs = new PrefsStore({
      storePath: join(stateDir, "prefs.json"),
      onChange: (entry) => this.notify("pi/prefs/updated", entry),
    });
    this.features = new FeatureService(this.prefs);
    this.repair = new RuntimeRepairLedger(join(stateDir, "runtime-repair.json"), this.launchId);
    const runtimeGuard = options.runtimeGeneration ? new RuntimeGenerationGuard(options.runtimeGeneration) : undefined;
    runtimeGuard?.verify();
    const featureGenerations = options.runtimeGeneration
      ? new FeatureGenerationStore(stateDir, options.runtimeGeneration.generationId)
      : undefined;

    // The definitions live here; every worker gets a copy when it starts
    // (`prime`, below) and again whenever they change. Clients hear the same
    // snapshot as `agents/updated`.
    this.agents = new AgentStore({
      storePath: join(stateDir, "agents.json"),
      agentDir,
      stateDir,
      workspaces,
      log: (line) => this.log(line),
      onChange: (snapshot) => {
        this.notify("agents/updated", snapshot);
        void this.pool?.broadcastRequest("agents/sync", { snapshot }).then((results) => {
          for (const result of results) {
            if (result.error) this.log(`agents: the worker for ${result.cwd} did not take the definitions: ${result.error}`);
          }
        });
      },
    });
    agentStore = this.agents;
    agentStore.setTrustedProjects(
      this.projects.list().filter((project) => projectEnvTrustAllows(project.trust)).map((project) => project.cwd),
    );
    this.runs = new AgentRunRegistry({
      storePath: join(stateDir, "agent-runs.json"),
      onRun: (run) => {
        this.notify("agents/run", { run });
        this.logs?.observeAgentRun(run);
      },
    });
    this.telemetry = new SessionTelemetryReader({ index: sessionIndex, revisions: this.revisions, runs: this.runs });
    this.agentFailureRecovery = new AgentFailureRecoveryQueue(this.runs, (line) => this.log(line));
    const loadedFailures = new Map<string, AgentRun[]>();
    for (const run of this.runs.takeLoadedFailures()) {
      const bucket = loadedFailures.get(run.projectCwd) ?? [];
      bucket.push(run);
      loadedFailures.set(run.projectCwd, bucket);
    }
    for (const [cwd, runs] of loadedFailures) this.agentFailureRecovery.note(cwd, runs);
    this.skillsCheck = new SkillsCheck({
      agents: () => this.agents.snapshot().agents,
      report: (warnings) => this.agents.setWarnings(warnings),
    });

    // Process inventory (RP-1). Demand-driven: constructing it starts nothing,
    // and the lookups below are called only while a snapshot is being built.
    // They answer with ids the host already publishes — never a path.
    this.resources = new ResourceService({
      requestDesktopRefresh: () => this.notify("resource/refresh_request", {}),
      lookups: {
        sessionIdOf: (path) => this.catalog.get(path)?.id,
        sessionIdsOf: (cwd) => this.pool.openSessions(cwd).map((path) => this.catalog.get(path)?.id).filter((id): id is string => Boolean(id)),
        runIdsOf: (cwd) => this.runs.list().filter((run) => run.projectCwd === cwd && !isTerminalRunStatus(run.status)).map((run) => run.runId),
        taskIdsOf: (cwd) => this.tasks.list().filter((task) => task.status === "running" && (this.pool.cwdOfSession(task.sessionPath) ?? this.catalog.cwdOf(task.sessionPath)) === cwd).map((task) => task.id),
      },
      retainedStores: () => this.retainedStores(),
      // The fixed-size pressure summary rides with the snapshot it belongs to,
      // and the journal is read once into an export (RP-8). A failure here
      // leaves the section out; it never fails a snapshot.
      pressure: () => this.memoryPressure.exportSection(),
    });

    const hostConfiguredOldSpaceBytes = configuredOldSpaceBytes(process.execArgv);
    // Memory pressure (RP-8). Self-sampled on its own small cadence: RP-1's
    // collector walks every process on demand, and a host looking at itself
    // every twenty seconds must not do that. E2's host pass uses only the body
    // memo, exact worker generations and the existing session/worker safety
    // decisions and E3 admission share this one current evidence source.
    this.memoryPressure = createHostPressureController({
      sample: options.pressureSample ?? createHostPressureSampler(),
      workers: () => this.pool.pressureWorkers(),
      publish: (publication) => this.publishPressure(publication),
      // The inventory's opaque salted project id, or nothing. Never a path.
      projectIdOf: (cwd) => this.resources.ownership.projectIdentity(cwd).id,
      // A window is connected, but until the renderer reports for itself its row
      // is missing coverage rather than calm.
      rendererPresent: () => this.hasWindowSocket(),
      totalMemoryBytes: totalmem,
      reservedWorkerCount: () => this.pool.reservedWorkerCount(),
      log: (line) => this.log(line),
      actions: {
        releaseEphemeral: () => this.bodyRange.forget(),
        directive: (cwd, expect, params) => this.pool.pressureDirective(cwd, expect, params),
        unloadIdle: (allow) => this.sessionLifetime.pressurePass(allow),
        retireIdle: (allow) => this.pool.retireIdleUnderPressure(allow),
      },
    }, {
      ...(hostConfiguredOldSpaceBytes !== undefined
        ? { configuredHostOldSpaceBytes: hostConfiguredOldSpaceBytes }
        : {}),
    });

    // The host resolves the package manager the workers should use — the one
    // the packaged app bundles, or the one on PATH on a developer machine —
    // and hands it down as environment (M10-T5). Settings still win inside.
    this.packages = new PackageService({
      agentDir,
      stateDir,
      // Retried once if it meets a worker that was retiring (RP-4): the
      // refusal proves the request was never written, and `pool.get` waits for
      // the decision, so the second attempt has a worker that is admitting.
      forward: async (cwd, method, params) => this.askWorker(cwd, method, params),
      log: (line) => this.log(line),
    });
    this.setup = new SetupService({ stateDir });
    const npmCommand = this.packages.npmCommand();
    this.log(npmCommand ? `packages: installer ${npmCommand.join(" ")}` : "packages: no installer found; installs will be refused with a reason");

    // RP-4c: one instance for the whole host. The router routes under it and
    // the pool releases under it, so a path-routed request and a release of the
    // same session are one decision rather than two that can straddle.
    this.routeLeases = new SessionRouteLeases();

    const poolOptions: WorkerPoolOptions = {
      routeLeases: this.routeLeases,
      ...(options.agentDir ? { agentDir: options.agentDir } : {}),
      env: {
        ...(npmCommand ? { [ENV.npmCommand]: JSON.stringify(npmCommand) } : {}),
        [ENV.taskLogRoot]: this.taskLogRoot,
        ...(options.runtimeGeneration ? {
          [ENV.runtimeGenerationId]: options.runtimeGeneration.generationId,
          [ENV.runtimeInstallRoot]: options.runtimeGeneration.installRoot,
          [ENV.runtimeManifestDigest]: options.runtimeGeneration.manifestDigest,
        } : {}),
      },
      envForCwd: (cwd, mode) => {
        const effectiveFeatures = mode === "safe" ? [] : this.features.enabled(cwd);
        const featureGeneration = featureGenerations?.ensure({
          cwd,
          featurePrefsRevision: this.features.revision,
          effectiveFeatures,
          mode,
        });
        return {
          [ENV.features]: JSON.stringify(effectiveFeatures),
          ...(featureGeneration ? { [ENV.featureGenerationId]: featureGeneration.featureGenerationId } : {}),
          // Non-secret: the executable, its arguments and whether this exact pair
          // was approved. Values never travel this way; the worker runs the hook.
          ...this.projectEnvForWorker(cwd),
        };
      },
      ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
      stateDir,
      environmentId: this.environment.id,
      repair: this.repair,
      // A store that keeps summaries only never receives a body: the capture
      // is recorded, without one, in the worker that holds it (RP-7).
      ...(options.logRetention?.providerPayloads ? { providerPayloads: options.logRetention.providerPayloads } : {}),
      ...(options.workerMain ? { workerMain: options.workerMain } : {}),
      ...(options.nodeBinary ? { nodeBinary: options.nodeBinary } : {}),
      ...(options.workerIdleMs !== undefined ? { idleMs: options.workerIdleMs } : {}),
      ...(options.workerSweepMs !== undefined ? { sweepMs: options.workerSweepMs } : {}),
      ...(options.workerOldSpaceMiB !== undefined ? { workerOldSpaceMiB: options.workerOldSpaceMiB } : {}),
      // A worker's first request already sees the agent definitions.
      prime: async (client, cwd, speculative) => {
        // Priming runs inside the spawn, before anything can ask this worker to
        // retire, and a failure here is reported and never fatal (RP-4): an
        // older worker that refuses the method is still a working worker.
        await client.request("agents/sync", { snapshot: this.agents.snapshot() });
        // Naming must not wait for a sign-in this run may never see. The first
        // worker to come up benchmarks Namer, after priming so nothing that
        // opened this worker waits on it.
        if (!speculative) setImmediate(() => void this.qualifyNamer(cwd, client));
      },
      onPreparedUse: (client, cwd) => {
        setImmediate(() => void this.qualifyNamer(cwd, client));
      },
      onNotification: (cwd, n, source) => {
        this.observe(cwd, n, source);
        this.broadcast(n);
      },
      // A worker's own pressure report (RP-8) arrives on a road of its own and
      // stops here. It is the app talking to itself: it carries that spawn's
      // private generation, and a client, a paired device, an audit line and
      // another worker must never see it. The controller binds it to the exact
      // process that delivered it and records what it says; nothing about it is
      // logged, published or forwarded.
      onWorkerPressure: (cwd, notification, source) => this.memoryPressure.observeWorkerReport(cwd, notification, source),
      // The process that opened a capture is the only one that may advance or
      // end it (RP-7): its exit ends what it started, and cannot touch the
      // successor that took its place. The same exact identity retires that
      // process's pressure evidence (RP-8).
      onWorkerGone: ({ cwd, generation }) => {
        this.captures.generationGone(generation);
        this.memoryPressure.forgetWorker(cwd, generation);
      },
      onWorkerLoss: ({ cwd, message }) => {
        const changed = this.runs.workerLost(cwd, message);
        this.agentFailureRecovery.note(cwd, changed);
      },
      onReopened: (client, cwd, paths) => this.agentFailureRecovery.deliver(client, cwd, paths),
      onStderr: (cwd, text) => {
        const safe = this.privateLogText(text);
        this.log(`[worker ${cwd}] ${safe.trimEnd()}`);
        this.logs?.observeWorkerStderr(cwd, safe);
      },
      onStatus: (info) => {
        // Captures are ended by `onWorkerGone`, which names the exact process
        // (RP-7); a status is about a directory and could end a successor's.
        if (info.status === "crashed") {
          this.attention.workerCrashed(info.cwd, info.message ?? "worker crashed");
          this.forgetSessionsOf(info.cwd, "the worker stopped");
        } else if (info.status === "ready") this.attention.workerRecovered(info.cwd);
        else if (info.status === "retired") {
          this.agentFailureRecovery.forget(info.cwd);
          this.attention.workerRetired(info.cwd);
          this.forgetSessionsOf(info.cwd, "the worker went to sleep");
          this.runs.workerLost(info.cwd);
        }
        this.logs?.observeWorkerStatus(info);
      },
      agentIsolation: (cwd) => this.projects.agentIsolationOf(cwd),
      prepareTrust: (cwd) => {
        // Catalog membership is necessary, never sufficient intent. No mkdir,
        // trust question, environment hook or Namer qualification on a hint.
        const project = this.projects.list().find((item) => item.cwd === cwd);
        if (!project || !existsSync(cwd)) return undefined;
        if (project.trust === "trusted") return { projectTrusted: true };
        if (project.trust === "not_required") return {};
        return undefined;
      },
      resolveTrust: (cwd) => {
        // All spawn routes (including recovery and settings) pass here. The
        // projectless Settings worker is intentional too, but its folder must
        // still be refused by every project/session creation entry point.
        if (workspaceAgentFor(cwd, workspaces) || canonical(cwd) === canonical(this.setup.cwd)) {
          const problem = ensureWorkspace(cwd);
          if (problem) throw new Error(`The conversation's workspace could not be created: ${problem}. Check the folder's permissions and try again.`);
        } else {
          this.projects.assertProject(cwd);
        }
        return this.projects.ensureTrusted(cwd);
      },
      // No worker starts until the command-log root has been cleaned: that
      // cleanup is only safe while nothing is writing there (RP-6).
      beforeSpawn: () => this.taskLogCleanup,
      isAttached: (cwd) => this.isAttached(cwd),
      hasLiveRun: (cwd) => this.runs.hasLiveRun(cwd),
      // The pid is only knowable at spawn. Recording it reads nothing and
      // blocks nothing; the identity is proved later against a collected table.
      resources: {
        noteWorker: (cwd, pid) => this.resources.ownership.noteWorker(cwd, pid),
        // The generation travels with the exit, so a dying worker cannot
        // delete the record of the one that took its pid.
        noteExit: (pid, generation) => this.resources.ownership.noteExit(pid, generation),
      },
    };
    this.pool = new WorkerPool(poolOptions);
    // Runtime lifetime, ahead of worker retirement (RP-4). Membership is read,
    // never written: `holders` is RP-6's one authority on who is following what.
    this.sessionLifetime = new SessionLifetime(
      {
        // Membership (RP-6) plus the routed requests in flight (RP-4c): a
        // session a mutation is being routed to is not a candidate at all, so
        // the sweep spends its tick elsewhere instead of being declined.
        holders: (path) => this.sessionMembership().holders(path) + this.routeLeases.routedHolders(path),
        loadedSessions: () => this.pool.loadedSessions(),
        lastActivity: (path) => this.pool.lastSessionActivity(path),
        unload: (cwd, path, reason) => this.pool.unloadSession(cwd, path, reason),
        log: (line) => this.log(line),
      },
      {
        ...(options.workerIdleMs !== undefined ? { workerIdleMs: options.workerIdleMs } : {}),
        ...(options.sessionLifetime ?? {}),
      },
    );

    const activation = new RuntimeActivationGate(stateDir, this.pool, this.runs, this.tasks);
    this.router = new Router(this.pool, this.catalog, {
      attention: this.attention,
      projects: this.projects,
      projectEnv: this.projectEnv,
      views: this.views,
      logs: this.logs,
      logsUnavailable: this.logsUnavailable,
      tasks: this.tasks,
      push: this.push,
      prefs: this.prefs,
      features: this.features,
      publicOrigin: () => this.publicOrigin(),
      packages: this.packages,
      setup: this.setup,
      agents: this.agents,
      runs: this.runs,
      resources: this.resources,
      admission: this.memoryPressure.admission,
      activation,
      revisions: this.revisions,
      projection: this.projection,
      bodyRange: this.bodyRange,
      telemetry: this.telemetry,
      access: this.access,
      audit: this.audit,
      routeLeases: this.routeLeases,
    });

    this.http = createServer((req, res) => this.serveHttp(req, res));
    this.wss = new WebSocketServer({
      server: this.http,
      path: "/ws",
      // A frame this large is not a request anybody meant to make (RP-7). `ws`
      // refuses it before any JSON is parsed and before the router sees it,
      // and closes that one socket; every other connection is untouched.
      maxPayload: FRAME_MAX_BYTES,
      verifyClient: ({ origin, req }, done) => {
        // A direct socket is this machine talking to itself, or it is nothing.
        // Reaching this host from elsewhere means the relay's authenticated
        // Noise session; a TCP peer is not a pairing and must not be admitted
        // with reduced authority, because "reduced" would still be authority
        // (RP-13).
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
          this.log(`refused a WebSocket upgrade from a peer that is not on this machine`);
          done(false, 403, `${PRODUCT_NAME} only accepts connections from this machine`);
          return;
        }
        if (this.isAllowedOrigin(origin)) {
          done(true);
          return;
        }
        this.log(`refused a WebSocket upgrade from origin ${origin}: not a ${PRODUCT_NAME} origin`);
        done(false, 403, `${PRODUCT_NAME} only accepts WebSocket connections from its own origin`);
      },
    });
    this.wss.on("connection", (ws, req) => this.onConnection(
      ws,
      // Locality was proved during the upgrade; what is left is the browser's
      // mandatory `Origin`, which tells the shell and the command line apart
      // from a page this host serves.
      localActor(Boolean(req.headers.origin)),
    ));
  }

  async listen(): Promise<{ host: string; port: number; url: string }> {
    const host = this.options.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.options.port ?? 0, host, () => {
        this.skillsCheck.start();
        this.sessionLifetime.start();
        this.memoryPressure.start();
        resolve();
      });
    });
    const { port } = this.http.address() as AddressInfo;
    this.boundPort = port;
    const url = `http://${host}:${port}`;
    this.log(`${PRODUCT_NAME} host listening on ${url}`);
    await this.startRelay();
    return { host, port, url };
  }

  /**
   * Bring up one outbound relay client per paired device (M6-T5). No-op unless
   * `options.relay` was supplied, which is the default: laser is a local app
   * until somebody links a device.
   *
   * A device whose channel id cannot be derived is reported and skipped rather
   * than aborting the host — the other devices, and the local UI, still work.
   */
  private async startRelay(): Promise<void> {
    const relay = this.options.relay;
    if (!relay || relay.devices.length === 0) return;
    for (const device of relay.devices) {
      let channelId: Uint8Array;
      try {
        channelId = await channelIdFor(relay.staticKeyPair, device.publicKey);
      } catch (error) {
        this.log(
          `relay: cannot derive a channel for ${device.id} — ${error instanceof Error ? error.message : String(error)}. ` +
            `That device's key is unusable; re-pair it.`,
        );
        continue;
      }
      // The device's identity is captured here, once, from what the host
      // knows about the pairing. Nothing a frame carries can contribute.
      const actor = pairedActor(this.environment.id, device.publicKey, device.grants);
      const client = new RelayClient({
        relayUrl: relay.url,
        channelId,
        staticKeyPair: relay.staticKeyPair,
        devicePublicKey: device.publicKey,
        deviceName: device.name,
        handle: (raw, searches) => this.router.handle(raw, { actor, searches }),
        subscribe: (listener) => {
          // A device hears only what its scopes cover (RP-13). Transcript
          // admission still applies inside the relay client itself.
          const scoped = (notification: JsonRpcNotification): void => {
            if (this.access.allowsNotification(notification.method, actor)) listener(notification);
          };
          this.notificationListeners.add(scoped);
          return () => this.notificationListeners.delete(scoped);
        },
        ...(relay.isAuthorized ? { isAuthorized: relay.isAuthorized } : {}),
        ...(relay.shapeTiming !== undefined ? { shapeTiming: relay.shapeTiming } : {}),
        log: (line) => this.log(`[relay ${device.id}] ${line}`),
        onStateChange: (state, detail) => relay.onStateChange?.(device, state, detail),
        onError: (error) => this.log(`[relay ${device.id}] ${error.message}`),
      });
      this.relayClients.push(client);
      client.start();
    }
    this.log(`relay: ${this.relayClients.length} of ${relay.devices.length} device channels started against ${relay.url}`);
  }

  /** Live relay clients, for `pi/worker/*`-style status surfaces and tests. */
  /** Resolves when the start-time command-log cleanup has finished (RP-6). */
  taskLogsCleaned(): Promise<number> {
    return this.taskLogCleanup;
  }

  relayStats(): RelayClientStats[] {
    return this.relayClients.map((client) => client.statistics());
  }

  async close(options: { initiator?: "user" | "harness" } = {}): Promise<void> {
    this.closing = true;
    // Stamp the owner before worker exits arrive. The default is deliberately
    // harness-owned: only an explicit signal/desktop shutdown may invent a
    // person-owned ending; crash cleanup uses the same close path.
    if (options.initiator === "user") this.runs.hostStopping();
    else this.runs.hostCrashed();
    // Captures in flight end as rows, not as retained bytes in a closing host.
    this.captures.clear();
    await Promise.all(this.relayClients.map((client) => client.stop("host shutting down").catch(() => {})));
    this.relayClients.length = 0;
    this.notificationListeners.clear();
    this.skillsCheck.stop();
    // Before the pool: a controller that is disposed publishes nothing, logs
    // nothing and records nothing, so a worker's last message on the way out
    // cannot reach a socket that is closing (RP-8).
    this.memoryPressure.dispose();
    this.sessionLifetime.stop();
    if (this.logFlush) clearTimeout(this.logFlush);
    this.logFlush = undefined;
    this.pendingLogRows = [];
    this.audit.close();
    this.logs?.close();
    this.projects.close();
    this.attention.close();
    this.prefs.close();
    this.agents.close();
    for (const ws of this.clients) ws.close(1001, "host shutting down");
    this.clients.clear();
    this.actors.clear();
    for (const deliveries of this.loadDeliveries.values()) for (const delivery of deliveries) delivery.dispose();
    this.loadDeliveries.clear();
    this.agentFailureRecovery.clear();
    await this.pool.stopAll();
    // After the workers: their exit fails what was still running.
    this.runs.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  /**
   * A worker went away. Every background command it was running died with it,
   * so the fleet is told rather than left with a row that spins forever.
   */
  private forgetSessionsOf(cwd: string, reason: string): void {
    const paths = this.pool.openSessions(cwd);
    this.tasks.workerLost(paths, reason);
    // Nothing that was open in that worker can end now, so the log store's
    // correlation bookkeeping for those sessions is closed too.
    for (const path of paths) this.logs?.forgetSession(path);
  }

  /**
   * The origin a device opens. The relay link when there is one, else this
   * host's own loopback address — which is right for a local browser and
   * useless to a phone, so `HostRelayOptions.publicOrigin` is what makes push
   * links work off this machine.
   */
  private publicOrigin(): string {
    const configured = this.options.relay?.publicOrigin;
    if (configured) return configured.replace(/\/$/, "");
    return `http://${this.options.host ?? "127.0.0.1"}:${this.boundPort ?? this.options.port ?? 0}`;
  }

  /**
   * Which agent a session belongs to, from what the host already holds: the
   * run registry names every child session it has heard of, and the catalog
   * carries the agent record of any session it has scanned. Undefined for a
   * session neither knows yet.
   */
  private agentInfoOf(path: string): SessionAgentInfo | undefined {
    const run = this.runs.latestFor(path);
    if (run) {
      return {
        agentName: run.agentName,
        kind: "child",
        subagentName: run.subagentName,
        ...(run.parent ? { parentPath: run.parent.sessionPath } : {}),
        rootPath: run.rootSessionPath,
        runId: run.runId,
        runStatus: run.status,
      };
    }
    return this.catalog.get(path)?.agent;
  }

  /** Send one host notification to every connected client. */
  notify<M extends keyof HostNotifications>(method: M, params: HostNotifications[M]): void {
    this.broadcast({ jsonrpc: "2.0", method, params });
  }

  // ------------------------------------------------------------- attention

  /**
   * Fold a worker notification into the attention model before it goes out.
   * The host is the only observer that sees every session, so this cannot live
   * in a client.
   */
  private observe(cwd: string, notification: JsonRpcNotification, source?: { generation: string }): void {
    switch (notification.method) {
      case "session/update": {
        const params = notification.params as SessionUpdateParams;
        this.attention.observeUpdate(params.sessionPath, cwd, params.update.kind, params.seq);
        this.logs?.observeSessionUpdate(cwd, params);
        // The transcript changed, so the cached hydration is stale. (The stat
        // check would catch it too, but only once Pi has flushed the file.)
        this.views.invalidate(params.sessionPath);
        // A compaction rewrites the file in place. The catalog's incremental
        // scan assumes append-only and would keep the old offset and message
        // count, so it has to be told.
        if (params.update.kind === "compaction_end") {
          this.catalog.invalidate(params.sessionPath);
          this.revisions.invalidate(params.sessionPath);
        }
        return;
      }
      case "pi/ui/request": {
        const params = notification.params as HostNotifications["pi/ui/request"];
        this.attention.dialogRaised(params.path, cwd, params.id);
        // A child's question is its parent's to answer, inside the parent's
        // conversation; a phone is interrupted only for a top-level session
        // (D-225).
        if (this.agentInfoOf(params.path)?.kind === "child") return;
        // One notification per question, tagged by dialog id so a re-send
        // replaces rather than stacks. Fire and forget: a phone that is not
        // subscribed costs nothing, and a push failure must never block a turn.
        void this.push
          .sendToAll(
            decisionPushPayload({
              origin: this.publicOrigin(),
              sessionPath: params.path,
              projectName: basename(cwd),
              decisionId: params.id,
              title: params.title ?? "A session needs you",
              ...(params.method === "confirm" && params.message !== undefined ? { message: params.message } : {}),
              yesNo: params.method === "confirm",
            }),
            { topic: `decision:${params.id}`, ttlSeconds: 3600, urgency: "high" },
          )
          .catch(() => {});
        return;
      }
      case "pi/ui/event": {
        const params = notification.params as HostNotifications["pi/ui/event"];
        if (params.method === "dialogResolved") this.attention.dialogResolved(params.path, params.id);
        return;
      }
      case "pi/resource/process": {
        // A pid whose meaning the worker knows (RP-1). It is consumed here and
        // dropped in `broadcast`: it carries a host-internal session path and a
        // process id, neither of which is a client's business. Nothing is
        // believed on the strength of this message — the inventory proves
        // `(pid, startToken)` and ancestry against its own collected table
        // before a row is named.
        const params = notification.params as HostNotifications["pi/resource/process"];
        if (params.registrations?.length) {
          this.resources.observeProcessRegistrations(cwd, params.registrations);
        }
        // No exit hints are accepted here, by design: a pid with no start token
        // is not an identity, and honouring "pid 412 has gone" could delete the
        // record of a process another worker started at that number. The next
        // process table decides — a pid that is absent, or whose start token
        // changed, loses its record there (RP-1).
        return;
      }
      case "pi/extension/message": {
        const params = notification.params as HostNotifications["pi/extension/message"];
        // Task messages become `tasks/update` broadcasts; nothing else needs them.
        if (this.tasks.observeExtensionMessage(params.path, params.message)) return;
        // A chunked provider capture is reassembled before it is a row (RP-7).
        if (
          source &&
          observeCapture(this.captures, { cwd, generation: source.generation }, params.path, params.message, (actor, path, meta, reason) =>
            this.logs?.recordProviderAbsent(actor.cwd, path, meta, reason),
          )
        ) {
          return;
        }
        this.logs?.observeExtensionMessage(cwd, params.path, params.message);
        return;
      }
      case "agents/run": {
        // The worker owns the run while it lives; the host keeps the record so
        // it outlives the worker. `agents/event` is transient and only broadcast.
        const { run } = notification.params as HostNotifications["agents/run"];
        const before = this.runs.get(run.runId);
        const stored = this.runs.upsert(run);
        if (before?.status !== stored.status) this.logs?.observeAgentRun(stored);
        return;
      }
      case "pi/providers/login/event": {
        const params = notification.params as HostNotifications["pi/providers/login/event"];
        // After the event is on its way to the clients, never in its path.
        if (params.event.type === "done") setImmediate(() => void this.onProviderConnected(cwd));
        return;
      }
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- agents

  /**
   * A provider was just connected. If Beam has no model yet, propose one and
   * open the choice (once per host run); if Namer still has no model, the new
   * provider set is a reason to benchmark again. Neither blocks anything: the
   * login has already been answered, and a failure only logs.
   */
  private async onProviderConnected(cwd: string): Promise<void> {
    const snapshot = this.agents.snapshot();
    const wantsBeam = snapshot.beam.model === null && snapshot.beam.needsChoice && !this.beamPrompted;
    const wantsNamer = this.namerNeedsQualifying();
    if (!wantsBeam && !wantsNamer) return;
    let worker: WorkerClient;
    try {
      worker = await this.pool.get(cwd);
    } catch (error) {
      this.log(`agents: no worker for ${cwd} after sign-in: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (wantsNamer) void this.qualifyNamer(cwd, worker);
    if (wantsBeam) {
      this.beamPrompted = true;
      try {
        const [providers, catalog] = await Promise.all([
          worker.request<ClientRequests["pi/providers/list"]["result"]>("pi/providers/list", { cwd }),
          worker.request<ClientRequests["pi/models/catalog"]["result"]>("pi/models/catalog", { cwd, settingsView: "effective" }),
        ]);
        const configured = new Set(providers.providers.filter((provider) => provider.configured).map((provider) => provider.id));
        const suggested = suggestBeamModel(catalog.models, { configuredProviders: configured });
        this.agents.setBeamSuggestion(suggested);
        this.notify("agents/beam/choose-model", { suggested });
      } catch (error) {
        // Nothing was shown, so the next sign-in may try again — including
        // when the worker was stopping and never received the request (RP-4).
        this.beamPrompted = false;
        this.log(`agents: could not propose a Beam model: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Benchmark Namer against this worker's connected providers.
   *
   * Naming used to wait for a sign-in performed through the UI during this
   * host run, so an installation whose providers were already connected — the
   * normal case — never qualified and never named anything. Any worker that
   * comes up is enough: the pool primes it, then this runs behind the
   * request that started it.
   *
   * One benchmark at a time for the whole host, one per provider set per run
   * (connecting another provider is a new set and so a new attempt), and a
   * failure only logs and leaves the state retryable.
   */
  private async qualifyNamer(cwd: string, existing?: WorkerClient): Promise<void> {
    if (this.closing || this.namerQualifying || !this.namerNeedsQualifying()) return;
    this.namerQualifying = true;
    try {
      const worker = existing ?? (await this.pool.get(cwd));
      // Nothing here is worth a request into a worker that is going away: the
      // benchmark is background work behind somebody else's request.
      if (this.closing || !worker.alive) return;
      const listed = await worker.request<ClientRequests["pi/providers/list"]["result"]>("pi/providers/list", { cwd });
      const configured = listed.providers.filter((provider) => provider.configured).map((provider) => provider.id).sort();
      // Nothing to name with yet. The sign-in that connects the first provider
      // brings us straight back here.
      if (configured.length === 0) return;
      const providerSet = configured.join(",");
      if (this.namerQualified.has(providerSet)) return;
      // Another attempt may have finished while the provider list was read.
      const snapshot = this.agents.snapshot();
      if (!this.namerNeedsQualifying()) return;
      if (this.closing || !worker.alive) return;
      this.agents.setNamerState({ ...snapshot.namer, status: "qualifying" });
      try {
        const state = await worker.request<NamerState>("agents/namer/qualify", { cwd });
        this.agents.setNamerState(state);
        // Only a usable result spends this provider set. A transient model or
        // formatting failure stays retryable when another worker starts.
        if (state.status === "ready" && state.model) this.namerQualified.add(providerSet);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.agents.setNamerState({ ...snapshot.namer, status: "unqualified", reason });
        this.log(`agents: Namer could not be qualified: ${reason}`);
      }
    } catch (error) {
      this.log(`agents: Namer could not be qualified from ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.namerQualifying = false;
    }
  }

  /**
   * Namer has no model of its own yet. `unavailable` counts only when no
   * connected candidate exists, and connecting one makes that verdict stale;
   * a failed candidate check stays retryable too. A model a person picked, or
   * one a benchmark chose, is `ready` and is never benchmarked over.
   */
  private namerNeedsQualifying(): boolean {
    const { status, model } = this.agents.snapshot().namer;
    return model === null && (status === "unqualified" || status === "unavailable");
  }

  // -------------------------------------------------------------- log store

  /**
   * Batch new rows into one notification. A busy turn produces a row per tool
   * event; sending each as its own frame would out-noise the transcript itself.
   */
  private queueLogAppend(entries: LogEntry[]): void {
    this.pendingLogRows.push(...entries);
    if (this.logFlush) return;
    this.logFlush = setTimeout(() => {
      this.logFlush = undefined;
      const rows = this.pendingLogRows;
      this.pendingLogRows = [];
      if (rows.length > 0) this.notify("pi/logs/append", { entries: rows });
    }, LOG_APPEND_FLUSH_MS);
    this.logFlush.unref?.();
  }

  /** Remove the trusted revision identity before text reaches any log sink/store. */
  private privateLogText(text: string): string {
    return text.replaceAll(this.environment.id, "[private environment identity]");
  }

  /**
   * The environment-command configuration a worker for `cwd` is started with.
   *
   * Two gates before anything is handed down, and both are refusals rather than
   * warnings:
   *
   *   - **Trust.** A project whose trust decision is not "trusted" gets no
   *     environment command. The hook never runs before a person has approved
   *     the project, which is the same rule the worktree setup hook follows.
   *   - **Approval.** The `{command, args}` pair must match the fingerprint
   *     recorded when a person saved it. Editing the store by hand, or any
   *     other change to what would actually execute, makes it stale and the
   *     worker is told the hook is unapproved.
   *
   * A worktree resolves to its owning project first (`projectRootOf`), so a
   * child agent working in `<project>/.worktrees/<name>` gets the project's
   * approved binding rather than nothing.
   */
  private projectEnvForWorker(cwd: string): Record<string, string> {
    const root = projectRootOf(cwd);
    const config = this.projectEnv.get(root);
    if (!config?.enabled) return {};
    const { trust } = this.projects.trustOf(root);
    if (!projectEnvTrustAllows(trust)) return {};
    const worker = projectEnvWorkerConfig(config);
    return worker ? { [ENV.projectEnv]: JSON.stringify(worker) } : {};
  }

  /**
   * One request to a project's worker, from host-side background work.
   *
   * The router has its own retry for client requests; this is the same promise
   * for the calls that do not come through it. A `WorkerRetiredError` means the
   * bytes were never written, so sending them once more is safe even when the
   * call is not idempotent — and by then `pool.get()` has waited for the
   * retirement decision, so the second attempt either reaches the same worker
   * (it refused) or a fresh one (it retired).
   */
  private async askWorker<R>(cwd: string, method: string, params: unknown): Promise<R> {
    try {
      return await (await this.pool.get(cwd)).request<R>(method, params);
    } catch (error) {
      if (!(error instanceof WorkerRetiredError)) throw error;
      return (await this.pool.get(cwd)).request<R>(method, params);
    }
  }

  /**
   * Is any connected client following a session in this directory?
   *
   * One truth for it (RP-6): the per-connection transcript membership, which
   * is reference-counted by connection and scope and now covers paired devices
   * as well as direct sockets. A phone watching a session used to pin nothing,
   * because the relay kept its own delivery and the retirement bookkeeping
   * only saw local sockets.
   */
  private isAttached(cwd: string): boolean {
    for (const membership of this.memberships()) {
      for (const path of membership.paths()) {
        if ((this.pool.cwdOfSession(path) ?? this.catalog.cwdOf(path)) === cwd) return true;
      }
    }
    return false;
  }

  /**
   * What this host and its live workers are retaining, for the Advanced
   * resource surface (RP-3). Counts and bytes of *state*, not of memory: a
   * task record is metadata, a delivery membership is a subscription, and
   * neither pretends to be a share of a process's footprint.
   *
   * Only workers that are **already running** are asked, with a bound: this is
   * a diagnostic, and a diagnostic must never start a worker or wait on one.
   * A worker that does not answer inside the bound leaves its numbers out and
   * makes the coverage incomplete, because a partial sum presented as a total
   * is the one thing this whole surface exists not to do.
   */
  private async retainedStores(): Promise<ResourceRetainedStores> {
    /** A worker that does not answer in time is missing coverage, not a delay. */
    const bounded = <T>(work: Promise<T>): Promise<T | undefined> =>
      new Promise<T | undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), RETAINED_STORES_TIMEOUT_MS);
        timer.unref?.();
        work.then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          () => {
            clearTimeout(timer);
            resolve(undefined);
          },
        );
      });
    const registry = this.tasks.retained();
    const delivery = this.sessionMembership().counts();
    const live = this.pool.liveClients();
    const answers = await Promise.all(
      live.map(async ({ client }) => {
        return bounded(client.request<ClientRequests["pi/worker/retained-stores"]["result"]>("pi/worker/retained-stores", {}));
      }),
    );
    const answered = answers.filter((answer): answer is ClientRequests["pi/worker/retained-stores"]["result"] => answer !== undefined);
    let workerTaskCount = 0;
    let workerTaskBytes = 0;
    // RP-4's rows live entirely inside the workers, so a sum of them is only a
    // total when every live worker answered; otherwise they are left out
    // rather than reported as a number that quietly means "some of them".
    let runtimes = 0;
    let replayCount = 0;
    let replayBytes = 0;
    let caches = 0;
    let workerQueueBytes = 0;
    let workerQueueFrames = 0;
    for (const answer of answered) {
      workerTaskCount += answer.stores.taskRegistry?.count ?? 0;
      workerTaskBytes += answer.stores.taskRegistry?.bytes ?? 0;
      runtimes += answer.stores.workerSessions?.count ?? 0;
      replayCount += answer.stores.workerReplay?.count ?? 0;
      replayBytes += answer.stores.workerReplay?.bytes ?? 0;
      caches += answer.stores.workerCaches?.count ?? 0;
      workerQueueBytes += answer.stores.providerQueues?.bytes ?? 0;
      workerQueueFrames += answer.stores.providerQueues?.count ?? 0;
    }
    const complete = answered.length === live.length;
    // Bytes in transit, and the captures being reassembled from them (RP-7).
    // The host's own outbound queues and its links to each worker are exact;
    // the workers' own side is only added when every one of them answered.
    const captures = this.captures.retained();
    const queues = this.transportQueues();
    return {
      entries: {
        taskRegistry: {
          count: registry.count + workerTaskCount,
          // Bytes are only honest when every live worker answered: the host's
          // own records are a fraction of what the tails cost.
          ...(complete ? { bytes: registry.bytes + workerTaskBytes } : {}),
        },
        ...(complete
          ? {
              workerSessions: { count: runtimes },
              workerReplay: { count: replayCount, bytes: replayBytes },
              workerCaches: { count: caches },
            }
          : {}),
        providerQueues: {
          // Frames in flight and captures being reassembled — never a count of
          // connections, which an idle socket would inflate.
          count: queues.frames + workerQueueFrames + captures.open,
          ...(complete ? { bytes: queues.bytes + captures.bytes + captures.reservedBytes + workerQueueBytes } : {}),
        },
        deliveryRegistry: {
          count: delivery.owners,
          // Queued transport bytes belong to the transport (RP-7); membership
          // itself holds no payload, and saying "0 bytes" would read as a
          // measurement rather than as the absence of one.
        },
      },
      coverage: {
        workers: live.length,
        answered: answered.length,
        complete,
        ...(complete ? {} : { reason: "collector_failed" as const }),
      },
    };
  }

  /**
   * Bytes this host is holding for somebody else right now (RP-7): queued for
   * direct sockets, queued for each paired device, and sitting in the pipes to
   * its own workers. Counted once each, and never containing anything but
   * numbers.
   */
  private transportQueues(): TransportQueues {
    const sources: TransportQueueSource[] = [];
    for (const pressure of this.pressure.values()) {
      sources.push({
        pendingFrames: () => pressure.snapshot().inFlight,
        queuedBytes: () => pressure.snapshot().queuedBytes,
      });
    }
    for (const client of this.relayClients) {
      sources.push({
        pendingFrames: () => client.transportPressure().pendingFrames,
        queuedBytes: () => client.transportPressure().queuedBytes,
      });
    }
    for (const { client } of this.pool.liveClients()) {
      sources.push({
        // Messages this host has written to that worker and it has not taken.
        // A partial frame being read is bytes, not a message: it is counted in
        // the bytes below and never as a frame.
        pendingFrames: () => client.transportPressure().pendingFrames,
        queuedBytes: () => {
          const link = client.transportPressure();
          return link.pending + (link.decoder?.retained ?? 0);
        },
      });
    }
    return collectTransportQueues(sources);
  }

  /** Every connection's membership: direct sockets first, then paired devices. */
  private memberships(): SessionMembershipView[] {
    return [...this.transcripts.values(), ...this.relayClients.map((client) => client.membership())];
  }

  /**
   * Holders of one session across every connection, and the totals behind
   * them. Read-only, and the only thing anything outside this file may use:
   * RP-4's unload policy consumes `holders(path) > 0` as one of its guards and
   * never writes membership itself. A hold counts from the moment a client
   * asks to attach, not from the moment the attach is answered: retiring a
   * worker between the request and its reply is exactly the race that guard
   * exists to stop.
   */
  sessionMembership(): { holders(path: string): number; counts(): { connections: number; paths: number; owners: number } } {
    return {
      holders: (path) => this.memberships().reduce((sum, membership) => sum + membership.holders(path), 0),
      counts: () => {
        const all = this.memberships();
        const paths = new Set<string>();
        let owners = 0;
        for (const membership of all) {
          for (const path of membership.paths()) paths.add(path);
          owners += membership.counts().owners;
        }
        return { connections: all.length, paths: paths.size, owners };
      },
    };
  }

  // ------------------------------------------------------------- sockets

  /**
   * Is this direct socket a *window* looking at this host right now (RP-8)?
   *
   * Not "is anything connected": the command line and scripts are direct
   * sockets too. A browser proves itself with the Origin-derived actor; the
   * native shell proves itself by sending a desktop report this host verifies.
   * This one predicate owns both renderer-presence accounting and publication,
   * so tooling can never count as a window without also being a recipient.
   */
  private isWindowSocket(ws: WebSocket): boolean {
    if (ws.readyState !== ws.OPEN) return false;
    return this.actors.get(ws)?.class === "local_browser" || this.verifiedDesktopReporters.has(ws);
  }

  private hasWindowSocket(): boolean {
    for (const ws of this.clients) if (this.isWindowSocket(ws)) return true;
    return false;
  }

  /**
   * The pressure summary, to the windows on this machine and nothing else (RP-8).
   *
   * Deliberately not `broadcast`: that writes to the relay listeners too, and a
   * paired device's memory is its own business — a host in trouble must not
   * make a phone release what it is showing. Every gate a direct notification
   * already passes still applies (a proved actor, the diagnostics scope, the
   * transcript filter, a `session/load` in flight, and outbound transport
   * pressure, which may shed this one because `resource/snapshot` carries the
   * same summary).
   */
  private publishPressure(publication: MemoryPressurePublish): void {
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method: "resource/pressure", params: publication };
    let line: string | undefined;
    for (const ws of this.clients) {
      if (this.isWindowSocket(ws)) this.emit(ws, notification, () => (line ??= JSON.stringify(notification)));
    }
  }

  private broadcast(notification: JsonRpcNotification): void {
    // Captures have already reached LogStore in observe(). Views inspect the
    // redacted retained body via logs/query + logs/content, not this raw event.
    // Filter before serialization and before relay listeners/frame admission.
    // Process registrations are consumed by the inventory and go no further:
    // no client, no relay listener and no audit ever sees a pid (RP-1/RP-6).
    if (notification.method === "pi/resource/process") return;
    // Belt and braces for RP-8: the pool already routes a worker's pressure
    // report away from this path, and if one ever reached it, it would stop
    // here rather than travel to a client or a relay listener.
    if (notification.method === "pi/resource/pressure") return;
    if (notification.method === "pi/extension/message") {
      const { message } = notification.params as HostNotifications["pi/extension/message"];
      // One predicate over every capture message, so a new one cannot slip
      // past this filter into a client, a relay listener or an audit line.
      if (isProviderCaptureMessage(message)) return;
    }
    let line: string | undefined;
    for (const ws of this.clients) this.emit(ws, notification, () => (line ??= JSON.stringify(notification)));
    for (const listener of this.notificationListeners) {
      // One relayed device throwing must not cost the others their stream.
      try {
        listener(notification);
      } catch (error) {
        this.log(`relay listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Which browser origins may open `/ws`.
   *
   * No `Origin` at all means a non-browser client (the CLI, a test, curl) and is
   * allowed: a browser always sends one, so this rule costs those clients
   * nothing and still refuses every page on the web. `null` (a `file://`
   * document, a sandboxed frame) is treated as unknown and refused; the desktop
   * shell passes its own renderer origin through `allowedOrigins`.
   */
  private isAllowedOrigin(origin: string | undefined): boolean {
    if (origin === undefined || origin === "") return true;
    const port = this.boundPort;
    if (port !== undefined) {
      for (const hostname of ["127.0.0.1", "localhost", "[::1]"]) {
        if (origin === `http://${hostname}:${port}`) return true;
      }
    }
    return (this.options.allowedOrigins ?? []).includes(origin);
  }

  /**
   * The one way a notification reaches a direct socket.
   *
   * Broadcast and the replay a client gets on connect both go through here, so
   * there is a single place where the order is decided and a single place to
   * change it: the connection must be open and **proved** (no actor is a drop,
   * never a send), its scopes must cover the notification (RP-13), the
   * transcript filter must admit it, and a `session/load` in flight may hold
   * it for ordering. Only then does it go out.
   */
  private emit(ws: WebSocket, notification: JsonRpcNotification, serialize?: () => string): boolean {
    if (ws.readyState !== ws.OPEN) return false;
    const actor = this.actors.get(ws);
    // Fail closed: a socket the host cannot name is a socket that hears nothing.
    if (!actor) return false;
    if (!this.access.allowsNotification(notification.method, actor)) return false;
    if (!this.transcripts.get(ws)?.accepts(notification)) return false;
    const held = [...(this.loadDeliveries.get(ws) ?? [])]
      .map((delivery) => delivery.offer(notification))
      .some(Boolean);
    if (held) return true;
    // Pressure is the last gate, after admission (RP-7): a connection that is
    // behind releases the three notifications it can read back explicitly, and
    // one that would fall too far behind is closed rather than queued for.
    // The size is part of that decision, so the frame that would cross the
    // mark is refused before it is written rather than after.
    const pressure = this.pressure.get(ws);
    const line = serialize ? serialize() : JSON.stringify(notification);
    const verdict = pressure?.admit(notification.method, Buffer.byteLength(line, "utf8")) ?? "send";
    if (verdict !== "send") return false;
    void this.sendSocket(ws, line);
    return true;
  }

  private onConnection(ws: WebSocket, actor: ActorIdentity): void {
    this.clients.add(ws);
    this.actors.set(ws, actor);
    this.pressure.set(
      ws,
      new OutboundPressure({
        // The socket's own view, as a second opinion: a `ws` callback settles
        // our account when the frame leaves our queue, not when the kernel
        // takes it (RP-7).
        bufferedAmount: () => ws.bufferedAmount,
        onShed: ({ method, total }) => this.log(`a client is behind: released ${total} ${method} notification(s) it can read back`),
        onFence: ({ reason, queuedBytes }) => {
          this.log(`disconnecting a client: ${fenceReasonText(reason)} (${queuedBytes} bytes queued)`);
          try {
            ws.close(1013, "reconnect to catch up");
          } catch {
            /* already closing; `dropClient` still runs on close */
          }
        },
      }),
    );
    const transcripts = new TranscriptDelivery();
    this.transcripts.set(ws, transcripts);
    const searches = new SearchCancellation();
    this.searches.set(ws, searches);
    this.loadDeliveries.set(ws, new Set());
    // A client that connects while a project is waiting on a trust decision
    // must see the question, not a worker that never starts.
    for (const request of this.projects.pendingTrustRequests()) {
      this.emit(ws, { jsonrpc: "2.0", method: "pi/project/trust_request", params: request });
    }
    ws.on("message", async (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        // Through the same bounded sender as every other reply: a peer that
        // never reads must not be able to build an uncharged queue by sending
        // malformed JSON (RP-7).
        await this.sendSocket(ws, JSON.stringify({ jsonrpc: "2.0", id: 0, error: { code: -32700, message: "invalid JSON" } }));
        return;
      }
      const request = raw as { method?: unknown; params?: { path?: unknown; id?: unknown } } | null;
      const delivery = request?.method === "session/load" && typeof request.params?.path === "string"
        ? new SessionLoadDelivery(request.params.path)
        : undefined;
      if (delivery) this.loadDeliveries.get(ws)?.add(delivery);
      const admission = transcripts.begin(raw);
      if (admission.refusal !== undefined) {
        // Refused before the router: a load this connection cannot follow must
        // not become work in a worker, and the person is told why (RP-6).
        delivery?.dispose();
        if (delivery) this.loadDeliveries.get(ws)?.delete(delivery);
        const id = (raw as { id?: string | number } | null)?.id ?? null;
        await this.sendSocket(ws, JSON.stringify({ jsonrpc: "2.0", id, error: { code: ErrorCodes.InvalidParams, message: admission.refusal } }));
        return;
      }
      const finishTranscript = admission.finish;
      let transcriptResponse;
      try {
        const response = await this.router.handle(raw, { actor, searches });
        transcriptResponse = response;
        if (!response.error && request?.method === "resource/report") {
          const result = response.result as { verified?: unknown } | undefined;
          if (result?.verified === true) this.verifiedDesktopReporters.add(ws);
        }
        // The one thing a reply still tells this layer: a dialog was answered
        // from a client, so the worker's UI bridge stays silent. What a client
        // is *following* is membership's, per connection and per scope, and
        // retirement reads that one place (`isAttached`).
        if (!response.error && request?.method === "pi/ui/response" && typeof request.params?.id === "string") {
          this.attention.dialogAnswered(request.params.id);
        }
        const sent = await this.sendSocket(ws, JSON.stringify(response));
        if (delivery && sent && !response.error) {
          await delivery.flush((notification) => this.sendSocket(ws, JSON.stringify(notification)));
        }
      } finally {
        finishTranscript(transcriptResponse);
        delivery?.dispose();
        if (delivery) this.loadDeliveries.get(ws)?.delete(delivery);
      }
    });
    ws.on("close", () => this.dropClient(ws));
    ws.on("error", () => this.dropClient(ws));
  }

  /**
   * The one place bytes reach a direct socket, and the one place they are
   * counted (RP-7): responses and notifications alike, from the moment they
   * are enqueued until the send callback settles them.
   */
  private sendSocket(ws: WebSocket, line: string): Promise<boolean> {
    if (ws.readyState !== ws.OPEN || !this.clients.has(ws)) return Promise.resolve(false);
    const pressure = this.pressure.get(ws);
    const bytes = Buffer.byteLength(line, "utf8");
    // The same guard at the moment of the write: a frame that does not fit is
    // not written and not accounted, and the connection is fenced instead.
    if (pressure && !pressure.charge(bytes)) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      try {
        ws.send(line, (error) => {
          pressure?.settle(bytes);
          resolve(!error && ws.readyState === ws.OPEN && this.clients.has(ws));
        });
      } catch {
        pressure?.settle(bytes);
        resolve(false);
      }
    });
  }

  private dropClient(ws: WebSocket): void {
    this.clients.delete(ws);
    this.actors.delete(ws);
    this.verifiedDesktopReporters.delete(ws);
    this.pressure.get(ws)?.reset();
    this.pressure.delete(ws);
    this.transcripts.delete(ws);
    this.searches.get(ws)?.close();
    this.searches.delete(ws);
    const deliveries = this.loadDeliveries.get(ws);
    if (deliveries) for (const delivery of deliveries) delivery.dispose();
    this.loadDeliveries.delete(ws);
  }

  /**
   * Static file serving, and nothing else, is allowed to fail here: a throw out
   * of a request listener becomes an `uncaughtException`, and the daemon
   * answers that by shutting the whole host down mid-turn. So every path out of
   * this function ends in a response.
   */
  private serveHttp(req: IncomingMessage, res: ServerResponse): void {
    try {
      this.serveFile(req, res);
    } catch (error) {
      this.log(`http request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(`${PRODUCT_NAME} could not serve that request`);
    }
  }

  private serveFile(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify({
          status: "ok",
          launchId: this.launchId,
          ...(this.options.runtimeGeneration ? { generationId: this.options.runtimeGeneration.generationId } : {}),
        }));
      return;
    }
    if (!this.uiDir) {
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(`<!doctype html><title>${PRODUCT_NAME}</title><p>${PRODUCT_NAME} host is running. Build <code>@lasercode/ui</code> to serve the app.</p>`);
      return;
    }
    // `/%25%` is a valid pathname and an invalid escape: decoding it throws.
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" }).end("that URL is not a valid percent-encoded path");
      return;
    }
    const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
    const root = resolvePath(this.uiDir);
    let file = resolvePath(join(root, rel));
    // A bare prefix test would also accept a sibling directory that happens to
    // start with the same characters (`<uiDir>-backup/...`).
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (statSync(file).isDirectory()) file = join(file, "index.html");
    } catch {
      file = join(root, "index.html"); // SPA fallback
    }
    try {
      const body = readFileSync(file);
      // Vite writes a content hash into every `assets/*` name, so a stale copy
      // is impossible: telling Chromium so lets it keep the compiled bytecode
      // of the app bundle between launches instead of parsing it every time.
      // `index.html` and the service worker stay unhinted and are re-read
      // on every navigation, which is how a new build is noticed.
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        ...(HASHED_ASSET.test(relative(root, file)) ? { "cache-control": "public, max-age=31536000, immutable" } : {}),
      }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  }
}
