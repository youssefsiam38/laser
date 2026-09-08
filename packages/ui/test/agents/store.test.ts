import { describe, expect, it } from "vitest";
import { AGENT_EVENTS_MAX, initialState, reduce, type AppState } from "../../src/store.js";
import { event, run, sessionState, snapshot } from "./fixtures.js";

const notify = (state: AppState, method: "agents/updated" | "agents/run" | "agents/event" | "agents/beam/choose-model", params: unknown): AppState =>
  reduce(state, { type: "notification", method, params: params as never });

describe("agents slice", () => {
  it("starts empty and loads the snapshot from agents/list", () => {
    expect(initialState.agents).toEqual({ snapshot: null, loading: false, error: null, runs: {}, events: [], chooseBeamModel: null });
    const loading = reduce(initialState, { type: "agents/loading" });
    expect(loading.agents.loading).toBe(true);
    const loaded = reduce(loading, { type: "agents/loaded", snapshot: snapshot({ revision: 4 }) });
    expect(loaded.agents).toMatchObject({ loading: false, error: null, snapshot: { revision: 4 } });
    // A failed list keeps whatever was held and says why.
    const failed = reduce(loaded, { type: "agents/error", error: "The host did not answer." });
    expect(failed.agents).toMatchObject({ loading: false, error: "The host did not answer.", snapshot: { revision: 4 } });
    // A later successful list clears the error; agents/list always wins, even with a lower revision (host restart).
    expect(reduce(failed, { type: "agents/loaded", snapshot: snapshot({ revision: 1 }) }).agents).toMatchObject({ error: null, snapshot: { revision: 1 } });
  });

  it("folds agents/updated by revision and never rewinds", () => {
    const held = reduce(initialState, { type: "agents/loaded", snapshot: snapshot({ revision: 5 }) });
    const stale = notify(held, "agents/updated", snapshot({ revision: 4 }));
    expect(stale).toBe(held);
    const fresh = notify(held, "agents/updated", snapshot({ revision: 6, defaultAgent: "reviewer" }));
    expect(fresh.agents.snapshot?.defaultAgent).toBe("reviewer");
    // Equal revisions replace: a snapshot with fresher warnings under the same number still lands.
    const same = notify(fresh, "agents/updated", snapshot({ revision: 6, warnings: [{ agentName: "reviewer", field: "skills", message: "Skill file moved.", since: "2026-09-08T10:00:00.000Z" }] }));
    expect(same.agents.snapshot?.warnings).toHaveLength(1);
  });

  it("keeps runs by id, ignores stale replays and keeps identity for identical re-sends", () => {
    const a = run({ runId: "r1", sessionPath: "/p/a.jsonl" });
    const one = notify(initialState, "agents/run", { run: a });
    expect(one.agents.runs).toEqual({ r1: a });
    // Byte-identical re-send: nothing changes, so nothing re-renders.
    expect(notify(one, "agents/run", { run: { ...a } })).toBe(one);
    const done = { ...a, status: "completed" as const, updatedAt: "2026-09-08T10:05:00.000Z", endedAt: "2026-09-08T10:05:00.000Z" };
    const two = notify(one, "agents/run", { run: done });
    expect(two.agents.runs.r1?.status).toBe("completed");
    // The replayed "running" record is older than what we hold: dropped.
    expect(notify(two, "agents/run", { run: a })).toBe(two);
    // A second run in another session lives beside the first.
    const b = run({ runId: "r2", sessionPath: "/p/b.jsonl" });
    expect(Object.keys(notify(two, "agents/run", { run: b }).agents.runs)).toEqual(["r1", "r2"]);
    // Views are untouched by every agents action.
    const opened = reduce(two, { type: "opened", state: sessionState({ path: "/p/a.jsonl" }) });
    const after = notify(opened, "agents/run", { run: b });
    expect(after.open["/p/a.jsonl"]).toBe(opened.open["/p/a.jsonl"]);
  });

  it("replaces the whole registry from a full list, but only one tree from a scoped list", () => {
    const rootA = "/p/root.jsonl";
    const rootB = "/q/root.jsonl";
    const a1 = run({ runId: "a1", sessionPath: "/p/a1.jsonl", rootSessionPath: rootA });
    const a2 = run({ runId: "a2", sessionPath: "/p/a2.jsonl", rootSessionPath: rootA });
    const b1 = run({ runId: "b1", sessionPath: "/q/b1.jsonl", rootSessionPath: rootB, parent: { sessionPath: rootB, sessionId: "rootB" } });
    let state = reduce(initialState, { type: "agents/runs/loaded", runs: [a1, a2, b1] });
    expect(Object.keys(state.agents.runs).sort()).toEqual(["a1", "a2", "b1"]);
    // Scoped to A's tree: a2 is gone from the host's answer, b1 is not covered and stays.
    state = reduce(state, { type: "agents/runs/loaded", runs: [a1], path: "/p/a1.jsonl" });
    expect(Object.keys(state.agents.runs).sort()).toEqual(["a1", "b1"]);
    // A scoped answer that is empty still names its tree through what we hold.
    state = reduce(state, { type: "agents/runs/loaded", runs: [], path: rootB });
    expect(Object.keys(state.agents.runs)).toEqual(["a1"]);
    // A live notification that already moved a run past the list is kept.
    const a1Done = { ...a1, status: "completed" as const, updatedAt: "2026-09-08T11:00:00.000Z" };
    state = notify(state, "agents/run", { run: a1Done });
    state = reduce(state, { type: "agents/runs/loaded", runs: [a1] });
    expect(state.agents.runs.a1?.status).toBe("completed");
    // A full list drops what the host no longer knows.
    state = reduce(state, { type: "agents/runs/loaded", runs: [] });
    expect(state.agents.runs).toEqual({});
    expect(state.agents.error).toBeNull();
  });

  it("appends events newest last, deduplicates by id and caps the list", () => {
    let state = notify(initialState, "agents/event", event({ id: "e1" }));
    state = notify(state, "agents/event", event({ id: "e2" }));
    expect(state.agents.events.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(notify(state, "agents/event", event({ id: "e1", summary: "changed" }))).toBe(state);
    for (let i = 3; i <= AGENT_EVENTS_MAX + 10; i++) state = notify(state, "agents/event", event({ id: `e${i}` }));
    expect(state.agents.events).toHaveLength(AGENT_EVENTS_MAX);
    expect(state.agents.events[0]?.id).toBe("e11");
    expect(state.agents.events.at(-1)?.id).toBe(`e${AGENT_EVENTS_MAX + 10}`);
  });

  it("holds the Beam model choice until the UI clears it", () => {
    const asked = notify(initialState, "agents/beam/choose-model", { suggested: { provider: "openai", id: "gpt-5.6-luna" } });
    expect(asked.agents.chooseBeamModel).toEqual({ suggested: { provider: "openai", id: "gpt-5.6-luna" } });
    const nothing = notify(asked, "agents/beam/choose-model", { suggested: null });
    expect(nothing.agents.chooseBeamModel).toEqual({ suggested: null });
    const cleared = reduce(nothing, { type: "agents/choose-beam-model/clear" });
    expect(cleared.agents.chooseBeamModel).toBeNull();
    expect(reduce(cleared, { type: "agents/choose-beam-model/clear" })).toBe(cleared);
  });

  it("keeps Namer labels per view and the view identity when a label is unchanged", () => {
    const path = "/p/a.jsonl";
    const opened = reduce(initialState, { type: "opened", state: sessionState({ path }) });
    expect(opened.open[path]?.namerLabels).toEqual({});
    const label = (state: AppState, toolCallId: string, text: string) =>
      reduce(state, { type: "notification", method: "pi/extension/message", params: { path, message: { type: "lasercode/namer/label", toolCallId, label: text } } });
    const one = label(opened, "t1", "Reading the config");
    expect(one.open[path]?.namerLabels).toEqual({ t1: "Reading the config" });
    expect(label(one, "t1", "Reading the config")).toBe(one);
    const two = label(one, "t2", "Running tests");
    expect(two.open[path]?.namerLabels).toEqual({ t1: "Reading the config", t2: "Running tests" });
    expect(two.open[path]).not.toBe(one.open[path]);
    // A label for a session we do not hold is dropped, not crashed on.
    expect(reduce(two, { type: "notification", method: "pi/extension/message", params: { path: "/p/other.jsonl", message: { type: "lasercode/namer/label", toolCallId: "t9", label: "x" } } })).toBe(two);
    // Forking carries the labels with the transcript.
    const forked = reduce(two, { type: "forked", from: path, state: sessionState({ path: "/p/fork.jsonl" }) });
    expect(forked.open["/p/fork.jsonl"]?.namerLabels).toEqual({ t1: "Reading the config", t2: "Running tests" });
  });
});
