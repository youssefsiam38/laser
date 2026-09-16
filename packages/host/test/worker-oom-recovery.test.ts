import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRun, WorkerInfo } from "@lasercode/protocol";
import { AgentRunRegistry } from "../src/agents/runs.js";
import { WorkerPool } from "../src/worker-pool.js";
import type { WorkerExit } from "../src/worker-client.js";

const OOM_WORKER = String.raw`
import { existsSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
const cwd = process.argv[process.argv.indexOf("--cwd") + 1];
const socket = new Socket({ fd: 3, readable: true, writable: true });
const send = (message) => socket.write(JSON.stringify(message) + "\n");
let buffer = "";
socket.setEncoding("utf8");
socket.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    if (request.method === "pi/worker/recover-agent-failures") {
      writeFileSync(process.env.RECOVERY_MARKER, "delivered");
      send({ jsonrpc: "2.0", id: request.id, result: { delivered: request.params.runs.map((run) => run.runId) } });
      continue;
    }
    send({ jsonrpc: "2.0", id: request.id, result: request.method === "session/load" ? { ok: true } : {} });
  }
});
socket.on("end", () => process.exit(0));
send({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "ready" } });
const marker = process.env.OOM_ONCE_MARKER;
if (marker && !existsSync(marker)) {
  writeFileSync(marker, "once");
  setTimeout(() => {
    const held = [];
    for (let i = 0; i < 32; i += 1) held.push(new Array(1024 * 1024).fill(i));
  }, 200);
}
`;

let scratch: string | undefined;
let pool: WorkerPool | undefined;

afterEach(async () => {
  await pool?.stopAll().catch(() => undefined);
  pool = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for worker recovery");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function liveRun(projectCwd: string, parentPath: string): AgentRun {
  return {
    agentName: "reviewer", subagentName: "review-auth", sessionId: "child-1", runId: "run-1",
    sessionPath: join(projectCwd, "child.jsonl"), projectCwd, rootSessionPath: parentPath, depth: 1,
    parent: { sessionPath: parentPath, sessionId: "parent-1" }, worktree: null, origin: "agent", status: "running",
    task: "review", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("a real worker old-space failure", () => {
  it("classifies OOM, attributes live runs to the harness, backs off once and reopens canonical paths", async () => {
    scratch = mkdtempSync(join(tmpdir(), "worker-oom-recovery-"));
    const project = join(scratch, "project");
    const workerMain = join(scratch, "oom-worker.mjs");
    const marker = join(scratch, "oom-once");
    const recoveryMarker = join(scratch, "recovered");
    const parentPath = join(scratch, "parent.jsonl");
    mkdirSync(project);
    writeFileSync(workerMain, OOM_WORKER);

    const registry = new AgentRunRegistry({ now: () => new Date("2026-01-01T00:01:00.000Z") });
    registry.upsert(liveRun(project, parentPath));
    const losses: WorkerExit[] = [];
    const statuses: WorkerInfo[] = [];
    const delays: number[] = [];
    const reopened: string[][] = [];
    let sawFatalMarker = false;
    let failedRuns: AgentRun[] = [];

    pool = new WorkerPool({
      workerMain,
      workerOldSpaceMiB: 64,
      env: { OOM_ONCE_MARKER: marker, RECOVERY_MARKER: recoveryMarker },
      sweepMs: 0,
      onNotification: () => undefined,
      onStderr: (_cwd, text) => { if (/Reached heap limit|heap out of memory|Allocation failed/i.test(text)) sawFatalMarker = true; },
      onWorkerLoss: ({ cwd, exit, message }) => {
        losses.push(exit);
        failedRuns = registry.workerLost(cwd, message);
      },
      onStatus: (status) => statuses.push(status),
      onReopened: async (client, _cwd, paths) => {
        reopened.push([...paths]);
        await client.request("pi/worker/recover-agent-failures", { runs: failedRuns });
      },
      setTimer: (fn, ms) => {
        delays.push(ms);
        const timer = setTimeout(fn, 0);
        return timer;
      },
    });

    const first = await pool.get(project);
    pool.bindSession(parentPath, project);
    await waitFor(() => reopened.length === 1);

    expect(losses).toHaveLength(1);
    expect(losses[0]).toMatchObject({ kind: "heap_oom" });
    if (process.platform === "linux") expect(losses[0]!.signal).toBe("SIGABRT");
    expect(sawFatalMarker).toBe(true);
    expect(delays).toEqual([1_000]);
    expect(reopened).toEqual([[parentPath]]);
    expect(existsSync(recoveryMarker)).toBe(true);
    expect((await pool.get(project)).generation).not.toBe(first.generation);
    expect(registry.get("run-1")).toMatchObject({
      status: "failed",
      error: "The project's agent ran out of memory before this run ended.",
      endedBy: { initiator: "harness" },
    });
    expect(statuses.filter((status) => status.status === "crashed")).toHaveLength(1);
    expect(statuses.find((status) => status.status === "crashed")?.message).toContain("ran out of memory");
    expect(JSON.stringify(statuses)).not.toMatch(/Fatal error|native stack trace|Reached heap limit/i);
    registry.close();
  }, 30_000);
});
