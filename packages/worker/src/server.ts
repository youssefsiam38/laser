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

import {
  ErrorCodes,
  ProtocolError,
  parseClientRequest,
  type ClientRequests,
  type HostNotifications,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type SessionState,
  type SessionUpdateParams,
  type TypedClientRequest,
} from "@piorbit/protocol";
import type { DriverEvent, SessionDriver } from "./driver.js";

export interface WorkerServerOptions {
  cwd: string;
  createDriver: () => SessionDriver;
  send: (message: JsonRpcMessage) => void;
  agentDir?: string;
  sessionDir?: string;
  subagentsTempRoot?: string;
  /** Updates kept per session for `fromSeq` replay. */
  replayBuffer?: number;
}

interface Live {
  driver: SessionDriver;
  seq: number;
  buffer: SessionUpdateParams[];
  unsubscribe: () => void;
  path: string;
}

type Result<M extends keyof ClientRequests> = ClientRequests[M]["result"];

export class WorkerServer {
  private readonly sessions = new Map<string, Live>();
  private readonly replayBuffer: number;

  constructor(private readonly options: WorkerServerOptions) {
    this.replayBuffer = options.replayBuffer ?? 5000;
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
    for (const live of this.sessions.values()) {
      live.unsubscribe();
      await live.driver.dispose().catch(() => {});
    }
    this.sessions.clear();
  }

  // ------------------------------------------------------------- dispatch

  private async dispatch(req: TypedClientRequest): Promise<unknown> {
    switch (req.method) {
      case "session/new":
        return this.sessionNew(req.params);
      case "session/load":
        return this.sessionLoad(req.params);
      case "session/prompt": {
        const { driver } = this.live(req.params.path);
        const r = await driver.prompt(req.params.content, {
          ...(req.params.streamingBehavior ? { streamingBehavior: req.params.streamingBehavior } : {}),
        });
        return r satisfies Result<"session/prompt">;
      }
      case "session/cancel":
        await this.live(req.params.path).driver.abort();
        return {};
      case "session/set_mode":
        throw new ProtocolError(ErrorCodes.Unsupported, "session/set_mode is not supported by this worker yet");

      case "pi/session/list":
        throw new ProtocolError(ErrorCodes.Unsupported, "pi/session/list is answered by the host catalog, not a worker");
      case "pi/session/steer":
        await this.live(req.params.path).driver.steer(req.params.content);
        return {};
      case "pi/session/follow_up":
        await this.live(req.params.path).driver.followUp(req.params.content);
        return {};
      case "pi/session/clear_queue":
        return this.live(req.params.path).driver.clearQueue();
      case "pi/session/fork": {
        const live = this.live(req.params.path);
        const forked = await live.driver.fork(req.params.entryId);
        const { state } = forked;
        if (state.path !== live.path) {
          // The driver now serves the forked session file; re-key it so later
          // requests by the new path find it. Clients learn the new path from
          // the result and from the state update that follows.
          this.sessions.delete(live.path);
          live.path = state.path;
          this.sessions.set(state.path, live);
        }
        this.onDriverEvent(live, { type: "update", update: { kind: "state", state } });
        return forked satisfies Result<"pi/session/fork">;
      }
      case "pi/session/navigate": {
        const { driver } = this.live(req.params.path);
        return driver.navigateTree(req.params.entryId, {
          ...(req.params.summarize !== undefined ? { summarize: req.params.summarize } : {}),
          ...(req.params.label !== undefined ? { label: req.params.label } : {}),
        });
      }
      case "pi/session/rename":
        await this.live(req.params.path).driver.rename(req.params.name);
        return {};
      case "pi/session/entries":
        return { entries: await this.live(req.params.path).driver.entries() } satisfies Result<"pi/session/entries">;
      case "pi/session/compact":
        await this.live(req.params.path).driver.compact(req.params.instructions);
        return {};
      case "pi/model/list":
        return { models: await this.live(req.params.path).driver.listModels() } satisfies Result<"pi/model/list">;
      case "pi/model/set":
        return { state: await this.live(req.params.path).driver.setModel(req.params.model) } satisfies Result<"pi/model/set">;
      case "pi/thinking/set":
        return {
          state: await this.live(req.params.path).driver.setThinkingLevel(req.params.level),
        } satisfies Result<"pi/thinking/set">;
      case "pi/ui/response": {
        // The dialog id is unique across sessions in this worker; find its owner.
        for (const live of this.sessions.values()) live.driver.respondToUi(req.params);
        return {};
      }
    }
  }

  private async sessionNew(params: ClientRequests["session/new"]["params"]): Promise<Result<"session/new">> {
    if (params.cwd !== this.options.cwd) {
      throw new ProtocolError(ErrorCodes.InvalidParams, `this worker serves ${this.options.cwd}, not ${params.cwd}`);
    }
    const state = await this.openAndAttach({
      cwd: this.options.cwd,
      ...(params.parentPath ? { parentSessionPath: params.parentPath } : {}),
      ...this.commonOpen(),
    });
    return { state };
  }

  private async sessionLoad(params: ClientRequests["session/load"]["params"]): Promise<Result<"session/load">> {
    const existing = this.sessions.get(params.path);
    if (existing) {
      const state = existing.driver.state();
      this.replay(existing, params.fromSeq);
      return { state, replayFrom: params.fromSeq ?? 0 };
    }
    const state = await this.openAndAttach({ cwd: this.options.cwd, sessionPath: params.path, ...this.commonOpen() });
    return { state, replayFrom: 0 };
  }

  /**
   * Subscribe before opening: extensions emit (e.g. the companion's capability
   * report at `session_start`) while `open()` is still running. Those events
   * are queued and flushed once the session path is known.
   */
  private async openAndAttach(openOptions: Parameters<SessionDriver["open"]>[0]): Promise<SessionState> {
    const driver = this.options.createDriver();
    const live: Live = { driver, seq: 0, buffer: [], unsubscribe: () => {}, path: "" };
    const queued: DriverEvent[] = [];
    let ready = false;
    live.unsubscribe = driver.subscribe((event) => (ready ? this.onDriverEvent(live, event) : queued.push(event)));
    try {
      const state = await driver.open(openOptions);
      live.path = state.path;
      this.sessions.set(state.path, live);
      ready = true;
      for (const event of queued) this.onDriverEvent(live, event);
      return state;
    } catch (error) {
      live.unsubscribe();
      await driver.dispose().catch(() => {});
      throw error;
    }
  }

  private commonOpen() {
    return {
      ...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
      ...(this.options.sessionDir ? { sessionDir: this.options.sessionDir } : {}),
      ...(this.options.subagentsTempRoot ? { subagentsTempRoot: this.options.subagentsTempRoot } : {}),
    };
  }

  // ------------------------------------------------------------- sessions

  private live(path: string): Live {
    const live = this.sessions.get(path);
    if (!live) throw new ProtocolError(ErrorCodes.SessionNotFound, `session ${path} is not open in this worker`);
    return live;
  }

  private onDriverEvent(live: Live, event: DriverEvent): void {
    switch (event.type) {
      case "update": {
        const params: SessionUpdateParams = {
          sessionPath: live.path,
          seq: ++live.seq,
          update: event.update,
          at: new Date().toISOString(),
        };
        live.buffer.push(params);
        if (live.buffer.length > this.replayBuffer) live.buffer.splice(0, live.buffer.length - this.replayBuffer);
        this.notify("session/update", params);
        return;
      }
      case "ui_request":
        this.notify("pi/ui/request", { path: live.path, ...event.request });
        return;
      case "ui_event":
        this.notify("pi/ui/event", { path: live.path, ...event.event });
        return;
      case "extension":
        this.notify("pi/extension/message", { path: live.path, message: event.message });
        return;
      case "closed":
        live.unsubscribe();
        this.sessions.delete(live.path);
        return;
    }
  }

  /** Re-send buffered updates after `fromSeq`, then any dialogs still waiting. */
  private replay(live: Live, fromSeq: number | undefined): void {
    if (fromSeq !== undefined) {
      for (const params of live.buffer) if (params.seq > fromSeq) this.notify("session/update", params);
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
