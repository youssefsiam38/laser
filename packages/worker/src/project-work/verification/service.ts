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
  isVerificationPhaseTerminal,
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
  /**
   * The bridge a run uses. One per run, resolved when that run starts.
   *
   * `sessionPath` is the run's **own** owner, read at call time rather than
   * captured: what it answers is the conversation that admitted this run, at
   * the address that conversation lives at now (a fork moves it). It is never
   * a "current session", and nothing it returns is written back into a
   * caller's request object.
   */
  bridgeFor: (cwd: string, sessionPath: () => string) => ProjectWorkBridge | undefined;
  /**
   * Whether this worker is holding that conversation open. A person's run
   * names a session; this is what stops it naming somebody else's.
   */
  holdsSession?: (sessionPath: string) => boolean;
  /** Publish one fleet row. Absent in narrow tests. */
  publishTask?: (sessionPath: string, task: BackgroundTask) => void;
  runner?: VerificationCommandRunner;
  now?: () => Date;
  /** One bounded diagnostic line. Never the error itself. Defaults to stderr. */
  log?: (line: string) => void;
}

interface Held {
  run: VerificationRun;
  cwd: string;
  startedAt: string;
  publishedAtMs: number;
  publishedPhase?: VerificationRunState["phase"];
  /**
   * The ending has been published, and the observer took it.
   *
   * A Command's ending is published once: the run publishes it as it settles
   * and the settlement below publishes it again in the one place that knows
   * retention may now forget the run, and those are the same ending. It stays
   * false while an observer is throwing, so the second attempt is a real
   * chance at the row rather than a duplicate.
   */
  publishedEnding?: boolean;
  /**
   * The run has ended *and* this registry knows it: its work is over, its
   * terminal row has been attempted, and only now may retention forget it.
   * A phase is not enough — the phase is published from inside the run, and
   * "finished" has to mean the settlement chain has run.
   */
  settled?: boolean;
  /**
   * The conversation that owned this run is gone (its runtime closed).
   *
   * Nothing more is published for it: a row published under a path no runtime
   * serves re-creates the session in this worker's index and in the host's
   * register, and a row nothing will ever terminate is a ghost the fleet
   * cannot lose. The run still stops, still settles, and is still pruned —
   * privately.
   */
  detached?: boolean;
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
    // The bridge carries this run's own owner, so what the host records about
    // a verification write names the conversation that admitted it rather
    // than nothing at all. `held` is assigned below, before anything can call
    // it; the fallback is the address the run was admitted at.
    let held: Held | undefined;
    const bridge = this.options.bridgeFor(input.cwd, () => held?.run.snapshot().sessionPath ?? sessionPath);
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
    held = {
      run,
      cwd: input.cwd,
      startedAt: run.snapshot().startedAt,
      publishedAtMs: 0,
    };
    this.runs.set(run.id, held);
    this.prune();
    // The first row a person sees is a running one, not a summary of something
    // that already happened.
    this.publish(run.id, true);
    // `execute()` does not reject — it catches everything — but the settlement
    // below must not be able to either, because nothing is waiting on this
    // chain to notice: an unhandled rejection here would be a worker-wide
    // diagnostic carrying whatever a project's own command printed.
    void run.execute().then(
      () => this.settleHeld(run.id),
      () => this.settleHeld(run.id),
    );
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

  /**
   * A person's stop.
   *
   * `stopped` answers one question only — *did this stop change anything* — so
   * a run that had already ended, one already winding up, and one whose
   * report is already with the host all answer `false` and are left exactly
   * as they were. None of those is an error, and none of them means the run
   * was not here.
   */
  stop(input: { runId: string; reason?: string }): { stopped: boolean; run?: VerificationRunState } {
    const held = this.runs.get(input.runId);
    if (!held) return { stopped: false };
    const accepted = held.run.stop(input.reason ?? "you stopped it");
    if (accepted) this.publish(input.runId, true);
    return { stopped: accepted, run: held.run.snapshot() };
  }

  /**
   * Stop from the fleet's own row. Answers whether this worker **holds** that
   * id — which is what `delivered` means everywhere else in the fleet.
   *
   * Deliberately not "the run was cancelled": a run already stopping, or one
   * whose report is already being written, was still found here and still
   * given the stop. Answering `false` for it would tell a person nobody holds
   * a Command they can see in their own fleet.
   */
  stopByTaskId(fleetTaskId: string): boolean {
    if (!isVerificationFleetTaskId(fleetTaskId)) return false;
    const runId = verificationRunIdOf(fleetTaskId);
    if (!this.runs.has(runId)) return false;
    this.stop({ runId });
    return true;
  }

  /**
   * The conversation this run belongs to has moved its file (a fork).
   *
   * The owner is unchanged: the same conversation owns the same runs, and
   * only its address moved. Every held run follows it, and the ones still
   * working republish once under the new path — a row is only ever learnt
   * from a publication, so without that the moved conversation would never
   * see a Command it owns. Nothing is ever published under the old path
   * again, because the run's own state is the single source the row reads.
   */
  rekeySession(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    const moved: string[] = [];
    for (const [runId, held] of this.runs) {
      if (held.run.snapshot().sessionPath !== oldPath) continue;
      held.run.rekeySession(newPath);
      if (!held.settled && held.detached !== true) moved.push(runId);
    }
    for (const runId of moved) this.publish(runId, true);
  }

  /** True while a run this conversation owns has not settled (M21-T19). */
  hasUnsettled(sessionPath: string): boolean {
    for (const held of this.runs.values()) {
      if (held.settled === true) continue;
      if (held.run.snapshot().sessionPath === sessionPath) return true;
    }
    return false;
  }

  /**
   * Work this worker still owes, by the conversation that owns it (M21-T19).
   *
   * Unsettled means what it means everywhere here: the commands, the drain
   * and the report the run owes have not finished. A run whose conversation
   * closed unexpectedly is still in this list — detaching it stopped the
   * *publishing*, not the work — and that is the point. Without it, closing a
   * driver would make a live host write invisible to the one predicate that
   * decides whether this whole worker may retire, and the process could end
   * in the middle of writing a project's record. A conversation that is open
   * again at the same path is the same case: its new runtime's fleet index is
   * empty, so the work is owed and nothing there accounts for it.
   *
   * What is answered is the **identities** — each run's own fleet task id —
   * and not a count, because the caller has to tell owed work apart from work
   * its own index is already pinning the session for. A number cannot be
   * deduplicated: it would either pin a running run twice or, if the caller
   * guessed, drop a pin that was the only thing standing between a live host
   * write and this process ending.
   */
  unsettledWork(): Array<{ sessionPath: string; taskIds: string[] }> {
    const byPath = new Map<string, string[]>();
    for (const held of this.runs.values()) {
      if (held.settled === true) continue;
      const state = held.run.snapshot();
      const owed = byPath.get(state.sessionPath);
      if (owed) owed.push(state.fleetTaskId);
      else byPath.set(state.sessionPath, [state.fleetTaskId]);
    }
    return [...byPath].map(([sessionPath, taskIds]) => ({ sessionPath, taskIds }));
  }

  /**
   * The conversation that owned these runs is gone.
   *
   * Its runtime closed — expectedly or not — so nothing can watch or stop
   * them there any more, and a row published under that path would resurrect
   * a session this worker has already let go. So: stop them, publish nothing
   * further for them, and let them settle and be pruned privately. What a
   * stopped run had proved is still written, which is the whole contract.
   */
  sessionClosed(sessionPath: string, reason = "the conversation it was running in was closed"): void {
    for (const held of this.runs.values()) {
      if (held.run.snapshot().sessionPath !== sessionPath) continue;
      held.detached = true;
      held.run.stop(reason);
    }
  }

  /**
   * One fleet row, in the vocabulary a Command row already has.
   *
   * Throttled the way an index build's is: a command starting is not a frame,
   * and a phase change always gets through.
   */
  private publish(runId: string, force = false): void {
    const held = this.runs.get(runId);
    if (!held || !this.options.publishTask || held.detached === true) return;
    const state = held.run.snapshot();
    const at = (this.options.now?.() ?? new Date()).getTime();
    const terminal = isVerificationPhaseTerminal(state.phase);
    if (terminal && held.publishedEnding === true) return;
    if (!force && !terminal && state.phase === held.publishedPhase && at - held.publishedAtMs < VERIFICATION_ROW_INTERVAL_MS) return;
    held.publishedAtMs = at;
    held.publishedPhase = state.phase;
    const task: BackgroundTask = {
      id: verificationFleetTaskId(runId),
      // The run's own state is the single source of the address: a fork moves
      // it there, and nothing here keeps a second copy to go stale.
      sessionPath: state.sessionPath,
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
      // A stopped run whose record could not be written says so here too: the
      // row a person reads in the fleet must not look like the row of a run
      // that stopped and *did* keep what it proved.
      ...(state.phase === "stopped"
        ? state.problem !== undefined
          ? { error: state.problem, terminalReason: state.problem }
          : { terminalReason: "you stopped it" }
        : {}),
      ...(state.phase === "done" ? { terminalReason: state.report?.summary ?? state.line } : {}),
    };
    try {
      this.options.publishTask(state.sessionPath, task);
      if (terminal) held.publishedEnding = true;
    } catch (error) {
      // An observer that threw has lost this row. Nothing is retried and
      // nothing is queued — this registry cannot promise anyone else's
      // delivery — but it must not lose the run itself, so settlement and
      // retention carry on and one bounded line says a row went missing: the
      // run's id and the error's *kind*, never its message, its stack, the
      // command that was run or a byte of what that command printed.
      const kind = error instanceof Error ? error.name.slice(0, 80) : typeof error;
      this.note(`a verification run's row could not be published for ${runId} (${kind}); its fleet row may be missing`);
    }
  }

  /**
   * One bounded diagnostic line, through an observer that is not trusted
   * either.
   *
   * The logger is somebody else's code exactly as the row observer is, and
   * the line is only ever reached because that one already failed. If saying
   * *"a row went missing"* could itself throw, a settlement would be rejected
   * by its own diagnostic: the run would never be marked finished, retention
   * would never run, and the rejection would surface as a worker-wide
   * unhandled error carrying whatever a project's own command printed. A
   * diagnostic never decides whether work settles.
   */
  private note(line: string): void {
    try {
      (this.options.log ?? ((text: string) => console.error(text)))(line);
    } catch {
      // Nothing left to say it with, and nothing here depends on having said
      // it. The run's own state is unaffected.
    }
  }

  /**
   * One run has ended: say so, then bound what is kept.
   *
   * The order is the point. The terminal row goes out while the run is still
   * held, so nothing can be forgotten between a run ending and a person being
   * told how it ended — and only then does this run count as finished for
   * retention.
   */
  private settleHeld(runId: string): void {
    const held = this.runs.get(runId);
    if (!held) return;
    try {
      this.publish(runId, true);
    } catch {
      // Publication is somebody else's code twice over — the observer and its
      // diagnostic — and both are guarded above. This is the last lock on the
      // same door: whatever happens out there, a run that has ended is marked
      // finished here and retention still runs, because nobody else is
      // waiting on this chain to notice.
    }
    held.settled = true;
    this.prune();
  }

  /**
   * Forget the oldest settled runs past the bound.
   *
   * Insertion order is start order, so the oldest settled run goes first. A
   * run that has not settled is never evicted however many there are: it is
   * still working, and forgetting it would lose the only handle a person has
   * on it.
   */
  private prune(): void {
    const settled = [...this.runs.entries()].filter(([, held]) => held.settled === true);
    for (let index = 0; index < settled.length - VERIFICATION_RUNS_KEPT; index += 1) {
      this.runs.delete(settled[index]![0]);
    }
  }
}
