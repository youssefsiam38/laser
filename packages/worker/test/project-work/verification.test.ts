/**
 * M21-T19 · the verification run, worker side.
 *
 * What is exercised here is the half only the worker can do: executing a
 * Task's declared commands in a real checkout, bounding and digesting their
 * output, recording their exit codes, and stopping when a person stops. The
 * verdict is never the worker's, so the bridge in these tests is scripted:
 * it answers the plan and takes the report, exactly as the host does.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import { runVerificationCommand } from "../../src/project-work/verification/commands.js";
import { VerificationService } from "../../src/project-work/verification/service.js";
import { verifyProjectTask } from "../../src/project-work/verification/tools.js";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

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
