/**
 * The verification runs this worker is holding (M21-T19).
 *
 * A run is started by a person from the Task detail or by a model through
 * `verify_project_task`, and both end up here: one registry, one set of rules,
 * one report path. The worker keeps the run so a person can watch it and stop
 * it; the *record* of what it proved lives in the host's store from the moment
 * the report is written, so nothing important is lost when this process ends.
 *
 * Runs are bounded in number and pruned when they are finished and old, the
 * way background commands are: a worker that verified a hundred Tasks does not
 * carry a hundred reports in memory.
 */
import type { VerificationDeviation, VerificationRunState } from "@lasercode/protocol";
import type { ProjectWorkBridge } from "../bridge.js";
import type { VerificationCommandRunner } from "./commands.js";
import { VerificationRun } from "./run.js";

/** How many finished runs are kept for a person to read before the oldest goes. */
export const VERIFICATION_RUNS_KEPT = 20;

export interface VerificationServiceOptions {
  /** The bridge a run uses. One per checkout, resolved when a run starts. */
  bridgeFor: (cwd: string) => ProjectWorkBridge | undefined;
  runner?: VerificationCommandRunner;
  now?: () => Date;
}

export class VerificationService {
  private readonly runs = new Map<string, { run: VerificationRun; cwd: string }>();

  constructor(private readonly options: VerificationServiceOptions) {}

  /**
   * Start one run. It returns as soon as the run exists, not when it ends: a
   * verification is a Command a person watches, not a request they wait on.
   */
  start(input: {
    cwd: string;
    entityId?: string;
    key?: string;
    deviations?: ReadonlyArray<Omit<VerificationDeviation, "state">>;
  }): VerificationRunState {
    const bridge = this.options.bridgeFor(input.cwd);
    if (!bridge) {
      throw new Error("This project's work could not be reached from here, so there is nothing to verify against.");
    }
    const run = new VerificationRun({
      bridge,
      cwd: input.cwd,
      ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
      ...(input.key !== undefined ? { key: input.key } : {}),
      ...(input.deviations && input.deviations.length > 0 ? { deviations: input.deviations } : {}),
      ...(this.options.runner ? { runner: this.options.runner } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    this.runs.set(run.id, { run, cwd: input.cwd });
    this.prune();
    void run.execute();
    return run.snapshot();
  }

  /** Start one run and wait for it, for a model tool that reports the answer. */
  async run(input: {
    cwd: string;
    entityId?: string;
    key?: string;
    deviations?: ReadonlyArray<Omit<VerificationDeviation, "state">>;
  }): Promise<VerificationRunState> {
    const started = this.start(input);
    const held = this.runs.get(started.runId);
    return held ? await held.run.execute() : started;
  }

  /** Where a run has got to. Without an id, every run in this checkout. */
  state(input: { cwd: string; runId?: string }): VerificationRunState[] {
    if (input.runId !== undefined) {
      const held = this.runs.get(input.runId);
      return held ? [held.run.snapshot()] : [];
    }
    return [...this.runs.values()].filter((held) => held.cwd === input.cwd).map((held) => held.run.snapshot());
  }

  /** A person's stop. A run that already ended is reported as it is. */
  stop(input: { runId: string; reason?: string }): { stopped: boolean; run?: VerificationRunState } {
    const held = this.runs.get(input.runId);
    if (!held) return { stopped: false };
    const before = held.run.snapshot().phase;
    held.run.stop(input.reason ?? "you stopped it");
    return { stopped: before !== "done" && before !== "stopped" && before !== "failed", run: held.run.snapshot() };
  }

  private prune(): void {
    const finished = [...this.runs.entries()].filter(([, held]) => {
      const phase = held.run.snapshot().phase;
      return phase === "done" || phase === "stopped" || phase === "failed";
    });
    while (finished.length > VERIFICATION_RUNS_KEPT) {
      const oldest = finished.shift();
      if (oldest) this.runs.delete(oldest[0]);
    }
  }
}
