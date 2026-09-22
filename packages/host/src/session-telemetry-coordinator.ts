import {
  ErrorCodes,
  ProtocolError,
  runsBeneathSession,
  type ClientRequests,
  type JsonRpcNotification,
  type SessionTelemetry,
  type SessionUpdateParams,
  type TelemetryChildSpendSnapshot,
} from "@lasercode/protocol";
import type { AgentRunRegistry } from "./agents/runs.js";
import type { SessionTelemetryReader } from "./session-telemetry.js";
import type { WorkerClient } from "./worker-client.js";

interface ScopeState {
  nextGeneration: number;
  dirtyGeneration?: number;
  ownerGeneration: string;
  knownPaths: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
  buildingGeneration?: number;
}

export interface SessionTelemetryCoordinatorOptions {
  reader: SessionTelemetryReader;
  runs: AgentRunRegistry;
  owner: (path: string) => WorkerClient | undefined;
  coalesceMs?: number;
}

type WithSourcesResult = ClientRequests["pi/session/telemetry/with-sources"]["result"];

/**
 * Bounded live interest only. Cold roots allocate nothing; close/rekey/worker
 * loss explicitly remove the corresponding state and timers.
 */
export class SessionTelemetryCoordinator {
  private readonly scopes = new Map<string, ScopeState>();
  private readonly coalesceMs: number;

  constructor(private readonly options: SessionTelemetryCoordinatorOptions) {
    this.coalesceMs = options.coalesceMs ?? 20;
  }

  async read(
    worker: WorkerClient,
    params: ClientRequests["pi/session/telemetry"]["params"],
  ): Promise<SessionTelemetry> {
    if (params.environmentKey !== undefined && params.environmentKey !== this.options.reader.environmentKey) {
      throw new ProtocolError(ErrorCodes.InvalidParams, "That conversation belongs to a different connection.");
    }
    const wantsSpend = params.scope !== "turn" && (params.include === undefined || params.include.includes("spend"));
    if (!wantsSpend) return worker.request<SessionTelemetry>("pi/session/telemetry", params);
    if (params.revision !== undefined) {
      await worker.request("pi/session/telemetry/fence", {
        path: params.path,
        ...(params.environmentKey ? { environmentKey: params.environmentKey } : {}),
        revision: params.revision,
      });
    }

    const state = this.scope(params.path, worker);
    const generation = ++state.nextGeneration;
    const snapshot = await this.options.reader.childSnapshot(params.path, generation);
    const publishIfWanted = state.dirtyGeneration !== undefined && generation >= state.dirtyGeneration;
    const answer = await worker.request<WithSourcesResult>("pi/session/telemetry/with-sources", {
      ...params,
      snapshot,
      subscribe: true,
      ...(publishIfWanted ? { publishIfWanted: true } : {}),
    });
    this.accept(params.path, worker, snapshot, answer);
    return answer.telemetry;
  }

  /** A persisted child/run signal. Only currently interested ancestor scopes are considered. */
  childChanged(childPath: string): void {
    for (const [scopePath, state] of this.scopes) {
      if (scopePath === childPath) continue;
      const beneath = runsBeneathSession(scopePath, this.options.runs.list(scopePath));
      if (!state.knownPaths.has(childPath) && !beneath.some((run) => run.sessionPath === childPath)) continue;
      this.markDirty(scopePath, state);
    }
  }

  isDirty(path: string): boolean {
    return this.scopes.get(path)?.dirtyGeneration !== undefined;
  }

  /** Remove stale telemetry and the private freshness marker; the numbered update still travels. */
  withoutStaleTelemetry(notification: JsonRpcNotification): JsonRpcNotification {
    if (notification.method !== "session/update") return notification;
    const params = notification.params as SessionUpdateParams;
    const dirtyGeneration = this.scopes.get(params.sessionPath)?.dirtyGeneration;
    const freshCorrection = dirtyGeneration !== undefined
      && params.telemetryGeneration !== undefined
      && params.telemetryGeneration >= dirtyGeneration;
    if (params.telemetryGeneration === undefined && (!params.telemetry || dirtyGeneration === undefined)) return notification;
    const { telemetry, telemetryGeneration: _generation, ...rest } = params;
    return {
      ...notification,
      params: dirtyGeneration !== undefined && !freshCorrection ? rest : { ...rest, ...(telemetry ? { telemetry } : {}) },
    };
  }

  forgetScope(path: string): void {
    const state = this.scopes.get(path);
    if (state?.timer) clearTimeout(state.timer);
    this.scopes.delete(path);
  }

  forgetWorker(generation: string): void {
    for (const [path, state] of this.scopes) {
      if (state.ownerGeneration === generation) this.forgetScope(path);
    }
  }

  rekey(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    const state = this.scopes.get(oldPath);
    if (state) {
      this.scopes.delete(oldPath);
      state.knownPaths.delete(oldPath);
      state.knownPaths.add(newPath);
      if (state.timer) {
        clearTimeout(state.timer);
        delete state.timer;
      }
      // Any old-path build will fail its map identity check before sending.
      delete state.buildingGeneration;
      this.scopes.set(newPath, state);
      if (state.dirtyGeneration !== undefined) this.scheduleRefresh(newPath, state);
    }
    for (const value of this.scopes.values()) {
      if (value.knownPaths.delete(oldPath)) value.knownPaths.add(newPath);
    }
  }

  close(): void {
    for (const state of this.scopes.values()) if (state.timer) clearTimeout(state.timer);
    this.scopes.clear();
  }

  /** Test evidence that cold/uninterested paths do not accumulate. */
  retainedScopes(): number {
    return this.scopes.size;
  }

  private scope(path: string, worker: WorkerClient): ScopeState {
    const existing = this.scopes.get(path);
    if (existing && existing.ownerGeneration === worker.generation) return existing;
    if (existing?.timer) clearTimeout(existing.timer);
    const created: ScopeState = {
      nextGeneration: existing?.nextGeneration ?? 0,
      ownerGeneration: worker.generation,
      knownPaths: new Set<string>(),
    };
    this.scopes.set(path, created);
    return created;
  }

  private markDirty(path: string, state: ScopeState): void {
    const worker = this.options.owner(path);
    if (!worker || worker.generation !== state.ownerGeneration) {
      this.forgetScope(path);
      return;
    }
    const generation = ++state.nextGeneration;
    state.dirtyGeneration = generation;
    void worker.request("pi/session/telemetry/invalidate", { path, generation }).catch(() => {});
    this.scheduleRefresh(path, state);
  }

  private scheduleRefresh(path: string, state: ScopeState): void {
    if (state.timer || state.buildingGeneration !== undefined) return;
    state.timer = setTimeout(() => {
      delete state.timer;
      void this.refresh(path, state);
    }, this.coalesceMs);
    state.timer.unref?.();
  }

  private async refresh(path: string, state: ScopeState): Promise<void> {
    if (state.buildingGeneration !== undefined || this.scopes.get(path) !== state) return;
    const generation = state.dirtyGeneration;
    const worker = this.options.owner(path);
    if (generation === undefined) return;
    if (!worker || worker.generation !== state.ownerGeneration) {
      this.forgetScope(path);
      return;
    }
    state.buildingGeneration = generation;
    let newerDirty = false;
    try {
      const snapshot = await this.options.reader.childSnapshot(path, generation);
      if (this.scopes.get(path) !== state) return;
      if (state.dirtyGeneration !== generation) return;
      if (this.options.owner(path) !== worker) return;
      const answer = await worker.request<WithSourcesResult>("pi/session/telemetry/with-sources", {
        path,
        include: ["spend"],
        snapshot,
        subscribe: false,
        publishIfWanted: true,
      });
      this.accept(path, worker, snapshot, answer);
    } catch {
      // A dead generation cannot publish through its successor. The next
      // signal or public read rebuilds; failures never create a retry loop.
    } finally {
      newerDirty = this.scopes.get(path) === state
        && state.dirtyGeneration !== undefined
        && state.dirtyGeneration !== generation;
      if (state.buildingGeneration === generation) delete state.buildingGeneration;
      if (newerDirty) this.scheduleRefresh(path, state);
    }
  }

  private accept(
    path: string,
    worker: WorkerClient,
    snapshot: TelemetryChildSpendSnapshot,
    answer: WithSourcesResult,
  ): void {
    const state = this.scopes.get(path);
    if (!state || state.ownerGeneration !== worker.generation) return;
    if (!answer.applied || answer.generation !== snapshot.generation) return;
    state.knownPaths = new Set(snapshot.sources.map((source) => source.sessionPath));
    if (state.dirtyGeneration !== undefined && snapshot.generation >= state.dirtyGeneration) {
      delete state.dirtyGeneration;
      if (state.timer) {
        clearTimeout(state.timer);
        delete state.timer;
      }
    }
  }
}
