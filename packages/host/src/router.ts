/**
 * Router — turns a client's JSON-RPC request into a worker call, or answers it
 * from the host's own state.
 *
 * Answered here, never by a worker:
 *   pi/session/list      catalog, decorated with attention
 *   pi/session/inbox     the same, attention-sorted and filtered to what wants you
 *   pi/session/seen      attention bookkeeping
 *   pi/session/entries   from the hydrated-view cache when the file has not moved
 *   pi/project/*         the project registry (M2-T4)
 *   pi/worker/*          the worker pool (M2-T1)
 *   agents/*             the agent store and the run registry (docs/agents-leap),
 *                        except the three the engine must answer (below) and
 *                        `agents/runs/stop`, which goes to the run's own worker
 *
 * Routed to one worker:
 *   session/new          worker for params.cwd
 *   session/load         worker for the cwd that owns the path (pool memory,
 *                        else the run registry, else the session file header
 *                        via the catalog — a child's worktree maps to its project)
 *   agents/skills, agents/engine-instructions, agents/namer/qualify
 *                        worker for params.cwd (they need the engine)
 *   everything with a path → same lookup
 *   pi/ui/response       every live worker (the worker that owns the dialog id
 *                        answers; the others ignore it)
 */
import { ErrorCodes, PRODUCT_DISPLAY_NAME, PRODUCT_NAME, ProtocolError, decisionPushPayload, isTerminalRunStatus, parseClientRequest, type AgentRun, type JsonRpcError, type JsonRpcResponse, type NamerState, type SessionAttention, type SessionState, type SessionSummary, type TypedClientRequest } from "@lasercode/protocol";
import { unlinkSync } from "node:fs";
import { PRODUCT_VERSION } from "@lasercode/protocol";
import type { AgentRunRegistry } from "./agents/runs.js";
import { removeRunWorktree } from "./agents/worktrees.js";
import type { AgentStore } from "./agents/store.js";
import type { AttentionTracker } from "./attention.js";
import type { SessionCatalog } from "./catalog.js";
import { searchSessions } from "./session-search.js";
import type { LogStore } from "./logstore.js";
import { browseDirectories, type PackageService, type SetupService } from "./packages.js";
import type { PanelHub } from "./panels/hub.js";
import { ensureWorkspace, projectRootOf } from "./paths.js";
import type { PrefsStore } from "./prefs.js";
import type { FeatureService } from "./features.js";
import type { ProjectRegistry } from "./projects.js";
import type { PushService } from "./push.js";
import type { SubagentsLayer } from "./subagents/layer.js";
import { canonical } from "./trust.js";
import type { ViewCache } from "./views.js";
import type { WorkerPool } from "./worker-pool.js";
import { WorkerRpcError } from "./worker-client.js";

/** Attention order for the inbox (DESIGN.md "Status language"). */
const ATTENTION_RANK: Record<SessionAttention, number> = {
  waiting_for_input: 0,
  error: 1,
  finished_unread: 2,
  working: 3,
  idle: 4,
};

const DEFAULT_INBOX_LIMIT = 50;

export interface RouterDeps {
  attention: AttentionTracker;
  projects: ProjectRegistry;
  views: ViewCache;
  /** M4 log store. Absent when the host could not open it (see LogStore). */
  logs?: LogStore | undefined;
  /** Why the log store is missing, so `pi/logs/*` can say so instead of 404ing. */
  logsUnavailable?: string | undefined;
  /** The panel hub (docs/ux-panels.md): answers `pi/panel/list` and `pi/panel/read`. */
  panels?: PanelHub | undefined;
  /**
   * The pi-subagents file layer. It owns the panels it discovered on disk, so
   * it also answers their actions: a terminal-started session has no worker to
   * route `pi/panel/action` to, and steering one is a file, not an RPC.
   */
  subagents?: SubagentsLayer | undefined;
  /** Web Push (M7-T5). */
  push?: PushService | undefined;
  /**
   * Package policy (M10-T5): pins versions, verifies installs, keeps the lock,
   * answers the catalog. When present it answers every `pi/packages/*` and
   * forwards the mechanics to the worker itself; absent, they route as before.
   */
  packages?: PackageService | undefined;
  /** First-run state (M10-T6). */
  setup?: SetupService | undefined;
  /** laser's own preferences (M11-T6). Host-owned; never Pi's settings file. */
  prefs?: PrefsStore | undefined;
  /** Laser-owned feature manifests and enablement. */
  features?: FeatureService | undefined;
  /** The origin a phone opens, for the URLs inside a notification. */
  publicOrigin?: (() => string) | undefined;
  /** Agent definitions (docs/agents-leap). Absent = the `agents/*` methods are refused. */
  agents?: AgentStore | undefined;
  /** Agent runs the host has heard of; routes a child session to its project's worker. */
  runs?: AgentRunRegistry | undefined;
}

/** Methods answered by the worker that owns `params.cwd` (M4). */
const CWD_ROUTED = new Set([
  "pi/settings/list",
  "pi/settings/get",
  "pi/settings/set",
  "pi/providers/list",
  "web-search/status",
  "web-search/configure",
  "pi/models/catalog",
  // Signing in (M10-T6): every message names the cwd so the worker that holds
  // the flow is the one that hears the answer.
  "pi/providers/login/start",
  "pi/providers/login/answer",
  "pi/providers/login/cancel",
  "pi/providers/logout",
  // The keybindings file is global, not per project; `cwd` only picks a worker
  // (the host imports no Pi, so only a worker can read the agent's own manager).
  "pi/keybindings/get",
  "pi/keybindings/set",
  // The `@` popover's file list, answered by the worker that owns the directory.
  "pi/project/files",
  // Dictation is per project: `status` and `begin` name a cwd; the id-carrying
  // chunk/end/cancel are routed by the upload table below.
  "pi/transcribe/status",
  "pi/transcribe/begin",
  // The git status of a project. The UI always sends a `path` as well, but the
  // CLI and any cwd-only caller must still reach the right worker.
  "pi/project/git",
  // The engine discovers skills and owns its built-in instructions; the Namer
  // benchmark needs a provider. All three name the cwd whose worker answers.
  "agents/skills",
  "agents/engine-instructions",
  "agents/namer/qualify",
]);

/** Dictation methods that carry only an upload id, routed by `uploads`. */
const UPLOAD_ROUTED = new Set(["pi/transcribe/chunk", "pi/transcribe/end", "pi/transcribe/cancel"]);

export class Router {
  /**
   * Sessions a worker holds open that Pi has not written to disk yet. Pi
   * persists lazily, so a session created by `session/new` is invisible to the
   * catalog until its first message lands — without this a brand-new session is
   * missing from the sidebar (and from `laser sessions`) until the first turn.
   * An entry is dropped as soon as the catalog sees the file or the worker
   * closes it, so nothing here can outlive the real session.
   */
  private readonly unwritten = new Map<string, SessionSummary>();

  /** Dictation upload id → cwd, so a chunk reaches the worker that opened it. */
  private readonly uploads = new Map<string, string>();

  constructor(
    private readonly pool: WorkerPool,
    private readonly catalog: SessionCatalog,
    private readonly deps: RouterDeps,
  ) {}

  async handle(raw: unknown): Promise<JsonRpcResponse> {
    const id = (raw as { id?: string | number } | null)?.id ?? 0;
    try {
      const req = parseClientRequest(raw);
      const clientVersion = (raw as { clientVersion?: string }).clientVersion;
      if (req.method !== "pi/host/version" && clientVersion && clientVersion !== PRODUCT_VERSION) {
        throw new ProtocolError(ErrorCodes.VersionMismatch, "Refresh this view to match the host before continuing.", { version: PRODUCT_VERSION });
      }
      const result = await this.dispatch(req);
      return { jsonrpc: "2.0", id: req.id, result };
    } catch (error) {
      return { jsonrpc: "2.0", id, error: toRpcError(error) };
    }
  }

  private packages(): PackageService {
    if (!this.deps.packages) {
      throw new ProtocolError(ErrorCodes.Unsupported, "this host was started without package management");
    }
    return this.deps.packages;
  }

  private setup(): SetupService {
    if (!this.deps.setup) throw new ProtocolError(ErrorCodes.Unsupported, "this host keeps no first-run state");
    return this.deps.setup;
  }

  /**
   * Catalog rows with attention (and `seenAt`) filled in, plus sessions no
   * worker has persisted yet, plus — for a session an agent runs — the latest
   * run's id and status from the registry.
   */
  sessions(cwd?: string): SessionSummary[] {
    const rows = this.catalog.list(cwd).map(({ size: _size, ...summary }) => summary);
    const known = new Set(rows.map((row) => row.path));
    for (const [path, summary] of this.unwritten) {
      // The catalog has it, or the worker let it go: the stub has done its job.
      if (this.catalog.get(path) || !this.pool.openSessions(summary.cwd).includes(path)) {
        this.unwritten.delete(path);
        continue;
      }
      if (known.has(path)) continue;
      if (cwd !== undefined && summary.cwd !== cwd) continue;
      rows.unshift(summary);
    }
    return this.withRuns(this.deps.attention.decorate(rows));
  }

  /** Stamp the latest run onto every row that belongs to an agent. */
  private withRuns<T extends SessionSummary>(rows: T[]): T[] {
    const registry = this.deps.runs;
    if (!registry || !rows.some((row) => row.agent)) return rows;
    const latest = registry.latestByChildPath();
    return rows.map((row) => {
      const run = row.agent ? latest.get(row.path) : undefined;
      return run ? { ...row, agent: { ...row.agent!, runId: run.runId, runStatus: run.status } } : row;
    });
  }

  /** Remember a session the worker just opened, until Pi writes its file. */
  private noteUnwritten(state: SessionState): void {
    if (this.catalog.get(state.path)) return;
    const now = new Date().toISOString();
    this.unwritten.set(state.path, {
      path: state.path,
      id: state.id,
      cwd: state.cwd,
      ...(state.name ? { name: state.name } : {}),
      createdAt: now,
      modifiedAt: now,
      messageCount: state.messageCount,
    });
  }

  /** Sessions that want a person, most urgent first. */
  inbox(cwd?: string, limit = DEFAULT_INBOX_LIMIT): SessionSummary[] {
    return this.sessions(cwd)
      .filter((session) => (session.attention ?? "idle") !== "idle")
      .sort((a, b) => {
        const rank = ATTENTION_RANK[a.attention ?? "idle"] - ATTENTION_RANK[b.attention ?? "idle"];
        return rank !== 0 ? rank : (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0);
      })
      .slice(0, limit);
  }

  private async dispatch(req: TypedClientRequest): Promise<unknown> {
    // Panels the host discovered itself are answered by the host. Checked
    // before the switch so everything else still routes to a worker unchanged.
    if (req.method === "pi/panel/action" && this.deps.subagents?.handles(req.params.id)) {
      return this.deps.subagents.act(req.params);
    }
    switch (req.method) {
      case "pi/host/version":
        return { version: PRODUCT_VERSION };
      case "pi/session/list":
        return { sessions: this.sessions(req.params.cwd) };

      case "session/search": {
        const { query, cwd, after, before, cursor } = req.params;
        const sessions = this.catalog.list(cwd).filter(s => (!after || s.modifiedAt >= after) && (!before || s.modifiedAt < before));
        return searchSessions(sessions, query, cursor);
      }

      case "pi/session/inbox":
        return { sessions: this.inbox(req.params.cwd, req.params.limit) };

      case "pi/session/seen": {
        const { path } = req.params;
        const cwd = this.cwdOf(path);
        this.deps.attention.markSeen(path, cwd, req.params.seq);
        return { attention: this.deps.attention.attentionOf(path, this.catalog.get(path)?.modifiedAt) };
      }

      case "pi/session/detach": {
        // Bookkeeping only, and deliberately host-side: the socket that sent it
        // is what stops counting as attached (HostServer.noteRequest). Nothing
        // is closed and no worker is touched, so detaching a path that was
        // never loaded is fine.
        return {};
      }

      case "pi/session/delete": {
        const { path } = req.params;
        const entry = this.catalog.list().find((session) => session.path === path);
        if (!entry) throw new ProtocolError(ErrorCodes.SessionNotFound, "That session is no longer on disk.");
        if (this.pool.openSessions(entry.cwd).includes(path)) {
          throw new ProtocolError(ErrorCodes.SessionBusy, "Close this session before deleting its transcript.");
        }
        unlinkSync(path);
        this.catalog.invalidate(path);
        this.deps.views.invalidate(path);
        this.unwritten.delete(path);
        // A child's runs cannot go on without their session, and a deleted
        // child's worktree has no owner left: remove it here, best effort.
        const runs = this.deps.runs;
        if (runs) {
          const owned = runs.byChildPath(path);
          runs.forgetSession(path);
          const worktrees = new Map<string, AgentRun>();
          for (const run of owned) if (run.worktree) worktrees.set(run.worktree.path, run);
          await Promise.all([...worktrees.values()].map((run) => removeRunWorktree(run).catch(() => undefined)));
        }
        return {};
      }

      case "pi/session/entries": {
        const { path } = req.params;
        const cached = this.deps.views.get(path);
        if (cached) return { entries: cached };
        const worker = await this.workerFor(path);
        const result = await worker.request<{ entries: unknown[] }>(req.method, req.params);
        this.deps.views.set(path, result.entries);
        return result;
      }

      case "session/new": {
        const { cwd } = req.params;
        const agentName = this.resolveStartAgent(cwd, req.params.agentName);
        // A workspace must exist before a worker is started in it. The engine
        // records the directory in the session header and refuses to open a
        // session whose directory is gone, so a missing folder is refused
        // here, with its reason, rather than becoming a session nobody can open.
        const workspaceAgent = this.workspaceAgentOf(cwd);
        if (workspaceAgent) {
          const problem = ensureWorkspace(cwd);
          if (problem) {
            throw new ProtocolError(
              ErrorCodes.Internal,
              `${labelOf(workspaceAgent)}'s workspace folder could not be created at ${cwd}: ${problem}. Give ${PRODUCT_DISPLAY_NAME} a writable state directory, then try again.`,
            );
          }
        }
        const worker = await this.pool.get(cwd);
        const result = await worker.request<{ state: SessionState }>(req.method, agentName ? { ...req.params, agentName } : req.params);
        this.pool.bindSession(result.state.path, cwd);
        // A workspace is not a project: Beam and Chat sessions never put one
        // in the project list.
        if (!this.isWorkspace(cwd)) this.deps.projects.touch(cwd);
        this.noteUnwritten(result.state);
        return result;
      }

      case "pi/ui/response": {
        const live = this.pool.liveClients();
        if (live.length === 0) {
          throw new ProtocolError(ErrorCodes.DriverUnavailable, "no worker is running to receive that answer");
        }
        // Every live worker is asked; only the one holding the dialog id can
        // deliver it. If none could, say so — answering into the void and
        // reporting success leaves the agent blocked with nothing on screen.
        const results = await Promise.all(
          live.map(({ client }) =>
            client
              .request<{ delivered?: boolean }>(req.method, req.params)
              .then((r) => r?.delivered === true)
              .catch(() => false),
          ),
        );
        if (!results.some(Boolean)) {
          throw new ProtocolError(
            ErrorCodes.SessionNotFound,
            "that question is no longer waiting for an answer — the session may have restarted, or it timed out",
          );
        }
        return { delivered: true };
      }

      // ---------------------------------------------------------- projects
      case "pi/project/list":
        return { projects: this.deps.projects.list() };

      case "pi/project/add":
        return { project: this.deps.projects.add(req.params.cwd) };

      case "pi/project/reorder":
        return { projects: this.deps.projects.reorder(req.params.cwds) };

      case "pi/project/remove": {
        this.deps.projects.remove(req.params.cwd);
        return {};
      }

      case "pi/project/trust":
        return {
          project: this.deps.projects.setTrust(req.params.cwd, req.params.trusted, req.params.remember ?? false),
        };

      case "pi/project/browse":
        return browseDirectories(req.params.path);

      // Package management is deliberately not part of Laser's product API.
      // These old wire methods remain parseable for a clear breaking-change
      // response instead of falling through and accidentally reaching Pi.
      case "pi/packages/catalog":
      case "pi/packages/runtime":
      case "pi/packages/records":
      case "pi/packages/install":
      case "pi/packages/remove":
      case "pi/packages/update":
      case "pi/packages/check_updates":
      case "pi/packages/list":
        throw new ProtocolError(
          ErrorCodes.Unsupported,
          `${PRODUCT_NAME} provides tested Features; it does not install agent packages. Open Settings → Features.`,
        );

      // ------------------------------------------------------------ M10-T6
      case "pi/setup/state":
        return this.setup().state();
      case "pi/setup/complete":
        return this.setup().complete(req.params.completed);

      // ---------------------------------------------------------- workers
      case "pi/worker/list":
        return { workers: this.pool.workers() };

      case "pi/worker/restart":
        return { worker: await this.pool.restart(req.params.cwd) };

      case "pi/worker/stop": {
        await this.pool.stop(req.params.cwd, "stopped from the app");
        return {};
      }

      // -------------------------------------------------------------- M4
      case "pi/logs/query":
        return this.logs().query(req.params);
      case "pi/logs/content":
        return this.logs().content(req.params.ref, req.params.maxBytes);
      case "pi/logs/stats":
        return { stats: this.logs().stats() };
      case "pi/logs/clear":
        return { deleted: this.logs().clear(req.params.sections) };

      // ------------------------------------------------------- preferences
      case "pi/prefs/get": {
        const store = this.prefs();
        return {
          entries: store.get(req.params.namespace),
          revision: store.currentRevision,
        };
      }
      case "pi/prefs/set":
        return { entry: this.prefs().set(req.params.namespace, req.params.value) };

      // ----------------------------------------------------------- features
      case "feature/list":
        return { features: this.features().list(req.params.cwd) };
      case "feature/set": {
        if (req.params.id === "web-search" && (req.params.enabled === true || (req.params.enabled === null && this.features().list().find((f) => f.manifest.id === "web-search")?.globalEnabled))) {
          const cwd = req.params.cwd ?? this.pool.cwds()[0];
          if (!cwd) throw new Error("Open a project to test your search connection before enabling web search.");
          await (await this.pool.get(cwd)).request("web-search/configure", { cwd, change: { action: "test" } });
        }
        const features = this.features().set(req.params.id, req.params.enabled, req.params.scope, req.params.cwd);
        const targets = req.params.scope === "project" && req.params.cwd ? [req.params.cwd] : this.pool.cwds();
        let restartPending = false;
        for (const cwd of targets) {
          try {
            await this.pool.restart(cwd);
          } catch {
            restartPending = true;
          }
        }
        return { features, restartPending };
      }

      // ------------------------------------------------------------ push
      case "pi/push/config":
        return this.push().config();
      case "pi/push/subscribe":
        return this.push().subscribe(req.params.subscription, req.params.device);
      case "pi/push/unsubscribe": {
        await this.push().unsubscribe(req.params.endpoint);
        return {};
      }
      case "pi/push/test": {
        const origin = this.deps.publicOrigin?.() ?? "http://127.0.0.1";
        const sent = await this.push().send(
          req.params.endpoint,
          decisionPushPayload({
            origin,
            sessionPath: "",
            projectName: PRODUCT_NAME,
            decisionId: "test",
            title: "Notifications are working",
            message: "This is what a session waiting for you looks like.",
            yesNo: false,
          }),
          { ttlSeconds: 60, topic: `${PRODUCT_NAME}_test` },
        );
        return { delivered: sent.delivered, ...(sent.error !== undefined ? { error: sent.error } : {}) };
      }

      // ---------------------------------------------------------- panels
      case "pi/panel/list":
        return this.panels().list(req.params.path);
      case "pi/panel/read":
        return this.panels().read(req.params);
      // `pi/panel/action` carries a session path and falls through to the
      // default: the worker that owns the session delivers it to the extension.

      // ---------------------------------------------------------- agents
      case "agents/list":
        return this.agents().snapshot();
      case "agents/validate":
        return { issues: this.agents().validate(req.params.agent) };
      case "agents/save": {
        const store = this.agents();
        const agent = store.save(req.params.agent);
        return { agent, snapshot: store.snapshot() };
      }
      case "agents/delete": {
        const store = this.agents();
        store.delete(req.params.name);
        return { snapshot: store.snapshot() };
      }
      case "agents/set-default": {
        const store = this.agents();
        store.setDefault(req.params.name);
        return { snapshot: store.snapshot() };
      }
      case "agents/set-policy": {
        const store = this.agents();
        store.setPolicy(req.params.policy);
        return { snapshot: store.snapshot() };
      }
      case "agents/beam/set-model": {
        const store = this.agents();
        store.setBeamModel(req.params.model);
        return { snapshot: store.snapshot() };
      }
      case "agents/namer/set-model": {
        const store = this.agents();
        store.setNamerModel(req.params.model);
        return { snapshot: store.snapshot() };
      }
      case "agents/runs/list":
        return { runs: this.runs().list(req.params.path) };
      case "agents/runs/stop": {
        // The run's own worker ends it (it holds the child session and tells
        // the parent); the host records what the worker says it became.
        const registry = this.runs();
        const run = registry.get(req.params.runId);
        if (!run) throw new ProtocolError(ErrorCodes.SessionNotFound, "That run is no longer known to the app.");
        if (isTerminalRunStatus(run.status)) return { run };
        const worker = await this.pool.get(run.projectCwd);
        const result = await worker.request<{ run: AgentRun }>(req.method, req.params);
        return { run: registry.upsert(result.run) };
      }
      case "agents/sync":
        throw new ProtocolError(ErrorCodes.Unsupported, "The app sends this to its own workers.");

      default:
        break;
    }
    return this.forwardToWorker(req);
  }

  /**
   * Which agent a new session starts with, and whether it may start here. A
   * workspace only runs its own agent; a project never runs a built-in; Namer
   * never runs a session at all. With no agent store the request is passed on
   * untouched, so a host without the feature behaves as before.
   */
  private resolveStartAgent(cwd: string, requested: string | undefined): string | undefined {
    const store = this.deps.agents;
    if (!store) {
      if (requested !== undefined) throw new ProtocolError(ErrorCodes.Unsupported, "This host has no agent definitions.");
      return undefined;
    }
    const workspaceAgent = this.workspaceAgentOf(cwd);
    const name = requested ?? workspaceAgent ?? store.defaultAgentName;
    const agent = store.get(name);
    if (!agent) {
      throw new ProtocolError(ErrorCodes.InvalidParams, `There is no agent named "${name}". Choose one from the Agents page.`, {
        issues: [{ field: "agentName", message: `There is no agent named "${name}".` }],
      });
    }
    if (name === "namer") {
      throw new ProtocolError(ErrorCodes.InvalidParams, "Namer names sessions and actions in the background; it does not run a session.");
    }
    if (workspaceAgent !== undefined && name !== workspaceAgent) {
      throw new ProtocolError(ErrorCodes.InvalidParams, `Only ${labelOf(workspaceAgent)} sessions start in the ${labelOf(workspaceAgent)} workspace.`);
    }
    if (agent.kind === "builtin" && workspaceAgent !== name) {
      throw new ProtocolError(ErrorCodes.InvalidParams, `${labelOf(name)} sessions start in ${PRODUCT_DISPLAY_NAME}'s own ${labelOf(name)} workspace, not in a project.`);
    }
    return name;
  }

  /** `beam` or `chat` when `cwd` is that built-in's workspace. */
  private workspaceAgentOf(cwd: string): "beam" | "chat" | undefined {
    const store = this.deps.agents;
    if (!store) return undefined;
    const key = canonical(cwd);
    const { beam, chat } = store.workspaces;
    if (key === canonical(beam)) return "beam";
    if (key === canonical(chat)) return "chat";
    return undefined;
  }

  private isWorkspace(cwd: string): boolean {
    return this.workspaceAgentOf(cwd) !== undefined;
  }

  /**
   * A Beam or Chat session by its own record, whatever directory its header
   * names: a session created while the workspaces lived elsewhere must not
   * turn that old directory into a project when it is opened.
   */
  private isWorkspaceSession(path: string): boolean {
    const kind = this.catalog.list().find((session) => session.path === path)?.agent?.kind;
    return kind === "beam" || kind === "chat";
  }

  /**
   * Anything the host does not answer itself goes to a worker: by `cwd` for the
   * per-project methods, by upload id for dictation chunks, by session path
   * for everything else.
   */
  private async forwardToWorker(req: TypedClientRequest): Promise<unknown> {
    // A brand-new composer has a project but no session path yet. The worker
    // answers from a disposable Pi runtime, so listing commands does not
    // create an empty transcript.
    if (req.method === "pi/commands/list" && "cwd" in req.params) {
      const { cwd } = req.params as { cwd: string };
      return (await this.pool.get(cwd)).request(req.method, req.params);
    }
    // Settings, packages, providers and models are per project, not per
    // session: they name a cwd and go to that project's worker.
    if (CWD_ROUTED.has(req.method)) {
      const { cwd } = req.params as { cwd: string };
      const worker = await this.pool.get(cwd);
      const result = await worker.request(req.method, req.params);
      // Remember which worker opened this upload: the chunks that follow carry
      // an id and nothing else.
      if (req.method === "pi/transcribe/begin") {
        const id = (result as { id?: string } | null)?.id;
        if (id) this.uploads.set(id, cwd);
      }
      // The benchmark's verdict is the host's to keep: every client and every
      // worker hears it through the store's own change notification.
      if (req.method === "agents/namer/qualify" && this.deps.agents && isNamerState(result)) {
        this.deps.agents.setNamerState(result);
      }
      return result;
    }

        if (UPLOAD_ROUTED.has(req.method)) {
          const { id } = req.params as { id: string };
          const cwd = this.uploads.get(id);
          if (!cwd) {
            throw new ProtocolError(
              ErrorCodes.InvalidParams,
              "that recording is no longer open — start dictating again",
            );
          }
          if (req.method !== "pi/transcribe/chunk") this.uploads.delete(id);
          return (await this.pool.get(cwd)).request(req.method, req.params);
        }

        const path = (req.params as { path: string }).path;
        const worker = await this.workerFor(path);
        const result = await worker.request(req.method, req.params);
        const cwd = this.pool.cwdOfSession(path);
        if (req.method === "session/load" && cwd && !this.isWorkspace(cwd) && !this.isWorkspaceSession(path)) this.deps.projects.touch(cwd);
        // A fork answers with a new session path served by the same worker; a
        // navigate rewrites the leaf, so the cached transcript is stale.
        const state = (result as { state?: SessionState } | null)?.state;
        const forked = state?.path;
        if (forked && cwd && forked !== path) {
          this.pool.bindSession(forked, cwd);
          if (state) this.noteUnwritten(state);
        }
        if (req.method === "pi/session/fork" || req.method === "pi/session/navigate" || req.method === "pi/session/compact") {
          this.deps.views.invalidate(path);
          // The catalog resumes its byte-offset scan whenever a file only grew.
          // A fork, a navigate and a compaction all rewrite in place, so the
          // cached message count and first message have to be dropped too.
          this.catalog.invalidate(path);
          if (forked) {
            this.deps.views.invalidate(forked);
            this.catalog.invalidate(forked);
          }
        }
        return result;
  }

  /** The agent store, or an error a person can act on. */
  private agents(): AgentStore {
    if (!this.deps.agents) {
      throw new ProtocolError(ErrorCodes.Unsupported, "This host is running without agent definitions, so agents cannot be listed or changed.");
    }
    return this.deps.agents;
  }

  /** The run registry, or an error a person can act on. */
  private runs(): AgentRunRegistry {
    if (!this.deps.runs) {
      throw new ProtocolError(ErrorCodes.Unsupported, "This host is running without a run registry, so agent runs cannot be listed or stopped.");
    }
    return this.deps.runs;
  }

  /** The panel hub, or an error a person can act on. */
  private panels(): PanelHub {
    if (!this.deps.panels) {
      throw new ProtocolError(
        ErrorCodes.Unsupported,
        "This host is running without the panel hub, so panels cannot be listed or read.",
      );
    }
    return this.deps.panels;
  }

  /** The preference store, or an error a person can act on. */
  private prefs(): PrefsStore {
    if (!this.deps.prefs) {
      throw new ProtocolError(
        ErrorCodes.Unsupported,
        "This host is running without a preference store, so it cannot remember settings like the theme.",
      );
    }
    return this.deps.prefs;
  }

  private features(): FeatureService {
    if (!this.deps.features) {
      throw new ProtocolError(ErrorCodes.Unsupported, "This host has no feature registry.");
    }
    return this.deps.features;
  }

  /** The push service, or an error a person can act on. */
  private push(): PushService {
    if (!this.deps.push) {
      throw new ProtocolError(
        ErrorCodes.Unsupported,
        "This host is running without push, so it cannot send notifications to a phone.",
      );
    }
    return this.deps.push;
  }

  /** The log store, or an error a person can act on. */
  private logs(): LogStore {
    if (!this.deps.logs) {
      throw new ProtocolError(
        ErrorCodes.Unsupported,
        this.deps.logsUnavailable ??
          "This host is running without a log store, so there is nothing to show on the logs page.",
      );
    }
    return this.deps.logs;
  }

  /**
   * The project that owns a session path: the pool's memory, else a run that
   * mentions it (a child session is its project's, whatever its header says),
   * else the session header — with a worktree mapped back to its project, so
   * no worker is ever spawned for a `.worktrees/<name>` directory.
   */
  private cwdOf(path: string): string | undefined {
    const known = this.pool.cwdOfSession(path) ?? this.deps.runs?.projectCwdOf(path);
    if (known) return known;
    const header = this.catalog.cwdOf(path);
    return header === undefined ? undefined : projectRootOf(header);
  }

  /** The worker that owns a session path, started if needed. */
  private async workerFor(path: string) {
    const cwd = this.cwdOf(path);
    if (!cwd) throw new ProtocolError(ErrorCodes.SessionNotFound, `no project known for session ${path}`);
    const worker = await this.pool.get(cwd);
    this.pool.bindSession(path, cwd);
    return worker;
  }
}

function labelOf(name: string): string {
  return name === "beam" ? "Beam" : name === "chat" ? "Chat" : name === "namer" ? "Namer" : name;
}

function isNamerState(value: unknown): value is NamerState {
  const state = value as Partial<NamerState> | null;
  return !!state && typeof state === "object" && typeof state.status === "string" && Array.isArray(state.candidates);
}

function toRpcError(error: unknown): JsonRpcError {
  if (error instanceof ProtocolError) {
    return { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) };
  }
  if (error instanceof WorkerRpcError) return error.rpc;
  return { code: ErrorCodes.Internal, message: error instanceof Error ? error.message : String(error) };
}
