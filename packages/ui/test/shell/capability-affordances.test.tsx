// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/runtime", async (original) => ({
  ...(await original<typeof import("../../src/runtime/index.js")>()),
  useLaserStable: () => ({ currentProject: undefined }),
}));
vi.mock("../../src/components/settings/SettingsScreen.js", () => ({ SettingsScreen: () => <div>Settings surface</div> }));
vi.mock("../../src/components/logs/LogsScreen.js", () => ({ LogsScreen: () => <div>Logs surface</div> }));
vi.mock("../../src/components/agents/page/AgentsScreen.js", () => ({ AgentsScreen: () => <div>Agents surface</div> }));

import { Workbench } from "../../src/components/workbench/Workbench.js";
import { WorkbenchProvider, useWorkbench, type Workbench as WorkbenchContext } from "../../src/components/workbench/workbench-context.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { createStateStore, LaserStoreProvider, type StateStore } from "../../src/runtime/LaserProvider.js";
import { initialState, type AppState } from "../../src/store.js";
import { testDescriptor } from "../runtime/environment-fixture.js";

let root: Root;
let container: HTMLDivElement;
let workbench: WorkbenchContext;
let state: AppState;
let store: StateStore;

function Probe() { workbench = useWorkbench(); return <Workbench />; }
function renderWorkbench() {
  root.render(<LaserStoreProvider store={store}><TooltipProvider><WorkbenchProvider><Probe /></WorkbenchProvider></TooltipProvider></LaserStoreProvider>);
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  state = { ...initialState, environment: testDescriptor() };
  store = createStateStore(state);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("removes shell destinations denied to a local browser and refuses a stale deep link", async () => {
  state = { ...state, environment: testDescriptor({ actor: { class: "local_browser", id: "browser" }, capabilities: { logs: false } }) };
  store = createStateStore(state);
  await act(async () => renderWorkbench());
  await act(async () => workbench.open("logs"));
  expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Logs")).toBe(false);
  expect(container.querySelector('section[aria-label="Settings"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Logs surface");
});

it("shows full local affordances and removes them immediately on a paired-device downgrade", async () => {
  await act(async () => renderWorkbench());
  await act(async () => workbench.open("logs"));
  expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Logs")).toBe(true);
  await act(async () => {
    store.dispatch({ type: "environment", environment: testDescriptor({ actor: { class: "paired_device", id: "phone" }, capabilities: { logs: false } }) });
  });
  expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Logs")).toBe(false);
  await act(async () => workbench.open("logs"));
  expect(container.textContent).toContain("Settings surface");
});
