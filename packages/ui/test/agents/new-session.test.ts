import { describe, expect, it, vi } from "vitest";
import { createSessionLauncher } from "../../src/runtime/new-session.js";
import { initialState, reduce, type AppState } from "../../src/store.js";
import { sessionState, snapshot, summary } from "./fixtures.js";

function fixture() {
  let state: AppState = reduce(initialState, { type: "agents/loaded", snapshot: snapshot({ defaultAgent: "default" }) });
  const add = (path: string, cwd = "/p", agentName?: string) => {
    const agent = agentName === undefined ? {} : { agent: { agentName, kind: agentName === "beam" ? ("beam" as const) : ("root" as const) } };
    state = reduce(state, { type: "opened", state: sessionState({ path, cwd, ...agent }) });
    state = reduce(state, { type: "hydrate", path, entries: [] });
    state = { ...state, sessions: [...state.sessions, summary({ path, cwd, messageCount: 0, ...agent })] };
  };
  const open = vi.fn(async () => {});
  const select = vi.fn((path: string) => { state = { ...state, current: path }; });
  let count = 0;
  const create = vi.fn(async (cwd: string, options: { agentName?: string }) => {
    const path = `/new-${++count}`;
    add(path, cwd, options.agentName);
    return path;
  });
  const launch = createSessionLauncher({
    state: () => state,
    archived: () => false,
    refresh: async () => {},
    open,
    select,
    create,
    resolveAgent: (name) => name ?? state.agents.snapshot?.defaultAgent,
  });
  return { get state() { return state; }, add, open, select, create, launch };
}

describe("New session with an agent", () => {
  it("reuses an empty session only for the same agent", async () => {
    const f = fixture();
    f.add("/empty-default");
    // No agent named: the default agent, which the unattributed empty session runs.
    await expect(f.launch("/p")).resolves.toBe("/empty-default");
    await expect(f.launch("/p", { agentName: "default" })).resolves.toBe("/empty-default");
    // A different agent must not take over that session.
    await expect(f.launch("/p", { agentName: "reviewer" })).resolves.toBe("/new-1");
    expect(f.create).toHaveBeenCalledWith("/p", { agentName: "reviewer", select: false });
    // And now the empty reviewer session is reused for reviewer, not for the default.
    await expect(f.launch("/p", { agentName: "reviewer" })).resolves.toBe("/new-1");
    await expect(f.launch("/p")).resolves.toBe("/empty-default");
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it("keeps a blank Beam chat away from project sessions and the reverse", async () => {
    const f = fixture();
    f.add("/beam-empty", "/state/beam", "beam");
    await expect(f.launch("/state/beam", { agentName: "beam" })).resolves.toBe("/beam-empty");
    await expect(f.launch("/state/beam")).resolves.toBe("/new-1");
    expect(f.create).toHaveBeenLastCalledWith("/state/beam", { select: false });
  });

  it("never reuses a child session, and coalesces per agent", async () => {
    const f = fixture();
    f.add("/child");
    f.state.sessions.at(-1)!.agent = { agentName: "default", kind: "child", parentPath: "/root" };
    const [a, b, c] = await Promise.all([f.launch("/p"), f.launch("/p"), f.launch("/p", { agentName: "reviewer" })]);
    expect(a).toBe(b);
    expect(a).not.toBe("/child");
    expect(c).not.toBe(a);
    expect(f.create).toHaveBeenCalledTimes(2);
  });
});
