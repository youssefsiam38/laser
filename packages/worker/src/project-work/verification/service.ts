/**
 * The verification runs this worker is holding, and their fleet rows
 * (M21-T19).
 *
 * A run is started by a person from the Task detail or by a model through
 * `verify_project_task`, and both end up here: one registry, one set of rules,
 * one report path, one row. The worker keeps the run so a person can watch it
 * and stop it; the *record* of what it proved lives in the host's store from
 * the moment the report is written, so nothing important is lost when this
 * process ends.
 *
 * Two rules decide the shape of this file:
 *
 * - **Every run belongs to a conversation.** A Command nobody can see in the
 *   fleet is a Command nobody can stop, so a run with no session is refused
 *   with the sentence that says how to get one — never started invisibly and
 *   never attached to a session that did not ask for it.
 * - **The row travels the road every Command row already travels** (M21-T13):
 *   a `BackgroundTask` published as a `lasercode/task/update` extension
 *   message, which the worker's task index and the host's register fold in.
 *   Nothing new is invented, and Stop from the row is the ordinary
 *   `pi/task/stop`.
 */
import {
  VERIFICATION_NEEDS_SESSION,
  isVerificationFleetTaskId,
  verificationFleetTaskId,
  verificationRunIdOf,
  type BackgroundTask,
  type VerificationDeviation,
  type VerificationRunState,
} from "@lasercode/protocol";
import type { ProjectWorkBridge } from "../bridge.js";
import type { VerificationCommandRunner } from "./commands.js";
import { VerificationRun } from "./run.js";

/** How many finished runs are kept for a person to read before the oldest goes. */
export const VERIFICATION_RUNS_KEPT = 20;

/** How often a running verification refreshes its fleet row. */
export const VERIFICATION_ROW_INTERVAL_MS = 250;

/** Why a run could not be started. Carries the sentence a person reads. */
export class VerificationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationRefused";
  }
}

export interface VerificationServiceOptions {
  /** The bridge a run uses. One per checkout, resolved when a run starts. */
  bridgeFor: (cwd: string) => ProjectWorkBridge | undefined;
  /**
   * Whether this worker is holding that conversation open. A person's run
   * names a session; this is what stops it naming somebody else's.
   */
  holdsSession?: (sessionPath: string) => boolean;
  /** Publish one fleet row. Absent in narrow tests. */
  publishTask?: (sessionPath: string, task: BackgroundTask) => void;
  runner?: VerificationCommandRunner;
  now?: () => Date;
}

interface Held {
  run: VerificationRun;
  cwd: string;
  sessionPath: string;
  startedAt: string;
  publishedAtMs: number;
  publishedPhase?: VerificationRunState["phase"];
}

export class VerificationService {
  private readonly runs = new Map<string, Held>();

  constructor(private readonly options: VerificationServiceOptions) {}

  /**
   * Start one run. It returns as soon as the run exists, not when it ends: a
   * verification is a Command a person watches, not a request they wait on.
   *
   * A run that names no conversation, or one this worker is not holding, is
   * refused: the fleet is where a Command is watched and stopped, and a row
   * needs a session to hang under.
   */
  start(input: {
    cwd: string;
    entityId?: string;
    key?: string;
    sessionPath?: string;
    deviations?: ReadonlyArray<Omit<VerificationDeviation, "state">>;
  }): VerificationRunState {
    const sessionPath = input.sessionPath;
    if (sessionPath === undefined || sessionPath.trim() === "") throw new VerificationRefused(VERIFICATION_NEEDS_SESSION);
    if (this.options.holdsSession && !this.options.holdsSession(sessionPath)) {
      throw new VerificationRefused(
        "That conversation is not open in this project, so a verification run started from it could not be watched or stopped. Open it, or use Start… to join this task to one that is.",
      );
    }
    const bridge = this.options.bridgeFor(input.cwd);
    if (!bridge) {
      throw new VerificationRefused("This project's work could not be reached from here, so there is nothing to verify against.");
    }
    const run = new VerificationRun({
      bridge,
      cwd: input.cwd,
      sessionPath,
      ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
      ...(input.key !== undefined ? { key: input.key } : {}),
      ...(input.deviations && input.deviations.length > 0 ? { deviations: input.deviations } : {}),
      ...(this.options.runner ? { runner: this.options.runner } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
      onProgress: (state) => this.publish(state.runId),
    });
    this.runs.set(run.id, {
      run,
      cwd: input.cwd,
      sessionPath,
      startedAt: run.snapshot().startedAt,
      publishedAtMs: 0,
    });
    this.prune();
    // The first row a person sees is a running one, not a summary of something
    // that already happened.
    this.publish(run.id, true);
    void run.execute().finally(() => this.publish(run.id, true));
    return run.snapshot();
  }

  /** Start one run and wait for it, for a model tool that reports the answer. */
  async run(input: {
    cwd: string;
    entityId?: string;
    key?: string;
    sessionPath?: string;
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
    this.publish(input.runId, true);
    return { stopped: before !== "done" && before !== "stopped" && before !== "failed", run: held.run.snapshot() };
  }

  /** Stop from the fleet's own row. Answers whether this worker had it. */
  stopByTaskId(fleetTaskId: string): boolean {
    if (!isVerificationFleetTaskId(fleetTaskId)) return false;
    const runId = verificationRunIdOf(fleetTaskId);
    if (!this.runs.has(runId)) return false;
    return this.stop({ runId }).stopped;
  }

  /**
   * One fleet row, in the vocabulary a Command row already has.
   *
   * Throttled the way an index build's is: a command starting is not a frame,
   * and a phase change always gets through.
   */
  private publish(runId: string, force = false): void {
    const held = this.runs.get(runId);
    if (!held || !this.options.publishTask) return;
    const state = held.run.snapshot();
    const at = (this.options.now?.() ?? new Date()).getTime();
    const terminal = state.phase === "done" || state.phase === "stopped" || state.phase === "failed";
    if (!force && !terminal && state.phase === held.publishedPhase && at - held.publishedAtMs < VERIFICATION_ROW_INTERVAL_MS) return;
    held.publishedAtMs = at;
    held.publishedPhase = state.phase;
    const task: BackgroundTask = {
      id: verificationFleetTaskId(runId),
      sessionPath: held.sessionPath,
      command: `Verify ${state.taskKey || "a project task"}`,
      title: `Verify ${state.taskKey || "a project task"}`,
      status: terminal ? (state.phase === "done" ? "completed" : state.phase === "stopped" ? "stopped" : "failed") : "running",
      origin: "background",
      startedAt: held.startedAt,
      // A verification run's output is the commands' own, kept in the report;
      // the row carries none of it, so it never pretends to be a log.
      outputBytes: 0,
      activity: state.line,
      ...(terminal
        ? { endedAt: state.endedAt ?? new Date(at).toISOString(), exitCode: null }
        : {}),
      ...(state.phase === "failed" && state.problem !== undefined ? { error: state.problem, terminalReason: state.problem } : {}),
      ...(state.phase === "stopped" ? { terminalReason: "you stopped it" } : {}),
      ...(state.phase === "done" ? { terminalReason: state.report?.summary ?? state.line } : {}),
    };
    this.options.publishTask(held.sessionPath, task);
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
