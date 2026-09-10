/**
 * HostServer (M1-T1, M2) — HTTP + WebSocket on 127.0.0.1.
 *   GET /           → the UI bundle (SPA fallback), or a placeholder if not built
 *   GET /healthz    → ok
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
 * Every connected client receives every notification; a per-session
 * subscription is not worth its complexity for a handful of local clients, and
 * the relay (M6) carries one client per channel anyway. Binding is loopback
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
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { basename, dirname, extname, join, normalize, resolve as resolvePath, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { channelIdFor, type KeyPair } from "@lasercode/crypto";
import { ENV, PRODUCT_NAME, decisionPushPayload, type ClientRequests, type HostNotifications, type JsonRpcNotification, type LogEntry, type NamerState, type SessionUpdateParams } from "@lasercode/protocol";
import { suggestBeamModel } from "./agents/models.js";
import { AgentRunRegistry } from "./agents/runs.js";
import { SkillsCheck } from "./agents/skills-check.js";
import { AgentStore } from "./agents/store.js";
import { AttentionTracker } from "./attention.js";
import { FeatureService } from "./features.js";
import { PrefsStore } from "./prefs.js";
import { SessionCatalog, defaultSessionDir } from "./catalog.js";
import { LogStore } from "./logstore.js";
import { PackageService, SetupService } from "./packages.js";
import { TaskRegister } from "./tasks/register.js";
import { defaultAgentDir, defaultStateDir, ensureWorkspace, workspacesDir } from "./paths.js";
import { ProjectRegistry } from "./projects.js";
import { PushService } from "./push.js";
import { RelayClient, type RelayClientState, type RelayClientStats } from "./relay-client.js";
import { Router } from "./router.js";
import { ViewCache } from "./views.js";
import type { WorkerClient } from "./worker-client.js";
import { WorkerPool, type WorkerPoolOptions } from "./worker-pool.js";

export interface HostServerOptions {
  host?: string;
  port?: number;
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
  logRetention?: { maxRows?: number; maxAgeDays?: number; providerPayloads?: "full" | "summary" };
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
  /** Untrusted label. Never rendered as markup by anything reading this. */
  name: string;
  /** Raw 32-byte X25519 static public key. */
  publicKey: Uint8Array;
}

/** Update kinds after which Pi may have appended to the session file. */
const PERSISTING_UPDATES = new Set(["message_end", "compaction_end", "entry_appended", "agent_end", "agent_settled"]);

/** New log rows are batched for this long before one notification goes out. */
const LOG_APPEND_FLUSH_MS = 120;

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
  /** Package policy (M10-T5) and first-run state (M10-T6). */
  readonly packages: PackageService;
  readonly setup: SetupService;
  readonly views: ViewCache;
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
  /** Agent definitions (docs/agents-leap): the person's, the seeded default, the three built-ins. */
  readonly agents: AgentStore;
  /** Every agent run a worker reported, kept after the worker is gone. */
  readonly runs: AgentRunRegistry;
  /** Periodic validation of scoped skills and child lists. */
  readonly skillsCheck: SkillsCheck;
  readonly router: Router;
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  /** Session paths each client is following, for the retirement guard. */
  private readonly attached = new Map<WebSocket, Set<string>>();
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

  constructor(private readonly options: HostServerOptions = {}) {
    this.log = options.log ?? (() => {});
    this.uiDir = options.uiDir ?? defaultUiDir();
    const agentDir = options.agentDir ?? defaultAgentDir();
    const stateDir = options.stateDir ?? defaultStateDir();
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
          onAppend: (entries) => this.queueLogAppend(entries),
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

    this.attention = new AttentionTracker({
      storePath: join(stateDir, "attention.json"),
      modifiedAt: (path) => this.catalog.get(path)?.modifiedAt,
      onChange: ({ path, cwd, attention, at }) =>
        this.notify("pi/session/attention", { path, cwd, attention, at }),
      onSeen: (path) => this.notify("pi/session/seen", { path }),
    });

    this.projects = new ProjectRegistry({
      catalog: this.catalog,
      agentDir,
      storePath: join(stateDir, "projects.json"),
      exclude: [workspaces.beam, workspaces.chat],
      ...(options.trustTimeoutMs !== undefined ? { trustTimeoutMs: options.trustTimeoutMs } : {}),
      onChange: (projects) => this.notify("pi/project/updated", { projects }),
      onTrustRequest: (request) => {
        this.log(`project trust: asking about ${request.cwd} (${request.reasons.join(", ")})`);
        this.notify("pi/project/trust_request", request);
      },
      onTrustResolved: (resolved) => this.notify("pi/project/trust_resolved", resolved),
      hasClients: () => this.clients.size > 0,
    });

    this.tasks = new TaskRegister({ notify: (method, params) => this.notify(method, params) });

    this.push = new PushService({ agentDir, log: (line) => this.log(line) });

    // Host-owned, so a theme chosen on the desktop is the theme a paired phone
    // opens with. Every client hears the change, including the one that made it.
    this.prefs = new PrefsStore({
      storePath: join(stateDir, "prefs.json"),
      onChange: (entry) => this.notify("pi/prefs/updated", entry),
    });
    this.features = new FeatureService(this.prefs);

    // The definitions live here; every worker gets a copy when it starts
    // (`prime`, below) and again whenever they change. Clients hear the same
    // snapshot as `agents/updated`.
    this.agents = new AgentStore({
      storePath: join(stateDir, "agents.json"),
      agentDir,
      stateDir,
      workspaces,
      onChange: (snapshot) => {
        this.notify("agents/updated", snapshot);
        void this.pool?.broadcastRequest("agents/sync", { snapshot }).then((results) => {
          for (const result of results) {
            if (result.error) this.log(`agents: the worker for ${result.cwd} did not take the definitions: ${result.error}`);
          }
        });
      },
    });
    this.runs = new AgentRunRegistry({
      storePath: join(stateDir, "agent-runs.json"),
      onRun: (run) => {
        this.notify("agents/run", { run });
        this.logs?.observeAgentRun(run);
      },
    });
    this.skillsCheck = new SkillsCheck({
      agents: () => this.agents.snapshot().agents,
      report: (warnings) => this.agents.setWarnings(warnings),
    });

    // The host resolves the package manager the workers should use — the one
    // the packaged app bundles, or the one on PATH on a developer machine —
    // and hands it down as environment (M10-T5). Settings still win inside.
    this.packages = new PackageService({
      agentDir,
      stateDir,
      forward: async (cwd, method, params) => (await this.pool.get(cwd)).request(method, params),
      log: (line) => this.log(line),
    });
    this.setup = new SetupService({ stateDir });
    const npmCommand = this.packages.npmCommand();
    this.log(npmCommand ? `packages: installer ${npmCommand.join(" ")}` : "packages: no installer found; installs will be refused with a reason");

    const poolOptions: WorkerPoolOptions = {
      ...(options.agentDir ? { agentDir: options.agentDir } : {}),
      ...(npmCommand ? { env: { [ENV.npmCommand]: JSON.stringify(npmCommand) } } : {}),
      envForCwd: (cwd) => ({ [ENV.features]: JSON.stringify(this.features.enabled(cwd)) }),
      ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
      stateDir,
      ...(options.workerMain ? { workerMain: options.workerMain } : {}),
      ...(options.nodeBinary ? { nodeBinary: options.nodeBinary } : {}),
      ...(options.workerIdleMs !== undefined ? { idleMs: options.workerIdleMs } : {}),
      // A worker's first request already sees the agent definitions.
      prime: async (client, cwd) => {
        await client.request("agents/sync", { snapshot: this.agents.snapshot() });
        // Naming must not wait for a sign-in this run may never see. The first
        // worker to come up benchmarks Namer, after priming so nothing that
        // opened this worker waits on it.
        setImmediate(() => void this.qualifyNamer(cwd, client));
      },
      onNotification: (cwd, n) => {
        this.observe(cwd, n);
        this.broadcast(n);
      },
      onStderr: (cwd, text) => {
        this.log(`[worker ${cwd}] ${text.trimEnd()}`);
        this.logs?.observeWorkerStderr(cwd, text);
      },
      onStatus: (info) => {
        if (info.status === "crashed") {
          this.attention.workerCrashed(info.cwd, info.message ?? "worker crashed");
          this.forgetSessionsOf(info.cwd, "the worker stopped");
          this.runs.workerLost(info.cwd);
        } else if (info.status === "ready") this.attention.workerRecovered(info.cwd);
        else if (info.status === "retired") {
          this.attention.workerRetired(info.cwd);
          this.forgetSessionsOf(info.cwd, "the worker went to sleep");
          this.runs.workerLost(info.cwd);
        }
        this.logs?.observeWorkerStatus(info);
      },
      resolveTrust: (cwd) => this.projects.ensureTrusted(cwd),
      isAttached: (cwd) => this.isAttached(cwd),
      hasLiveRun: (cwd) => this.runs.hasLiveRun(cwd),
    };
    this.pool = new WorkerPool(poolOptions);

    this.router = new Router(this.pool, this.catalog, {
      attention: this.attention,
      projects: this.projects,
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
    });

    this.http = createServer((req, res) => this.serveHttp(req, res));
    this.wss = new WebSocketServer({
      server: this.http,
      path: "/ws",
      verifyClient: ({ origin }, done) => {
        if (this.isAllowedOrigin(origin)) {
          done(true);
          return;
        }
        this.log(`refused a WebSocket upgrade from origin ${origin}: not a ${PRODUCT_NAME} origin`);
        done(false, 403, `${PRODUCT_NAME} only accepts WebSocket connections from its own origin`);
      },
    });
    this.wss.on("connection", (ws) => this.onConnection(ws));
  }

  async listen(): Promise<{ host: string; port: number; url: string }> {
    const host = this.options.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.options.port ?? 0, host, () => {
        this.skillsCheck.start();
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
      const client = new RelayClient({
        relayUrl: relay.url,
        channelId,
        staticKeyPair: relay.staticKeyPair,
        devicePublicKey: device.publicKey,
        deviceName: device.name,
        handle: (raw) => this.router.handle(raw),
        subscribe: (listener) => {
          this.notificationListeners.add(listener);
          return () => this.notificationListeners.delete(listener);
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
  relayStats(): RelayClientStats[] {
    return this.relayClients.map((client) => client.statistics());
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.relayClients.map((client) => client.stop("host shutting down").catch(() => {})));
    this.relayClients.length = 0;
    this.notificationListeners.clear();
    this.skillsCheck.stop();
    if (this.logFlush) clearTimeout(this.logFlush);
    this.logFlush = undefined;
    this.pendingLogRows = [];
    this.logs?.close();
    this.projects.close();
    this.attention.close();
    this.prefs.close();
    this.agents.close();
    for (const ws of this.clients) ws.close(1001, "host shutting down");
    this.clients.clear();
    this.attached.clear();
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
    this.tasks.workerLost(this.pool.openSessions(cwd), reason);
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
  private observe(cwd: string, notification: JsonRpcNotification): void {
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
        if (params.update.kind === "compaction_end") this.catalog.invalidate(params.sessionPath);
        return;
      }
      case "pi/ui/request": {
        const params = notification.params as HostNotifications["pi/ui/request"];
        this.attention.dialogRaised(params.path, cwd, params.id);
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
      case "pi/extension/message": {
        const params = notification.params as HostNotifications["pi/extension/message"];
        // Task messages become `tasks/update` broadcasts; nothing else needs them.
        if (this.tasks.observeExtensionMessage(params.path, params.message)) return;
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
          worker.request<ClientRequests["pi/models/catalog"]["result"]>("pi/models/catalog", { cwd }),
        ]);
        const configured = new Set(providers.providers.filter((provider) => provider.configured).map((provider) => provider.id));
        const suggested = suggestBeamModel(catalog.models, { configuredProviders: configured });
        this.agents.setBeamSuggestion(suggested);
        this.notify("agents/beam/choose-model", { suggested });
      } catch (error) {
        // Nothing was shown, so the next sign-in may try again.
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

  /** Is any connected client following a session in this directory? */
  private isAttached(cwd: string): boolean {
    for (const paths of this.attached.values()) {
      for (const path of paths) {
        if ((this.pool.cwdOfSession(path) ?? this.catalog.cwdOf(path)) === cwd) return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------- sockets

  private broadcast(notification: JsonRpcNotification): void {
    const line = JSON.stringify(notification);
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(line);
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

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    this.attached.set(ws, new Set());
    // A client that connects while a project is waiting on a trust decision
    // must see the question, not a worker that never starts.
    for (const request of this.projects.pendingTrustRequests()) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", method: "pi/project/trust_request", params: request }));
    }
    ws.on("message", async (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 0, error: { code: -32700, message: "invalid JSON" } }));
        return;
      }
      const request = raw as { method?: unknown; params?: { path?: unknown; id?: unknown } } | null;
      const response = await this.router.handle(raw);
      if (!response.error) this.noteRequest(ws, request, response.result);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(response));
    });
    ws.on("close", () => this.dropClient(ws));
    ws.on("error", () => this.dropClient(ws));
  }

  /**
   * Remember what this client is following (so an attached worker is never
   * retired) and clear a dialog it just answered (the worker's UI bridge stays
   * silent when the answer came from a client).
   */
  private noteRequest(ws: WebSocket, request: { method?: unknown; params?: { path?: unknown; id?: unknown } } | null, result: unknown): void {
    const method = request?.method;
    if (method === "session/load" && typeof request?.params?.path === "string") {
      this.attached.get(ws)?.add(request.params.path);
      return;
    }
    if (method === "session/new") {
      const path = (result as { state?: { path?: string } } | null)?.state?.path;
      if (path) this.attached.get(ws)?.add(path);
      return;
    }
    if (method === "pi/session/fork") {
      const path = (result as { state?: { path?: string } } | null)?.state?.path;
      if (path) this.attached.get(ws)?.add(path);
      return;
    }
    if (method === "pi/session/detach" && typeof request?.params?.path === "string") {
      // The one thing that made idle retirement fire in practice: without a
      // detach the attached set only ever grew, so every project the user had
      // clicked into today kept its worker for the life of the window.
      this.attached.get(ws)?.delete(request.params.path);
      return;
    }
    if (method === "pi/ui/response" && typeof request?.params?.id === "string") {
      this.attention.dialogAnswered(request.params.id);
    }
  }

  private dropClient(ws: WebSocket): void {
    this.clients.delete(ws);
    this.attached.delete(ws);
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
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
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
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  }
}
