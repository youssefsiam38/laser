/**
 * M21-T19 · the verification run, worker side.
 *
 * What is exercised here is the half only the worker can do: executing a
 * Task's declared commands in a real checkout, bounding and digesting their
 * output, recording their exit codes, and stopping when a person stops. The
 * verdict is never the worker's, so the bridge in these tests is scripted:
 * it answers the plan and takes the report, exactly as the host does.
 */
import { EventEmitter } from "node:events";
import { execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ClientRequests,
  VerificationBridgeResult,
  VerificationCommandRun,
  VerificationEnvelope,
  VerificationPlan,
  VerificationReport,
} from "@lasercode/protocol";
import { convergenceOf, verificationSummary } from "@lasercode/protocol";
import { isVerificationFleetTaskId, type BackgroundTask } from "@lasercode/protocol";
import type { ProjectWorkBridge, ProjectWorkExecutionShape, ProjectWorkSessionIdentity } from "../../src/project-work/bridge.js";
import { ProjectWorkToolFailure } from "../../src/project-work/bridge.js";
import { VerificationRefused } from "../../src/project-work/verification/service.js";
import {
  COMMAND_STILL_RUNNING_PROBLEM,
  killVerificationTree,
  runVerificationCommand,
} from "../../src/project-work/verification/commands.js";
import { VERIFICATION_RUNS_KEPT } from "../../src/project-work/verification/service.js";
import { VerificationService } from "../../src/project-work/verification/service.js";
import { verifyProjectTask } from "../../src/project-work/verification/tools.js";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/**
 * A barrier the test resolves by hand.
 *
 * Everything about a run's lifetime below is asserted at an exact point —
 * before a command has closed, before the report has landed, after it has
 * failed — and a wall-clock sleep would be asserting about a machine's speed
 * instead.
 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** One turn of the event loop, so what the last barrier released has run. */
async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Run turns until something the code under test did becomes true. */
async function until(what: string, ready: () => boolean): Promise<void> {
  for (let step = 0; step < 200 && !ready(); step += 1) await turn();
  expect(ready(), what).toBe(true);
}

/** A real repository, because a verification run happens in a real checkout. */
function repository(): string {
  const dir = mkdtempSync(join(tmpdir(), "verify-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# a project\n");
  return dir;
}

/** The conversation every run in this file belongs to. */
const SESSION = "/work/app/one.jsonl";

/** The approved artifact a deviation in this file is proposed against. */
const UPSTREAM = { entityId: "ent_spec", key: "SPEC-1", revisionId: "rev_spec_2", digest: "9".repeat(64) };

const SOURCE = {
  authority: "task" as const,
  entityId: "ent_1",
  kind: "task" as const,
  key: "TASK-1",
  revisionId: "rev_1",
  digest: "a".repeat(64),
  title: "Failed rows say why",
};

/**
 * A scripted host: it derives the plan and it decides the report. The run
 * under test supplies only the command results, which is the whole point.
 */
class ScriptedHost implements ProjectWorkBridge {
  reports: VerificationReport[] = [];
  constructor(private readonly commands: string[]) {}

  projectId(): string | undefined {
    return "prj_1";
  }
  identity(): ProjectWorkSessionIdentity {
    return { label: "Verification" };
  }
  async execution(): Promise<ProjectWorkExecutionShape> {
    return { workspace: "shared", checkout: "/tmp" };
  }
  task(): { entityId: string; key: string } | undefined {
    return undefined;
  }
  /** Only the one read a deviation needs: the upstream it is proposed about. */
  async call(_method: string, params: { key?: string }): Promise<unknown> {
    if (params.key !== UPSTREAM.key) throw new Error("this test's bridge answers verification and one upstream read");
    return {
      entity: { entityId: UPSTREAM.entityId, kind: "spec", key: UPSTREAM.key },
      revision: { revisionId: UPSTREAM.revisionId, digest: UPSTREAM.digest },
    };
  }
  lastResearchResult(): undefined {
    return undefined;
  }

  private plan(): VerificationPlan {
    return {
      task: SOURCE,
      authorities: [SOURCE],
      criteria: this.commands.map((command, index) => ({
        id: `task:command:${String(index)}`,
        authority: "task" as const,
        kind: "command" as const,
        text: `${command} passes.`,
        required: true,
        machineVerifiable: true,
        source: SOURCE,
        command,
      })),
      commands: this.commands,
      blockers: [],
      truncated: [],
    };
  }

  async verify(): Promise<{ result: ClientRequests["project/work/get"]["result"]; verify: VerificationBridgeResult }> {
    return {
      result: { entity: { entityId: SOURCE.entityId } } as unknown as ClientRequests["project/work/get"]["result"],
      verify: { plan: this.plan() },
    };
  }

  async verifyReport(
    _params: ClientRequests["project/work/link"]["params"],
    envelope: Extract<VerificationEnvelope, { action: "report" }>,
  ): Promise<{ result: ClientRequests["project/work/link"]["result"]; verify: VerificationBridgeResult }> {
    const plan = this.plan();
    const runs = new Map(envelope.commands.map((run) => [run.command, run]));
    const findings = plan.criteria.map((criterion) => {
      const run = runs.get(criterion.command!);
      return {
        criterionId: criterion.id,
        outcome:
          run?.status === "passed" ? ("satisfied" as const) : run?.status === "failed" ? ("failed" as const) : ("needs_person" as const),
        detail: `${criterion.command!} ${run?.status ?? "did not run"}`,
        evidenceIds: [],
      };
    });
    const convergence = convergenceOf({
      criteria: plan.criteria,
      findings,
      blockers: [],
      ...(envelope.stopped ? { stopped: true } : {}),
    });
    const withoutSummary: Omit<VerificationReport, "summary"> = {
      version: 1,
      runId: envelope.runId,
      task: SOURCE,
      startedAt: envelope.startedAt,
      endedAt: envelope.endedAt,
      ...(envelope.stopped ? { stopped: envelope.stopped } : {}),
      authorities: [SOURCE],
      criteria: plan.criteria,
      commands: envelope.commands,
      findings,
      deviations: (envelope.deviations ?? []).map((deviation) => ({ ...deviation, state: "proposed" as const })),
      blockers: [],
      personDecisions: [],
      converged: convergence.converged,
      outcome: convergence.outcome,
      truncated: [],
    };
    const report: VerificationReport = { ...withoutSummary, summary: verificationSummary(withoutSummary) };
    this.reports.push(report);
    return {
      result: { link: { type: "evidence", evidence: {} }, seq: 1 } as unknown as ClientRequests["project/work/link"]["result"],
      verify: {
        report,
        evidenceId: "evd_1",
        blobId: "blb_1",
        taskState: report.converged ? "needs_review" : "in_progress",
      },
    };
  }
}

describe("running a task's declared commands", () => {
  it("records the exit code, the exact byte count and a digest over every byte", async () => {
    const cwd = repository();
    const text = "hello from the checkout\n";
    const run = await runVerificationCommand({ command: `printf '%s' '${text.trim()}'`, cwd });
    expect(run.status).toBe("passed");
    expect(run.exitCode).toBe(0);
    expect(run.tail).toContain("hello from the checkout");
    expect(run.outputBytes).toBe(text.trim().length);
    expect(run.outputDigest).toBe(createHash("sha256").update(text.trim()).digest("hex"));
  });

  it("records a non-zero exit as a failure rather than deciding what it means", async () => {
    const cwd = repository();
    const run = await runVerificationCommand({ command: "exit 3", cwd });
    expect(run.status).toBe("failed");
    expect(run.exitCode).toBe(3);
  });

  it("runs in the checkout it was given, and nowhere else", async () => {
    const cwd = repository();
    const run = await runVerificationCommand({ command: "cat README.md", cwd });
    expect(run.tail).toContain("# a project");
  });

  it("is stopped by a person's stop, and says it was stopped rather than that it failed", async () => {
    const cwd = repository();
    const controller = new AbortController();
    const running = runVerificationCommand({ command: "sleep 30", cwd, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const run = await running;
    expect(run.status).toBe("stopped");
    expect(run.exitCode).toBeUndefined();
  });
});

describe("a run, end to end over the bridge", () => {
  const fake = (failing: readonly string[]) =>
    async ({ command }: { command: string }): Promise<VerificationCommandRun> => ({
      command,
      status: failing.includes(command) ? "failed" : "passed",
      exitCode: failing.includes(command) ? 1 : 0,
      startedAt: "2026-03-01T09:00:00.000Z",
      endedAt: "2026-03-01T09:00:01.000Z",
      outputBytes: 3,
      outputDigest: "c".repeat(64),
      tail: "ok\n",
    });

  it("runs every declared command and comes back with what the host decided", async () => {
    const host = new ScriptedHost(["pnpm test", "pnpm lint"]);
    const service = new VerificationService({ bridgeFor: () => host, runner: fake([]) });
    const state = await service.run({ cwd: repository(), key: "TASK-1", sessionPath: SESSION });
    expect(state.phase).toBe("done");
    expect(state.report!.converged).toBe(true);
    expect(state.taskState, "the host's move, reported back, never invented here").toBe("needs_review");
    expect(state.report!.commands.map((command) => command.command)).toEqual(["pnpm test", "pnpm lint"]);
  });

  it("reports a failing command without converging, and never moves the task itself", async () => {
    const host = new ScriptedHost(["pnpm test", "pnpm lint"]);
    const service = new VerificationService({ bridgeFor: () => host, runner: fake(["pnpm lint"]) });
    const state = await service.run({ cwd: repository(), key: "TASK-1", sessionPath: SESSION });
    expect(state.report!.converged).toBe(false);
    expect(state.report!.outcome).toBe("failed");
    expect(state.taskState).toBe("in_progress");
  });

  it("is watchable and stoppable while it runs, and still writes a report", async () => {
    const host = new ScriptedHost(["slow-one", "slow-two"]);
    let started = 0;
    const service = new VerificationService({
      bridgeFor: () => host,
      runner: async ({ command, signal }) => {
        started += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          command,
          status: signal?.aborted === true ? ("stopped" as const) : ("passed" as const),
          ...(signal?.aborted === true ? {} : { exitCode: 0 }),
          startedAt: "2026-03-01T09:00:00.000Z",
          endedAt: "2026-03-01T09:00:01.000Z",
          outputBytes: 0,
          outputDigest: "d".repeat(64),
          tail: "",
        };
      },
    });
    const started1 = service.start({ cwd: repository(), key: "TASK-1", sessionPath: SESSION });
    expect(service.state({ cwd: "ignored", runId: started1.runId })[0]!.runId).toBe(started1.runId);
    const stopped = service.stop({ runId: started1.runId, reason: "you stopped it" });
    expect(stopped.stopped).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const after = service.state({ cwd: "ignored", runId: started1.runId })[0]!;
    expect(after.phase).toBe("stopped");
    expect(after.report!.stopped?.reason).toBe("you stopped it");
    expect(started, "a stopped run does not start the commands it had not reached").toBeLessThanOrEqual(2);
  });
});

describe("the fleet row a run takes", () => {
  const publishing = (host: ScriptedHost, rows: Array<{ sessionPath: string; task: BackgroundTask }>) =>
    new VerificationService({
      bridgeFor: () => host,
      holdsSession: (path) => path === SESSION,
      publishTask: (sessionPath, task) => rows.push({ sessionPath, task }),
      runner: async ({ command }) => ({
        command,
        status: "passed" as const,
        exitCode: 0,
        startedAt: "2026-03-01T09:00:00.000Z",
        endedAt: "2026-03-01T09:00:01.000Z",
        outputBytes: 0,
        outputDigest: "f".repeat(64),
        tail: "",
      }),
    });

  it("publishes a running row under the owning conversation the moment it starts, and a terminal one when it ends", async () => {
    const host = new ScriptedHost(["pnpm test"]);
    const rows: Array<{ sessionPath: string; task: BackgroundTask }> = [];
    const service = publishing(host, rows);
    const state = service.start({ cwd: repository(), key: "TASK-1", sessionPath: SESSION });
    expect(rows[0]!.sessionPath, "the row hangs under the conversation that owns the run").toBe(SESSION);
    expect(rows[0]!.task.status).toBe("running");
    expect(isVerificationFleetTaskId(rows[0]!.task.id), "a namespaced id, so Stop from the row finds it").toBe(true);
    expect(rows[0]!.task.id).toBe(state.fleetTaskId);
    await service.state({ cwd: "ignored", runId: state.runId })[0] && (await new Promise((resolve) => setTimeout(resolve, 30)));
    const last = rows.at(-1)!.task;
    expect(last.status).toBe("completed");
    expect(last.endedAt, "a finished Command says when it finished").toBeDefined();
    expect(last.terminalReason).toBeDefined();
    expect(last.outputBytes, "the row carries no output: the commands' bytes live in the report").toBe(0);
  });

  it("is stopped from the fleet row by its own id, and publishes a stopped row", async () => {
    const host = new ScriptedHost(["one", "two"]);
    const rows: Array<{ sessionPath: string; task: BackgroundTask }> = [];
    const service = new VerificationService({
      bridgeFor: () => host,
      holdsSession: () => true,
      publishTask: (sessionPath, task) => rows.push({ sessionPath, task }),
      runner: async ({ command, signal }) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          command,
          status: signal?.aborted === true ? ("stopped" as const) : ("passed" as const),
          ...(signal?.aborted === true ? {} : { exitCode: 0 }),
          startedAt: "2026-03-01T09:00:00.000Z",
          endedAt: "2026-03-01T09:00:01.000Z",
          outputBytes: 0,
          outputDigest: "f".repeat(64),
          tail: "",
        };
      },
    });
    const state = service.start({ cwd: repository(), key: "TASK-1", sessionPath: SESSION });
    expect(service.stopByTaskId(state.fleetTaskId)).toBe(true);
    expect(service.stopByTaskId("design-index-7"), "another kind of Command is not this one's to stop").toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(rows.at(-1)!.task.status).toBe("stopped");
    expect(rows.at(-1)!.task.terminalReason).toBe("you stopped it");
  });

  it("refuses to start a run no conversation owns, and says which act gets one", () => {
    const host = new ScriptedHost(["pnpm test"]);
    const rows: Array<{ sessionPath: string; task: BackgroundTask }> = [];
    const service = publishing(host, rows);
    expect(() => service.start({ cwd: repository(), key: "TASK-1" })).toThrow(VerificationRefused);
    try {
      service.start({ cwd: repository(), key: "TASK-1" });
    } catch (error) {
      expect((error as Error).message).toContain("Start…");
    }
    expect(rows, "nothing invisible was started").toHaveLength(0);
  });

  it("refuses a conversation this worker is not holding, rather than inventing a row under it", () => {
    const host = new ScriptedHost(["pnpm test"]);
    const rows: Array<{ sessionPath: string; task: BackgroundTask }> = [];
    const service = publishing(host, rows);
    expect(() => service.start({ cwd: repository(), key: "TASK-1", sessionPath: "/somebody/else.jsonl" })).toThrow(VerificationRefused);
    expect(rows).toHaveLength(0);
  });
});

describe("verify_project_task", () => {
  /** `session: null` is a conversation that has no identity yet. */
  const deps = (host: ScriptedHost, cwd: string, session: string | null = SESSION) => ({
    bridge: host,
    sessionPath: () => session ?? undefined,
    service: new VerificationService({
      bridgeFor: () => host,
      runner: async ({ command }: { command: string }) => ({
        command,
        status: "passed" as const,
        exitCode: 0,
        startedAt: "2026-03-01T09:00:00.000Z",
        endedAt: "2026-03-01T09:00:01.000Z",
        outputBytes: 0,
        outputDigest: "e".repeat(64),
        tail: "",
      }),
    }),
    cwd,
  });

  it("answers with the outcome, the commands and the task's state, and says done is not its to give", async () => {
    const host = new ScriptedHost(["pnpm test"]);
    const answer = await verifyProjectTask(deps(host, repository()), { key: "TASK-1" });
    expect(answer["outcome"]).toBe("converged");
    expect(answer["state"]).toBe("needs_review");
    expect(String(answer["note"])).toContain("Only they mark it done");
    expect((answer["commands"] as Array<{ exit_code: number }>)[0]!.exit_code).toBe(0);
  });

  it("refuses a call that names no task, and says how to find one", async () => {
    const host = new ScriptedHost(["pnpm test"]);
    await expect(verifyProjectTask(deps(host, repository()), {})).rejects.toBeInstanceOf(ProjectWorkToolFailure);
  });

  it("belongs to the conversation the tool call ran in, and refuses when that has no identity yet", async () => {
    const host = new ScriptedHost(["pnpm test"]);
    const answer = await verifyProjectTask(deps(host, repository()), { key: "TASK-1" });
    expect(answer["run_id"]).toBeDefined();
    const failure = await verifyProjectTask(deps(host, repository(), null), { key: "TASK-1" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProjectWorkToolFailure);
    expect((failure as ProjectWorkToolFailure).toolError.code).toBe("no_session_identity");
  });

  it("persists a deviation it proposes, against the upstream's exact revision and digest", async () => {
    const host = new ScriptedHost(["pnpm test"]);
    await verifyProjectTask(deps(host, repository()), {
      key: "TASK-1",
      deviation_reason: "the lint rule this spec assumes does not exist",
      deviation_upstream_key: "SPEC-1",
      deviation_proposal: "name the rules the package really has",
    });
    const deviation = host.reports.at(-1)!.deviations[0]!;
    expect(deviation.state, "only a person accepts one").toBe("proposed");
    expect(deviation.reason).toContain("lint rule");
    expect(deviation.upstream.revisionId).toBe(UPSTREAM.revisionId);
    expect(deviation.upstream.digest, "the exact bytes the proposal was written against").toBe(UPSTREAM.digest);
  });

  it("refuses a deviation that does not say which upstream it is about", async () => {
    const host = new ScriptedHost(["pnpm test"]);
    const failure = await verifyProjectTask(deps(host, repository()), {
      key: "TASK-1",
      deviation_reason: "the rule does not exist",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProjectWorkToolFailure);
    expect((failure as ProjectWorkToolFailure).toolError.code).toBe("no_deviation_upstream");
  });
});

// ---------------------------------------------------------------------------
// The Command's lifetime: a stop, the report it still owes, and its ending
// ---------------------------------------------------------------------------

/** The scripted host, with the two host calls held open until a test lets go. */
class BarrierHost extends ScriptedHost {
  readonly planGate = deferred();
  readonly reportGate = deferred();
  reportCalls = 0;
  lastEnvelope: Extract<VerificationEnvelope, { action: "report" }> | undefined;

  override async verify(): Promise<{ result: ClientRequests["project/work/get"]["result"]; verify: VerificationBridgeResult }> {
    await this.planGate.promise;
    return await super.verify();
  }

  override async verifyReport(
    params: ClientRequests["project/work/link"]["params"],
    envelope: Extract<VerificationEnvelope, { action: "report" }>,
  ): Promise<{ result: ClientRequests["project/work/link"]["result"]; verify: VerificationBridgeResult }> {
    this.reportCalls += 1;
    this.lastEnvelope = envelope;
    await this.reportGate.promise;
    return await super.verifyReport(params, envelope);
  }
}

/** A service whose rows a test can read, with the command held on a barrier. */
function lifetime(host: BarrierHost, commandGate?: { promise: Promise<void> }) {
  const rows: Array<{ sessionPath: string; task: BackgroundTask }> = [];
  const logged: string[] = [];
  const service = new VerificationService({
    bridgeFor: () => host,
    holdsSession: () => true,
    publishTask: (sessionPath, task) => rows.push({ sessionPath, task }),
    log: (line) => logged.push(line),
    runner: async ({ command, signal }) => {
      if (commandGate) await commandGate.promise;
      return {
        command,
        status: signal?.aborted === true ? ("stopped" as const) : ("passed" as const),
        ...(signal?.aborted === true ? {} : { exitCode: 0 }),
        startedAt: "2026-03-01T09:00:00.000Z",
        endedAt: "2026-03-01T09:00:01.000Z",
        outputBytes: 0,
        outputDigest: "b".repeat(64),
        tail: "",
      };
    },
  });
  return { rows, logged, service };
}

describe("a stop, and the ending it does not publish early", () => {
  it("keeps the run running and pinned until the report it owes has landed", async () => {
    const host = new BarrierHost(["pnpm test"]);
    const commandGate = deferred();
    const { rows, service } = lifetime(host, commandGate);
    const started = service.start({ cwd: repository(), key: "TASK-1", sessionPath: SESSION });
    host.planGate.resolve();
    await until("the command started", () => service.state({ cwd: "x", runId: started.runId })[0]!.phase === "running");

    // The stop, while the command is still open.
    expect(service.stop({ runId: started.runId }).stopped, "the first stop changes something").toBe(true);
    const stopping = service.state({ cwd: "x", runId: started.runId })[0]!;
    expect(stopping.stopping, "it is winding up").toBe(true);
    expect(stopping.phase, "and it has not ended").not.toBe("stopped");
    expect(stopping.endedAt, "so nothing says when it ended").toBeUndefined();
    expect(stopping.line).toContain("Stopping");
    expect(rows.at(-1)!.task.status, "the fleet row is still running, so the session is still pinned").toBe("running");
    expect(rows.some((row) => row.task.status === "stopped"), "no ending has been published").toBe(false);

    // A second stop is not a second stop, and it does not restate anything.
    expect(service.stop({ runId: started.runId }).stopped, "nothing left to change").toBe(false);
    expect(service.stopByTaskId(started.fleetTaskId), "but this worker plainly holds it").toBe(true);

    // The command closes; the report is still held open.
    commandGate.resolve();
    await until("the report was dispatched", () => host.reportCalls === 1);
    const reporting = service.state({ cwd: "x", runId: started.runId })[0]!;
    expect(reporting.phase).toBe("reporting");
    expect(reporting.line, "and it says what it is doing now").toContain("Saving what this run proved");
    expect(rows.at(-1)!.task.status, "still running, still pinned").toBe("running");

    // Only now, with the record written, is the ending published.
    host.reportGate.resolve();
    await until("the run settled", () => service.state({ cwd: "x", runId: started.runId })[0]!.phase === "stopped");
    const terminal = rows.filter((row) => row.task.status === "stopped");
    expect(terminal, "exactly one ending, published once").toHaveLength(1);
    expect(terminal[0]!.task.endedAt).toBeDefined();
    expect(terminal[0]!.task.terminalReason).toBe("you stopped it");
    expect(host.lastEnvelope!.stopped?.reason, "the report says the run was stopped").toBe("you stopped it");
    expect(host.reports.at(-1)!.converged, "a stopped run's report moves nothing").toBe(false);
  });

  it("says what was lost when the record of a stopped run could not be written", async () => {
    const host = new BarrierHost(["pnpm test"]);
    const commandGate = deferred();
    const { rows, service } = lifetime(host, commandGate);
    const started = service.start({ cwd: repository(), key: "TASK-1", sessionPath: SESSION });
    host.planGate.resolve();
    await until("the command started", () => service.state({ cwd: "x", runId: started.runId })[0]!.phase === "running");
    service.stop({ runId: started.runId });
    commandGate.resolve();
    await until("the report was dispatched", () => host.reportCalls === 1);

    host.reportGate.reject(new Error("The app could not reach this project's work."));
    await until("the run settled", () => service.state({ cwd: "x", runId: started.runId })[0]!.phase === "stopped");
    const state = service.state({ cwd: "x", runId: started.runId })[0]!;
    expect(state.problem, "a stopped run whose record was lost does not look like one that kept it").toContain(
      "could not be recorded",
    );
    expect(state.problem).toContain("could not reach");
    expect(rows.at(-1)!.task.error, "and the fleet row carries it too").toContain("could not be recorded");
  });

  it("does not claim a report already with the host was cancelled", async () => {
    const host = new BarrierHost(["pnpm test"]);
    const { rows, service } = lifetime(host);
    const started = service.start({ cwd: repository(), key: "TASK-1", sessionPath: SESSION });
    host.planGate.resolve();
    await until("the report was dispatched", () => host.reportCalls === 1);
    const before = service.state({ cwd: "x", runId: started.runId })[0]!;

    const stop = service.stop({ runId: started.runId });
    expect(stop.stopped, "nothing was changed, because nothing here can change it").toBe(false);
    expect(service.stopByTaskId(started.fleetTaskId), "the run is still held here, and says so").toBe(true);
    const after = service.state({ cwd: "x", runId: started.runId })[0]!;
    expect(after.stopping, "it is not winding up: the record is being written").toBeUndefined();
    expect(after.phase).toBe(before.phase);
    expect(after.line, "and the line stays the true one").toBe(before.line);
    expect(host.lastEnvelope!.stopped, "the payload the host is reading was not rewritten").toBeUndefined();

    host.reportGate.resolve();
    await until("the run settled", () => service.state({ cwd: "x", runId: started.runId })[0]!.phase === "done");
    const settled = service.state({ cwd: "x", runId: started.runId })[0]!;
    expect(host.reportCalls, "no second report, and no rollback invented").toBe(1);
    expect(settled.taskState, "the host's own outcome, reported as it is").toBe("needs_review");
    expect(rows.filter((row) => row.task.status === "completed"), "one ending").toHaveLength(1);
  });
});

describe("a command this app could not stop, while the run is still going", () => {
  /**
   * The one thing a person watching a stuck run needs, and the one thing it
   * must not become.
   *
   * A command whose tree would not end, or whose output will not close, is
   * *live work*: the record is not made, the pin is not released and the row
   * is still a running one. What the app owes the person is the reason, in
   * the state they are already watching — not a line on stderr they will
   * never see, and not a fabricated ending.
   */
  it("puts the reason in the run's own visible state, settles nothing, and drops the sentence once the work really closes", async () => {
    const host = new BarrierHost(["pnpm test"]);
    const commandGate = deferred();
    const rows: Array<{ sessionPath: string; task: BackgroundTask }> = [];
    const service = new VerificationService({
      bridgeFor: () => host,
      holdsSession: () => true,
      publishTask: (sessionPath, task) => rows.push({ sessionPath, task }),
      // The runner's own seam, saying exactly what the real one says when a
      // kill is refused. The command has *not* ended: it goes on until the
      // gate opens, which is what a tree that would not die looks like.
      runner: async ({ command, onProblem }) => {
        onProblem?.(COMMAND_STILL_RUNNING_PROBLEM.cannotEnd("EPERM"));
        await commandGate.promise;
        return {
          command,
          status: "passed" as const,
          exitCode: 0,
          startedAt: "2026-03-01T09:00:00.000Z",
          endedAt: "2026-03-01T09:00:01.000Z",
          outputBytes: 0,
          outputDigest: "d".repeat(64),
          tail: "",
        };
      },
    });
    const started = service.start({ cwd: repository(), key: "TASK-1", sessionPath: SESSION });
    host.planGate.resolve();
    await until(
      "the run said why it is still going",
      () => service.state({ cwd: "x", runId: started.runId })[0]!.problem !== undefined,
    );

    const live = service.state({ cwd: "x", runId: started.runId })[0]!;
    expect(live.problem, "what the app could not do").toContain("could not be stopped");
    expect(live.problem, "with the platform's own code and no more").toContain("EPERM");
    expect(live.problem, "and nothing the command read or where it ran").not.toContain("pnpm test");
    expect(live.phase, "the run has not ended: an unstoppable command is live work").toBe("running");
    expect(live.endedAt, "so nothing says when it ended").toBeUndefined();
    expect(live.report, "and no report was invented from a diagnostic").toBeUndefined();
    expect(service.hasUnsettled(SESSION), "the conversation is still pinned").toBe(true);
    expect(service.unsettledWork(), "and the worker still owes this path exactly one run").toEqual([
      { sessionPath: SESSION, taskIds: [started.fleetTaskId] },
    ]);
    expect(rows.at(-1)!.task.status, "the fleet row is still a running one").toBe("running");
    expect(rows.every((row) => row.task.error === undefined), "no failure was published for work that has not failed").toBe(true);

    // It really closes.
    commandGate.resolve();
    host.reportGate.resolve();
    await until("the run settled", () => service.state({ cwd: "x", runId: started.runId })[0]!.phase === "done");
    const settled = service.state({ cwd: "x", runId: started.runId })[0]!;
    expect(settled.problem, "“still waiting to close” is not true of a run that closed").toBeUndefined();
    expect(settled.report, "and what it proved was recorded").toBeDefined();
    expect(service.hasUnsettled(SESSION), "nothing is owed any more").toBe(false);
  });

  it("keeps the problem the ending itself carries, rather than clearing it with the live one", async () => {
    const host = new BarrierHost(["pnpm test"]);
    const service = new VerificationService({
      bridgeFor: () => host,
      holdsSession: () => true,
      runner: async ({ command, onProblem }) => {
        onProblem?.(COMMAND_STILL_RUNNING_PROBLEM.lingering);
        return {
          command,
          status: "passed" as const,
          exitCode: 0,
          startedAt: "2026-03-01T09:00:00.000Z",
          endedAt: "2026-03-01T09:00:01.000Z",
          outputBytes: 0,
          outputDigest: "e".repeat(64),
          tail: "",
        };
      },
    });
    const started = service.start({ cwd: repository(), key: "TASK-1", sessionPath: SESSION });
    host.planGate.resolve();
    await until("the report was dispatched", () => host.reportCalls === 1);
    host.reportGate.reject(new Error("The app could not reach this project's work."));
    await until("the run settled", () => service.state({ cwd: "x", runId: started.runId })[0]!.phase === "failed");
    const state = service.state({ cwd: "x", runId: started.runId })[0]!;
    expect(state.problem, "the ending's own reason is the one a person needs").toContain("could not reach");
    expect(state.problem, "and it is not overwritten by a sentence about waiting").not.toContain("still has its output open");
  });
});

describe("the conversation a run belongs to", () => {
  it("follows a fork, republishes once under the new path and never names the old one again", async () => {
    const host = new BarrierHost(["pnpm test"]);
    const commandGate = deferred();
    const owners: Array<() => string> = [];
    const rows: Array<{ sessionPath: string; task: BackgroundTask }> = [];
    const service = new VerificationService({
      bridgeFor: (_cwd, sessionPath) => {
        owners.push(sessionPath);
        return host;
      },
      holdsSession: () => true,
      publishTask: (sessionPath, task) => rows.push({ sessionPath, task }),
      runner: async ({ command }) => {
        await commandGate.promise;
        return {
          command,
          status: "passed" as const,
          exitCode: 0,
          startedAt: "2026-03-01T09:00:00.000Z",
          endedAt: "2026-03-01T09:00:01.000Z",
          outputBytes: 0,
          outputDigest: "c".repeat(64),
          tail: "",
        };
      },
    });
    const cwd = repository();
    const started = service.start({ cwd, key: "TASK-1", sessionPath: SESSION });
    const elsewhere = service.start({ cwd, key: "TASK-1", sessionPath: "/work/app/other.jsonl" });
    host.planGate.resolve();
    await until("the command started", () => service.state({ cwd: "x", runId: started.runId })[0]!.phase === "running");
    expect(owners[0]!(), "the bridge asks the host as the conversation that admitted the run").toBe(SESSION);

    const moved = "/work/app/two.jsonl";
    const before = rows.length;
    service.rekeySession(SESSION, moved);
    expect(rows.length, "the moved conversation is told about the Command it owns, once").toBe(before + 1);
    expect(rows.at(-1)!.sessionPath).toBe(moved);
    expect(service.state({ cwd: "x", runId: started.runId })[0]!.sessionPath).toBe(moved);
    expect(owners[0]!(), "and the host hears the address it lives at now").toBe(moved);
    expect(
      service.state({ cwd: "x", runId: elsewhere.runId })[0]!.sessionPath,
      "another conversation's run is not touched by a fork that was not its own",
    ).toBe("/work/app/other.jsonl");
    expect(owners[1]!()).toBe("/work/app/other.jsonl");

    commandGate.resolve();
    host.reportGate.resolve();
    await until("the run settled", () => service.state({ cwd: "x", runId: started.runId })[0]!.phase === "done");
    expect(
      rows.slice(before).filter((row) => row.task.id === started.fleetTaskId).every((row) => row.sessionPath === moved),
      "nothing is ever published under the old path",
    ).toBe(true);

    // A settled run does not republish, and a path this service holds nothing
    // for publishes nothing at all.
    const after = rows.length;
    service.rekeySession(moved, "/work/app/three.jsonl");
    service.rekeySession("/nobody/here.jsonl", "/work/app/four.jsonl");
    expect(rows.length, "a run that has ended is not re-announced").toBe(after);
  });

  it("stops its runs when the conversation closes, and publishes nothing under a path nobody serves", async () => {
    const host = new BarrierHost(["pnpm test"]);
    const commandGate = deferred();
    const { rows, service } = lifetime(host, commandGate);
    const started = service.start({ cwd: repository(), key: "TASK-1", sessionPath: SESSION });
    host.planGate.resolve();
    await until("the command started", () => service.state({ cwd: "x", runId: started.runId })[0]!.phase === "running");
    const before = rows.length;

    service.sessionClosed(SESSION);
    commandGate.resolve();
    host.reportGate.resolve();
    await until("the run settled privately", () => service.state({ cwd: "x", runId: started.runId })[0]!.phase === "stopped");
    expect(rows.length, "a closed conversation is never re-created by a row").toBe(before);
    expect(host.reports.at(-1)!.stopped?.reason, "and what it had proved was still written").toContain("closed");
  });
});

describe("what this worker keeps", () => {
  const instant = (host: ScriptedHost, rows: Array<{ sessionPath: string; task: BackgroundTask }>) =>
    new VerificationService({
      bridgeFor: () => host,
      holdsSession: () => true,
      publishTask: (sessionPath, task) => rows.push({ sessionPath, task }),
      runner: async ({ command }) => ({
        command,
        status: "passed" as const,
        exitCode: 0,
        startedAt: "2026-03-01T09:00:00.000Z",
        endedAt: "2026-03-01T09:00:01.000Z",
        outputBytes: 0,
        outputDigest: "a".repeat(64),
        tail: "",
      }),
    });

  it("keeps twenty settled runs without waiting for another to start, and publishes every ending first", async () => {
    const host = new ScriptedHost(["pnpm test"]);
    const rows: Array<{ sessionPath: string; task: BackgroundTask }> = [];
    const service = instant(host, rows);
    const cwd = repository();
    const ids: string[] = [];
    for (let index = 0; index < VERIFICATION_RUNS_KEPT + 1; index += 1) {
      ids.push(service.start({ cwd, key: "TASK-1", sessionPath: SESSION }).runId);
    }
    await until("every run settled", () => rows.filter((row) => row.task.status === "completed").length === ids.length);

    expect(service.state({ cwd }), "the bound holds with no further start").toHaveLength(VERIFICATION_RUNS_KEPT);
    expect(service.state({ cwd, runId: ids[0]! }), "the oldest settled run is the one that went").toHaveLength(0);
    expect(
      rows.filter((row) => row.task.id === `verify-${ids[0]!}` && row.task.status === "completed"),
      "and its ending was published before it was forgotten",
    ).toHaveLength(1);
  });

  it("never forgets a run that has not settled, however many there are", async () => {
    const host = new BarrierHost(["pnpm test"]);
    const commandGate = deferred();
    const { service } = lifetime(host, commandGate);
    const cwd = repository();
    const ids: string[] = [];
    for (let index = 0; index < VERIFICATION_RUNS_KEPT + 4; index += 1) {
      ids.push(service.start({ cwd, key: "TASK-1", sessionPath: SESSION }).runId);
    }
    host.planGate.resolve();
    await until("they are all working", () => service.state({ cwd }).every((run) => run.phase === "running"));
    expect(service.state({ cwd }), "nothing still working is ever evicted").toHaveLength(ids.length);
  });

  it("loses no ending and prints no raw error when an observer throws", async () => {
    const host = new ScriptedHost(["pnpm test"]);
    const logged: string[] = [];
    const service = new VerificationService({
      bridgeFor: () => host,
      holdsSession: () => true,
      publishTask: () => {
        throw new Error("the fleet row carried /home/someone/secret and 'pnpm test' output");
      },
      log: (line) => logged.push(line),
      runner: async ({ command }) => ({
        command,
        status: "passed" as const,
        exitCode: 0,
        startedAt: "2026-03-01T09:00:00.000Z",
        endedAt: "2026-03-01T09:00:01.000Z",
        outputBytes: 0,
        outputDigest: "a".repeat(64),
        tail: "",
      }),
    });
    const cwd = repository();
    const started = service.start({ cwd, key: "TASK-1", sessionPath: SESSION });
    const rest = Array.from({ length: VERIFICATION_RUNS_KEPT }, () => service.start({ cwd, key: "TASK-1", sessionPath: SESSION }));
    await until(
      "every run settled anyway",
      () => [started, ...rest].every((run) => (service.state({ cwd, runId: run.runId })[0]?.phase ?? "done") === "done"),
    );

    // What this registry can prove is its own state and its own bound: it
    // cannot promise a delivery through an observer that throws, and it does
    // not pretend to. What it can prove is that nothing here is lost or kept
    // for ever because somebody else's code failed.
    expect(service.state({ cwd }), "the bound still holds when every row was refused").toHaveLength(VERIFICATION_RUNS_KEPT);
    expect(service.state({ cwd, runId: rest.at(-1)!.runId })[0]!.report, "the run kept what it proved").toBeDefined();
    expect(logged.length, "and said that a row went missing").toBeGreaterThan(0);
    const ids = new Set([started, ...rest].map((run) => run.runId));
    for (const line of logged) {
      expect([...ids].some((id) => line.includes(id)), "the line names the run it is about").toBe(true);
      expect(line, "and the error's kind, which is all a diagnostic needs").toContain("Error");
      expect(line, "never the message, the path or a byte the command printed").not.toContain("secret");
      expect(line).not.toContain("pnpm test");
    }
  });

  it("settles and bounds itself when the row observer and its own diagnostic both throw", async () => {
    const host = new ScriptedHost([]);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const service = new VerificationService({
        bridgeFor: () => host,
        holdsSession: () => true,
        publishTask: () => {
          throw new Error("the fleet row carried /home/someone/secret");
        },
        // The diagnostic that was only reached because the row failed — and
        // it fails too. A settlement that a *log line* could reject would
        // leave a finished run marked unfinished for ever: never pruned,
        // never released, and the rejection surfacing as a worker-wide error
        // carrying whatever a project's command printed.
        log: () => {
          throw new Error("this logger is broken and says /home/someone/secret too");
        },
      });
      const cwd = repository();
      const runs = Array.from({ length: VERIFICATION_RUNS_KEPT + 3 }, () => service.start({ cwd, key: "TASK-1", sessionPath: SESSION }));
      await until(
        "every run reached its ending anyway",
        () => runs.every((run) => service.state({ cwd, runId: run.runId }).length === 0 || service.state({ cwd, runId: run.runId })[0]?.phase === "done"),
      );
      // Two turns past the last settlement: an unhandled rejection is reported
      // after the microtask queue drains, so this is where one would appear.
      await turn();
      await turn();

      expect(service.state({ cwd }), "retention still bounds what this worker keeps").toHaveLength(VERIFICATION_RUNS_KEPT);
      expect(service.state({ cwd, runId: runs.at(-1)!.runId })[0]?.report, "and the last run still kept what it proved").toBeDefined();
      expect(unhandled, "nothing was left for the worker's rejection guard to print").toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

// ---------------------------------------------------------------------------
// The runner's own lifecycle, driven with an inert double
// ---------------------------------------------------------------------------

/** A child process that does nothing until a test makes it do something. */
class InertChild extends EventEmitter {
  pid: number | undefined = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  kill(): boolean {
    return true;
  }
  /** What a real child emits when it has gone and its output is closed. */
  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
  say(text: string): void {
    this.stdout.emit("data", Buffer.from(text));
  }
}

const inert = () => {
  const child = new InertChild();
  return { child, as: child as unknown as ChildProcess };
};

describe("when a verification command really ends", () => {
  it("starts no process at all for a run that was already stopped", async () => {
    let spawned = 0;
    const controller = new AbortController();
    controller.abort();
    const run = await runVerificationCommand({
      command: "pnpm test",
      cwd: "/tmp",
      signal: controller.signal,
      spawnProcess: () => {
        spawned += 1;
        return inert().as;
      },
    });
    expect(spawned, "nothing is started in order to be killed").toBe(0);
    expect(run.status).toBe("stopped");
    expect(run.detail).toContain("You stopped");
  });

  it("records a spawn that fails on the spot as unavailable, rather than throwing", async () => {
    const run = await runVerificationCommand({
      command: "pnpm test",
      cwd: "/tmp",
      spawnProcess: () => {
        throw new Error("this machine has no shell to run that in");
      },
    });
    expect(run.status).toBe("unavailable");
    expect(run.detail).toContain("no shell");
  });

  it("waits for the output to close, and keeps what arrived after the process ended", async () => {
    const { child, as } = inert();
    let settled = false;
    const running = runVerificationCommand({ command: "pnpm test", cwd: "/tmp", spawnProcess: () => as }).then((run) => {
      settled = true;
      return run;
    });
    await turn();
    child.say("first\n");
    child.emit("exit", 0, null);
    await turn();
    expect(settled, "an exit is not a closed pipe, and the record is not made yet").toBe(false);
    child.say("the line that says why\n");
    child.emit("close", 0, null);
    const run = await running;
    expect(run.status).toBe("passed");
    expect(run.exitCode).toBe(0);
    expect(run.tail, "the last thing it printed is in the record").toContain("the line that says why");
    expect(run.outputBytes).toBe(Buffer.byteLength("first\nthe line that says why\n"));
  });

  it("kills the tree on a stop and still records nothing until it has closed", async () => {
    const { child, as } = inert();
    const controller = new AbortController();
    const killed: number[] = [];
    let settled = false;
    const running = runVerificationCommand({
      command: "pnpm test",
      cwd: "/tmp",
      signal: controller.signal,
      spawnProcess: () => as,
      killTree: (process_) => killed.push(process_.pid ?? 0),
    }).then((run) => {
      settled = true;
      return run;
    });
    await turn();
    controller.abort();
    await turn();
    expect(killed, "the whole tree was asked to end").toEqual([4242]);
    expect(settled, "but nothing has been recorded: a signal sent is not a process gone").toBe(false);
    child.close(null, "SIGKILL");
    const run = await running;
    expect(run.status).toBe("stopped");
    expect(run.exitCode, "a stopped command has no exit code to report").toBeUndefined();
    expect(run.detail).toContain("You stopped");
  });

  it("ends a command that outstays its bound, and still waits for it to close", async () => {
    vi.useFakeTimers();
    try {
      const { child, as } = inert();
      let settled = false;
      const running = runVerificationCommand({
        command: "pnpm test",
        cwd: "/tmp",
        timeoutMs: 60_000,
        spawnProcess: () => as,
        killTree: () => {},
      }).then((run) => {
        settled = true;
        return run;
      });
      await vi.advanceTimersByTimeAsync(60_001);
      expect(settled, "the bound ends it; the close is what records it").toBe(false);
      child.close(null, "SIGKILL");
      await vi.advanceTimersByTimeAsync(0);
      const run = await running;
      expect(run.status).toBe("stopped");
      expect(run.detail).toContain("was ended");
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a command that is not on this machine as unavailable", async () => {
    const { child, as } = inert();
    child.pid = undefined;
    const running = runVerificationCommand({ command: "pnpm test", cwd: "/tmp", spawnProcess: () => as });
    await turn();
    const error: NodeJS.ErrnoException = new Error("spawn pnpm ENOENT");
    error.code = "ENOENT";
    child.emit("error", error);
    const run = await running;
    expect(run.status).toBe("unavailable");
    expect(run.detail).toContain("PATH");
  });

  it("invents no ending for a process tree it could not end", async () => {
    const { child, as } = inert();
    const controller = new AbortController();
    const logged: string[] = [];
    let settled = false;
    const running = runVerificationCommand({
      command: "pnpm test",
      cwd: "/tmp",
      signal: controller.signal,
      spawnProcess: () => as,
      killTree: () => {
        const error: NodeJS.ErrnoException = new Error("kill EPERM");
        error.code = "EPERM";
        throw error;
      },
      log: (line) => logged.push(line),
    }).then((run) => {
      settled = true;
      return run;
    });
    await turn();
    controller.abort();
    await turn();
    expect(settled, "no record is made: nothing witnessed an exit").toBe(false);
    expect(logged, "one bounded line says why the run is still pinned").toHaveLength(1);
    expect(logged[0]).toContain("EPERM");
    expect(logged[0], "and it carries nothing the command read").not.toContain("pnpm test");

    // And it is not leaked: if the process does go, the record is still made.
    child.close(null, "SIGKILL");
    const run = await running;
    expect(run.status).toBe("stopped");
  });

  it("never settles on a timer while output a grandchild holds is still open, and keeps what it writes", async () => {
    vi.useFakeTimers();
    try {
      const { child, as } = inert();
      const killed: number[] = [];
      const logged: string[] = [];
      let settled = false;
      const running = runVerificationCommand({
        command: "pnpm test",
        cwd: "/tmp",
        stdioGraceMs: 500,
        spawnProcess: () => as,
        killTree: (process_) => killed.push(process_.pid ?? 0),
        log: (line) => logged.push(line),
      }).then((run) => {
        settled = true;
        return run;
      });
      await vi.advanceTimersByTimeAsync(0);
      child.say("before it exited\n");
      child.emit("exit", 0, null);

      // Well past the wait: the process has gone, something it started still
      // has the pipe, and no clock may turn that into a passed command.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled, "no record is made from a timer: the run is still working, and still pinned").toBe(false);
      expect(killed, "the wait asks for the owned tree to be cleaned up, once").toEqual([4242]);
      expect(logged, "and says out loud that this run is waiting").toHaveLength(1);
      expect(logged[0]).toContain("still open");
      expect(logged[0], "with nothing the command read in it").not.toContain("pnpm test");

      // The late bytes are this command's output, and they are in the record
      // the close finally makes — counted and digested with everything else,
      // exactly once.
      child.say("the line that says why\n");
      child.emit("close", 0, null);
      await vi.advanceTimersByTimeAsync(0);
      const run = await running;
      expect(run.status).toBe("passed");
      expect(run.exitCode).toBe(0);
      expect(run.tail).toContain("the line that says why");
      expect(run.outputBytes, "every byte, including the ones that came after the exit").toBe(
        Buffer.byteLength("before it exited\nthe line that says why\n"),
      );
      expect(run.outputDigest, "digested over exactly those bytes").toBe(
        createHash("sha256").update("before it exited\nthe line that says why\n").digest("hex"),
      );
      expect(run.detail, "and the record says it waited rather than pretending nothing happened").toContain("stayed open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets go of the output once the record exists, so nothing can change what it says", async () => {
    const { child, as } = inert();
    const running = runVerificationCommand({ command: "pnpm test", cwd: "/tmp", spawnProcess: () => as });
    await turn();
    child.say("all of it\n");
    child.close(0, null);
    const run = await running;
    expect(run.outputBytes).toBe(Buffer.byteLength("all of it\n"));

    // A chunk after the close — a stream this worker no longer listens to, or
    // a double-emitting double — cannot be counted into a published total or
    // hashed into a digest that has already been reported as a fact.
    child.say("and something afterwards\n");
    await turn();
    expect(run.outputBytes, "the record is the bytes it was made from").toBe(Buffer.byteLength("all of it\n"));
    expect(run.outputDigest).toBe(createHash("sha256").update("all of it\n").digest("hex"));
  });
});

describe("ending a process tree this worker owns", () => {
  /** A child with a pid and nothing else: the kill is what is under test. */
  const target = (): ChildProcess => ({ pid: 4242 }) as unknown as ChildProcess;

  it("reports a Windows kill that failed after it returned, rather than dropping it", () => {
    const problems: string[] = [];
    let asked: string[] | undefined;
    killVerificationTree(target(), (code) => problems.push(code), {
      platform: "win32",
      runTaskkill: (arguments_, done) => {
        asked = arguments_;
        const error: NodeJS.ErrnoException = new Error("taskkill: access is denied for /home/someone/app");
        error.code = "EPERM";
        // Later, from another process: the whole point of the callback.
        done(error);
      },
    });
    expect(asked, "the whole tree is what is ended, not the shell alone").toEqual(["/pid", "4242", "/T", "/F"]);
    expect(problems, "the refusal reaches the caller").toEqual(["EPERM"]);
  });

  it("says nothing when the Windows kill found the tree already gone", () => {
    const problems: string[] = [];
    killVerificationTree(target(), (code) => problems.push(code), {
      platform: "win32",
      runTaskkill: (_arguments, done) => {
        const error: NodeJS.ErrnoException = new Error("no such process");
        error.code = "ESRCH";
        done(error);
      },
    });
    expect(problems, "already ended is not a failure to end it").toEqual([]);
  });

  it("says nothing when taskkill itself reports the process is not there, which is how Windows says it", () => {
    const problems: string[] = [];
    let asked: string[] | undefined;
    killVerificationTree(target(), (code) => problems.push(code), {
      platform: "win32",
      runTaskkill: (arguments_, done) => {
        asked = arguments_;
        // The real shape, not a synthetic one: `taskkill` is another process,
        // so a refusal arrives as a non-zero **exit status**, which `execFile`
        // puts in `error.code` as a number. 128 is the one it uses for a pid
        // it cannot find — the ordinary outcome of stopping a run whose tree
        // has already gone.
        const error = new Error('ERROR: The process "4242" not found.') as Error & { code?: unknown };
        error.code = 128;
        done(error);
      },
    });
    expect(asked, "the whole tree is what is ended, not the shell alone").toEqual(["/pid", "4242", "/T", "/F"]);
    expect(problems, "a tree that is already gone is not a run this app could not stop").toEqual([]);
  });

  it("still reports a taskkill that refused for any other reason, with the status it refused by", () => {
    const problems: string[] = [];
    killVerificationTree(target(), (code) => problems.push(code), {
      platform: "win32",
      runTaskkill: (_arguments, done) => {
        const error = new Error("taskkill: the process could not be terminated") as Error & { code?: unknown };
        error.code = 1;
        done(error);
      },
    });
    expect(problems, "only 'not found' is benign; every other status is news").toEqual(["1"]);
  });

  it("keeps a command unsettled when the platform refuses the kill later, and records nothing it did not see", async () => {
    const { child, as } = inert();
    const controller = new AbortController();
    const logged: string[] = [];
    let settled = false;
    const running = runVerificationCommand({
      command: "pnpm test",
      cwd: "/tmp",
      signal: controller.signal,
      spawnProcess: () => as,
      // The Windows shape, through the runner's own seam: the call returns,
      // and the refusal arrives afterwards.
      killTree: (_child, onProblem) => {
        void Promise.resolve().then(() => onProblem("EPERM"));
      },
      log: (line) => logged.push(line),
    }).then((run) => {
      settled = true;
      return run;
    });
    await turn();
    controller.abort();
    await turn();
    await turn();
    expect(settled, "a kill that failed is not an exit, whenever its failure arrives").toBe(false);
    expect(logged, "one bounded line says why this run is still pinned").toHaveLength(1);
    expect(logged[0]).toContain("EPERM");
    expect(logged[0], "and carries nothing the command read").not.toContain("pnpm test");

    child.close(null, "SIGKILL");
    const run = await running;
    expect(run.status, "and the record is still made if the tree does go").toBe("stopped");
  });
});

/**
 * Anything that escaped to the process while the body ran.
 *
 * A diagnostic in an abort listener or an asynchronous kill callback has
 * nobody above it to catch a throw: it leaves as a worker-wide unhandled
 * error, carrying whatever a project's own command printed, and the run it
 * was about is left with no record and nobody waiting on its promise.
 */
async function withNoGlobalErrors(what: string, body: () => Promise<void>): Promise<void> {
  const escaped: unknown[] = [];
  const onEscape = (error: unknown): void => {
    escaped.push(error);
  };
  process.on("unhandledRejection", onEscape);
  process.on("uncaughtException", onEscape);
  try {
    await body();
  } finally {
    process.off("unhandledRejection", onEscape);
    process.off("uncaughtException", onEscape);
  }
  expect(
    escaped.map((error) => (error instanceof Error ? error.message : String(error))),
    what,
  ).toEqual([]);
}

/**
 * A sink that takes what it is given and then breaks.
 *
 * Both halves matter: the message is asserted, *and* the failure is real. A
 * double that only threw could not prove the sentence was the right one, and
 * one that only recorded could not prove a broken observer decides nothing.
 */
function brokenSink(seen: string[], why: string): (line: string) => void {
  return (line: string) => {
    seen.push(line);
    throw new Error(why);
  };
}

describe("what a stuck command tells, and who it cannot take down with it", () => {
  it("reports a kill the platform refused on the spot, and is not derailed by sinks that throw", async () => {
    await withNoGlobalErrors("nothing escaped from an abort listener", async () => {
      const { child, as } = inert();
      const controller = new AbortController();
      const logged: string[] = [];
      const problems: string[] = [];
      let settled = false;
      const running = runVerificationCommand({
        command: "pnpm test",
        cwd: "/tmp",
        signal: controller.signal,
        spawnProcess: () => as,
        killTree: () => {
          const error: NodeJS.ErrnoException = new Error("kill EPERM");
          error.code = "EPERM";
          throw error;
        },
        log: brokenSink(logged, "this worker's log is broken"),
        onProblem: brokenSink(problems, "whoever was watching is broken"),
      }).then((run) => {
        settled = true;
        return run;
      });
      await turn();
      // Synchronous, in this test's own stack: the listener runs here, and a
      // throw from either sink would leave from here.
      expect(() => controller.abort()).not.toThrow();
      await turn();

      expect(problems, "the person watching is told, once").toHaveLength(1);
      expect(problems[0]).toBe(COMMAND_STILL_RUNNING_PROBLEM.cannotEnd("EPERM"));
      expect(problems[0], "in words about what is happening now").toContain("still running");
      expect(problems[0], "and nothing the command read, ran or ran in").not.toContain("pnpm test");
      expect(logged, "and the bounded line was still attempted").toHaveLength(1);
      expect(settled, "no record is made: nothing witnessed an exit").toBe(false);

      // The tree does go in the end, and the record is the close's.
      child.close(null, "SIGKILL");
      const run = await running;
      expect(run.status, "a broken observer changed nothing about the run").toBe("stopped");
      expect(run.detail).toContain("You stopped");
    });
  });

  it("reports a kill that failed after it returned — the Windows shape — through sinks that throw", async () => {
    await withNoGlobalErrors("nothing escaped from the kill's own callback", async () => {
      const { child, as } = inert();
      const controller = new AbortController();
      const logged: string[] = [];
      const problems: string[] = [];
      let settled = false;
      const running = runVerificationCommand({
        command: "pnpm test",
        cwd: "/tmp",
        signal: controller.signal,
        spawnProcess: () => as,
        // `taskkill` is another process: the call returns, and the refusal
        // arrives later, in a microtask with nobody above it.
        killTree: (_child, onProblem) => {
          void Promise.resolve().then(() => onProblem("EPERM"));
        },
        log: brokenSink(logged, "this worker's log is broken"),
        onProblem: brokenSink(problems, "whoever was watching is broken"),
      }).then((run) => {
        settled = true;
        return run;
      });
      await turn();
      controller.abort();
      await turn();
      await turn();

      expect(problems, "a refusal that arrives late is still told").toHaveLength(1);
      expect(problems[0]).toBe(COMMAND_STILL_RUNNING_PROBLEM.cannotEnd("EPERM"));
      expect(logged).toHaveLength(1);
      expect(settled, "and a kill that failed is not an exit, whenever its failure arrives").toBe(false);

      child.close(null, "SIGKILL");
      const run = await running;
      expect(run.status).toBe("stopped");
    });
  });

  it("says the output has not closed, and the timer that says it takes nothing down", async () => {
    vi.useFakeTimers();
    try {
      await withNoGlobalErrors("nothing escaped from the waiting timer", async () => {
        const { child, as } = inert();
        const logged: string[] = [];
        const problems: string[] = [];
        let settled = false;
        const running = runVerificationCommand({
          command: "pnpm test",
          cwd: "/tmp",
          stdioGraceMs: 500,
          spawnProcess: () => as,
          killTree: () => {},
          log: brokenSink(logged, "this worker's log is broken"),
          onProblem: brokenSink(problems, "whoever was watching is broken"),
        }).then((run) => {
          settled = true;
          return run;
        });
        await vi.advanceTimersByTimeAsync(0);
        child.say("before it exited\n");
        child.emit("exit", 0, null);
        await vi.advanceTimersByTimeAsync(5_000);

        expect(problems, "the wait is explained where a person is watching").toHaveLength(1);
        expect(problems[0]).toBe(COMMAND_STILL_RUNNING_PROBLEM.lingering);
        expect(problems[0], "and carries nothing the command printed").not.toContain("before it exited");
        expect(logged).toHaveLength(1);
        expect(settled, "no clock settles a run, and no broken sink settles one either").toBe(false);

        child.say("the line that says why\n");
        child.emit("close", 0, null);
        await vi.advanceTimersByTimeAsync(0);
        const run = await running;
        expect(run.status, "the close is what records it, with every byte").toBe("passed");
        expect(run.outputBytes).toBe(Buffer.byteLength("before it exited\nthe line that says why\n"));
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the id a run is recorded under", () => {
  /**
   * A worker that was restarted: a fresh module registry, so every module
   * counter in the process starts again exactly as it does after a crash, an
   * update or a person stopping this project's worker.
   */
  async function restartedWorker(): Promise<typeof import("../../src/project-work/verification/service.js")> {
    vi.resetModules();
    return import("../../src/project-work/verification/service.js");
  }

  it("cannot hand the host a durable key a run from a previous worker already spent", async () => {
    /**
     * The host's side of the contract, as it really is: `verify-<runId>` is a
     * project-wide idempotency key, and a key it has already seen answers
     * with the first result for ever — across worker restarts, because the
     * record is the project's and not this process's.
     */
    type Answer = Awaited<ReturnType<ScriptedHost["verifyReport"]>>;
    const receipts = new Map<string, Answer>();
    const hostOf = (commands: string[]): ScriptedHost => {
      const host = new ScriptedHost(commands);
      const write = host.verifyReport.bind(host);
      host.verifyReport = async (params, envelope) => {
        const key = String(params.idempotencyKey);
        const replay = receipts.get(key);
        // A key this project has already seen answers with the first result,
        // for ever. That is the durable behaviour a colliding run id turns
        // into a lost record.
        if (replay) return replay;
        const answer = await write(params, envelope);
        const stored: Answer = { ...answer, verify: { ...answer.verify, evidenceId: `evd_${String(receipts.size + 1)}` } };
        receipts.set(key, stored);
        return stored;
      };
      return host;
    };

    const cwd = repository();
    const keys: string[] = [];
    const evidence: Array<string | undefined> = [];
    const recorded: Array<string | undefined> = [];
    for (let restart = 0; restart < 2; restart += 1) {
      const module_ = await restartedWorker();
      const host = hostOf([]);
      const service = new module_.VerificationService({ bridgeFor: () => host, holdsSession: () => true });
      const state = await service.run({ cwd, key: "TASK-1", sessionPath: SESSION });
      keys.push(`verify-${state.runId}`);
      evidence.push(state.evidenceId);
      recorded.push(state.report?.runId);
      expect(state.phase, "each restarted worker's run reported").toBe("done");
      expect(state.report?.runId, "and got back the record of its own run").toBe(state.runId);
    }

    expect(keys[0], "a restarted worker cannot mint the key its predecessor already used").not.toBe(keys[1]);
    expect(receipts.size, "so the host wrote two receipts, not one replay of the first").toBe(2);
    expect(evidence[0], "and the second run's evidence is its own").not.toBe(evidence[1]);
    expect(recorded[0], "as is the record it points at").not.toBe(recorded[1]);
    for (const key of keys) {
      expect(key.length, "inside the host's key limit").toBeLessThanOrEqual(80);
      expect(key.slice("verify-".length).length, "and inside the protocol's run id limit").toBeLessThanOrEqual(64);
      expect(key).toMatch(/^[A-Za-z0-9_.:-]+$/);
    }
  });
});
