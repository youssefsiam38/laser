import { describe, expect, it, vi } from "vitest";
import { initialState, reduce, type AppState } from "../../src/store.js";
import { createThreadAdapter } from "../../src/runtime/adapter.js";
import { sessionOpenPhase } from "../../src/runtime/main-destination.js";
import { sessionState } from "../agents/fixtures.js";

const path = "/session.jsonl";
const adapter = (state: AppState) => createThreadAdapter({
  view: state.open[path], path, openPhase: sessionOpenPhase(state, path), client: { request: vi.fn() }, connection: "open", dispatch: vi.fn(), onError: vi.fn(),
});
const entries = [{ id: "u", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "Visible history" }] } }];

describe("canonical session open phase", () => {
  it("uses transactions, not snapshot freshness, and preserves history through refresh/failure", () => {
    let state = reduce(initialState, { type: "sessionLoad", path, phase: "opening" });
    expect(sessionOpenPhase(state, path)).toMatchObject({ phase: "opening", hasTranscript: false });
    expect(adapter(state).isLoading).toBe(true);
    state = reduce(state, { type: "opened", state: sessionState({ path }) });
    state = reduce(state, { type: "hydrate", path, entries, seq: 10 });
    expect(adapter(state).isLoading).toBe(false);
    expect(adapter(state).messages).toHaveLength(1);
    expect(adapter(state).isDisabled).toBe(false);
    state = reduce(state, { type: "sessionLoad", path, phase: "ready" });
    state = reduce(state, { type: "resync", path, lastSeq: 0 });
    expect(state.open[path]?.hydrated).toBe(false);
    expect(sessionOpenPhase(state, path).phase).toBe("ready");
    expect(adapter(state).isLoading).toBe(false);
    state = reduce(state, { type: "sessionLoad", path, phase: "opening" });
    expect(adapter(state).isLoading).toBe(false);
    expect(adapter(state).isDisabled).toBe(false);
    state = reduce(state, { type: "sessionLoad", path, phase: "error", reason: "History is unavailable. Retry." });
    expect(sessionOpenPhase(state, path)).toMatchObject({ phase: "failed", hasTranscript: true, reason: "History is unavailable. Retry." });
    expect(adapter(state).messages).toHaveLength(1);
    expect(adapter(state).isDisabled).toBe(false);
  });

  it("retains a pre-view failure reason and clears it on Retry/close", () => {
    let state = reduce(initialState, { type: "sessionLoad", path, phase: "error", reason: "The host is offline." });
    expect(sessionOpenPhase(state, path)).toMatchObject({ phase: "failed", reason: "The host is offline." });
    expect(adapter(state).isLoading).toBe(false);
    expect(adapter(state).isDisabled).toBe(true);
    state = reduce(state, { type: "sessionLoad", path, phase: "opening" });
    expect(sessionOpenPhase(state, path).reason).toBeUndefined();
    state = reduce(state, { type: "closeView", path });
    expect(state.sessionLoads[path]).toBeUndefined();
  });

  it.each(["chat-tab", "startup-code", "startup-project", "project", "code-tab"] as const)("%s is preparation, not conversation loading", kind => {
    const state = { ...initialState, destination: { ...initialState.destination, phase: "resolving", target: { kind, project: "/p", code: { kind: "no-project-landing" } } } } as AppState;
    expect(sessionOpenPhase(state, undefined)).toMatchObject({ phase: "preparing", expectsTranscript: false, hasTranscript: false });
  });

  it("a known empty session does not promise history", () => {
    const state = reduce({ ...initialState, sessions: [{ path, messageCount: 0 }] } as AppState, { type: "sessionLoad", path, phase: "opening" });
    expect(sessionOpenPhase(state, path).expectsTranscript).toBe(false);
    expect(adapter(state).isLoading).toBe(false);
  });
});
