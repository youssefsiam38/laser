import { describe, expect, it, vi } from "vitest";
import { createSessionLauncher } from "../../src/runtime/new-session.js";
import { initialState, reduce, type AppState } from "../../src/store.js";
import { agentInfo, sessionState, snapshot, summary } from "./fixtures.js";

const CHAT_CWD = "/state/chat";

function fixture() {
  let state: AppState = reduce(initialState, { type: "agents/loaded", snapshot: snapshot({ defaultAgent: "default" }) });
  const add = (path: string, cwd = "/p", agentName?: string, sessionKind?: "chat") => {
    const agent = sessionKind === "chat"
      ? { agent: agentInfo({ kind: "chat" }) }
      : agentName === undefined ? {} : { agent: agentInfo({ agentName, kind: "root" }) };
    state = reduce(state, { type: "opened", state: sessionState({ path, cwd, ...agent }) });
    state = reduce(state, { type: "hydrate", path, entries: [] });
    state = { ...state, sessions: [...state.sessions, summary({ path, cwd, messageCount: 0, ...agent })] };
  };
  const open = vi.fn(async () => {});
  const select = vi.fn((path: string) => { state = { ...state, current: path }; });
  let count = 0;
  const create = vi.fn(async (cwd: string, options: { agentName?: string; sessionKind?: "chat" | "project" }) => {
    const path = `/new-${++count}`;
    add(path, cwd, options.agentName, options.sessionKind === "chat" ? "chat" : undefined);
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

  it("keeps a blank Chat away from project sessions and the reverse", async () => {
    const f = fixture();
    f.add("/chat-empty", CHAT_CWD, undefined, "chat");
    f.add("/project-empty", "/p");
    // Each request reuses only its own kind of empty conversation (D-347).
    await expect(f.launch(CHAT_CWD, { sessionKind: "chat" })).resolves.toBe("/chat-empty");
    await expect(f.launch("/p")).resolves.toBe("/project-empty");
    // An agent's empty session that happens to sit in the Chat workspace is a
    // project session: a New chat must not take it over, and it must not take
    // the blank Chat over either.
    f.add("/agent-in-chat", CHAT_CWD, "reviewer");
    await expect(f.launch(CHAT_CWD, { agentName: "reviewer" })).resolves.toBe("/agent-in-chat");
    await expect(f.launch(CHAT_CWD, { sessionKind: "chat" })).resolves.toBe("/chat-empty");
    expect(f.create).not.toHaveBeenCalled();
  });

  it("asks the host for a Chat by kind, never by an agent name", async () => {
    const f = fixture();
    await expect(f.launch(CHAT_CWD, { sessionKind: "chat" })).resolves.toBe("/new-1");
    // `docs/plain-chat.md`: there is no Chat agent to name any more, and the
    // protocol refuses `agentName` beside `sessionKind: "chat"`.
    expect(f.create).toHaveBeenLastCalledWith(CHAT_CWD, { sessionKind: "chat", select: false });
  });

  it("never reuses a child session, and coalesces per agent", async () => {
    const f = fixture();
    f.add("/child");
    f.state.sessions.at(-1)!.agent = agentInfo({ agentName: "default", kind: "child", parentPath: "/root" });
    const [a, b, c] = await Promise.all([f.launch("/p"), f.launch("/p"), f.launch("/p", { agentName: "reviewer" })]);
    expect(a).toBe(b);
    expect(a).not.toBe("/child");
    expect(c).not.toBe(a);
    expect(f.create).toHaveBeenCalledTimes(2);
  });
});
