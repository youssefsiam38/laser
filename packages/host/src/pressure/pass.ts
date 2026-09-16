import {
  memoryPressureDirectiveResultSchema,
  type MemoryPressureActionResult,
  type MemoryPressureDirective,
  type MemoryPressureLevel,
  type MemoryPressureLevelState,
  type MemoryPressureRole,
} from "@lasercode/protocol";
import { LEVEL_SEVERITY } from "./sampler.js";

/** One live worker, identified only by host-private generations. */
export interface HostPressureWorker {
  cwd: string;
  clientGeneration: string;
  workerGeneration: number;
  /** What this exact process was explicitly asked to use, when configured. */
  configuredOldSpaceBytes?: number;
}

/** Step 5's exact answer at its destructive boundary. */
export type PressureAllowDecision = "authorized" | "generation_moved" | "not_in_pass";

export interface HostPressureActions {
  releaseEphemeral(): boolean;
  directive(cwd: string, expect: HostPressureWorker, params: MemoryPressureDirective): Promise<unknown>;
  unloadIdle(allow: (cwd: string) => PressureAllowDecision): Promise<MemoryPressureActionResult>;
  retireIdle(
    allow: ReadonlyMap<string, { clientGeneration: string; workerGeneration: number }>,
  ): Promise<MemoryPressureActionResult>;
}

export interface HostPressurePassCounters {
  passes: number;
  passCooldownSkips: number;
  passFailures: number;
  directivesSent: number;
  directivesTimedOut: number;
  directivesMalformed: number;
  directivesRefused: number;
  directivesStale: number;
  directivesFailed: number;
  directivesLate: number;
}

export interface HostPressurePassDeps {
  actions: HostPressureActions;
  now(): number;
  workers(): HostPressureWorker[] | undefined;
  /** Fresh evidence's level, or undefined when this exact generation has none. */
  freshLevel(worker: HostPressureWorker, at: number): MemoryPressureLevelState | undefined;
  projectId(cwd: string): string | undefined;
  addRow(row: MemoryPressureActionResult, role: MemoryPressureRole, level: MemoryPressureLevel, project?: string): void;
  /** Read-only sample: updates evidence/publication, never hysteresis. */
  reprobe(level: MemoryPressureLevel): Promise<"unknown" | "relieved" | "still_elevated">;
  refresh(): void;
  serialize(work: () => Promise<void>): Promise<void>;
  nextEpoch(): number;
  isDisposed(): boolean;
  callbackFailed(kind: "releaseEphemeral" | "unloadIdle" | "retireIdle"): void;
  counters: HostPressurePassCounters;
  directiveStageMs: number;
  workerDirectiveSkipMs: number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface HostPressurePass {
  run(level: MemoryPressureDirective["level"]): Promise<void>;
  forgetWorker(cwd: string, clientGeneration: string): void;
}

type DirectiveAnswer = "authorized" | "refused" | "invalid";

export function createHostPressurePass(deps: HostPressurePassDeps): HostPressurePass {
  let lastPassAt = Number.NEGATIVE_INFINITY;
  let passCooldownMs = 0;
  let rotation = 0;
  const lastDirectedAt = new Map<string, { at: number; clientGeneration: string }>();

  const currentWorker = (selected: HostPressureWorker): boolean =>
    Boolean(deps.workers()?.some((worker) =>
      worker.cwd === selected.cwd &&
      worker.clientGeneration === selected.clientGeneration &&
      worker.workerGeneration === selected.workerGeneration,
    ));

  const processAnswer = (
    selected: HostPressureWorker,
    value: unknown,
    level: MemoryPressureLevel,
    late: boolean,
    collect?: (row: MemoryPressureActionResult) => void,
  ): DirectiveAnswer => {
    if (deps.isDisposed()) return "invalid";
    const parsed = memoryPressureDirectiveResultSchema.safeParse(value);
    if (!parsed.success) {
      deps.counters.directivesMalformed += 1;
      return "invalid";
    }
    if (!currentWorker(selected)) {
      deps.counters.directivesStale += 1;
      return "invalid";
    }
    if (!parsed.data.applied) {
      deps.counters.directivesRefused += 1;
      return "refused";
    }
    const project = deps.projectId(selected.cwd);
    for (const row of parsed.data.results) {
      deps.addRow(row, "project_worker", level, project);
      collect?.(row);
    }
    if (late) deps.counters.directivesLate += 1;
    return "authorized";
  };

  const selectedWorkers = (at: number): HostPressureWorker[] => {
    const candidates = (deps.workers() ?? []).filter((worker) =>
      at - (lastDirectedAt.get(worker.cwd)?.at ?? Number.NEGATIVE_INFINITY) >= deps.workerDirectiveSkipMs,
    );
    const rank = (worker: HostPressureWorker): number => {
      const level = deps.freshLevel(worker, at);
      return level === undefined ? -1 : LEVEL_SEVERITY[level];
    };
    const ties = candidates.map((worker) => worker.cwd).sort();
    const tieRank = (cwd: string): number => {
      const index = ties.indexOf(cwd);
      return (index - rotation + ties.length) % Math.max(1, ties.length);
    };
    candidates.sort((a, b) =>
      rank(b) - rank(a) ||
      (lastDirectedAt.get(a.cwd)?.at ?? -1) - (lastDirectedAt.get(b.cwd)?.at ?? -1) ||
      tieRank(a.cwd) - tieRank(b.cwd),
    );
    const selected = candidates.slice(0, 4);
    if (selected.length > 0) rotation = (rotation + 1) % candidates.length;
    return selected;
  };

  const runDirectives = async (
    level: MemoryPressureDirective["level"],
    epoch: number,
    allow: Map<string, HostPressureWorker>,
    collect: (row: MemoryPressureActionResult) => void,
  ): Promise<void> => {
    const selected = selectedWorkers(deps.now());
    if (selected.length === 0) return;
    type State = { selected: HostPressureWorker; settled: boolean; processed: boolean; value?: unknown; failed?: boolean };
    const states: State[] = selected.map((worker) => ({ selected: worker, settled: false, processed: false }));
    const requests = states.map(async (state) => {
      lastDirectedAt.set(state.selected.cwd, { at: deps.now(), clientGeneration: state.selected.clientGeneration });
      deps.counters.directivesSent += 1;
      try {
        state.value = await deps.actions.directive(state.selected.cwd, state.selected, {
          level,
          epoch,
          generation: state.selected.workerGeneration,
        });
      } catch {
        state.failed = true;
      } finally {
        state.settled = true;
      }
    });

    let deadline: unknown;
    let timedOut = false;
    await Promise.race([
      Promise.all(requests),
      new Promise<void>((resolve) => {
        deadline = deps.setTimer(() => {
          timedOut = true;
          resolve();
        }, deps.directiveStageMs);
      }),
    ]);
    if (!timedOut && deadline !== undefined) deps.clearTimer(deadline);

    for (const state of states) {
      if (!state.settled) {
        deps.counters.directivesTimedOut += 1;
        continue;
      }
      state.processed = true;
      if (state.failed) {
        deps.counters.directivesFailed += 1;
        continue;
      }
      if (processAnswer(state.selected, state.value, level, false, collect) === "authorized") {
        allow.set(state.selected.cwd, state.selected);
      }
    }

    let lateOrder = Promise.resolve();
    for (let index = 0; index < states.length; index += 1) {
      const state = states[index]!;
      if (state.processed) continue;
      lateOrder = lateOrder
        .then(() => requests[index])
        .then(() => deps.serialize(async () => {
          if (deps.isDisposed() || state.processed) return;
          state.processed = true;
          if (state.failed) deps.counters.directivesFailed += 1;
          else processAnswer(state.selected, state.value, level, true);
          deps.refresh();
        }));
    }
    void lateOrder.catch(() => {
      deps.counters.passFailures += 1;
    });
  };

  const freshAuthorized = (at: number): Map<string, HostPressureWorker> => {
    const answer = new Map<string, HostPressureWorker>();
    for (const worker of deps.workers() ?? []) {
      if (deps.freshLevel(worker, at) !== undefined) answer.set(worker.cwd, worker);
    }
    return answer;
  };

  const run = async (level: MemoryPressureDirective["level"]): Promise<void> => {
    const at = deps.now();
    if (at - lastPassAt < passCooldownMs) {
      deps.counters.passCooldownSkips += 1;
      return;
    }
    deps.counters.passes += 1;
    const epoch = deps.nextEpoch();
    const rows: MemoryPressureActionResult[] = [];
    let completed = false;
    const record = (row: MemoryPressureActionResult): void => {
      rows.push(row);
      deps.addRow(row, "host", level);
      deps.refresh();
    };

    try {
      try {
        const gave = deps.actions.releaseEphemeral();
        record(gave
          ? { action: "ephemeral_caches", outcome: "released", released: { count: 1 } }
          : { action: "ephemeral_caches", outcome: "nothing_to_give" });
      } catch {
        deps.callbackFailed("releaseEphemeral");
        record({ action: "ephemeral_caches", outcome: "unavailable" });
      }
      if (await deps.reprobe(level) !== "still_elevated") return;

      const allow = freshAuthorized(deps.now());
      await runDirectives(level, epoch, allow, (row) => rows.push(row));
      if (await deps.reprobe(level) !== "still_elevated") return;

      const allowDecision = (cwd: string): PressureAllowDecision => {
        const expected = allow.get(cwd);
        if (!expected) return "not_in_pass";
        return currentWorker(expected) ? "authorized" : "generation_moved";
      };
      try {
        record(await deps.actions.unloadIdle(allowDecision));
      } catch {
        deps.callbackFailed("unloadIdle");
        record({ action: "idle_session_unload", outcome: "unavailable" });
      }
      if (await deps.reprobe(level) !== "still_elevated") return;

      try {
        const exact = new Map([...allow].map(([cwd, worker]) => [cwd, {
          clientGeneration: worker.clientGeneration,
          workerGeneration: worker.workerGeneration,
        }]));
        record(await deps.actions.retireIdle(exact));
      } catch {
        deps.callbackFailed("retireIdle");
        record({ action: "worker_retirement", outcome: "unavailable" });
      }
      completed = true;
    } finally {
      lastPassAt = deps.now();
      const quiet = completed && rows.length > 0 && rows.every((row) =>
        row.outcome === "nothing_to_give" || row.outcome === "held",
      );
      passCooldownMs = quiet ? 60_000 : level === "critical" ? 10_000 : 30_000;
    }
  };

  return {
    run,
    forgetWorker(cwd, clientGeneration) {
      if (lastDirectedAt.get(cwd)?.clientGeneration === clientGeneration) lastDirectedAt.delete(cwd);
    },
  };
}
