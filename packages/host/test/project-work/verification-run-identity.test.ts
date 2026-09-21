/**
 * M21-T19 · what a verification run's id means in the project's own record.
 *
 * A run reports under `verify-<runId>` as its idempotency key, and this store
 * answers a key it has already seen with the **first** result, for ever: that
 * is what makes a retried report safe. The other side of that promise is the
 * one this file pins. The key is project-wide and durable, so it outlives the
 * worker that minted it — and a worker that starts its run ids again from the
 * beginning (a crash, an update, a person stopping the project's worker) hands
 * back a key a previous run already spent. What comes back then is not this
 * run's record: it is the old one's, and what this run actually proved is
 * never written at all.
 *
 * Nothing here is a new host capability. It is the durable behaviour the
 * worker's run id has to be chosen against, proven through the real authority
 * so the worker's side (`packages/worker/test/project-work/verification.test.ts`,
 * "the id a run is recorded under") is standing on the real thing rather than
 * on a description of it.
 */
import { mkdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  VERIFICATION_REPORT_MEDIA_TYPE,
  type ProjectWorkBlobReadResult,
  type ProjectWorkBody,
  type ProjectWorkBridgeParams,
  type ProjectWorkBridgeResult,
  type ProjectWorkGetResult,
  type ProjectWorkWriteResult,
  type VerificationCommandRun,
  type VerificationReport,
} from "@lasercode/protocol";
import { projectWorkHarness, ok, type ProjectWorkHarness } from "./harness.js";

let h: ProjectWorkHarness;

afterEach(() => {
  h?.cleanup();
});

const ACTOR = { class: "local_app" as const, id: "worker:alpha" };
const AGENT = { label: "Verifier", sessionId: "ses_v", runId: "run_v" };

async function bridge(request: ProjectWorkBridgeParams["request"], extras: Partial<ProjectWorkBridgeParams> = {}): Promise<ProjectWorkBridgeResult> {
  return h.methods.handleBridge({ agent: AGENT, request, ...extras }, { actor: ACTOR, cwd: h.projectRoot });
}

function taskBody(): ProjectWorkBody {
  return {
    kind: "task",
    task: {
      outcome: "The export list shows why a failed export failed.",
      nonGoals: [],
      dependencies: [],
      scope: { packages: ["exports"], repositories: [], paths: ["src/exports/list.ts"], capabilities: [] },
      acceptance: [{ id: "a1", text: "A failed export row shows the reason.", machineVerifiable: true, command: "pnpm -F exports test" }],
      verificationCommands: ["pnpm -F exports test"],
      visualEvidenceRequired: false,
      assignment: { policy: "agent", agentName: "worker" },
    },
  };
}

/** One command's result, as a run reports it. */
function commandRun(passed: boolean): VerificationCommandRun {
  const text = passed ? "ok\n" : "1 failing\n";
  return {
    command: "pnpm -F exports test",
    status: passed ? "passed" : "failed",
    exitCode: passed ? 0 : 1,
    startedAt: "2026-03-01T09:00:00.000Z",
    endedAt: "2026-03-01T09:01:00.000Z",
    outputBytes: text.length,
    outputDigest: (passed ? "a" : "b").repeat(64),
    tail: text,
  };
}

/** A Task to verify, and the revision every report below is fenced on. */
async function task(): Promise<{ entityId: string; revisionId: string }> {
  h = projectWorkHarness();
  mkdirSync(h.projectRoot, { recursive: true });
  const created = ok<ProjectWorkWriteResult>(
    await h.call("project/work/create", { projectId: h.projectId, kind: "task", title: "Failed rows say why", body: taskBody(), idempotencyKey: "c-task" }),
  );
  return { entityId: created.entity.entityId, revisionId: created.revision.revisionId };
}

/** One run reporting what its commands did, under the key it minted. */
async function report(subject: { entityId: string; revisionId: string }, runId: string, passed: boolean): Promise<ProjectWorkBridgeResult> {
  return bridge(
    {
      method: "project/work/link",
      params: {
        projectId: h.projectId,
        expectedRevisionId: subject.revisionId,
        link: {
          type: "evidence",
          entityId: subject.entityId,
          revisionId: subject.revisionId,
          kind: "verification",
          role: "supporting",
          summary: "Verification",
          outcome: "inconclusive",
        },
        idempotencyKey: `verify-${runId}`,
      },
    },
    {
      verify: {
        action: "report",
        runId,
        startedAt: "2026-03-01T09:00:00.000Z",
        endedAt: "2026-03-01T09:02:00.000Z",
        commands: [commandRun(passed)],
      },
    },
  );
}

/** Every verification record this Task carries, as a person would read them. */
async function evidence(entityId: string): Promise<Array<{ evidenceId: string; blobId?: string }>> {
  const answer = await bridge({
    method: "project/work/get",
    params: { projectId: h.projectId, entityId, body: { mode: "none" }, include: { evidence: true } },
  });
  const detail = answer.result as ProjectWorkGetResult;
  return (detail.evidence ?? [])
    .filter((row) => row.kind === "verification")
    .map((row) => ({ evidenceId: row.evidenceId, ...(row.blobId !== undefined ? { blobId: row.blobId } : {}) }));
}

/** The canonical report a record points at — what the project actually kept. */
async function storedReport(blobId: string): Promise<VerificationReport> {
  const page = ok<ProjectWorkBlobReadResult>(await h.call("project/work/blob/read", { projectId: h.projectId, blobId }));
  expect(page.mediaType).toBe(VERIFICATION_REPORT_MEDIA_TYPE);
  return JSON.parse(Buffer.from(page.data!, "base64").toString("utf8")) as VerificationReport;
}

describe("a verification run's durable identity", () => {
  it("answers a run id a previous run already used with the first run's record, and writes nothing new", async () => {
    const subject = await task();

    // The first worker generation: its command passed, and the host wrote the
    // record of that.
    const first = await report(subject, "ver_0001", true);
    expect(first.verifyResult?.report?.converged, "the first run's report is the first run's").toBe(true);
    const firstEvidence = first.verifyResult?.evidenceId;
    expect(firstEvidence).toBeDefined();

    // A restarted worker, minting run ids from the beginning again. Its
    // command *failed*, and the key it carries was spent before this process
    // existed.
    const second = await report(subject, "ver_0001", false);
    expect(second.verifyResult?.evidenceId, "the store answers the spent key with the first receipt").toBe(firstEvidence);
    expect(second.verifyResult?.report?.converged, "the second run evaluated its own failing command").toBe(false);

    // And that evaluation went nowhere. The Task carries one record, it is the
    // first run's, and what the second run proved is not in the project at
    // all — while the run was handed a receipt saying it was stored.
    const rows = await evidence(subject.entityId);
    expect(rows, "one record, because the second run's write was answered by the first").toHaveLength(1);
    const kept = await storedReport(rows[0]!.blobId!);
    expect(kept.commands[0]?.status, "the passing run's commands are what the project kept").toBe("passed");
    expect(kept.converged, "and its verdict").toBe(true);
  });

  it("keeps each run's own record when the ids cannot collide", async () => {
    const subject = await task();
    const first = await report(subject, "ver_9b0a5e2c-6c1f-4d8e-9c2a-6a1d7f0b2e55", true);
    const second = await report(subject, "ver_2f7c1d90-8a45-4b6e-bf31-0c9d54ab7e12", false);

    expect(second.verifyResult?.evidenceId, "a fresh id is a fresh receipt").not.toBe(first.verifyResult?.evidenceId);
    expect(second.verifyResult?.report?.commands?.[0]?.status, "carrying what this run actually proved").toBe("failed");
    expect(second.verifyResult?.report?.converged, "and its own verdict").toBe(false);

    const rows = await evidence(subject.entityId);
    expect(rows, "both runs are in the Task's record").toHaveLength(2);
  });

  it("takes the id shape a worker mints, inside the key and run id limits", async () => {
    const subject = await task();
    const runId = "ver_9b0a5e2c-6c1f-4d8e-9c2a-6a1d7f0b2e55";
    expect(runId.length, "the protocol's run id ceiling").toBeLessThanOrEqual(64);
    expect(`verify-${runId}`.length, "the store's idempotency key ceiling").toBeLessThanOrEqual(80);
    expect(`verify-${runId}`, "and the alphabet a key is allowed to use").toMatch(/^[A-Za-z0-9_.:-]+$/);

    const answer = await report(subject, runId, true);
    expect(answer.verifyResult?.report?.runId, "the record names the run that made it").toBe(runId);
  });
});
