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
 *
 * Routed to one worker:
 *   session/new          worker for params.cwd
 *   session/load         worker for the cwd that owns the path (pool memory,
 *                        else the session file header via the catalog)
 *   everything with a path → same lookup
 *   pi/ui/response       every live worker (the worker that owns the dialog id
 *                        answers; the others ignore it)
 */
import {
  ErrorCodes,
  ProtocolError,
  decisionPushPayload,
  parseClientRequest,
  type JsonRpcError,
  type JsonRpcResponse,
  type SessionAttention,
  type SessionState,
  type SessionSummary,
  type TypedClientRequest,
} from "@piorbit/protocol";
import type { AttentionTracker } from "./attention.js";
import type { SessionCatalog } from "./catalog.js";
import type { LogStore } from "./logstore.js";
import type { PanelHub } from "./panels/hub.js";
import type { ProjectRegistry } from "./projects.js";
import type { PushService } from "./push.js";
import type { SubagentsLayer } from "./subagents/layer.js";
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
  /** The origin a phone opens, for the URLs inside a notification. */
  publicOrigin?: (() => string) | undefined;
}

/** Methods answered by the worker that owns `params.cwd` (M4). */
const CWD_ROUTED = new Set([
  "pi/settings/list",
  "pi/settings/get",
  "pi/settings/set",
  "pi/packages/list",
  "pi/packages/install",
  "pi/packages/remove",
  "pi/packages/update",
  "pi/packages/check_updates",
  "pi/providers/list",
  "pi/models/catalog",
  // Dictation is per project: `status` and `begin` name a cwd; the id-carrying
  // chunk/end/cancel are routed by the upload table below.
  "pi/transcribe/status",
  "pi/transcribe/begin",
  // The git status of a project. The UI always sends a `path` as well, but the
  // CLI and any cwd-only caller must still reach the right worker.
  "pi/project/git",
]);

/** Dictation methods that carry only an upload id, routed by `uploads`. */
const UPLOAD_ROUTED = new Set(["pi/transcribe/chunk", "pi/transcribe/end", "pi/transcribe/cancel"]);

export class Router {
  /**
   * Sessions a worker holds open that Pi has not written to disk yet. Pi
   * persists lazily, so a session created by `session/new` is invisible to the
   * catalog until its first message lands — without this a brand-new session is
   * missing from the sidebar (and from `piorbit sessions`) until the first turn.
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
      const result = await this.dispatch(req);
      return { jsonrpc: "2.0", id: req.id, result };
    } catch (error) {
      return { jsonrpc: "2.0", id, error: toRpcError(error) };
    }
  }

  /** Catalog rows with attention (and `seenAt`) filled in, plus sessions no worker has persisted yet. */
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
    return this.deps.attention.decorate(rows);
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
      case "pi/session/list":
        return { sessions: this.sessions(req.params.cwd) };

      case "pi/session/inbox":
        return { sessions: this.inbox(req.params.cwd, req.params.limit) };

      case "pi/session/seen": {
        const { path } = req.params;
        const cwd = this.pool.cwdOfSession(path) ?? this.catalog.cwdOf(path);
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
        const worker = await this.pool.get(req.params.cwd);
        const result = await worker.request<{ state: SessionState }>(req.method, req.params);
        this.pool.bindSession(result.state.path, req.params.cwd);
        this.deps.projects.touch(req.params.cwd);
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

      case "pi/project/remove": {
        this.deps.projects.remove(req.params.cwd);
        return {};
      }

      case "pi/project/trust":
        return {
          project: this.deps.projects.setTrust(req.params.cwd, req.params.trusted, req.params.remember ?? false),
        };

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
            projectName: "piorbit",
            decisionId: "test",
            title: "Notifications are working",
            message: "This is what a session waiting for you looks like.",
            yesNo: false,
          }),
          { ttlSeconds: 60, topic: "piorbit_test" },
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

      default: {
        // Settings, packages, providers and models are per project, not per
        // session: they name a cwd and go to that project's worker.
        if (CWD_ROUTED.has(req.method)) {
          const { cwd } = req.params as { cwd: string };
          const worker = await this.pool.get(cwd);
          const result = await worker.request(req.method, req.params);
          // Remember which worker opened this upload: the chunks that follow
          // carry an id and nothing else.
          if (req.method === "pi/transcribe/begin") {
            const id = (result as { id?: string } | null)?.id;
            if (id) this.uploads.set(id, cwd);
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
        if (req.method === "session/load" && cwd) this.deps.projects.touch(cwd);
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
    }
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

  /** The worker that owns a session path, started if needed. */
  private async workerFor(path: string) {
    const cwd = this.pool.cwdOfSession(path) ?? this.catalog.cwdOf(path);
    if (!cwd) throw new ProtocolError(ErrorCodes.SessionNotFound, `no project known for session ${path}`);
    const worker = await this.pool.get(cwd);
    this.pool.bindSession(path, cwd);
    return worker;
  }
}

function toRpcError(error: unknown): JsonRpcError {
  if (error instanceof ProtocolError) {
    return { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) };
  }
  if (error instanceof WorkerRpcError) return error.rpc;
  return { code: ErrorCodes.Internal, message: error instanceof Error ? error.message : String(error) };
}
