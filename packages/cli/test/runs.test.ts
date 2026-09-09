/**
 * `runs` speaks the app's run vocabulary, including the one live state
 * where nothing happens until someone acts (M13-T45): a run paused on a
 * question is `asking`, painted as needing someone, and its question is what
 * it is doing.
 */
import type { AgentRun, SessionSummary } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import { orderRuns, paintState, readFleet } from "../src/commands/runs.js";
import { Terminal } from "../src/output.js";
import type { HostRpc } from "../src/rpc.js";

const session: SessionSummary = { path: "/s/child.jsonl", id: "child", cwd: "/p", createdAt: "2026-09-08T10:00:00.000Z", modifiedAt: "2026-09-08T10:00:00.000Z", messageCount: 3 };

const run = (over: Partial<AgentRun>): AgentRun => ({
  agentName: "reviewer",
  subagentName: "reviewer-1",
  sessionId: "child",
  runId: "run_1",
  sessionPath: "/s/child.jsonl",
  projectCwd: "/p",
  rootSessionPath: "/s/root.jsonl",
  depth: 1,
  parent: { sessionPath: "/s/root.jsonl", sessionId: "root" },
  worktree: null,
  origin: "agent",
  status: "running",
  task: "Review it",
  startedAt: "2026-09-08T10:00:00.000Z",
  updatedAt: "2026-09-08T10:00:00.000Z",
  ...over,
});

function rpcWith(runs: AgentRun[]): HostRpc {
  return {
    request: (async (method: string) => {
      if (method === "agents/runs/list") return { runs };
      if (method === "tasks/list") return { tasks: [] };
      throw new Error(`unexpected ${method}`);
    }) as HostRpc["request"],
    close: () => {},
  } as unknown as HostRpc;
}

describe("runs", () => {
  it("lists a run paused on a question as live, asking, with the question as its activity", async () => {
    const asking = run({
      status: "needs_input",
      activity: { turns: 1, tools: 2, currentTool: "bash", lastAt: "2026-09-08T10:01:00.000Z" },
      question: { id: "ui-1", kind: "select", title: "Which token store?", options: ["cookie", "header"], askedAt: "2026-09-08T10:01:00.000Z" },
    });
    const working = run({ runId: "run_2", status: "running", activity: { turns: 1, tools: 1, currentTool: "bash", lastAt: "2026-09-08T10:01:00.000Z" } });
    const ended = run({ runId: "run_3", status: "blocked", endedAt: "2026-09-08T10:02:00.000Z", result: { status: "blocked", message: "Need the schema." } });
    const fleet = await readFleet(rpcWith([ended, working, asking]), [session]);
    const byId = Object.fromEntries(fleet.rows.map((row) => [row.id, row]));
    expect(byId["run_1"]).toMatchObject({ state: "needs_input", live: true, activity: "Asking: Which token store?", terminalReason: null });
    expect(byId["run_2"]).toMatchObject({ state: "running", live: true, activity: "Running bash" });
    expect(byId["run_3"]).toMatchObject({ state: "blocked", live: false });
    // Live first: a run waiting on someone is still going.
    expect(orderRuns(fleet.rows).map((row) => row.id).slice(0, 2).sort()).toEqual(["run_1", "run_2"]);
  });

  it("paints the state words: asking in the same warm colour as blocked, and plain in a pipe", () => {
    const plain = new Terminal({ json: false, color: "never" }).out;
    expect(paintState("needs_input", plain)).toBe("asking");
    expect(paintState("blocked", plain)).toBe("blocked");
    expect(paintState("running", plain)).toBe("running");
    const colour = new Terminal({ json: false, color: "always" }).out;
    expect(paintState("needs_input", colour)).toBe(colour.yellow("asking"));
    expect(paintState("blocked", colour)).toBe(colour.yellow("blocked"));
    expect(paintState("running", colour)).toBe(colour.cyan("running"));
  });
});
