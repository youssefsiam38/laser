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
 *   agents/skills, agents/engine-instructions
 *                        worker for params.cwd (they need the engine)
 *   everything with a path → same lookup
 *   pi/ui/response       every live worker (the worker that owns the dialog id
 *                        answers; the others ignore it)
 */
import { AGENT_ISOLATION_DEFAULTS, ENVIRONMENT_DESCRIBE_METHOD, ErrorCodes, PRODUCT_DISPLAY_NAME, PRODUCT_NAME, PRODUCT_VERSION, ProtocolError, decisionPushPayload, isCheckpointRetention, isTerminalRunStatus, parseClientRequest, type AgentIsolationDefault, type AgentRun, type AgentWorktreeStatus, type CheckpointRetention, type JsonRpcError, type JsonRpcResponse, type ProjectEnvStatus, type SessionAttention, type SessionState, type SessionSummary, type TypedClientRequest } from "@lasercode/protocol";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { HOST_ENVIRONMENT_METHOD, applyHostEnvironment } from "./environment.js";
import { LIFETIME_RETRY } from "@lasercode/protocol";
import { WorkerRetiredError } from "./worker-client.js";
import type { AccessControl, ActorIdentity, RequestAccess } from "./access.js";
import { unknownMethodDigest, type AccessAudit } from "./access-audit.js";
import { destinationFor, rewriteSessionFile } from "./session-move.js";
import type { AgentRunRegistry } from "./agents/runs.js";
import { removeRunWorktree, worktreeStatus } from "./agents/worktrees.js";
import type { AgentStore } from "./agents/store.js";
import type { AttentionTracker } from "./attention.js";
import type { SessionCatalog } from "./catalog.js";
import type { ProjectEnvStore } from "./project-env.js";
import { searchSessions } from "./session-search.js";
import { pageCatalog } from "./catalog-page.js";
import type { SearchCancellation } from "./search-cancellation.js";
import type { LogStore } from "./logstore.js";
import { browseDirectories, type PackageService, type SetupService } from "./packages.js";
import { browseExplorer } from "./directory-explorer.js";
import type { TaskRegister } from "./tasks/register.js";
import { createPrivateSessionWorkspace, ensureWorkspace, isChatWorkspace, isWithinDirectory, projectRootOf } from "./paths.js";
import type { PrefsStore } from "./prefs.js";
import type { FeatureService } from "./features.js";
import type { ProjectRegistry } from "./projects.js";
import type { PushService } from "./push.js";
import { RESOURCE_REPORT_METHOD } from "./resources/guard.js";
import type { PressureAdmission } from "./pressure/index.js";
import type { ResourceService } from "./resources/index.js";
import { deleteAllCheckpoints, deleteSessionCheckpoints } from "./source-control/cleanup.js";
import { writeProjectCheckpointRetention } from "./source-control/settings.js";
import { canonical } from "./trust.js";
import { SessionRouteLeases } from "./session-route-lease.js";
import type { SessionProjection } from "./session-projection.js";
import type { SessionBodyRange } from "./session-body-range.js";
import type { SessionRevisions } from "./session-revision.js";
import type { SessionTelemetryReader } from "./session-telemetry.js";
import type { ViewCache } from "./views.js";
import type { WorkerPool } from "./worker-pool.js";
import { createWorkspaceResolver } from "./workspace.js";
import type { RuntimeActivationGate } from "./runtime-activation.js";
import { WorkerRpcError, type WorkerClient } from "./worker-client.js";

/** Attention order for the inbox (DESIGN.md "Status language"). */
const ATTENTION_RANK: Record<SessionAttention, number> = {
  waiting_for_input: 0,
  error: 1,
  finished_unread: 2,
  working: 3,
  idle: 4,
};

const DEFAULT_INBOX_LIMIT = 50;
type EntriesRequest = Extract<TypedClientRequest, { method: "pi/session/entries" }>;

export interface RouterDeps {
  attention: AttentionTracker;
  projects: ProjectRegistry;
  projectEnv: ProjectEnvStore;
  views: ViewCache;
  /** M4 log store. Absent when the host could not open it (see LogStore). */
  logs?: LogStore | undefined;
  /** Why the log store is missing, so `pi/logs/*` can say so instead of 404ing. */
  logsUnavailable?: string | undefined;
  /** Background tasks (docs/ux-fleet.md): answers `tasks/list`, `tasks/output` and `tasks/stop`. */
  tasks?: TaskRegister | undefined;
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
  /** Injectable clock, for the dictation route sweep. */
  now?: (() => number) | undefined;
  /**
   * Durable session revisions (RP-9). Absent = this host can only answer for a
   * session a worker already owns, and says so rather than inventing one.
   */
  revisions?: SessionRevisions | undefined;
  /** Read-only bounded history pages over the durable revision index (RP-12). */
  projection?: SessionProjection | undefined;
  bodyRange?: SessionBodyRange | undefined;
  telemetry?: SessionTelemetryReader | undefined;
  /**
   * Process inventory (RP-1). Absent = the `resource/*` methods are refused
   * rather than answered with an invented shape.
   */
  resources?: ResourceService | undefined;
  /** Host memory-pressure step 7. Absent only in narrow router tests. */
  admission?: PressureAdmission | undefined;
  /** Immutable update admission gate. Absent only in narrow router tests. */
  activation?: RuntimeActivationGate | undefined;
  /**
   * The boundary's authorization and environment descriptor (RP-13).
   *
   * Required. A Router that could be built without one would be a Router that
   * runs with whatever a fallback happened to allow, and the wiring mistake
   * would surface as authority rather than as a compile error.
   */
  access: AccessControl;
  /** The access audit (RP-13). Absent = decisions are not recorded. */
  audit?: AccessAudit | undefined;
  /**
   * Per-session route leases (RP-4c), shared with the pool that releases under
   * them. Absent, this Router owns a private one: routing is still serialized
   * against itself, but only the shared instance can see a release in flight.
   */
  routeLeases?: SessionRouteLeases | undefined;
}

/** Methods answered by the worker that owns `params.cwd` (M4). */
const CWD_ROUTED = new Set([
  "pi/settings/list",
  "pi/settings/get",
  "pi/settings/set",
  "pi/providers/list",
  "web-search/status",
  "web-search/configure",
  // MCP servers (docs/mcp.md): the worker owns the files, the engine and the
  // inspector's connections; the host only picks the project's worker and
  // forwards its `mcp/changed` notifications as they are.
  "mcp/list",
  "mcp/save",
  "mcp/remove",
  "mcp/inspect",
  "mcp/ping",
  "mcp/call",
  "mcp/disconnect",
  "mcp/auth/start",
  "mcp/auth/complete",
  "mcp/auth/logout",
  "mcp/import/detect",
  "mcp/import/apply",
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
  "pi/project/read",
  // Dictation is per project: `status` and `begin` name a cwd; the id-carrying
  // chunk/end/cancel are routed by the upload table below.
  "pi/transcribe/status",
  "pi/transcribe/begin",
  // The git status of a project. The UI always sends a `path` as well, but the
  // CLI and any cwd-only caller must still reach the right worker.
  "pi/project/git",
  "pi/project/changes",
  "pi/project/file_diff",
  "pi/project/file_source",
  "pi/project/file_blob",
  "pi/project/checkpoint/list",
  "pi/project/restore",
  "pi/project/git/hosts",
  "pi/project/git/commit",
  "pi/project/git/push",
  "pi/project/git/branch",
  "pi/project/git/prose",
  "pi/project/pr/create",
  "pi/project/pr/read",
  "pi/project/pr/checkout",
  "pi/project/pr/merge",
  "pi/project/pr/viewed",
  // The worker discovers user skills and supplies Laser's default
  // instructions; both name the answering cwd.
  "agents/skills",
  "agents/engine-instructions",
]);

/** Dictation methods that carry only an upload id, routed by `uploads`. */
const UPLOAD_ROUTED = new Set(["pi/transcribe/chunk", "pi/transcribe/end", "pi/transcribe/cancel"]);

/**
 * A dictation route nothing has used for this long belonged to a client that is
 * gone. Well above any pause inside a recording; the worker's own upload has
 * ended long before.
 */
export const UPLOAD_IDLE_MS = 10 * 60_000;

export class Router {
  /**
   * Compatibility rows for an older or alternate driver that returns before
   * writing its file. Stable sessions are durable before `session/new` returns.
   * A row is dropped as soon as the catalog sees the file or the worker closes
   * it, so this fallback can never become a second persistence owner.
   */
  private readonly unwritten = new Map<string, SessionSummary>();

  /**
   * Dictation upload id → the worker that opened it and when it was last used,
   * so a chunk reaches that worker.
   *
   * A recording ends with `pi/transcribe/end` or `cancel`, which drops its row —
   * but a client that disconnects mid-dictation (a phone leaving, a window
   * closed, a reload) sends neither, and those rows used to stay for the life of
   * the host. Every new recording sweeps the ones nothing has touched for
   * `UPLOAD_IDLE_MS`; a live dictation keeps its row by using it.
   */
  private readonly uploads = new Map<string, { cwd: string; at: number }>();

  /**
   * RP-4c: the reader half of the session route lease. Every path-routed
   * request runs under it, ensure-open included.
   */
  private readonly leases: SessionRouteLeases;
  /** Host-answered workspace shape; no worker is started to ask git. */
  private readonly workspaces = createWorkspaceResolver();

  constructor(
    private readonly pool: WorkerPool,
    private readonly catalog: SessionCatalog,
    private readonly deps: RouterDeps,
  ) {
    // The host wires one instance into both; `Partial` because a pool is also
    // stood up as a stub in tests, where nothing releases anything.
    this.leases = deps.routeLeases ?? (pool as Partial<WorkerPool>).routeLeases ?? new SessionRouteLeases();
  }

  /**
   * Run one path-routed request under this session's route lease (RP-4c).
   *
   * The lease must cover ensure-open *and* the request that follows it: the
   * whole point is that the decision not to re-open cannot go stale between the
   * two. A release in flight is waited out first, and a release the host cannot
   * prove the outcome of refuses the route having written nothing.
   */
  private route<T>(path: string, work: () => Promise<T>): Promise<T> {
    return this.leases.route(path, work);
  }

  /**
   * Ask the worker that already owns this session, under the lease (RP-4c).
   *
   * Every live fast path goes through here instead of snapshotting
   * `liveWorkerFor` and then awaiting a request against that snapshot: the
   * owner is chosen again *inside* the lease, so a release that took the
   * runtime in between is waited out and then seen. When nothing owns the
   * session once the lease is held, this answers `undefined` and the caller
   * reads the durable record exactly as it does for a cold session.
   */
  private async routeLive<T>(path: string, send: (worker: WorkerClient) => Promise<T>): Promise<{ answered: true; result: T } | { answered: false }> {
    // Nothing owns it: no lease is taken, and no worker is asked. A durable
    // read needs no authority over a runtime that does not exist.
    if (!this.liveWorkerFor(path)) return { answered: false };
    return this.route(path, async () => {
      const live = this.liveWorkerFor(path);
      if (!live) return { answered: false as const };
      return { answered: true as const, result: await send(live) };
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Drop dictation routes whose client never said it was finished. */
  private sweepUploads(): void {
    const cutoff = this.now() - UPLOAD_IDLE_MS;
    for (const [id, upload] of this.uploads) if (upload.at <= cutoff) this.uploads.delete(id);
  }

  /**
   * Answer one client request.
   *
   * `access.actor` is who the boundary **proved** this connection to be, and
   * it is required: a call site that could omit it would be a call site that
   * silently defaults to trusted. Authorization runs on the method name alone,
   * before the params are parsed and therefore before any session is looked
   * up, any file is opened, any worker is started and anything is changed
   * (RP-13).
   */
  async handle(raw: unknown, access: RequestAccess & { searches?: SearchCancellation }): Promise<JsonRpcResponse> {
    const id = (raw as { id?: string | number } | null)?.id ?? 0;
    const method = (raw as { method?: unknown } | null)?.method;
    const name = typeof method === "string" ? method : "";
    const decision = this.deps.access.authorize(name, access.actor);
    if (!decision.ok) {
      this.audit()?.record({
        actorId: access.actor.id,
        actorClass: access.actor.class,
        method: decision.reason === "unknown_method" ? undefined : name,
        ...(decision.reason === "unknown_method" ? { methodDigest: unknownMethodDigest(name) } : {}),
        scope: decision.reason === "unknown_method" ? undefined : decision.policy.scope,
        outcome: "refused",
        reason: decision.reason,
        code: decision.error.code,
      });
      return { jsonrpc: "2.0", id, error: toRpcError(decision.error) };
    }

    const startedAt = Date.now();
    let response: JsonRpcResponse;
    try {
      const req = parseClientRequest(raw);
      const clientVersion = (raw as { clientVersion?: string }).clientVersion;
      if (req.method !== "pi/host/version" && clientVersion && clientVersion !== PRODUCT_VERSION) {
        throw new ProtocolError(ErrorCodes.VersionMismatch, "Refresh this view to match the host before continuing.", { version: PRODUCT_VERSION });
      }
      const leave = this.deps.activation?.enter(req.method) ?? (() => undefined);
      try {
        const result = await this.dispatch(req, access.searches, access.actor);
        response = { jsonrpc: "2.0", id: req.id, result };
      } finally {
        leave();
      }
    } catch (error) {
      response = { jsonrpc: "2.0", id, error: toRpcError(error) };
    }
    this.audit()?.record({
      actorId: access.actor.id,
      actorClass: access.actor.class,
      method: name,
      scope: decision.policy.scope,
      outcome: response.error ? "error" : "ok",
      ...(response.error ? { code: response.error.code } : {}),
      durationMs: Date.now() - startedAt,
    });
    return response;
  }

  private audit(): AccessAudit | undefined {
    return this.deps.audit;
  }

  private packages(): PackageService {
    if (!this.deps.packages) {
      throw new ProtocolError(ErrorCodes.Unsupported, "this host was started without package management");
    }
    return this.deps.packages;
  }

  private resources(): ResourceService {
    if (!this.deps.resources) throw new ProtocolError(ErrorCodes.Unsupported, "this host was started without resource diagnostics");
    return this.deps.resources;
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
    const isSessionDirectory = this.sessionDirectorySnapshot();
    const rows = this.catalog.list(cwd).filter((session) => isSessionDirectory(session.cwd)).map(({ size: _size, ...summary }) => summary);
    const known = new Set(rows.map((row) => row.path));
    for (const [path, summary] of this.unwritten) {
      // The catalog has it, or the worker let it go: the stub has done its job.
      if (this.catalog.get(path) || !this.pool.openSessions(summary.cwd).includes(path)) {
        this.unwritten.delete(path);
        continue;
      }
      if (known.has(path) || !isSessionDirectory(summary.cwd)) continue;
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
      // An alternate driver's compatibility row still needs the agent before
      // its file appears. Stable's durable empty file normally makes this path
      // unnecessary, but keeping it preserves the driver seam (M13-T47).
      ...(state.agent !== undefined ? { agent: state.agent } : {}),
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

  private async dispatch(req: TypedClientRequest, searches: SearchCancellation | undefined, actor: ActorIdentity): Promise<unknown> {
    switch (req.method) {
      case "pi/host/version":
        return { version: PRODUCT_VERSION };
      case "pi/runtime/activation/prepare":
        if (!this.deps.activation) throw new ProtocolError(ErrorCodes.Unsupported, "Runtime activation is unavailable in this host.");
        return this.deps.activation.prepare(req.params.updateId, req.params.generationId);
      case "pi/runtime/activation/status":
        if (!this.deps.activation) throw new ProtocolError(ErrorCodes.Unsupported, "Runtime activation is unavailable in this host.");
        return this.deps.activation.status(req.params.updateId);
      case "pi/runtime/activation/cancel":
        if (!this.deps.activation) throw new ProtocolError(ErrorCodes.Unsupported, "Runtime activation is unavailable in this host.");
        return this.deps.activation.cancel(req.params.updateId);
      case ENVIRONMENT_DESCRIBE_METHOD:
        return { environment: this.deps.access.describe(actor) };
      case HOST_ENVIRONMENT_METHOD: return applyHostEnvironment(this.pool, req.params);
      case "pi/session/list": {
        if (!req.params.page) return { sessions: this.sessions(req.params.cwd) };
        const rows = this.sessions();
        const byPath = new Map(rows.map(row => [row.path, row]));
        return pageCatalog(rows, req.params, (row) => {
          const visited = new Set<string>();
          let root = row;
          while (!visited.has(root.path)) {
            visited.add(root.path);
            const parent = root.parentPath ?? root.agent?.parentPath;
            const next = parent ? byPath.get(parent) : undefined;
            if (!next) break;
            root = next;
          }
          return this.isWorkspace(root.cwd) ? this.deps.agents!.workspaces.chat : projectRootOf(root.cwd);
        });
      }

      case "session/search": {
        const { query, cwd, after, before, cursor, searchId } = req.params;
        const read = searches?.begin(searchId ?? `rpc:${req.id}`);
        try {
          read?.signal.throwIfAborted();
          // One classification per request (F02), cancellable search (F07).
          const isSessionDirectory = this.sessionDirectorySnapshot();
          const sessions = this.catalog.list(cwd).filter(s => isSessionDirectory(s.cwd) && (!after || s.modifiedAt >= after) && (!before || s.modifiedAt < before));
          return await searchSessions(sessions, query, cursor, read?.signal);
        } finally { read?.finish(); }
      }
      case "session/search/cancel":
        searches?.cancel(req.params.searchId);
        return {};

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
        const entry = this.catalog.getListed(path);
        if (!entry) throw new ProtocolError(ErrorCodes.SessionNotFound, "That session is no longer on disk.");
        if (this.pool.openSessions(entry.cwd).includes(path)) {
          throw new ProtocolError(ErrorCodes.SessionBusy, "Close this session before deleting its transcript.");
        }
        // The worktree decision is read before the transcript is unlinked, so
        // the answer describes what was actually there.
        const wanted = req.params.worktree ?? "keep";
        const before = await this.sessionWorktree(path);
        unlinkSync(path);
        this.catalog.invalidate(path);
        this.deps.views.invalidate(path);
        this.deps.revisions?.invalidate(path);
        this.unwritten.delete(path);
        await deleteSessionCheckpoints(entry.cwd, path).catch(() => 0);
        // A child's runs cannot go on without their session. Its worktree is a
        // separate thing on disk, and it is kept unless this request asked for
        // it to go (M13-T42): a caller that omits the field never destroys work.
        const runs = this.deps.runs;
        if (!runs) return {};
        const owned = runs.byChildPath(path);
        runs.forgetSession(path);
        if (wanted !== "delete") return before ? { worktree: before.status } : {};
        const worktrees = new Map<string, AgentRun>();
        for (const run of owned) if (run.worktree) worktrees.set(run.worktree.path, run);
        // Deleting is the person's explicit instruction, so it is not refused
        // for holding work — they were shown what it held before they chose.
        const removals = await Promise.all([...worktrees.entries()].map(async ([worktreePath, run]) => {
          const removal = await removeRunWorktree(run, { force: true }).catch(() => undefined);
          if (removal?.removed === true) runs.worktreeRemoved(worktreePath);
          return removal;
        }));
        const removed = removals.find((removal) => removal?.worktree);
        return removed?.worktree ? { worktree: removed.worktree } : before ? { worktree: before.status } : {};
      }

      case "session/revision": {
        const { path } = req.params;
        const revisions = this.deps.revisions;
        if (!revisions) {
          throw new ProtocolError(
            ErrorCodes.RevisionUnavailable,
            "This host has no configured revision identity. Restart the app and try again.",
          );
        }

        this.assertDurableReadPath(path);

        // The owning worker wins whenever there is one: its leaf can be ahead
        // of anything the file shows. Its answer still has to belong to this
        // host's environment; an unconfigured/stale worker is never trusted.
        const live = await this.routeLive(path, (worker) => worker.request(req.method, req.params));
        if (live.answered) return revisions.validateLive(live.result);
        if (!existsSync(path)) throw new ProtocolError(ErrorCodes.SessionNotFound, "This conversation is no longer stored here.");

        const answer = await revisions.read(path, req.params.baseRevision);
        if (answer.kind === "answer") return answer.result;
        if (answer.kind === "refuse") throw answer.error;
        // Pi may still understand unsupported/large/changing content, and can
        // also give the authoritative error for parser/unreadable cases once
        // normal path ownership has proved this is its transcript.
        const forwarded = await this.route(path, async () => (await this.workerFor(path)).request(req.method, req.params));
        return revisions.validateLive(forwarded);
      }

      // RP-5b. Authorization already ran on the method name alone, before this
      // switch and before any session lookup, worker or file (see `handle`).
      case "session/entry_range": {
        const { path } = req.params;
        const revisions = this.deps.revisions;
        const bodyRange = this.deps.bodyRange;
        if (!revisions || !bodyRange) {
          throw new ProtocolError(
            ErrorCodes.RevisionUnavailable,
            "This host has no configured durable history reader. Restart the app and try again.",
          );
        }
        this.assertDurableReadPath(path);
        // The owning worker wins: its entries can be ahead of the file, and a
        // turn that has not been written yet exists only there.
        const live = await this.routeLive(path, (worker) => worker.request(req.method, req.params));
        if (live.answered) return live.result;
        if (!existsSync(path)) throw new ProtocolError(ErrorCodes.SessionNotFound, "This conversation is no longer stored here.");
        const answer = await bodyRange.read(path, req.params);
        if (answer.kind === "answer") return answer.result;
        if (answer.kind === "refuse") throw answer.error;
        // Only an unmigrated format routes live, exactly as the page reader does.
        return await this.route(path, async () => (await this.workerFor(path)).request(req.method, req.params));
      }

      // RP-5b §2: the attachments inside one body. Same authorization, same
      // ownership rule and the same read-only projection as a range read; a
      // conversation with no live worker is never started for one.
      case "session/entry_regions": {
        const { path } = req.params;
        const bodyRange = this.deps.bodyRange;
        if (!this.deps.revisions || !bodyRange) {
          throw new ProtocolError(
            ErrorCodes.RevisionUnavailable,
            "This host has no configured durable history reader. Restart the app and try again.",
          );
        }
        this.assertDurableReadPath(path);
        const live = await this.routeLive(path, (worker) => worker.request(req.method, req.params));
        if (live.answered) return live.result;
        if (!existsSync(path)) throw new ProtocolError(ErrorCodes.SessionNotFound, "This conversation is no longer stored here.");
        const answer = await bodyRange.regions(path, req.params);
        if (answer.kind === "answer") return answer.result;
        if (answer.kind === "refuse") throw answer.error;
        return await this.route(path, async () => (await this.workerFor(path)).request(req.method, req.params));
      }

      case "pi/session/move":
        return this.moveSession(req.params.path, req.params.cwd);

      case "pi/session/close":
        // Host → worker only (`moveSession` sends it): a client closing a
        // session another view may be reading is nobody's to do.
        throw new ProtocolError(ErrorCodes.Unsupported, "The app closes a session itself when it moves one.");

      case "pi/session/entries": {
        const { path } = req.params;
        if (req.params.authority === "any") return this.readAnyHistory(req);
        if (req.params.window) {
          // Default/explicit `live` preserves today's worker-owned behavior.
          const result = await this.route(path, async () => (await this.workerFor(path)).request(req.method, req.params));
          return this.deps.revisions ? this.deps.revisions.validateWindow(result) : result;
        }
        const transcriptCwd = this.cwdOf(path);
        if (this.deps.admission && !this.deps.admission.admits("whole_transcript", transcriptCwd)) {
          throw new ProtocolError(
            ErrorCodes.SessionBusy,
            "Memory is constrained, so this conversation cannot be loaded all at once. Open it normally to load a bounded recent window.",
          );
        }
        const cached = this.deps.views.get(path);
        // The leaf travels with the entries: a navigation moves it without
        // appending anything, so a cache that kept only the entries would
        // hand back the branch the person just left.
        if (cached) return cached;
        const result = await this.route(path, async () =>
          (await this.workerFor(path)).request<{ entries: unknown[]; leafId?: string | null }>(req.method, req.params),
        );
        this.deps.views.set(path, result);
        return result;
      }

      case "pi/session/telemetry": {
        const { path } = req.params;
        const revisions = this.deps.revisions;
        const telemetry = this.deps.telemetry;
        if (!revisions || !telemetry) {
          throw new ProtocolError(
            ErrorCodes.RevisionUnavailable,
            "This host has no configured durable telemetry reader. Restart the app and try again.",
          );
        }
        this.assertDurableReadPath(path);
        const live = await this.routeLive(path, (worker) => worker.request(req.method, req.params));
        if (live.answered) return live.result;
        if (!existsSync(path)) throw new ProtocolError(ErrorCodes.SessionNotFound, "This conversation is no longer stored here.");
        const answer = await telemetry.read(path, req.params);
        if (answer.kind === "answer") return answer.result;
        if (answer.kind === "refuse") throw answer.error;
        return await this.route(path, async () => (await this.workerFor(path)).request(req.method, req.params));
      }

      case "session/new": {
        const requestedCwd = req.params.cwd;
        // Validate the requested agent against the public workspace root
        // before allocating anything, so a refused request leaves no orphan.
        if (!this.isWorkspace(requestedCwd)) this.deps.projects.assertProject(requestedCwd);
        const agentName = this.resolveStartAgent(requestedCwd, req.params.agentName);
        if (!this.pool.hasReservedWorker(requestedCwd) && this.deps.admission && !this.deps.admission.admits("new_project_worker", requestedCwd)) {
          throw new ProtocolError(
            ErrorCodes.SessionBusy,
            "Memory is constrained, so another project cannot start right now. Continue in an open project, or close an idle project and try again.",
          );
        }
        // The Chat workspace is a container, not a shared checkout. Starting
        // at its root allocates one persistent, opaque directory for this
        // conversation; reopening it routes to that same directory from the
        // stored session header.
        let cwd = requestedCwd;
        const root = this.isWorkspace(requestedCwd) ? this.agents().workspaces.chat : undefined;
        // Reverse containment means this is the root itself, including a
        // filesystem alias of it; a request naming the retired folder is not
        // inside the current root at all, and starts a chat in the current one.
        if (root && (isWithinDirectory(root, requestedCwd) || !isWithinDirectory(requestedCwd, root))) {
          try {
            cwd = createPrivateSessionWorkspace(root);
          } catch (error) {
            throw new ProtocolError(
              ErrorCodes.Internal,
              `This chat's folder could not be created: ${error instanceof Error ? error.message : String(error)}. Give ${PRODUCT_DISPLAY_NAME} a writable state directory, then try again.`,
            );
          }
        }
        // A workspace must exist before a worker is started in it. The engine
        // records the directory in the session header and refuses to open a
        // session whose directory is gone, so a missing folder is refused
        // here, with its reason, rather than becoming a session nobody can open.
        if (this.isWorkspace(cwd)) {
          const problem = ensureWorkspace(cwd);
          if (problem) {
            throw new ProtocolError(
              ErrorCodes.Internal,
              `This chat's folder could not be created at ${cwd}: ${problem}. Give ${PRODUCT_DISPLAY_NAME} a writable state directory, then try again.`,
            );
          }
        }
        const worker = await this.pool.get(cwd);
        const params = { ...req.params, cwd, ...(agentName ? { agentName } : { sessionKind: "chat" as const }) };
        const result = await worker.request<{ state: SessionState }>(req.method, params);
        await this.bindOpenedSession(result.state.path, cwd);
        // A workspace is not a project: a chat never puts one in the project
        // list.
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
        return req.params.explorer ? browseExplorer(req.params.path, req.params.explorer) : browseDirectories(req.params.path);

      case "pi/project/workspace": {
        const cwd = projectRootOf(req.params.cwd);
        this.deps.projects.assertProject(cwd);
        return this.workspaces.resolve(cwd, { rescan: req.params.rescan === true });
      }

      case "pi/project/isolation/set": {
        const cwd = projectRootOf(req.params.cwd);
        const isolation = req.params.isolation;
        if (!(AGENT_ISOLATION_DEFAULTS as readonly string[]).includes(isolation)) {
          throw new ProtocolError(ErrorCodes.InvalidParams, "isolation must be decide, isolate, or share.");
        }
        const live = this.pool.liveClients().find((entry) => entry.cwd === cwd);
        if (live) {
          try {
            await live.client.request("pi/project/isolation/set", { cwd, isolation });
          } catch {
            throw new ProtocolError(
              ErrorCodes.Internal,
              "The live worker could not take the new isolation default. Try again.",
            );
          }
        }
        this.deps.projects.setAgentIsolation(cwd, isolation as AgentIsolationDefault);
        return { ok: true as const };
      }

      case "pi/project/checkpoint/retention/set": {
        const cwd = projectRootOf(req.params.cwd);
        const retention = req.params.retention;
        if (!isCheckpointRetention(retention)) {
          throw new ProtocolError(ErrorCodes.InvalidParams, "Retention must be 50, 200, 1000, all, or off.");
        }
        const project = this.deps.projects.setCheckpointRetention(cwd, retention as CheckpointRetention);
        try {
          writeProjectCheckpointRetention(cwd, retention);
        } catch {
          // The registry still holds the setting; a project directory we cannot write is not a reason to refuse.
        }
        if (retention === "off") {
          await deleteAllCheckpoints(cwd).catch(() => 0);
        }
        return { project };
      }

      // --------------------------------- project environment (M16-T17) ---
      // Configuration and trust live here; the worker runs the hook and owns
      // the values. Every answer carries names, never values.
      case "pi/project/env/status":
        return { status: await this.projectEnvStatus(req.params.cwd) };

      case "pi/project/env/set": {
        const root = projectRootOf(req.params.cwd);
        // Saving is the approval: the person is looking at the command.
        this.deps.projectEnv.set(root, req.params.config);
        const base = this.projectEnvBase(root);
        const live = this.pool.liveClients().find(entry => entry.cwd === root);
        let status = base;
        if (live) {
          try {
            const config = base.state === "ready" || base.state === "failed" ? req.params.config : null;
            const answer = (await live.client.request("pi/project/env/set", { cwd: root, config })) as { status: ProjectEnvStatus };
            status = base.state === "ready" || base.state === "failed"
              ? { ...base, ...answer.status, cwd: root }
              : base;
          } catch {
            // The stored value is still authoritative. An older worker keeps
            // its current shell until it retires; a new worker reads this save.
          }
        }
        status = this.deps.projectEnv.publicStatus(status);
        this.deps.projectEnv.emit(status);
        return { status };
      }

      case "pi/project/env/test":
      case "pi/project/env/refresh": {
        const root = projectRootOf(req.params.cwd);
        const base = this.projectEnvBase(root);
        // Never start a worker only to test a hook, and never run one for a
        // project that is not trusted or not approved.
        if (base.state !== "failed" && base.state !== "ready") return { status: base };
        const worker = await this.deps.projects.ensureTrusted(root).then(
          () => this.pool.get(root),
          () => undefined,
        );
        if (!worker) return { status: base };
        const answer = (await worker.request(req.method, { cwd: root })) as { status: ProjectEnvStatus };
        const status = this.deps.projectEnv.publicStatus({ ...base, ...answer.status, cwd: root });
        this.deps.projectEnv.emit(status);
        return { status };
      }

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

      case "pi/worker/prepare":
        if (this.deps.admission && !this.deps.admission.admits("speculative_worker", req.params.cwd)) return {};
        await this.pool.prepare(req.params.cwd);
        return {};

      case "pi/worker/restart":
        return { worker: await this.pool.restart(req.params.cwd, req.params.mode) };

      case "pi/worker/stop": {
        await this.pool.stop(req.params.cwd, "stopped from the app");
        return {};
      }

      // ------------------------------------------------- process inventory
      case "resource/snapshot":
        return this.resources().snapshot(req.params);
      case "resource/history":
        return this.resources().historyPage(req.params);
      case "resource/export":
        return this.resources().export();
      case RESOURCE_REPORT_METHOD:
        // Guarded above: only a local shell reaches this, and even then the
        // service proves the claimed desktop process is this host's own
        // ancestor before a single number is believed.
        return this.resources().receiveDesktopReport(req.params);

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
          const cwd = req.params.cwd;
          if (!cwd) throw new Error("No Settings target was supplied for the Web Search connection test. Reopen Settings, choose Global or a project, then try again.");
          await (await this.pool.get(cwd)).request("web-search/configure", { cwd, change: { action: "test" } });
        }
        const features = this.features().set(req.params.id, req.params.enabled, req.params.scope, req.params.cwd);
        // A hidden warm process holds startup configuration too. Invalidate it
        // without restarting/promoting a project the person has not opened.
        let restartPending = req.params.scope === "global" && !(await this.pool.discardPrepared());
        const targets = req.params.scope === "project" && req.params.cwd ? [req.params.cwd] : this.pool.cwds();
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

      // ------------------------------------------------ background tasks
      case "tasks/list":
        return { tasks: this.tasks().list(req.params.path) };
      case "tasks/output":
        return this.tasks().read(req.params.path, req.params.id, req.params.fromByte);
      case "tasks/stop": {
        // The register is the authority on which session owns the task; the
        // worker that runs it is the only party that can end it. A task that
        // already ended answers as it is rather than failing.
        const tasks = this.tasks();
        const task = tasks.get(req.params.path, req.params.id);
        if (!task) {
          throw new ProtocolError(ErrorCodes.InvalidParams, "That task is not one of this session's, so it cannot be stopped from here.");
        }
        if (task.status !== "running") return { task };
        const { delivered } = await this.route(req.params.path, async () =>
          (await this.workerFor(req.params.path)).request<{ delivered: boolean }>("pi/task/stop", req.params),
        );
        if (!delivered) {
          throw new ProtocolError(
            ErrorCodes.InvalidParams,
            "That task is no longer running in its session — the session may have restarted since it started.",
          );
        }
        return { task: tasks.get(req.params.path, req.params.id) ?? task };
      }

      // ---------------------------------------------------------- agents
      case "agents/list":
        return this.agents().snapshot();
      case "agents/validate":
        return { issues: this.agents().validate(req.params.agent, req.params.originalName) };
      case "agents/save": {
        const store = this.agents();
        let authoredTrustCwd: string | undefined;
        if (req.params.agent.scope === "project") {
          const projectCwd = canonical(req.params.agent.projectCwd ?? "");
          const registered = this.deps.projects.list().some((project) => project.cwd === projectCwd);
          const trust = registered ? this.deps.projects.trustOf(projectCwd).trust : undefined;
          if (trust === "not_required") {
            authoredTrustCwd = projectCwd;
          } else if (trust !== "trusted") {
            throw new ProtocolError(
              ErrorCodes.ProjectUntrusted,
              "Choose Trust in Settings before saving an agent in this project.",
              { cwd: projectCwd },
            );
          }
        }
        const agent = store.save(req.params.agent, req.params.originalName);
        if (authoredTrustCwd) {
          // A successful product write is the person's trust decision (D-298).
          // Invalid drafts never persist trust.
          this.deps.projects.setTrust(authoredTrustCwd, true, true);
        }
        return { agent, snapshot: store.snapshot() };
      }
      case "agents/delete": {
        const store = this.agents();
        store.delete(req.params.name, req.params.location);
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
      // Model profiles live in the global settings file, which only a worker
      // may write (`SettingsManager`). The host picks the worker, and owns the
      // two decisions a worker cannot make on its own: which definitions point
      // at a profile, and what happens to them when it is deleted.
      case "models/profiles/list":
      case "models/profiles/save":
        return this.onProfiles(req.method, req.params);
      case "models/profiles/delete":
        return this.deleteProfile(req.params);
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
      case "agents/worktree/status": {
        const found = await this.sessionWorktree(req.params.path);
        return { worktree: found?.status ?? null };
      }
      case "agents/worktree/remove": {
        // The person's escape hatch for a worktree its parent never cleaned up
        // (M13-T42). The session stays; only the directory and its branch go,
        // and only when nothing unmerged is left in it — or when `force` says
        // the work is deliberately being thrown away.
        const found = await this.sessionWorktree(req.params.path);
        if (!found) return { removed: false, worktree: null };
        const removal = await removeRunWorktree(found.run, { force: req.params.force === true });
        if (removal?.removed === true && found.run.worktree) this.deps.runs?.worktreeRemoved(found.run.worktree.path);
        return { removed: removal?.removed === true, worktree: removal?.worktree ?? found.status };
      }
      case "agents/sync":
      case "pi/worker/recover-agent-failures":
        throw new ProtocolError(ErrorCodes.Unsupported, "The app sends this to its own workers.");
      // Same rule, and said here rather than left to the forwarder: a client
      // asking a worker what it is retaining would reach a worker of its
      // choosing. The host asks its own live workers, inside a snapshot (RP-6).
      case "pi/worker/retained-stores":
        throw new ProtocolError(ErrorCodes.Unsupported, "The app sends this to its own workers.");
      // Same rule for RP-4's pair: releasing a session's runtime and reading
      // what its sessions are holding are the app's own lifetime decisions,
      // taken against its own live workers. A client asking would be choosing
      // a worker, and a person's detach already says everything a client can.
      case "pi/session/unload":
      case "pi/worker/safety":
      // And RP-8's directive for the same reason: asking a worker to give
      // memory back releases runtime state, so a client that could send it
      // would be choosing which of this machine's workers releases something.
      // The host decides that from what it measured itself.
      case "pi/worker/pressure":
        throw new ProtocolError(ErrorCodes.Unsupported, "The app manages its own session runtimes.");

      default:
        break;
    }
    return this.forwardToWorker(req);
  }

  /**
   * Move a saved session into a project (M13-T58): a Chat session becomes
   * that project's, with its history, its name and its id. The host does the
   * file work itself, while no worker holds the file — the session is closed
   * in its worker first when one has it open — and then keeps every cache in
   * step and registers the project when it is new. Refusals are for a
   * person: what stops the move, and what to do about it.
   */
  private async moveSession(path: string, cwd: string): Promise<{ path: string }> {
    const target = canonical(cwd);
    const entry = this.catalog.get(path);
    if (!entry) throw new ProtocolError(ErrorCodes.SessionNotFound, "That session is no longer on disk.");
    if (entry.agent?.kind === "child" || entry.parentPath !== undefined) {
      throw new ProtocolError(ErrorCodes.InvalidParams, "An agent started this session under another one, so it moves with that session's tree, not on its own.");
    }
    if (this.isWorkspace(target)) {
      throw new ProtocolError(ErrorCodes.InvalidParams, "That folder is where chats are kept, not a project. Choose a project folder.");
    }
    this.deps.projects.assertProject(target);
    if (projectRootOf(target) !== target) {
      throw new ProtocolError(ErrorCodes.InvalidParams, "That folder is an agent's worktree. Choose the project it belongs to instead.");
    }
    if (canonical(entry.cwd) === target) throw new ProtocolError(ErrorCodes.InvalidParams, "This session is already in that project.");
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(target);
    } catch {
      throw new ProtocolError(ErrorCodes.InvalidParams, `There is no folder at ${cwd}. Choose one that exists on the computer running ${PRODUCT_DISPLAY_NAME}.`);
    }
    if (!stat.isDirectory()) throw new ProtocolError(ErrorCodes.InvalidParams, `${cwd} is a file, not a folder. Choose a folder.`);
    // The default agent's plain record replaces the workspace kind, so a
    // host without definitions has nothing to write there.
    const agentName = this.agents().defaultAgentName;
    const live = this.deps.runs?.list(path).some((run) => !isTerminalRunStatus(run.status)) ?? false;
    if (live) throw new ProtocolError(ErrorCodes.SessionBusy, "An agent this session started is still working. Wait for it to finish, or end it, then move the session.");
    const dest = destinationFor(this.catalog.sessionDir, path, target);
    // Refused before anything is held, so a collision costs the conversation
    // nothing at all.
    this.assertNoDestinationFile(path, dest);
    // One writer per file, and one authority over both names (RP-4c). A move
    // closes the runtime, rewrites the file and hands the caches the new path;
    // all three are authority over the same conversation, so they are one
    // exclusive operation over the old and the new path rather than a reader
    // that other routes may run beside. A release cannot start under it, a
    // routed request cannot straddle it, and nothing else can be writing the
    // destination. A streaming turn is still refused by the worker itself.
    return this.leases.exclusive([path, dest], async () => {
      if (this.pool.openSessions(entry.cwd).includes(path)) {
        const worker = await this.pool.get(entry.cwd);
        await worker.request("pi/session/close", { path });
        this.pool.forgetSession(path);
      }
      // Re-read on this side of the close: the destination is only proved free
      // while this operation holds it.
      this.assertNoDestinationFile(path, dest);
      rewriteSessionFile(path, dest, { cwd: target, agentName });
      this.catalog.invalidate(path);
      this.catalog.invalidate(dest);
      this.deps.views.invalidate(path);
      this.deps.revisions?.invalidate(path);
      this.deps.revisions?.invalidate(dest);
      this.unwritten.delete(path);
      // Read where it was read: a session someone had caught up on must not
      // come back as unread for having moved.
      const seenAt = this.deps.attention.seenAt(path);
      this.deps.attention.forget(path);
      if (seenAt !== undefined) this.deps.attention.markSeen(dest, target);
      // The project the person chose is a project from now on, exactly as the
      // rail's Add project makes one: pinned, so it outlives its sessions.
      this.deps.projects.add(target);
      this.deps.projects.touch(target);
      return { path: dest };
    });
  }

  /** A move never writes over a file that is already there. */
  private assertNoDestinationFile(path: string, dest: string): void {
    if (dest !== path && existsSync(dest)) {
      throw new ProtocolError(ErrorCodes.Internal, `That project already has a session file named ${dest.split(/[\\/]/).pop() ?? dest}. Nothing was moved.`);
    }
  }

  /**
   * The worktree a child session owns, read from git, with the run that owns
   * it. `undefined` when the app knows no run for that session or the child
   * was started with `worktree: false` — in which case there is no branch, no
   * directory, and nothing to say about either.
   */
  private async sessionWorktree(path: string): Promise<{ run: AgentRun; status: AgentWorktreeStatus } | undefined> {
    const registry = this.deps.runs;
    if (!registry) return undefined;
    const run = registry.byChildPath(path).find((candidate) => candidate.worktree);
    if (!run) return undefined;
    const status = await worktreeStatus(run).catch(() => undefined);
    return status ? { run, status } : undefined;
  }

  /**
   * Which agent a new session starts with, and whether it may start here.
   *
   * `undefined` means no agent at all: the Chat workspace runs the plain
   * conversation of `docs/plain-chat.md`, which has no definition. With no
   * agent store the request is passed on untouched, so a host without the
   * feature behaves as before.
   */
  private resolveStartAgent(cwd: string, requested: string | undefined): string | undefined {
    const store = this.deps.agents;
    if (!store) {
      if (requested !== undefined) throw new ProtocolError(ErrorCodes.Unsupported, "This host has no agent definitions.");
      return undefined;
    }
    if (this.isWorkspace(cwd)) {
      if (requested === undefined) return undefined;
      throw new ProtocolError(ErrorCodes.InvalidParams, "A chat runs no agent. Open a session in a project to start one.", {
        issues: [{ field: "agentName", message: "A chat runs no agent." }],
      });
    }
    const name = requested ?? store.defaultAgentName;
    if (!store.get(name)) {
      throw new ProtocolError(ErrorCodes.InvalidParams, `There is no agent named "${name}". Choose one from the Agents page.`, {
        issues: [{ field: "agentName", message: `There is no agent named "${name}".` }],
      });
    }
    return name;
  }

  /**
   * One ownership/project gate for every host-side transcript read. It runs
   * before any fd is opened, so an arbitrary path cannot become a file oracle.
   */
  private assertDurableReadPath(path: string): string {
    const knownCwd = this.pool.cwdOfSession(path) ?? this.deps.runs?.projectCwdOf(path);
    const listedCwd = knownCwd === undefined ? this.catalog.cwdOfListed(path) : undefined;
    const cwd = knownCwd ?? (listedCwd ? projectRootOf(listedCwd) : undefined);
    if (!cwd) throw new ProtocolError(ErrorCodes.SessionNotFound, "This conversation is not stored here.");
    if (!this.isWorkspace(cwd)) this.deps.projects.assertProject(cwd);
    return cwd;
  }

  /** The complete `authority:any` route, including live-owner precedence. */
  private async readAnyHistory(req: EntriesRequest): Promise<unknown> {
    const { path } = req.params;
    const revisions = this.deps.revisions;
    const projection = this.deps.projection;
    if (!revisions || !projection) {
      throw new ProtocolError(ErrorCodes.RevisionUnavailable, "This host has no configured durable history reader. Restart the app and try again.");
    }
    const cwd = this.assertDurableReadPath(path);

    // Omitted `window` under `any` means a bounded first screen. Default/live
    // omission remains the legacy whole-transcript route in the switch above.
    const window = req.params.window ?? ({ tail: 40 } as const);
    const params = { ...req.params, window };
    const live = await this.routeLive(path, (worker) => worker.request(req.method, params));
    if (live.answered) return revisions.validateWindow(live.result);
    if (
      "all" in window
      && this.deps.admission
      && !this.deps.admission.admits("worker_free_full_read", cwd)
    ) {
      throw new ProtocolError(
        ErrorCodes.SessionBusy,
        "Memory is constrained, so this conversation cannot be read all at once without its worker. Open it first, or load a bounded history window.",
      );
    }
    if (!existsSync(path)) throw new ProtocolError(ErrorCodes.SessionNotFound, "This conversation is no longer stored here.");

    // Bounds/unreadability refuse truthfully instead of silently spawning.
    // Only an unmigrated format routes live: the pinned engine owns that
    // rewrite and the host deliberately cannot reproduce it.
    const answer = await projection.read(path, params.window, req.params.baseRevision, req.params.bodyLimit);
    if (answer.kind === "refuse") throw answer.error;
    if (answer.kind === "route-live") {
      const forwarded = await this.route(path, async () => (await this.workerFor(path)).request(req.method, params));
      return revisions.validateWindow(forwarded);
    }
    return answer.result;
  }

  /** True when `cwd` is inside the container plain Chat conversations run in. */
  private isWorkspace(cwd: string): boolean {
    const store = this.deps.agents;
    return store ? isChatWorkspace(cwd, store.workspaces) : false;
  }

  /** Presentation-only memo, owned by one synchronous list/search operation.
   * Mutation, trust and spawn checks always resolve containment afresh. */
  private sessionDirectorySnapshot(): (cwd: string) => boolean {
    const values = new Map<string, boolean>();
    return (cwd) => {
      let value = values.get(cwd);
      if (value === undefined) {
        value = this.isSessionDirectory(cwd);
        values.set(cwd, value);
      }
      return value;
    };
  }

  /** Only real projects and the Chat workspace are session directories. */
  private isSessionDirectory(cwd: string): boolean {
    return !this.deps.projects.isExcluded(cwd) || this.isWorkspace(cwd);
  }

  /**
   * A Chat by its own record, whatever directory its header names: a
   * conversation created while the workspaces lived elsewhere — including one
   * written before M23 — must not turn that old directory into a project when
   * it is opened.
   */
  private isWorkspaceSession(path: string): boolean {
    return this.catalog.getListed(path)?.agent?.sessionKind === "chat";
  }

  /**
   * Anything the host does not answer itself goes to a worker: by `cwd` for the
   * per-project methods, by upload id for dictation chunks, by session path
   * for everything else.
   */
  /**
   * Forward one request to a worker, retrying exactly once when a lifetime
   * fence refused it (RP-4).
   *
   * Both refusals happen **before** the request is acted on: a release fence
   * refuses at admission and the arrival is what makes that release refuse
   * itself, so the retry lands on the runtime that stayed; a retiring worker's
   * refusal never reaches the pipe at all (`WorkerRetiredError.written` is
   * false), so the retry opens the worker that replaces it. That is why even a
   * `session/prompt` is safe to send again here: it was never delivered.
   */
  private async forwardToWorker(req: TypedClientRequest): Promise<unknown> {
    try {
      return await this.forwardOnce(req);
    } catch (error) {
      if (!retryableLifetimeRefusal(error)) throw error;
      return this.forwardOnce(req);
    }
  }

  private async forwardOnce(req: TypedClientRequest): Promise<unknown> {
    // A brand-new composer has a project but no session path yet. The worker
    // answers from a disposable Pi runtime, so listing commands does not
    // create an empty transcript.
    if (req.method === "pi/commands/list" && "cwd" in req.params) {
      const { cwd } = req.params as { cwd: string };
      return (await this.pool.get(cwd)).request(req.method, req.params);
    }
    // Settings, packages, providers and models are per project, not per
    // session: they name a cwd and go to that project's worker. A child's
    // worktree is part of its project (invariant 5): a cwd under
    // `.worktrees/<name>` reaches the project's worker as the project, never
    // a second worker of its own, and a file it named keeps its place inside
    // that worktree. File reads allow machine-wide targets, but a relative
    // request must retain its originating directory before worker routing.
    if (CWD_ROUTED.has(req.method)) {
      const params = req.params as { cwd: string; path?: string };
      const cwd = projectRootOf(params.cwd);
      const routed = cwd === params.cwd
        ? req.params
        : {
            ...params,
            cwd,
            ...(req.method === "pi/project/read" && typeof params.path === "string" && !isAbsolute(params.path)
              ? { path: resolve(params.cwd, params.path) }
              : {}),
          };
      const worker = await this.pool.get(cwd);
      const result = await worker.request(req.method, routed);
      // Remember which worker opened this upload: the chunks that follow carry
      // an id and nothing else.
      if (req.method === "pi/transcribe/begin") {
        const id = (result as { id?: string } | null)?.id;
        if (id) {
          this.sweepUploads();
          this.uploads.set(id, { cwd, at: this.now() });
        }
      }
      return result;
    }

        if (UPLOAD_ROUTED.has(req.method)) {
          const { id } = req.params as { id: string };
          const upload = this.uploads.get(id);
          if (!upload) {
            throw new ProtocolError(
              ErrorCodes.InvalidParams,
              "that recording is no longer open — start dictating again",
            );
          }
          upload.at = this.now();
          // Keep the route while transcription is in flight: Discard must
          // still be able to reach the worker and abort the provider request.
          try {
            return await (await this.pool.get(upload.cwd)).request(req.method, req.params);
          } finally {
            if (req.method !== "pi/transcribe/chunk") this.uploads.delete(id);
          }
        }

        const path = (req.params as { path: string }).path;
        const loading = req.method === "session/load";
        // RP-4c: choosing the worker, ensure-open, the request *and* the host's
        // record of where this session now lives are one lease. Between any two
        // of them the lifetime sweep, a retirement or a crash may otherwise take
        // the runtime, and the mutation would reach a worker that had correctly
        // let the session go — or the pool would keep advertising a path the
        // worker has already re-keyed under a fork.
        const { result, cwd, forked } = await this.route(path, async () => {
          const worker = await this.workerFor(path, !loading);
          const forwarded = await worker.request(req.method, req.params);
          // Validated before anything is recorded: a load whose answer does not
          // belong to this host must not become the pool's idea of ownership.
          const answer = loading && this.deps.revisions ? this.deps.revisions.validateLoad(forwarded) : forwarded;
          const owner = this.pool.cwdOfSession(path) ?? this.cwdOf(path);
          if (loading && owner) await this.bindOpenedSession(path, owner);
          // A fork answers with a new session path served by the same worker; a
          // navigate rewrites the leaf, so the cached transcript is stale.
          const state = (answer as { state?: SessionState } | null)?.state;
          const moved = typeof state?.path === "string" && state.path !== path ? state.path : undefined;
          if (moved && owner) {
            // One runtime, one row (RP-4): the fork moved the session's file, so
            // the pool's bookkeeping moves with it, inside the same lease that
            // wrote the request. Leaving the source path behind would leave a row
            // nobody serves, and every later lifetime question about this worker
            // would disagree with it for ever.
            this.pool.rekeySession(path, moved, owner);
            if (state) this.noteUnwritten(state);
          }
          return { result: answer, cwd: owner, forked: moved };
        });
        // Presentation only from here: no authority over a runtime or a file.
        if (loading && cwd && !this.isWorkspace(cwd) && !this.isWorkspaceSession(path)) this.deps.projects.touch(cwd);
        if (req.method === "pi/session/fork" || req.method === "pi/session/navigate" || req.method === "pi/session/compact") {
          this.deps.views.invalidate(path);
          // The catalog resumes its byte-offset scan whenever a file only grew.
          // A fork, a navigate and a compaction all rewrite in place, so the
          // cached message count and first message have to be dropped too.
          this.catalog.invalidate(path);
          this.deps.revisions?.invalidate(path);
          if (forked) {
            this.deps.views.invalidate(forked);
            this.catalog.invalidate(forked);
            this.deps.revisions?.invalidate(forked);
          }
        }
        return result;
  }

  /** The agent store, or an error a person can act on. */
  /**
   * A worker that can write the global settings file. Any of them can: the
   * file is one person's, not one project's. `cwd` picks a specific one when
   * the caller named one, otherwise the first project this host knows.
   */
  private async settingsWorker(cwd: string | undefined): Promise<{ worker: WorkerClient; cwd: string }> {
    const chosen = cwd ?? this.deps.projects.list()[0]?.cwd ?? this.agents().workspaces.chat;
    const root = projectRootOf(chosen);
    return { worker: await this.pool.get(root), cwd: root };
  }

  private async onProfiles(
    method: "models/profiles/list" | "models/profiles/save",
    params: { cwd?: string } & Record<string, unknown>,
  ): Promise<unknown> {
    const { worker, cwd } = await this.settingsWorker(params.cwd);
    return worker.request(method, { ...params, cwd });
  }

  /**
   * Deleting a profile, with nothing left pointing at it.
   *
   * The host owns the definitions, so it is the one place that can see every
   * reference: agent files and the built-ins, beside the assignments the
   * worker holds. A profile something still uses is refused unless the caller
   * names what takes its place, and then every reference moves in this call
   * before the profile itself goes (`docs/model-profiles.md`, "Assignments").
   */
  private async deleteProfile(params: { cwd?: string; id: string; replacementId?: string }): Promise<unknown> {
    const store = this.agents();
    const snapshot = store.snapshot();
    const definitions = snapshot.agents.filter((agent) => agent.profileId === params.id);
    if (definitions.length > 0 && !params.replacementId) {
      const used = definitions.map((agent) => agent.name);
      throw new ProtocolError(
        ErrorCodes.InvalidParams,
        `This profile is still used by ${used.join(", ")}. Choose the profile that should take its place, then delete it.`,
      );
    }
    // Anything that would refuse the rewrite is refused *before* the profile
    // goes: the replacement has to be a change every definition can actually
    // take, or there is nothing to delete yet.
    if (params.replacementId) {
      for (const agent of definitions) {
        const issues = store.validate({ ...agent, profileId: params.replacementId }, agent.name);
        if (issues.length === 0) continue;
        throw new ProtocolError(
          ErrorCodes.InvalidParams,
          `“${agent.name}” cannot be moved to that profile, so this one was not deleted: ${issues[0]!.message}`,
        );
      }
    }
    const { worker, cwd } = await this.settingsWorker(params.cwd);
    // The worker validates the replacement and moves the assignments; do that
    // first, so a refusal leaves every definition exactly as it was.
    const result = await worker.request("models/profiles/delete", { ...params, cwd });
    if (params.replacementId) {
      for (const agent of definitions) {
        try {
          store.save({ ...agent, profileId: params.replacementId }, agent.name);
        } catch (error) {
          // The profile is already gone by now, and the two writes are not one
          // transaction: a crash between them leaves the same residue. Say so
          // on the definition itself rather than waiting for the periodic
          // profile check in `skills-check.ts` to find it.
          store.noteProfileWarning(
            agent,
            "The profile this agent used was deleted and it could not be moved to the replacement, so it runs on the profile new conversations use. Choose a profile for it.",
            error,
          );
        }
      }
    }
    return result;
  }

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

  /** The background-task register, or an error a person can act on. */
  private tasks(): TaskRegister {
    if (!this.deps.tasks) {
      throw new ProtocolError(
        ErrorCodes.Unsupported,
        "This host is running without the task register, so background work cannot be listed or read.",
      );
    }
    return this.deps.tasks;
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
   * What a person sees before any worker is asked: configured, approved,
   * trusted. A project with no worker running still has a truthful status.
   */
  private projectEnvBase(cwd: string): ProjectEnvStatus {
    const root = projectRootOf(cwd);
    const { trust } = this.deps.projects.trustOf(root);
    return this.deps.projectEnv.baseStatus(root, trust);
  }

  /**
   * The base status, enriched by the worker when one is already up.
   *
   * A worker is never started just to answer a status question: starting one
   * runs the project's hook, and looking at a settings screen should not.
   */
  private async projectEnvStatus(cwd: string): Promise<ProjectEnvStatus> {
    const root = projectRootOf(cwd);
    const base = this.projectEnvBase(root);
    if (base.state !== "failed" && base.state !== "ready") return base;
    const live = this.pool.liveClients().find((entry) => entry.cwd === root);
    if (!live) return base;
    try {
      const answer = (await live.client.request("pi/project/env/status", { cwd: root })) as { status: ProjectEnvStatus };
      return this.deps.projectEnv.publicStatus({ ...base, ...answer.status, cwd: root });
    } catch {
      // An older worker without the method is still a working worker.
      return base;
    }
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

  /** The worker that already owns this session, if one does. Never spawns. */
  private liveWorkerFor(path: string) {
    return this.pool.ownerOfSession(path);
  }

  /**
   * The worker that owns a session path, started if needed. Path-routed actions
   * may arrive before a reconnecting client has sent `session/load`, so a saved
   * transcript is opened here before the action reaches the worker. An empty
   * session that disappeared with an idle worker has no transcript to recover;
   * refuse it before the engine can create a different session under its stale
   * filename.
   */
  private async bindOpenedSession(path: string, cwd: string): Promise<void> {
    this.pool.bindSession(path, cwd);
    await this.pool.recoverOpenedSession(path, cwd);
  }

  private async workerFor(path: string, ensureOpen = true) {
    const cwd = this.cwdOf(path);
    if (!cwd) throw new ProtocolError(ErrorCodes.SessionNotFound, `no project known for session ${path}`);
    if (!this.isWorkspace(cwd)) this.deps.projects.assertProject(cwd);
    // Refuse before anything is started, so a session with nothing to recover
    // never costs a worker process.
    this.openOrRefuse(path, cwd);
    const worker = await this.pool.get(cwd);
    // Read again on this side of the await (RP-4c). Getting the worker can wait
    // out a retirement, replace a crashed process or return a successor, and any
    // of those empties the pool's membership for this path. The whole guard is
    // re-evaluated, not only `open`: after an explicit stop a path with no saved
    // file can lose its runtime, and a stale `open` would let `session/load`
    // create a different session under that filename.
    const open = this.openOrRefuse(path, cwd);
    if (ensureOpen && !open) {
      await worker.request("session/load", { path });
      await this.bindOpenedSession(path, cwd);
    }
    return worker;
  }

  /**
   * Whether this worker holds the session right now, refusing when it does not
   * and there is nothing saved to re-open.
   */
  private openOrRefuse(path: string, cwd: string): boolean {
    const open = this.pool.openSessions(cwd).includes(path);
    if (!open && !this.catalog.get(path) && !existsSync(path)) {
      throw new ProtocolError(
        ErrorCodes.SessionNotFound,
        "This session is no longer open and has no saved transcript. Start a new session.",
      );
    }
    return open;
  }
}

/**
 * Whether a failure is a lifetime fence saying "not now" (RP-4).
 *
 * Two shapes, one meaning, and both prove the request was never acted on: a
 * worker whose admission was closed for a retirement decision refused it before
 * writing anything, and a worker releasing a session refused it at admission
 * with the retry marker in the error's data.
 */
function retryableLifetimeRefusal(error: unknown): boolean {
  if (error instanceof WorkerRetiredError) return true;
  if (error instanceof WorkerRpcError) {
    const data = error.rpc.data as { retry?: unknown } | undefined;
    return data?.retry === LIFETIME_RETRY;
  }
  return false;
}

function toRpcError(error: unknown): JsonRpcError {
  if (error instanceof ProtocolError) {
    return { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) };
  }
  if (error instanceof WorkerRpcError) return error.rpc;
  return { code: ErrorCodes.Internal, message: error instanceof Error ? error.message : String(error) };
}
