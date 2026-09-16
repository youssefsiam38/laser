// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const stable = vi.hoisted(() => ({ actions: { goal: vi.fn() }, client: { request: vi.fn() } }));
vi.mock("@/runtime", async (original) => ({ ...(await original<typeof import("../../src/runtime/index.js")>()), useLaserStable: () => stable }));

import { GoalBar } from "../../src/components/thread/GoalBar.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { createStateStore, LaserStoreProvider } from "../../src/runtime/LaserProvider.js";
import { initialState } from "../../src/store.js";
import { view } from "../agents/fixtures.js";
import { testDescriptor } from "../runtime/environment-fixture.js";

let root: Root; let container: HTMLDivElement;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; stable.actions.goal.mockReset(); stable.client.request.mockReset(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("keeps the goal readable and hides all controls under local-only denial", async () => {
  const path = "/p/session.jsonl";
  const opened = { ...view({ path }), goal: { id: "g1", objective: "Ship the release", status: "active" as const, iteration: 2, automaticTurns: 2, startedAt: 1, updatedAt: 2 } };
  const store = createStateStore({ ...initialState, current: path, open: { [path]: opened }, environment: testDescriptor({ actor: { class: "local_browser", id: "browser" }, localOnly: ["session/goal/action"] }) });
  await act(async () => root.render(<LaserStoreProvider store={store}><TooltipProvider><GoalBar /></TooltipProvider></LaserStoreProvider>));
  expect(container.textContent).toContain("Ship the release");
  expect(container.textContent).toContain("2 automatic continuations");
  expect(container.querySelector('[aria-label="Pause goal"], [aria-label="Resume goal"], [aria-label="Edit goal"], [aria-label="Clear goal"]')).toBeNull();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(stable.actions.goal).not.toHaveBeenCalled(); expect(stable.client.request).not.toHaveBeenCalled();
});
