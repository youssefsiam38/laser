/**
 * One verification run, as a bounded stoppable Command (M21-T19).
 *
 * The shape is the one `docs/agents.md` §6 and the Research run already use: a
 * title, a phase, counted progress, `stop()`, and a line a fleet row and a
 * live region can read. There is no percentage and no estimate, because there
 * is nothing honest to compute one from.
 *
 * What the run itself does is deliberately small:
 *
 * 1. ask the host for the **plan** — every criterion, derived from the store
 *    at exact revisions, and the commands the Task declared;
 * 2. run those commands in the checkout, in order, stopping at a person's
 *    stop;
 * 3. hand the exit codes and the bounded output back, and let the host
 *    evaluate, store the report and decide whether anything converged.
 *
 * It never decides a criterion, never writes a link, and never moves a Task.
 */
import {
  verificationFleetTaskId,
  verificationRunLine,
  type ProjectWorkGetResult,
  type VerificationCommandRun,
  type VerificationDeviation,
  type VerificationPlan,
  type VerificationReport,
  type VerificationRunState,
} from "@lasercode/protocol";
import type { ProjectWorkBridge } from "../bridge.js";
import { notRun, runVerificationCommand, type VerificationCommandRunner } from "./commands.js";

export interface VerificationRunOptions {
  bridge: ProjectWorkBridge;
  /** The Task, by opaque id or by key. One of the two is required. */
  entityId?: string;
  key?: string;
  /** The checkout the commands run in. */
  cwd: string;
  /**
   * The conversation this run belongs to, and appears in the fleet under.
   * Every run has one (M21-T19): the service refuses to start one without.
   */
  sessionPath: string;
  runner?: VerificationCommandRunner;
  /** What the run proposes to change upstream, when the caller has proposals. */
  deviations?: ReadonlyArray<Omit<VerificationDeviation, "state">>;
  now?: () => Date;
  onProgress?: (state: VerificationRunState) => void;
}

let counter = 0;

/** One run: its progress while it lasts, its report when it ends. */
export class VerificationRun {
  readonly id: string;
  private readonly controller = new AbortController();
  private state: VerificationRunState;
  private stoppedReason: string | undefined;
  /** One run runs once: starting it and awaiting it are the same run. */
  private running: Promise<VerificationRunState> | undefined;

  constructor(private readonly options: VerificationRunOptions) {
    counter += 1;
    this.id = `ver_${String(counter).padStart(4, "0")}`;
    const startedAt = (this.options.now ?? (() => new Date()))().toISOString();
    this.state = {
      runId: this.id,
      taskKey: options.key ?? "",
      entityId: options.entityId ?? "",
      sessionPath: options.sessionPath,
      fleetTaskId: verificationFleetTaskId(this.id),
      phase: "gathering",
      startedAt,
      commandsRun: 0,
      commandsTotal: 0,
      criteriaTotal: 0,
      line: "",
    };
    this.state = { ...this.state, line: verificationRunLine(this.state) };
  }

  snapshot(): VerificationRunState {
    return this.state;
  }

  /**
   * A person's stop. The commands stop; the report still says what it knows.
   *
   * The row says `stopped` **now**, not when the run next notices: a person
   * who stopped something and watches it keep saying "running" has been told
   * something untrue. Whatever the run is still waiting on — a command's
   * process, or the app's own authority — it is stopped from this moment, and
   * the report it writes afterwards says so too.
   */
  stop(reason = "you stopped it"): void {
    if (this.state.phase === "done" || this.state.phase === "stopped" || this.state.phase === "failed") return;
    this.stoppedReason = reason;
    this.controller.abort();
    this.clearCommand();
    this.publish({ phase: "stopped", endedAt: this.clock() });
  }

  /** Run it through: plan, commands, report. Never throws at the caller. */
  execute(): Promise<VerificationRunState> {
    this.running ??= this.runThrough();
    return this.running;
  }

  private async runThrough(): Promise<VerificationRunState> {
    try {
      const plan = await this.plan();
      const commands = await this.runCommands(plan);
      return await this.report(plan, commands);
    } catch (error) {
      // A run a person stopped did not fail: whatever it was waiting on gave
      // up afterwards, and the row keeps the reason the person gave it.
      if (this.stoppedReason !== undefined) return this.publish({ phase: "stopped", endedAt: this.clock() });
      return this.publish({
        phase: "failed",
        endedAt: this.clock(),
        problem: problemOf(error),
      });
    }
  }

  private clock(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

  /** No command is running any more: the field goes, rather than reading stale. */
  private clearCommand(): void {
    const { currentCommand: _running, ...rest } = this.state;
    void _running;
    this.state = { ...rest, line: verificationRunLine(rest) };
  }

  private publish(over: Partial<VerificationRunState>): VerificationRunState {
    const next = { ...this.state, ...over };
    this.state = { ...next, line: verificationRunLine(next) };
    this.options.onProgress?.(this.state);
    return this.state;
  }

  /**
   * Which project this run is in — the host's answer, never a guess.
   *
   * A run a person started has no conversation's bridge behind it and so has
   * not learnt the project yet; the first read is what teaches it, exactly as
   * a session's first `project/work/list { cwd }` does. A host that keeps no
   * work for this folder is a refusal a person can act on, not a crash.
   */
  private async projectId(): Promise<string> {
    const known = this.options.bridge.projectId();
    if (known !== undefined) return known;
    try {
      await this.options.bridge.call("project/work/list", { cwd: this.options.cwd, limit: 1 });
    } catch {
      // The refusal below is the one a person reads; the read's own wording is
      // about listing, which is not what they asked for.
    }
    const resolved = this.options.bridge.projectId();
    if (resolved === undefined) {
      throw new Error("This folder is not a project this app keeps work for, so there is no task to verify.");
    }
    return resolved;
  }

  /** Ask the host what this Task has to satisfy. The answer is the host's. */
  private async plan(): Promise<VerificationPlan> {
    const projectId = await this.projectId();
    const answer = await this.options.bridge.verify(
      {
        projectId,
        ...(this.options.entityId !== undefined ? { entityId: this.options.entityId } : {}),
        ...(this.options.key !== undefined ? { key: this.options.key } : {}),
        body: { mode: "none" as const },
        include: { comments: true, approvals: true, evidence: true, links: true },
      },
      { action: "plan" },
    );
    const plan = answer.verify.plan;
    if (!plan) throw new Error("The app could not work out what this task has to satisfy.");
    const detail = answer.result as ProjectWorkGetResult;
    this.publish({
      taskKey: plan.task.key,
      entityId: detail.entity.entityId,
      criteriaTotal: plan.criteria.length,
      commandsTotal: plan.commands.length,
      phase: "running",
    });
    return plan;
  }

  private async runCommands(plan: VerificationPlan): Promise<VerificationCommandRun[]> {
    const runner = this.options.runner ?? runVerificationCommand;
    const results: VerificationCommandRun[] = [];
    for (const command of plan.commands) {
      if (this.controller.signal.aborted) {
        results.push(notRun(command, this.clock(), "The run was stopped before this command."));
        continue;
      }
      this.publish({ currentCommand: command });
      const result = await runner({
        command,
        cwd: this.options.cwd,
        signal: this.controller.signal,
        ...(this.options.now ? { now: this.options.now } : {}),
      });
      results.push(result);
      this.publish({ commandsRun: this.state.commandsRun + 1 });
    }
    return results;
  }

  /** Hand the facts to the host, and take back what it decided. */
  private async report(plan: VerificationPlan, commands: VerificationCommandRun[]): Promise<VerificationRunState> {
    const projectId = await this.projectId();
    const endedAt = this.clock();
    this.clearCommand();
    this.publish({ phase: "reporting" });
    const answer = await this.options.bridge.verifyReport(
      {
        projectId,
        expectedRevisionId: plan.task.revisionId,
        link: {
          type: "evidence",
          entityId: plan.task.entityId,
          revisionId: plan.task.revisionId,
          kind: "verification",
          role: "supporting",
          summary: `Verification of ${plan.task.key}`,
          outcome: "inconclusive",
        },
        idempotencyKey: `verify-${this.id}`,
      },
      {
        action: "report",
        runId: this.id,
        startedAt: this.state.startedAt,
        endedAt,
        commands,
        ...(this.options.deviations && this.options.deviations.length > 0 ? { deviations: [...this.options.deviations] } : {}),
        ...(this.stoppedReason !== undefined ? { stopped: { reason: this.stoppedReason } } : {}),
      },
    );
    const report: VerificationReport | undefined = answer.verify.report;
    return this.publish({
      phase: this.stoppedReason !== undefined ? "stopped" : "done",
      endedAt,
      ...(report ? { report } : {}),
      ...(answer.verify.evidenceId !== undefined ? { evidenceId: answer.verify.evidenceId } : {}),
      ...(answer.verify.blobId !== undefined ? { blobId: answer.verify.blobId } : {}),
      ...(answer.verify.taskState !== undefined ? { taskState: answer.verify.taskState } : {}),
    });
  }
}

function problemOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message.slice(0, 500);
  return "This verification run could not finish, and the app could not say why.";
}
