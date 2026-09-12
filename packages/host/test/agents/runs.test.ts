/**
 * AgentRunRegistry: what the host remembers about runs after the worker that
 * ran them is gone, and how a child path finds its tree and its project.
 */
import { PRODUCT_NAME, type AgentRun } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunRegistry } from "../../src/agents/runs.js";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-runs-`))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const PROJECT = "/projects/a";
const ROOT = "/sessions/root.jsonl";

function run(runId: string, patch: Partial<AgentRun> = {}): AgentRun {
  return {
    agentName: "reviewer",
    subagentName: `review-${runId}`,
    sessionId: `session-${runId}`,
    runId,
    sessionPath: `/sessions/child-${runId}.jsonl`,
    projectCwd: PROJECT,
    rootSessionPath: ROOT,
    depth: 1,
    parent: { sessionPath: ROOT, sessionId: "root" },
    worktree: { path: `${PROJECT}/.worktrees/${runId}`, branch: `agent/${runId}`, baseCommit: "abc" },
    origin: "agent",
    status: "running",
    task: "Review it",
    startedAt: `2026-06-01T00:00:0${runId.length % 10}.000Z`,
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...patch,
  };
}

/** Fixtures date from June; a fixed clock keeps retention from pruning them. */
const NOW = () => new Date("2026-06-02T00:00:00.000Z");

describe("AgentRunRegistry", () => {
  it("indexes retained history without global scans and isolates every public mutation boundary", () => {
    const registry = new AgentRunRegistry({ now: NOW });
    try {
      for (let i = 0; i < 5000; i++) registry.upsert(run(`r${i}`, { status: "completed", projectCwd: `/p/${i % 20}`, rootSessionPath: `/root/${i % 20}` }));
      const input = run("live", { sessionPath: "/s/live", status: "needs_input" });
      const returned = registry.upsert(input);
      input.parent!.sessionPath = "caller mutation";
      returned.status = "failed";
      const global = (registry as unknown as { runs: Map<string, AgentRun> }).runs;
      const spy = vi.spyOn(global, "values");
      try {
        registry.upsert(run("live", { sessionPath: "/s/live", status: "needs_input" }));
        expect(registry.hasLiveRun(PROJECT)).toBe(true);
        expect(registry.latestFor("/s/live")?.status).toBe("needs_input");
        expect(registry.rootOf("/s/live")).toBe(ROOT);
        expect(registry.projectCwdOf("/s/live")).toBe(PROJECT);
        expect(registry.list("/s/live")).toHaveLength(1);
        expect(spy).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); }
      const latest = registry.latestFor("/s/live")!;
      latest.parent!.sessionPath = "another mutation";
      expect(registry.get("live")?.parent?.sessionPath).toBe(ROOT);
      registry.forgetSession("/s/live");
      expect(registry.hasLiveRun(PROJECT)).toBe(false);
      registry.upsert(run("next", { sessionPath: "/s/live", startedAt: "2026-06-01T00:00:09.000Z" }));
      expect(registry.latestFor("/s/live")?.runId).toBe("next");
      registry.workerLost(PROJECT);
      expect(registry.hasLiveRun(PROJECT)).toBe(false);
      expect(registry.latestFor("/s/live")?.status).toBe("failed");
    } finally { registry.close(); }
  });

  it("expires idle projects in bounded scheduled passes without expiring live work", async () => {
    vi.useFakeTimers();
    let now = NOW();
    const registry = new AgentRunRegistry({ now: () => now, retentionDays: 1 });
    try {
      registry.upsert(run("done", { status: "completed", updatedAt: now.toISOString() }));
      registry.upsert(run("question", { status: "needs_input" }));
      now = new Date("2026-06-05");
      await vi.advanceTimersByTimeAsync(60_010);
      expect(registry.get("done")).toBeUndefined();
      expect(registry.latestFor("/sessions/child-question.jsonl")?.status).toBe("needs_input");
      expect(registry.hasLiveRun(PROJECT)).toBe(true);
    } finally { registry.close(); vi.useRealTimers(); }
  });
  it("upserts, lists by tree root through a child path, and finds the project of a child", () => {
    const registry = new AgentRunRegistry({ now: NOW });
    registry.upsert(run("r1", { startedAt: "2026-06-01T00:00:01.000Z" }));
    registry.upsert(run("r2", { startedAt: "2026-06-01T00:00:02.000Z", parent: { sessionPath: "/sessions/child-r1.jsonl", sessionId: "session-r1" }, depth: 2 }));
    registry.upsert(run("other", { rootSessionPath: "/sessions/other.jsonl", projectCwd: "/projects/b", startedAt: "2026-06-01T00:00:03.000Z" }));

    expect(registry.list().map((r) => r.runId)).toEqual(["other", "r2", "r1"]);
    expect(registry.list(ROOT).map((r) => r.runId)).toEqual(["r2", "r1"]);
    expect(registry.list("/sessions/child-r2.jsonl").map((r) => r.runId)).toEqual(["r2", "r1"]);
    expect(registry.list("/sessions/unknown.jsonl")).toEqual([]);
    expect(registry.byChildPath("/sessions/child-r1.jsonl").map((r) => r.runId)).toEqual(["r1"]);
    expect(registry.projectCwdOf("/sessions/child-r2.jsonl")).toBe(PROJECT);
    expect(registry.projectCwdOf(ROOT)).toBe(PROJECT);
    expect(registry.projectCwdOf("/sessions/other.jsonl")).toBe("/projects/b");
    expect(registry.projectCwdOf("/nope.jsonl")).toBeUndefined();
    expect(registry.latestByChildPath().get("/sessions/child-r1.jsonl")?.runId).toBe("r1");
  });

  it("keeps the latest run of a child session, newest first", () => {
    const registry = new AgentRunRegistry({ now: NOW });
    const path = "/sessions/child-x.jsonl";
    registry.upsert(run("first", { sessionPath: path, status: "completed", startedAt: "2026-06-01T00:00:01.000Z" }));
    registry.upsert(run("second", { sessionPath: path, startedAt: "2026-06-01T00:00:05.000Z" }));
    expect(registry.latestFor(path)?.runId).toBe("second");
    expect(registry.latestByChildPath().get(path)?.runId).toBe("second");
  });

  it("stands a child on the run that can still act while a newer successor only waits behind it", () => {
    const registry = new AgentRunRegistry({ now: NOW });
    const path = "/sessions/child-y.jsonl";
    // A declared completion unwinding: the old invocation can still write, the
    // successor is queued behind it (M13-T98). The row must say the old run.
    registry.upsert(run("old", { sessionPath: path, status: "running", startedAt: "2026-06-01T00:00:01.000Z" }));
    registry.upsert(run("next", { sessionPath: path, status: "queued", startedAt: "2026-06-01T00:00:05.000Z" }));
    expect(registry.latestFor(path)?.runId).toBe("old");
    expect(registry.latestByChildPath().get(path)?.runId).toBe("old");
    // A live question keeps the same rank as working.
    registry.upsert(run("old", { sessionPath: path, status: "needs_input", startedAt: "2026-06-01T00:00:01.000Z" }));
    expect(registry.latestFor(path)?.runId).toBe("old");
    // Once the old run is terminal, the successor stands — queued or running.
    registry.upsert(run("old", { sessionPath: path, status: "completed", startedAt: "2026-06-01T00:00:01.000Z", endedAt: "2026-06-01T00:00:09.000Z" }));
    expect(registry.latestFor(path)?.runId).toBe("next");
    registry.upsert(run("next", { sessionPath: path, status: "running", startedAt: "2026-06-01T00:00:05.000Z" }));
    expect(registry.latestByChildPath().get(path)?.runId).toBe("next");
    // A newer active run still outranks an older failure (D-189).
    registry.upsert(run("next", { sessionPath: path, status: "failed", startedAt: "2026-06-01T00:00:05.000Z", endedAt: "2026-06-01T00:00:10.000Z" }));
    registry.upsert(run("resumed", { sessionPath: path, status: "running", startedAt: "2026-06-01T00:00:11.000Z" }));
    expect(registry.latestFor(path)?.runId).toBe("resumed");
  });

  it("fails every live run of a project whose worker is gone, and notifies each", () => {
    const notified: AgentRun[] = [];
    const registry = new AgentRunRegistry({ onRun: (r) => notified.push(r), now: () => new Date("2026-06-02T00:00:00.000Z") });
    registry.upsert(run("live"));
    registry.upsert(run("done", { status: "completed", result: { status: "completed", message: "ok" } }));
    registry.upsert(run("elsewhere", { projectCwd: "/projects/b" }));

    const changed = registry.workerLost(PROJECT);
    expect(changed.map((r) => r.runId)).toEqual(["live"]);
    expect(changed[0]).toMatchObject({
      status: "failed",
      error: "The project's worker stopped before this run ended.",
      endedAt: "2026-06-02T00:00:00.000Z",
      endedBy: { initiator: "harness" },
    });
    expect(notified.map((r) => r.runId)).toEqual(["live"]);
    expect(registry.get("done")?.status).toBe("completed");
    expect(registry.get("elsewhere")?.status).toBe("running");
    expect(registry.workerLost(PROJECT)).toEqual([]); // nothing left to fail
  });

  it("cancels the live runs of a deleted session", () => {
    const registry = new AgentRunRegistry({ now: NOW });
    registry.upsert(run("gone"));
    registry.upsert(run("kept", { sessionPath: "/sessions/child-kept.jsonl" }));
    expect(registry.forgetSession("/sessions/child-gone.jsonl").map((r) => r.status)).toEqual(["cancelled"]);
    expect(registry.get("kept")?.status).toBe("running");
  });

  it("stamps every run that owned a worktree a person removed, once, and tells the server", () => {
    const notified: AgentRun[] = [];
    const registry = new AgentRunRegistry({ now: NOW, onRun: (r) => notified.push(r) });
    const worktree = { path: "/p/.worktrees/explorer-1", branch: "agents/explorer-1", baseCommit: "x" };
    registry.upsert(run("owner", { status: "completed", worktree }));
    registry.upsert(run("other", { worktree: { ...worktree, path: "/p/.worktrees/other" } }));
    registry.upsert(run("none"));
    expect(registry.worktreeRemoved("/p/.worktrees/explorer-1").map((r) => r.runId)).toEqual(["owner"]);
    expect(registry.get("owner")?.worktree?.removedAt).toBe(NOW().toISOString());
    expect(registry.get("other")?.worktree?.removedAt).toBeUndefined();
    expect(notified.map((r) => r.runId)).toEqual(["owner"]);
    // Already stamped: nothing changes and nothing is announced again.
    expect(registry.worktreeRemoved("/p/.worktrees/explorer-1")).toEqual([]);
    expect(notified).toHaveLength(1);
  });

  it("persists, fails what was still running on reload, and prunes old and excess terminal runs", () => {
    const file = join(dir, "agent-runs.json");
    const first = new AgentRunRegistry({ storePath: file, retentionPerProject: 2, now: () => new Date("2026-06-10T00:00:00.000Z") });
    first.upsert(run("live"));
    first.upsert(run("old", { status: "completed", endedAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z" }));
    for (const id of ["t1", "t2", "t3"]) {
      first.upsert(run(id, { status: "completed", startedAt: `2026-06-0${id.slice(1)}T00:00:00.000Z`, endedAt: "2026-06-09T00:00:00.000Z", updatedAt: "2026-06-09T00:00:00.000Z" }));
    }
    first.close();
    const stored = JSON.parse(readFileSync(file, "utf8")) as { version: number; runs: AgentRun[] };
    expect(stored.version).toBe(1);
    expect(stored.runs.map((r) => r.runId).sort()).toEqual(["live", "t2", "t3"]); // `old` aged out, `t1` beyond the cap

    const second = new AgentRunRegistry({ storePath: file, now: () => new Date("2026-06-11T00:00:00.000Z") });
    expect(second.get("live")).toMatchObject({ status: "failed", error: "The project's worker stopped before this run ended." });
    expect(second.get("t3")?.status).toBe("completed");
  });

  it("does not let a stale report resurrect an ended run", () => {
    const registry = new AgentRunRegistry({ now: NOW });
    registry.upsert(run("r", { status: "completed", updatedAt: "2026-06-01T00:00:09.000Z" }));
    registry.upsert(run("r", { status: "running", updatedAt: "2026-06-01T00:00:01.000Z" }));
    expect(registry.get("r")?.status).toBe("completed");
  });
  it("calls a project busy while any of its runs is going, whatever its age", () => {
    const registry = new AgentRunRegistry({ now: NOW });
    registry.upsert(run("r1", { startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }));
    // A run started months ago and still going keeps its project alive (D-144).
    expect(registry.hasLiveRun(PROJECT)).toBe(true);
    expect(registry.hasLiveRun("/projects/b")).toBe(false);
    registry.upsert(run("r1", { status: "completed", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-06-01T12:00:00.000Z" }));
    expect(registry.hasLiveRun(PROJECT)).toBe(false);
  });

});
