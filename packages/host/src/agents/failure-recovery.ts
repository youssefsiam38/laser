import { AGENT_FAILURE_RECOVERY_BATCH_MAX, type AgentRun } from "@lasercode/protocol";
import { canonical } from "../trust.js";
/** The authoritative run payload and creation-order recovery page. */
export interface FailureRecoveryRegistry {
  get(runId: string): AgentRun | undefined;
  recoveryFailures(cwd: string, afterRunId: string | undefined, limit: number): AgentRun[];
}

/** IDs retained directly per project; overflow stays authoritative in the run registry. */
export const AGENT_FAILURE_RECOVERY_IDS_MAX = 500;

interface RecoveryState {
  queued: Set<string>;
  /** One creation-order cursor covers every incident merged behind it. */
  overflow?: { afterRunId?: string };
  inFlight?: { ids: string[]; overflowAfterRunId?: string };
  unavailableLogged: boolean;
  overflowMergedLogged: boolean;
}

export interface FailureRecoveryClient {
  readonly alive: boolean;
  request<T>(method: string, params: unknown): Promise<T>;
}

/**
 * Bounded handoff of harness-owned failures to a project's exact successor.
 *
 * Payloads remain authoritative in AgentRunRegistry. This queue retains at
 * most 500 ids, one registry cursor and one 32-row in-flight batch per project.
 * A refused request keeps the batch; only a later successful reopen calls
 * deliver again.
 */
export class AgentFailureRecoveryQueue {
  private readonly states = new Map<string, RecoveryState>();

  constructor(
    private readonly runs: FailureRecoveryRegistry,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** Queue ids only; the durable run registry remains the source of payloads. */
  note(cwd: string, runs: readonly AgentRun[]): void {
    const recoverable = runs.filter((run) => run.parent !== null);
    if (recoverable.length === 0) return;
    const key = canonical(cwd);
    const state = this.states.get(key) ?? this.freshState();
    const hadOverflow = state.overflow !== undefined;
    let mergedOverflow = false;

    for (const run of recoverable) {
      if (state.queued.has(run.runId) || state.inFlight?.ids.includes(run.runId)) continue;
      if (state.queued.size < AGENT_FAILURE_RECOVERY_IDS_MAX) {
        state.queued.add(run.runId);
        continue;
      }
      if (!state.overflow) {
        state.overflow = { afterRunId: [...state.queued].at(-1)! };
      } else if (hadOverflow) {
        // The single creation-order cursor will encounter this later incident;
        // record the merge categorically rather than retaining another copy.
        mergedOverflow = true;
      }
    }

    if (mergedOverflow && !state.overflowMergedLogged) {
      state.overflowMergedLogged = true;
      this.log("agent failure recovery merged another incident into the pending overflow cursor");
    }
    this.states.set(key, state);
  }

  forget(cwd: string): void {
    this.states.delete(canonical(cwd));
  }

  clear(): void {
    this.states.clear();
  }

  /**
   * Hand bounded batches to exactly the successor that reopened their parents.
   * A refusal or exit leaves `inFlight` intact for a later successful reopen.
   */
  async deliver(client: FailureRecoveryClient, cwd: string, paths: readonly string[]): Promise<void> {
    const key = canonical(cwd);
    const state = this.states.get(key);
    if (!state) return;
    const reopened = new Set(paths);

    while (client.alive) {
      if (state.inFlight && !this.refilterInFlight(state, reopened)) return;

      if (!state.inFlight) {
        const ids = this.eligibleQueued(state, reopened);
        if (ids.length > 0) {
          state.inFlight = { ids };
        } else if (state.overflow) {
          const page = this.runs.recoveryFailures(cwd, state.overflow.afterRunId, AGENT_FAILURE_RECOVERY_BATCH_MAX);
          if (page.length === 0) {
            delete state.overflow;
            state.overflowMergedLogged = false;
            continue;
          }
          const pageEnd = page.at(-1)!.runId;
          const eligible = page.filter((run) => run.parent && reopened.has(run.parent.sessionPath));
          if (eligible.length === 0) {
            // Progress even when this successor did not reopen any parent in
            // the page. Otherwise the same page permanently stalls overflow.
            state.overflow.afterRunId = pageEnd;
            this.logUnavailable(state, "agent failure recovery unavailable: no failed run had a reopened parent");
            continue;
          }
          state.inFlight = { ids: eligible.map((run) => run.runId), overflowAfterRunId: pageEnd };
        } else {
          if (state.queued.size > 0) {
            this.logUnavailable(state, "agent failure recovery unavailable: a failed run's parent was not reopened");
          }
          if (state.queued.size === 0 && !state.overflow) this.states.delete(key);
          return;
        }
      }

      const inFlight = state.inFlight;
      if (!inFlight) continue;
      const batch = inFlight.ids.map((id) => this.runs.get(id)).filter((run): run is AgentRun => run !== undefined);
      if (batch.length !== inFlight.ids.length) {
        for (const id of inFlight.ids) if (!this.runs.get(id)) state.queued.delete(id);
        if (inFlight.overflowAfterRunId !== undefined && state.overflow) {
          state.overflow.afterRunId = inFlight.overflowAfterRunId;
        }
        delete state.inFlight;
        continue;
      }

      const result = await client.request<{ delivered: string[] }>("pi/worker/recover-agent-failures", { runs: batch });
      if (result.delivered.length !== batch.length || result.delivered.some((id, index) => id !== batch[index]!.runId)) {
        throw new Error("the recovered worker did not acknowledge the exact failure batch");
      }
      for (const id of inFlight.ids) state.queued.delete(id);
      if (inFlight.overflowAfterRunId !== undefined && state.overflow) {
        state.overflow.afterRunId = inFlight.overflowAfterRunId;
      }
      delete state.inFlight;
      state.unavailableLogged = false;
    }
    throw new Error("the recovered worker exited before agent failure delivery completed");
  }

  private freshState(): RecoveryState {
    return {
      queued: new Set<string>(),
      unavailableLogged: false,
      overflowMergedLogged: false,
    };
  }

  private eligibleQueued(state: RecoveryState, reopened: ReadonlySet<string>): string[] {
    const ids: string[] = [];
    for (const id of state.queued) {
      const run = this.runs.get(id);
      if (!run) {
        state.queued.delete(id);
        continue;
      }
      if (!run.parent || !reopened.has(run.parent.sessionPath)) continue;
      ids.push(id);
      if (ids.length >= AGENT_FAILURE_RECOVERY_BATCH_MAX) break;
    }
    return ids;
  }

  /** Re-check a retained batch against the exact successor before every send. */
  private refilterInFlight(state: RecoveryState, reopened: ReadonlySet<string>): boolean {
    const inFlight = state.inFlight!;
    const eligible: string[] = [];
    let couldNotRetain = false;

    for (const id of inFlight.ids) {
      const run = this.runs.get(id);
      if (!run) {
        state.queued.delete(id);
        continue;
      }
      if (run.parent && reopened.has(run.parent.sessionPath)) {
        eligible.push(id);
        continue;
      }
      if (!state.queued.has(id)) {
        if (state.queued.size < AGENT_FAILURE_RECOVERY_IDS_MAX) state.queued.add(id);
        else couldNotRetain = true;
      }
    }

    if (couldNotRetain) {
      // An overflow batch remains behind the unadvanced registry cursor. Wait
      // for a reopen that can drain queued ids rather than skipping anything.
      delete state.inFlight;
      this.logUnavailable(state, "agent failure recovery unavailable: the successor did not reopen the retained batch's parent");
      return false;
    }
    if (eligible.length === 0) {
      if (inFlight.overflowAfterRunId !== undefined && state.overflow) {
        // Every still-existing row was returned to the bounded queue.
        state.overflow.afterRunId = inFlight.overflowAfterRunId;
      }
      delete state.inFlight;
      return true;
    }
    inFlight.ids = eligible;
    return true;
  }

  private logUnavailable(state: RecoveryState, message: string): void {
    if (state.unavailableLogged) return;
    state.unavailableLogged = true;
    this.log(message);
  }
}
