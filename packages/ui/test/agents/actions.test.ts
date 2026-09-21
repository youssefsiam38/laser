import { describe, expect, it, vi } from "vitest";
import { createAgentsActions } from "../../src/agents/index.js";
import { initialState, reduce, type Action, type AppState } from "../../src/store.js";
import { agent, run, snapshot } from "./fixtures.js";

function harness(answers: Record<string, unknown | ((params: unknown) => unknown)>) {
  let state: AppState = initialState;
  const dispatch = vi.fn((action: Action) => {
    state = reduce(state, action);
  });
  const toasts: string[] = [];
  const request = vi.fn(async (method: string, params: unknown) => {
    const answer = answers[method];
    if (answer === undefined) throw new Error(`unknown method ${method}`);
    return typeof answer === "function" ? (answer as (p: unknown) => unknown)(params) : answer;
  });
  const guard = async <T,>(work: () => Promise<T>): Promise<T | undefined> =>
    work().catch((error: unknown) => {
      toasts.push(error instanceof Error ? error.message : String(error));
      return undefined;
    });
  const actions = createAgentsActions({ client: { request } as never, dispatch, guard });
  return { actions, request, dispatch, toasts, get state() { return state; } };
}

describe("agents actions", () => {
  it("loads the snapshot and the run registry into the store, recording failure as the slice error", async () => {
    const h = harness({ "agents/list": snapshot({ revision: 7 }), "agents/runs/list": { runs: [run({ runId: "r1", sessionPath: "/p/a.jsonl" })] } });
    const pending = h.actions.refresh();
    expect(h.state.agents.loading).toBe(true);
    await pending;
    expect(h.state.agents).toMatchObject({ loading: false, error: null, snapshot: { revision: 7 } });
    await h.actions.runs();
    expect(h.request).toHaveBeenLastCalledWith("agents/runs/list", {});
    expect(Object.keys(h.state.agents.runs)).toEqual(["r1"]);
    await h.actions.runs("/p/a.jsonl");
    expect(h.request).toHaveBeenLastCalledWith("agents/runs/list", { path: "/p/a.jsonl" });

    const broken = harness({});
    await broken.actions.refresh();
    expect(broken.state.agents).toMatchObject({ loading: false, error: "unknown method agents/list" });
    await broken.actions.runs();
    expect(broken.state.agents.error).toBe("unknown method agents/runs/list");
    expect(broken.toasts).toEqual([]);
  });

  it("answers validate and save, folding the saved snapshot into the store, and rejects on failure", async () => {
    const saved = agent({ name: "reviewer" });
    const h = harness({
      "agents/validate": { issues: [{ field: "name", message: "Taken." }] },
      "agents/save": { agent: saved, snapshot: snapshot({ revision: 2, agents: [saved] }) },
    });
    await expect(h.actions.validate({ ...saved }, null)).resolves.toEqual([{ field: "name", message: "Taken." }]);
    await expect(h.actions.save({ ...saved }, null)).resolves.toEqual(saved);
    expect(h.request).toHaveBeenNthCalledWith(1, "agents/validate", { agent: saved, originalName: null });
    expect(h.request).toHaveBeenNthCalledWith(2, "agents/save", { agent: saved, originalName: null });
    expect(h.state.agents.snapshot?.revision).toBe(2);
    const broken = harness({});
    await expect(broken.actions.save({ ...saved }, null)).rejects.toThrow("unknown method agents/save");
    await expect(broken.actions.validate({ ...saved }, null)).rejects.toThrow();
    expect(broken.toasts).toEqual([]);
  });

  it("rejects delete refusals, while default and policy settle through the toast guard", async () => {
    const h = harness({
      "agents/delete": ({ name }: { name: string }) => ({ snapshot: snapshot({ revision: 3, agents: snapshot().agents.filter((a) => a.name !== name) }) }),
      "agents/set-default": ({ name }: { name: string }) => ({ snapshot: snapshot({ revision: 4, defaultAgent: name }) }),
      "agents/set-policy": ({ policy }: { policy: { maxDepth?: number } }) => ({ snapshot: snapshot({ revision: 5, policy: { maxDepth: policy.maxDepth ?? 3, foregroundCommandSeconds: 120 } }) }),
    });
    await h.actions.remove("reviewer", { scope: "project", projectCwd: "/p" });
    expect(h.request).toHaveBeenLastCalledWith("agents/delete", { name: "reviewer", location: { scope: "project", projectCwd: "/p" } });
    expect(h.state.agents.snapshot?.agents.some((a) => a.name === "reviewer")).toBe(false);
    await h.actions.setDefault("writer");
    expect(h.state.agents.snapshot?.defaultAgent).toBe("writer");
    await h.actions.setPolicy({ maxDepth: 2 });
    expect(h.state.agents.snapshot?.policy.maxDepth).toBe(2);
    const broken = harness({});
    await expect(broken.actions.remove("reviewer", { scope: "global" })).rejects.toThrow("unknown method agents/delete");
    await broken.actions.setDefault("writer");
    await broken.actions.setPolicy({ maxDepth: 1 });
    expect(broken.toasts).toEqual(["unknown method agents/set-default", "unknown method agents/set-policy"]);
    expect(broken.state.agents.snapshot).toBeNull();
  });

  it("returns skills and engine instructions, and stops runs into the store", async () => {
    const stopped = run({ runId: "r1", sessionPath: "/p/a.jsonl", status: "cancelled", endedBy: { initiator: "user", reason: "Not needed" } });
    const h = harness({
      "agents/skills": { skills: [], roots: [{ path: "/p/.skills", scope: "project", exists: false }] },
      "agents/engine-instructions": { text: "You are a coding agent." },
      "agents/runs/stop": ({ runId, reason }: { runId: string; reason?: string }) => ({ run: { ...stopped, runId, ...(reason !== undefined ? { endedBy: { initiator: "user", reason } } : {}) } }),
    });
    await expect(h.actions.skills("/p")).resolves.toMatchObject({ roots: [{ scope: "project" }] });
    await expect(h.actions.engineInstructions("/p")).resolves.toBe("You are a coding agent.");
    await expect(h.actions.stopRun("r1", "Not needed")).resolves.toMatchObject({ status: "cancelled" });
    expect(h.request).toHaveBeenCalledWith("agents/runs/stop", { runId: "r1", reason: "Not needed" });
    expect(h.state.agents.runs.r1?.status).toBe("cancelled");
    await h.actions.stopRun("r1");
    expect(h.request).toHaveBeenLastCalledWith("agents/runs/stop", { runId: "r1" });
    const broken = harness({});
    await expect(broken.actions.stopRun("r1")).rejects.toThrow();
    await expect(broken.actions.skills("/p")).rejects.toThrow();
  });
});
