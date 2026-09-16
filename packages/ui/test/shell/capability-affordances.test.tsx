// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ logs: false }));
vi.mock("@/runtime", () => ({
  useCapability: () => runtime.logs ? { state: "available" } : { state: "hidden" },
  useLaserStable: () => ({ currentProject: undefined }),
  useLaserState: (selector: (state: unknown) => unknown) => selector({ current: undefined, open: {} }),
}));
vi.mock("../../src/components/settings/SettingsScreen.js", () => ({ SettingsScreen: () => <div>Settings surface</div> }));
vi.mock("../../src/components/logs/LogsScreen.js", () => ({ LogsScreen: () => <div>Logs surface</div> }));
vi.mock("../../src/components/agents/page/AgentsScreen.js", () => ({ AgentsScreen: () => <div>Agents surface</div> }));

import { Workbench } from "../../src/components/workbench/Workbench.js";
import { WorkbenchProvider, useWorkbench, type Workbench as WorkbenchContext } from "../../src/components/workbench/workbench-context.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

let root: Root;
let container: HTMLDivElement;
let workbench: WorkbenchContext;

function Probe() {
  workbench = useWorkbench();
  return <Workbench />;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("removes the Logs entry and refuses a stale deep link when logs are not granted", async () => {
  runtime.logs = false;
  await act(async () => root.render(<TooltipProvider><WorkbenchProvider><Probe /></WorkbenchProvider></TooltipProvider>));
  await act(async () => workbench.open("logs"));
  expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Logs")).toBe(false);
  expect(container.querySelector('section[aria-label="Settings"]')).not.toBeNull();
  expect(container.textContent).toContain("Settings surface");
  expect(container.textContent).not.toContain("Logs surface");
});

it("shows Logs when the descriptor grants the diagnostics and logs capability", async () => {
  runtime.logs = true;
  await act(async () => root.render(<TooltipProvider><WorkbenchProvider><Probe /></WorkbenchProvider></TooltipProvider>));
  await act(async () => workbench.open("logs"));
  expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Logs")).toBe(true);
  expect(container.querySelector('section[aria-label="Logs"]')).not.toBeNull();
  expect(container.textContent).toContain("Logs surface");
});
