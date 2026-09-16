import { describe, expect, it } from "vitest";
import type { AgentRun } from "@lasercode/protocol";
import {
  AGENT_FAILURE_RECOVERY_IDS_MAX,
  AgentFailureRecoveryQueue,
  type FailureRecoveryClient,
} from "../../src/agents/failure-recovery.js";

const CWD = "/projects/a";
const OPEN = "/sessions/open.jsonl";
const CLOSED = "/sessions/closed.jsonl";

function run(index: number, parent = OPEN): AgentRun {
  const id = `run-${String(index).padStart(5, "0")}`;
  return {
    agentName: "worker",
    subagentName: `child-${index}`,
    sessionId: `session-${index}`,
    runId: id,
    sessionPath: `/sessions/${id}.jsonl`,
    projectCwd: CWD,
    rootSessionPath: parent,
    depth: 1,
    parent: { sessionPath: parent, sessionId: "parent" },
    worktree: null,
    origin: "agent",
    status: "failed",
    task: "work",
    error: "worker lost",
    endedBy: { initiator: "harness", reason: "worker lost" },
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
  };
}

class Registry {
  readonly rows: AgentRun[] = [];
  readonly pages: Array<{ after: string | undefined; limit: number }> = [];

  add(rows: readonly AgentRun[]): void {
    this.rows.push(...rows);
  }

  get(id: string): AgentRun | undefined {
    return this.rows.find((row) => row.runId === id);
  }

  recoveryFailures(cwd: string, afterRunId: string | undefined, limit: number): AgentRun[] {
    this.pages.push({ after: afterRunId, limit });
    const rows = this.rows.filter((row) => row.projectCwd === cwd && row.status === "failed"
      && row.endedBy?.initiator === "harness" && row.parent !== null);
    const cursor = afterRunId === undefined ? -1 : rows.findIndex((row) => row.runId === afterRunId);
    return rows.slice(cursor + 1, cursor + 1 + limit);
  }
}

function client(
  answer: (ids: string[], call: number) => Promise<{ delivered: string[] }> = async (ids) => ({ delivered: ids }),
): FailureRecoveryClient & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    alive: true,
    calls,
    async request<T>(_method: string, params: unknown): Promise<T> {
      const ids = (params as { runs: AgentRun[] }).runs.map((row) => row.runId);
      calls.push(ids);
      return await answer(ids, calls.length) as T;
    },
  };
}

const flatten = (calls: readonly string[][]): string[] => calls.flatMap((ids) => ids);

describe("AgentFailureRecoveryQueue", () => {
  it("bounds retained ids and advances overflow across pages with no reopened parent", async () => {
    const registry = new Registry();
    const rows = Array.from({ length: 540 }, (_, index) => run(index, index < 532 ? CLOSED : OPEN));
    registry.add(rows);
    const logs: string[] = [];
    const recovery = new AgentFailureRecoveryQueue(registry as never, (line) => logs.push(line));
    recovery.note(CWD, rows);
    const successor = client();

    await recovery.deliver(successor, CWD, [OPEN]);

    expect(registry.pages[0]).toEqual({ after: rows[AGENT_FAILURE_RECOVERY_IDS_MAX - 1]!.runId, limit: 32 });
    expect(flatten(successor.calls)).toEqual(rows.filter((row) => row.parent!.sessionPath === OPEN).map((row) => row.runId));
    expect(successor.calls.every((ids) => ids.length <= 32)).toBe(true);
    expect(logs).toContain("agent failure recovery unavailable: no failed run had a reopened parent");
  });

  it("coalesces duplicate ids", async () => {
    const registry = new Registry();
    const one = run(1);
    registry.add([one]);
    const recovery = new AgentFailureRecoveryQueue(registry as never);
    recovery.note(CWD, [one, one]);
    recovery.note(CWD, [one]);
    const successor = client();

    await recovery.deliver(successor, CWD, [OPEN]);
    expect(flatten(successor.calls)).toEqual([one.runId]);
  });

  it("keeps a refused batch and retries it only after a successor reopens its parent", async () => {
    const registry = new Registry();
    const one = run(1);
    registry.add([one]);
    const recovery = new AgentFailureRecoveryQueue(registry as never);
    recovery.note(CWD, [one]);
    const refused = client(async () => { throw new Error("worker exited"); });
    await expect(recovery.deliver(refused, CWD, [OPEN])).rejects.toThrow("worker exited");

    const wrongSuccessor = client();
    await recovery.deliver(wrongSuccessor, CWD, [CLOSED]);
    expect(wrongSuccessor.calls).toEqual([]);

    const reopened = client();
    await recovery.deliver(reopened, CWD, [OPEN]);
    expect(flatten(reopened.calls)).toEqual([one.runId]);
  });

  it("clears one project on retirement and every project on close", async () => {
    const registry = new Registry();
    const first = run(1);
    const other = { ...run(2), projectCwd: "/projects/b" };
    registry.add([first, other]);
    const recovery = new AgentFailureRecoveryQueue(registry as never);
    recovery.note(CWD, [first]);
    recovery.note(other.projectCwd, [other]);
    recovery.forget(CWD);

    const successor = client();
    await recovery.deliver(successor, CWD, [OPEN]);
    expect(successor.calls).toEqual([]);
    recovery.clear();
    await recovery.deliver(successor, other.projectCwd, [OPEN]);
    expect(successor.calls).toEqual([]);
  });

  it("merges a second overflowing incident behind the same bounded cursor", async () => {
    const registry = new Registry();
    const first = Array.from({ length: 501 }, (_, index) => run(index));
    const second = Array.from({ length: 501 }, (_, index) => run(index + 1_000));
    registry.add(first);
    const logs: string[] = [];
    const recovery = new AgentFailureRecoveryQueue(registry as never, (line) => logs.push(line));
    recovery.note(CWD, first);
    registry.add(second);
    recovery.note(CWD, second);
    const successor = client();

    await recovery.deliver(successor, CWD, [OPEN]);
    expect(flatten(successor.calls)).toEqual([...first, ...second].map((row) => row.runId));
    expect(logs).toContain("agent failure recovery merged another incident into the pending overflow cursor");
  });

  it("re-filters a retained in-flight batch against each new successor", async () => {
    const registry = new Registry();
    const one = run(1, OPEN);
    registry.add([one]);
    const recovery = new AgentFailureRecoveryQueue(registry as never);
    recovery.note(CWD, [one]);
    await expect(recovery.deliver(client(async () => { throw new Error("response lost"); }), CWD, [OPEN]))
      .rejects.toThrow("response lost");

    const different = client();
    await recovery.deliver(different, CWD, [CLOSED]);
    expect(different.calls).toEqual([]);
    const matching = client();
    await recovery.deliver(matching, CWD, [OPEN]);
    expect(flatten(matching.calls)).toEqual([one.runId]);
  });

  it("drops a row missing from the registry instead of retrying forever", async () => {
    const registry = new Registry();
    const one = run(1);
    registry.add([one]);
    const recovery = new AgentFailureRecoveryQueue(registry as never);
    recovery.note(CWD, [one]);
    registry.rows.length = 0;
    const successor = client();

    await recovery.deliver(successor, CWD, [OPEN]);
    await recovery.deliver(successor, CWD, [OPEN]);
    expect(successor.calls).toEqual([]);
  });

  it("retains a batch when the successor does not acknowledge its exact ids", async () => {
    const registry = new Registry();
    const one = run(1);
    registry.add([one]);
    const recovery = new AgentFailureRecoveryQueue(registry as never);
    recovery.note(CWD, [one]);
    await expect(recovery.deliver(client(async () => ({ delivered: [] })), CWD, [OPEN]))
      .rejects.toThrow(/exact failure batch/);
    const successor = client();
    await recovery.deliver(successor, CWD, [OPEN]);
    expect(flatten(successor.calls)).toEqual([one.runId]);
  });
});
