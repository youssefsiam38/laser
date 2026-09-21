import { describe, expect, it } from "vitest";
import { historyWindow, type SessionState, type SessionUpdateParams } from "@lasercode/protocol";
import { createStateStore } from "../../src/runtime/LaserProvider.js";
import { createHistoryWindows, MAIN_WINDOW_SCOPE } from "../../src/runtime/history-owners.js";
import type { AppState } from "../../src/store.js";

const state: SessionState = { path: "/session", id: "s", cwd: "/project", model: null, thinkingLevel: "off", isStreaming: false, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true, messageCount: 80, pendingMessageCount: 0 };
const other: SessionState = { ...state, path: "/other", id: "o" };
const entries = Array.from({ length: 80 }, (_, i) => ({ type: "message", id: `e${i}`, parentId: i ? `e${i - 1}` : null, message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `Message ${i}` }] } }));
const source = { entries, leafId: "e79" };
const scope = { sessionId: state.id, epoch: "one", seq: 4, revision: "r1.test.base", environmentKey: "e1.test" };
const update = (seq: number, delta: string): SessionUpdateParams => ({ sessionPath: state.path, epoch: scope.epoch, seq, at: "2026-01-01T00:00:00Z", update: { kind: "text_delta", delta, contentIndex: 0 } });

function fixture() {
  const store = createStateStore();
  const windows = createHistoryWindows(store);
  store.dispatch({ type: "opened", state });
  store.dispatch({ type: "opened", state: other });
  const load = (page: ReturnType<typeof historyWindow>, token = "canonical") => {
    store.dispatch({ type: "historyBegin", path: state.path, token });
    store.dispatch({ type: "historySnapshot", path: state.path, token, ...page, window: page.window! });
  };
  load(historyWindow(source, { all: true }, scope));
  const main = windows.owner(MAIN_WINDOW_SCOPE, state.path);
  const second = windows.owner("second", state.path);
  const view = (owner: { overlay(state: AppState): AppState }, path = state.path) => owner.overlay(store.getSnapshot()).open[path]!;
  return { store, windows, main, second, view, load };
}

describe("owner-local transcript windows", () => {
  it("keeps a peer's expanded history when the other surface takes the recent tail", () => {
    const f = fixture();
    expect(f.view(f.main).blocks).toHaveLength(80);
    expect(f.view(f.second).blocks).toHaveLength(80);
    const tail = historyWindow(source, { tail: 40 }, scope);
    f.second.dispatch({ type: "historyBegin", path: state.path, token: "second" });
    f.second.dispatch({ type: "historyReset", path: state.path, token: "second" });
    expect(f.view(f.second).blocks).toHaveLength(0);
    expect(f.view(f.second).hydrated).toBe(false);
    expect(f.view(f.main).blocks).toHaveLength(80);
    f.second.dispatch({ type: "historySnapshot", path: state.path, token: "second", ...tail, window: tail.window!, replaceWindow: true });
    expect(f.view(f.second).blocks).toHaveLength(40);
    expect(f.view(f.second).history).toEqual(tail.window);
    // Canonical structure and session state are shared; loaded history is not.
    expect(f.view(f.main).blocks).toHaveLength(80);
    expect(f.view(f.main).history?.complete).toBe(true);
    expect(f.view(f.second).state).toBe(f.view(f.main).state);
    expect(f.view(f.second).leafId).toBe(f.view(f.main).leafId);
    // The peer pages its own window back without disturbing the other.
    const page = historyWindow(source, { before: tail.window!.before! }, scope);
    f.second.dispatch({ type: "historyPrepend", path: state.path, before: tail.window!.before!, anchor: tail.window!.anchor!, baseRevision: tail.window!.revision, ownerRevision: f.view(f.second).historyRevision, entries: page.entries, window: page.window! });
    expect(f.view(f.second).entries).toHaveLength(80);
    expect(new Set(f.view(f.second).blocks.map(block => block.id)).size).toBe(80);
    expect(f.view(f.main).blocks).toHaveLength(80);
  });

  it("lets one surface recover a trimmed window without changing its peer", () => {
    const f = fixture();
    f.store.dispatch({ type: "views/trim", paths: [state.path], keepBytes: 1, at: "2026-09-18T00:00:00.000Z" });
    expect(f.view(f.main).trimmed).toBeDefined();
    expect(f.view(f.second).trimmed).toBeDefined();

    const tail = historyWindow(source, { tail: 40 }, scope);
    f.second.dispatch({ type: "historyBegin", path: state.path, token: "second-recovery" });
    f.second.dispatch({ type: "historySnapshot", path: state.path, token: "second-recovery", ...tail, window: tail.window!, replaceWindow: true });

    expect(f.view(f.second).trimmed).toBeUndefined();
    expect(f.view(f.second).history?.before).toBe(tail.window?.before);
    expect(f.view(f.main).trimmed).toBeDefined();
    expect(f.view(f.main).history?.before).toBeUndefined();
  });

  it("leaves a peer's expanded window alone when the canonical surface re-enters at the tail", () => {
    const f = fixture();
    const page = historyWindow(source, { all: true }, scope);
    f.second.dispatch({ type: "historyBegin", path: state.path, token: "second" });
    f.second.dispatch({ type: "historySnapshot", path: state.path, token: "second", ...page, window: page.window!, replaceWindow: true });
    const expanded = f.view(f.second);
    expect(expanded.blocks).toHaveLength(80);
    expect(expanded.historyRevision).toBe("second");
    // The canonical surface reloads its own recent tail, same epoch, same leaf.
    const tail = historyWindow(source, { tail: 40 }, scope);
    f.store.dispatch({ type: "historyBegin", path: state.path, token: "main-2" });
    f.store.dispatch({ type: "historyReset", path: state.path, token: "main-2" });
    f.store.dispatch({ type: "historySnapshot", path: state.path, token: "main-2", ...tail, window: tail.window!, replaceWindow: true });
    expect(f.view(f.main).blocks).toHaveLength(40);
    expect(f.view(f.main).historyRevision).toBe("main-2");
    // The peer is untouched: its window, its place, its revision.
    expect(f.view(f.second).blocks).toEqual(expanded.blocks);
    expect(f.view(f.second).entries).toEqual(expanded.entries);
    expect(f.view(f.second).history).toEqual(expanded.history);
    expect(f.view(f.second).historyRevision).toBe(expanded.historyRevision);
  });

  it("reconciles both surfaces onto a new generation or branch before either is ready", () => {
    const f = fixture();
    const tail = historyWindow(source, { tail: 40 }, scope);
    f.second.dispatch({ type: "historyBegin", path: state.path, token: "second" });
    f.second.dispatch({ type: "historyReset", path: state.path, token: "second" });
    f.second.dispatch({ type: "historySnapshot", path: state.path, token: "second", ...tail, window: tail.window!, replaceWindow: true });
    expect(f.view(f.second).blocks).toHaveLength(40);
    // A restarted worker: canonical adopts the new generation and re-reads.
    f.store.dispatch({ type: "historyBegin", path: state.path, token: "restart" });
    const replacement = historyWindow(source, { tail: 40 }, { ...scope, epoch: "two", seq: 1 });
    f.store.dispatch({ type: "historySnapshot", path: state.path, token: "restart", ...replacement, window: replacement.window! });
    // Neither surface is left on the old generation, and neither is stranded.
    expect(f.view(f.second).history?.epoch).toBe("two");
    expect(f.view(f.main).history?.epoch).toBe("two");
    expect(f.view(f.second).hydrated).toBe(f.view(f.main).hydrated);
    // A later update on the new generation reaches both, once.
    f.store.dispatch({ type: "notification", method: "session/update", params: { sessionPath: state.path, epoch: "two", seq: 2, at: "2026-01-01T00:00:00Z", update: { kind: "agent_start" } } });
    f.store.dispatch({ type: "notification", method: "session/update", params: { sessionPath: state.path, epoch: "two", seq: 3, at: "2026-01-01T00:00:00Z", update: { kind: "text_delta", delta: "after the restart", contentIndex: 0 } } });
    expect(f.view(f.second).blocks.at(-1)).toMatchObject({ text: "after the restart" });
    expect(f.view(f.main).blocks.at(-1)).toMatchObject({ text: "after the restart" });
    expect(f.view(f.second).blocks).toHaveLength(f.view(f.main).blocks.length);
  });

  it("delivers one live update to both surfaces exactly once, with the same identity", () => {
    const f = fixture();
    const tail = historyWindow(source, { tail: 40 }, scope);
    f.second.dispatch({ type: "historyBegin", path: state.path, token: "second" });
    f.second.dispatch({ type: "historyReset", path: state.path, token: "second" });
    f.second.dispatch({ type: "historySnapshot", path: state.path, token: "second", ...tail, window: tail.window!, replaceWindow: true });
    f.store.dispatch({ type: "notification", method: "session/update", params: { sessionPath: state.path, epoch: scope.epoch, seq: 5, at: "2026-01-01T00:00:00Z", update: { kind: "agent_start" } } });
    f.store.dispatch({ type: "notification", method: "session/update", params: update(6, "live") });
    const last = (owner: typeof f.main) => f.view(owner).blocks.at(-1)!;
    const started = { main: last(f.main).id, second: last(f.second).id };
    f.store.dispatch({ type: "notification", method: "session/update", params: update(7, " text") });
    expect(last(f.main)).toMatchObject({ kind: "assistant", text: "live text" });
    expect(last(f.second)).toMatchObject({ kind: "assistant", text: "live text" });
    // One growing message per surface: a partial never starts a second row.
    expect({ main: last(f.main).id, second: last(f.second).id }).toEqual(started);
    // Persisted messages are canonical and identical in both.
    expect(f.view(f.second).blocks.slice(0, -1).map(block => block.id))
      .toEqual(f.view(f.main).blocks.slice(40, -1).map(block => block.id));
    expect(f.view(f.second).blocks).toHaveLength(41);
    expect(f.view(f.main).blocks).toHaveLength(81);
    expect(f.view(f.second).running).toBe(f.view(f.main).running);
  });

  it("replays an event the canonical view already had into a window still loading", () => {
    const f = fixture();
    f.store.dispatch({ type: "notification", method: "session/update", params: update(5, "seen") });
    expect(f.view(f.main).lastSeq).toBe(5);
    f.second.dispatch({ type: "historyBegin", path: state.path, token: "second" });
    f.second.dispatch({ type: "historyReset", path: state.path, token: "second" });
    // Canonical ignores this: it is behind its watermark. The waiting window
    // still needs it, and must receive it exactly once.
    f.store.dispatch({ type: "notification", method: "session/update", params: update(5, "seen") });
    const older = historyWindow(source, { tail: 40 }, { ...scope, seq: 4 });
    f.second.dispatch({ type: "historySnapshot", path: state.path, token: "second", ...older, window: older.window!, replaceWindow: true });
    expect(f.view(f.second).lastSeq).toBe(5);
    expect(f.view(f.second).blocks.at(-1)).toMatchObject({ kind: "assistant", text: "seen" });
    expect(f.view(f.main).blocks.at(-1)).toMatchObject({ kind: "assistant", text: "seen" });
  });

  it("shares one question and one answer across both surfaces", () => {
    const f = fixture();
    f.second.dispatch({ type: "historyBegin", path: state.path, token: "second" });
    f.second.dispatch({ type: "historyReset", path: state.path, token: "second" });
    f.store.dispatch({ type: "notification", method: "pi/ui/request", params: { path: state.path, id: "q1", kind: "confirm", message: "Proceed?" } });
    expect(f.view(f.second).dialogs).toHaveLength(1);
    expect(f.view(f.second).dialogs).toBe(f.view(f.main).dialogs);
    f.store.dispatch({ type: "dialogAnswered", id: "q1", path: state.path });
    expect(f.view(f.second).dialogs).toHaveLength(0);
    expect(f.view(f.main).dialogs).toHaveLength(0);
  });

  it("keeps an unsent draft and an optimistic message through a recent-tail reset", () => {
    const f = fixture();
    f.store.dispatch({ type: "optimisticUser", path: state.path, id: "pending-1", text: "Not yet acknowledged", images: [] });
    f.store.dispatch({ type: "notification", method: "pi/ui/event", params: { path: state.path, method: "setEditorText", text: "unsent draft" } });
    f.second.dispatch({ type: "historyBegin", path: state.path, token: "second" });
    f.second.dispatch({ type: "historyReset", path: state.path, token: "second" });
    expect(f.view(f.second).blocks).toEqual([expect.objectContaining({ id: "pending-1", optimistic: true })]);
    expect(f.view(f.second).editorText).toBe("unsent draft");
    const tail = historyWindow(source, { tail: 40 }, scope);
    f.second.dispatch({ type: "historySnapshot", path: state.path, token: "second", ...tail, window: tail.window!, replaceWindow: true });
    expect(f.view(f.second).blocks.at(-1)).toMatchObject({ id: "pending-1", optimistic: true });
    expect(f.view(f.second).editorText).toBe("unsent draft");
  });

  it("hands one surface the same owner every time it asks", () => {
    const f = fixture();
    // The owner is a dependency of a scope's store, its history loader and its
    // thread-list adapter: a new object every render is a new adapter, and
    // assistant-ui cancels the work in flight under one.
    expect(f.windows.owner("second", state.path)).toBe(f.second);
    expect(f.windows.owner(MAIN_WINDOW_SCOPE, state.path)).toBe(f.main);
    expect(f.windows.owner("second", other.path)).not.toBe(f.second);
    // A surface that let go and came back is a new surface.
    f.windows.forget("second", state.path);
    expect(f.windows.owner("second", state.path)).not.toBe(f.second);
  });

  it("leaves another session alone and stops following a released window", () => {
    const f = fixture();
    const elsewhere = f.windows.owner("second", other.path);
    expect(f.view(elsewhere, other.path)).toBe(f.store.getSnapshot().open[other.path]);
    const tail = historyWindow(source, { tail: 40 }, scope);
    f.second.dispatch({ type: "historyBegin", path: state.path, token: "second" });
    f.second.dispatch({ type: "historyReset", path: state.path, token: "second" });
    f.second.dispatch({ type: "historySnapshot", path: state.path, token: "second", ...tail, window: tail.window!, replaceWindow: true });
    expect(f.view(f.second).blocks).toHaveLength(40);
    f.windows.forget("second", state.path);
    // Released: the surface is gone, the canonical session is untouched.
    expect(f.store.getSnapshot().open[state.path]!.blocks).toHaveLength(80);
    f.store.dispatch({ type: "closeView", path: state.path });
    expect(f.store.getSnapshot().open[state.path]).toBeUndefined();
    expect(f.store.getSnapshot().open[other.path]).toBeDefined();
  });

  it("drops a window when its session closes", () => {
    const f = fixture();
    const tail = historyWindow(source, { tail: 40 }, scope);
    f.second.dispatch({ type: "historyBegin", path: state.path, token: "second" });
    f.second.dispatch({ type: "historySnapshot", path: state.path, token: "second", ...tail, window: tail.window!, replaceWindow: true });
    f.store.dispatch({ type: "closeView", path: state.path });
    expect(f.second.overlay(f.store.getSnapshot()).open[state.path]).toBeUndefined();
  });

  it("notifies React once the canonical fold and every window fold have finished", () => {
    const f = fixture();
    const seen: Array<{ main: number; second: number }> = [];
    f.store.subscribe(() => seen.push({ main: f.view(f.main).blocks.length, second: f.view(f.second).blocks.length }));
    const tail = historyWindow(source, { tail: 40 }, scope);
    f.second.dispatch({ type: "historyBegin", path: state.path, token: "second" });
    f.second.dispatch({ type: "historyReset", path: state.path, token: "second" });
    f.second.dispatch({ type: "historySnapshot", path: state.path, token: "second", ...tail, window: tail.window!, replaceWindow: true });
    f.store.dispatch({ type: "notification", method: "session/update", params: update(5, "after") });
    expect(seen.at(-1)).toEqual({ main: 81, second: 41 });
    expect(seen.every(entry => entry.main >= 80)).toBe(true);
  });
});
