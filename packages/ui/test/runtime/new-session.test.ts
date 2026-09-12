import { describe, expect, it, vi } from "vitest";
import type { SessionState, SessionSummary } from "@lasercode/protocol";
import { initialState, reduce, type AppState, type SessionView } from "../../src/store.js";
import { createSessionLauncher, isUnstartedSession } from "../../src/runtime/new-session.js";
import { snapshot } from "../agents/fixtures.js";

const session = (path: string, cwd = "/one"): SessionState => ({
  path, id: path, cwd, model: { provider: "stub", id: "stub-1" }, thinkingLevel: "medium",
  isStreaming: false, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time",
  autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0,
});
const summary = (path: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  path, id: path, cwd: "/one", messageCount: 0, createdAt: "2026-09-01T00:00:00Z",
  modifiedAt: "2026-09-01T00:00:00Z", ...extra,
});
function fixture() {
  let state: AppState = { ...initialState, open: {}, sessions: [] };
  const archived = new Set<string>();
  const add = (path: string, cwd = "/one") => {
    state = reduce(state, { type: "opened", state: session(path, cwd) });
    state = reduce(state, { type: "hydrate", path, entries: [] });
    state = { ...state, current: path };
    return state.open[path]!;
  };
  const refresh = vi.fn(async () => {});
  const open = vi.fn(async (path: string) => { add(path); });
  const select = vi.fn((path: string) => { state = { ...state, current: path }; });
  let count = 0;
  const create = vi.fn(async (cwd: string) => { const path = `/new-${++count}`; add(path, cwd); return path; });
  const launch = createSessionLauncher({ state: () => state, archived: (path) => archived.has(path), refresh, open, select, create });
  return { get state() { return state; }, add, archived, refresh, open, select, create, launch };
}

describe("New session", () => {
  it("returns to the current empty thread without replacing its draft, model or transcript", async () => {
    const f = fixture();
    const view = f.add("/empty");
    view.editorText = "Unsent composition";
    await expect(f.launch("/one")).resolves.toBe("/empty");
    expect(f.state.open["/empty"]).toBe(view);
    expect(view.editorText).toBe("Unsent composition");
    expect(view.state.model).toEqual({ provider: "stub", id: "stub-1" });
    expect(f.open).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });

  it("returns to an empty chat after navigating into another conversation", async () => {
    const f = fixture(); f.add("/empty");
    f.add("/started").state.messageCount = 2;
    await expect(f.launch("/one")).resolves.toBe("/empty");
    expect(f.state.current).toBe("/empty");
  });

  it("coalesces a burst of clicks and reuses the result on the next click", async () => {
    const f = fixture();
    const first = f.launch("/one");
    expect(f.launch("/one")).toBe(first);
    const paths = await Promise.all([first, f.launch("/one"), f.launch("/one")]);
    expect(new Set(paths).size).toBe(1);
    expect(f.create).toHaveBeenCalledTimes(1);
    await expect(f.launch("/one")).resolves.toBe(paths[0]);
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it("shares allocation between a quiet bubble open and a simultaneous sidebar +", async () => {
    const f = fixture();
    const quiet = f.launch("/one", { select: false });
    const selected = f.launch("/one");
    const [one, two] = await Promise.all([quiet, selected]);
    expect(one).toBe(two); expect(f.create).toHaveBeenCalledOnce();
    expect(f.create).toHaveBeenCalledWith("/one", { select: false });
    expect(f.select).toHaveBeenCalledWith(one);
  });

  it("keeps projects independent, even for concurrent requests", async () => {
    const f = fixture();
    const [one, two] = await Promise.all([f.launch("/one"), f.launch("/two")]);
    expect(one).not.toBe(two);
    expect(f.state.open[one]!.state.cwd).toBe("/one");
    expect(f.state.open[two]!.state.cwd).toBe("/two");
  });

  it("does not resurrect archived sessions or reuse branches", async () => {
    const f = fixture(); f.add("/archived"); f.archived.add("/archived");
    f.state.sessions = [summary("/branch", { parentPath: "/parent" })];
    await expect(f.launch("/one")).resolves.toBe("/new-1");
    expect(f.open).not.toHaveBeenCalled();
    expect(f.archived.has("/archived")).toBe(true);
  });

  it("prefers the current empty chat, then the newest, without deleting old duplicates", async () => {
    const f = fixture(); f.add("/newest"); f.add("/current");
    f.state.sessions = [summary("/newest", { modifiedAt: "2026-09-07T00:00:00Z" }), summary("/current")];
    await expect(f.launch("/one")).resolves.toBe("/current");
    f.add("/started").state.messageCount = 1;
    await expect(f.launch("/one")).resolves.toBe("/newest");
    expect(Object.keys(f.state.open)).toHaveLength(3);
  });

  it("reuses an empty Beam chat the catalog lists without attribution (M13-T47)", async () => {
    // Pi writes a session file on the first message, so an empty Beam chat is
    // an *unwritten* row: the catalog has no file to read an agent record from
    // and lists it with no `agent`. The open view knows better. Before the fix,
    // the launcher resolved the missing attribution to the default agent, never
    // matched Beam, and every press of Beam's + made another empty session.
    const beam = "/state/workspaces/beam";
    const f = fixture();
    let state: AppState = { ...initialState, open: {}, sessions: [] };
    const empty: SessionState = { ...session("/beam-1", beam), agent: { agentName: "beam", kind: "beam" } };
    state = reduce(state, { type: "opened", state: empty });
    state = reduce(state, { type: "hydrate", path: "/beam-1", entries: [] });
    state = reduce(state, { type: "sessions", sessions: [summary("/beam-1", { cwd: beam })] }); // no `agent`
    const create = vi.fn(async () => "/beam-2");
    const launch = createSessionLauncher({
      state: () => state,
      archived: () => false,
      refresh: async () => {},
      open: async () => {},
      select: (path) => { state = { ...state, current: path }; },
      create,
      resolveAgent: (name) => name ?? "default",
    });
    await expect(launch(beam, { agentName: "beam" })).resolves.toBe("/beam-1");
    await expect(launch(beam, { agentName: "beam" })).resolves.toBe("/beam-1");
    await expect(launch(beam, { agentName: "beam" })).resolves.toBe("/beam-1");
    expect(create).not.toHaveBeenCalled();
    // A project's + wants the default agent, which is what a missing attribution
    // resolves to — the old behaviour was correct there by accident, and stays.
    void f;
  });

  it.each(["beam", "chat"] as const)("reuses an attributed private %s workspace from its sidebar root", async (kind) => {
    const f = fixture(); f.state.agents.snapshot = snapshot();
    const view = f.add("/private-session", `/state/${kind}/private-session`);
    view.state.agent = { kind, agentName: kind };
    f.add("/other-project");
    await expect(f.launch(`/state/${kind}`, { agentName: kind, select: false })).resolves.toBe("/private-session");
    expect(f.state.current).toBe("/other-project");
    await expect(f.launch(`/state/${kind}`, { agentName: kind })).resolves.toBe("/private-session");
    expect(f.state.current).toBe("/private-session"); expect(f.create).not.toHaveBeenCalled();
    view.state.messageCount = 1;
    await expect(f.launch(`/state/${kind}`, { agentName: kind })).resolves.not.toBe("/private-session");
  });

  it("reuses an empty project chat the catalog stamps unread, with the default agent (M13-T47)", async () => {
    // The chat's own + is the same launcher. An empty session the host had
    // decorated `finished_unread` (a stale attention stamp on a row that was
    // never prompted) used to be skipped, so every press of + in the sessions
    // sidebar made another empty chat. The stamp is not a reason; a hydrated
    // empty transcript is.
    const f = fixture();
    let state: AppState = { ...initialState, open: {}, sessions: [] };
    state = reduce(state, { type: "opened", state: session("/chat-1") });
    state = reduce(state, { type: "hydrate", path: "/chat-1", entries: [] });
    state = reduce(state, { type: "sessions", sessions: [summary("/chat-1", { attention: "finished_unread" })] });
    const create = vi.fn(async () => "/chat-2");
    const launch = createSessionLauncher({
      state: () => state,
      archived: () => false,
      refresh: async () => {},
      open: async () => {},
      select: (path) => { state = { ...state, current: path }; },
      create,
      resolveAgent: (name) => name ?? "default",
    });
    await expect(launch("/one")).resolves.toBe("/chat-1");
    await expect(launch("/one")).resolves.toBe("/chat-1");
    await expect(launch("/one")).resolves.toBe("/chat-1");
    expect(create).not.toHaveBeenCalled();
    // A session that genuinely wants a person is still left alone.
    state = reduce(state, { type: "sessions", sessions: [summary("/chat-1", { attention: "waiting_for_input" })] });
    await expect(launch("/one")).resolves.toBe("/chat-2");
    void f;
  });

  it("hydrates a catalog candidate before trusting its message count", async () => {
    const f = fixture(); f.state.sessions = [summary("/unloaded")];
    f.open.mockImplementationOnce(async (path) => { f.add(path).state.messageCount = 1; });
    await expect(f.launch("/one")).resolves.toBe("/new-1");
    expect(f.open).toHaveBeenCalledWith("/unloaded", { select: false });
  });

  it("finds an empty session from a fresh catalog, including after reload", async () => {
    const f = fixture();
    f.refresh.mockImplementationOnce(async () => { f.state.sessions = [summary("/unloaded")]; });
    await expect(f.launch("/one")).resolves.toBe("/unloaded");
    expect(f.create).not.toHaveBeenCalled();
  });

  it("does not create blindly when the catalog or candidate load fails, and permits retry", async () => {
    const f = fixture(); f.refresh.mockRejectedValueOnce(new Error("Disconnected"));
    await expect(f.launch("/one")).rejects.toThrow("Disconnected");
    expect(f.create).not.toHaveBeenCalled();
    f.state.sessions = [summary("/unloaded")];
    f.open.mockRejectedValueOnce(new Error("Unavailable"));
    await expect(f.launch("/one")).rejects.toThrow("Unavailable");
    expect(f.create).not.toHaveBeenCalled();
    await expect(f.launch("/one")).resolves.toBe("/unloaded");
  });

  it("creates a new chat after an optimistic first send even with a stale zero count", async () => {
    const f = fixture();
    f.add("/started").blocks.push({ kind: "user", id: "pending", text: "hello", images: [], optimistic: true });
    f.state.sessions = [summary("/started")];
    await expect(f.launch("/one")).resolves.toBe("/new-1");
  });

  it.each([
    (v: SessionView) => { v.running = true; },
    (v: SessionView) => { v.state.isStreaming = true; },
    (v: SessionView) => { v.state.isCompacting = true; },
    (v: SessionView) => { v.state.pendingMessageCount = 1; },
    (v: SessionView) => { v.queue.followUp.push("next"); },
    (v: SessionView) => { v.queue.steering.push("next"); },
    (v: SessionView) => { v.dialogs.push({ method: "confirm", id: "ask", title: "Continue?" }); },
    (v: SessionView) => { v.goal = { id: "goal", objective: "Check work", status: "active", startedAt: 1, updatedAt: 1, iteration: 0, automaticTurns: 0 }; },
    (v: SessionView) => { v.hydrated = false; },
    (v: SessionView) => { v.entries.push({ type: "custom", customType: "goal-state", data: {} }); },
    (v: SessionView) => { v.entries.push({ type: "message", message: {} }); },
    (v: SessionView) => { v.blocks.push({ kind: "tool", id: "tool", name: "read", args: {}, done: true }); },
  ])("never calls work-in-progress or retained history empty (%#)", (mutate) => {
    const f = fixture(); const view = f.add("/work"); mutate(view);
    expect(isUnstartedSession(view)).toBe(false);
  });
});
