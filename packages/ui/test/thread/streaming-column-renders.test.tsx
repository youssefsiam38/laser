// @vitest-environment happy-dom
/**
 * M16-T32: a component beside the transcript reads what it draws, not the
 * session. The goal bar is the representative case of the class the browser
 * profile found (`woke by <component> {path,state,blocks,lastSeq,running,queue}`):
 * reading the whole `SessionView` re-rendered it for every streamed batch,
 * although a goal changes only when the goal engine says so.
 */
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStateStore, LaserStoreProvider } from "../../src/runtime/LaserProvider.js";
import { initialState } from "../../src/store.js";
import { view } from "../agents/fixtures.js";

vi.mock("@/runtime", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useLaserStable: () => ({ actions: { goal: vi.fn() } }),
}));

const { GoalBar } = await import("../../src/components/thread/GoalBar.js");
const { TooltipProvider } = await import("../../src/components/ui/tooltip.js");

const PATH = "/streaming.jsonl";
const goalState = (objective: string) => ({
  goalId: "g1", objective, status: "active" as const, iteration: 1, startedAt: "2026-09-13T10:00:00.000Z",
});

let root: Root, host: HTMLDivElement, renders: number;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  renders = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("does not re-render the goal bar for a streamed delta, and does for a goal change", async () => {
  const store = createStateStore({
    ...initialState,
    current: PATH,
    open: { [PATH]: { ...view({ path: PATH }), goal: goalState("Ship the profiler") } },
  });
  await act(async () => root.render(
    <LaserStoreProvider store={store}>
      <TooltipProvider>
        <Profiler id="goal-bar" onRender={() => { renders++; }}><GoalBar /></Profiler>
      </TooltipProvider>
    </LaserStoreProvider>,
  ));
  expect(host.textContent).toContain("Ship the profiler");
  renders = 0;

  for (let seq = 1; seq <= 10; seq++) {
    await act(async () => store.dispatch({ type: "notification", method: "session/update", params: {
      sessionPath: PATH, seq, at: "", update: { kind: "text_delta", delta: "token ", contentIndex: 0 },
    } }));
  }
  expect(renders).toBe(0);

  await act(async () => store.dispatch({ type: "notification", method: "pi/extension/message", params: {
    path: PATH, message: { type: "lasercode/goal/state", goal: goalState("Record the numbers") },
  } }));
  expect(renders).toBeGreaterThan(0);
  expect(host.textContent).toContain("Record the numbers");
});
