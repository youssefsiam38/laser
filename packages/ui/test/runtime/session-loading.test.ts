import { describe, expect, it, vi } from "vitest";
import { initialState, reduce } from "../../src/store.js";
import { createThreadAdapter } from "../../src/runtime/adapter.js";
import { sessionState } from "../agents/fixtures.js";

const path = "/session.jsonl";
const adapter = (view = undefined as ReturnType<typeof reduce>["open"][string] | undefined, loading = false, loadState?: "opening" | "error") => createThreadAdapter({
  view, path, loading, loadState, client: { request: vi.fn() }, connection: "open", dispatch: vi.fn(), onError: vi.fn(),
});

describe("session opening transaction", () => {
  it("holds loading through entries, goal and pending; retry clears error without losing history", () => {
    let state = reduce(initialState, { type: "sessionLoad", path, phase: "opening" });
    expect(state.sessionLoads[path]).toBe("opening");
    expect(adapter(undefined, true).isLoading).toBe(true);
    state = reduce(state, { type: "opened", state: sessionState({ path }) });
    expect(state.open[path]).toMatchObject({ hydrated: false, loadState: "opening" });
    expect(adapter(state.open[path]).isLoading).toBe(true);
    state = reduce(state, { type: "hydrate", path, entries: [] });
    expect(state.open[path]?.hydrated).toBe(true);
    expect(adapter(state.open[path]).isLoading).toBe(true);
    state = reduce(state, { type: "sessionLoad", path, phase: "error" });
    expect(state.open[path]?.loadState).toBe("error");
    expect(adapter(state.open[path]).isLoading).toBe(false);
    expect(adapter(state.open[path]).isDisabled).toBe(true);
    state = reduce(state, { type: "sessionLoad", path, phase: "opening" });
    expect(adapter(state.open[path]).isLoading).toBe(true);
    const blocks = state.open[path]?.blocks;
    state = reduce(state, { type: "sessionLoad", path, phase: "ready" });
    expect(state.sessionLoads[path]).toBeUndefined();
    expect(state.open[path]?.blocks).toBe(blocks);
    expect(adapter(state.open[path]).isLoading).toBe(false);
    expect(adapter(state.open[path]).isDisabled).toBe(false);
  });
  it("covers failure before a view exists and a resync that needs entries again", () => {
    let state = reduce(initialState, { type: "sessionLoad", path, phase: "error" });
    expect(state.sessionLoads[path]).toBe("error");
    expect(adapter(undefined, false, "error").isLoading).toBe(false);
    expect(adapter(undefined, false, "error").isDisabled).toBe(true);
    state = reduce(state, { type: "sessionLoad", path, phase: "opening" });
    state = reduce(state, { type: "opened", state: sessionState({ path }) });
    state = reduce(state, { type: "hydrate", path, entries: [], seq: 10 });
    state = reduce(state, { type: "sessionLoad", path, phase: "ready" });
    state = reduce(state, { type: "resync", path, lastSeq: 0 });
    expect(state.open[path]?.hydrated).toBe(false);
    expect(adapter(state.open[path]).isLoading).toBe(true);
    state = reduce(state, { type: "closeView", path });
    expect(state.open[path]).toBeUndefined();
    expect(state.sessionLoads[path]).toBeUndefined();
  });
});
