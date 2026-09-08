// @vitest-environment happy-dom
/**
 * The spark in the rail: exactly one, drawn in the accent, `aria-expanded`
 * following the bubble, keyboard-operable.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("./fake-host.js")).FakeHostClient,
}));
// The rail also carries the Agents page's button (another lane); it is not under test here.
vi.mock("@/components/agents/page/AgentsButton", () => ({ AgentsButton: () => null }));

import { beamStore } from "../../src/components/beam/beam-store.js";
import { Rail } from "../../src/components/shell/Rail.js";
import { ShellContext, type ShellContextValue } from "../../src/components/shell/shell-context.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { WorkbenchProvider } from "../../src/components/workbench/workbench-context.js";
import { LaserProvider } from "../../src/runtime/LaserProvider.js";
import { createWorld, FakeHostClient, settle } from "./fake-host.js";

const shell: ShellContextValue = {
  layout: "desktop",
  sessionsOpen: true,
  telemetryOpen: false,
  setSessionsOpen: () => {},
  setTelemetryOpen: () => {},
  toggleSessions: () => {},
  toggleTelemetry: () => {},
  historyOpen: false,
  setHistoryOpen: () => {},
  openHistory: () => {},
  toolsOpen: false,
  setToolsOpen: () => {},
  addProjectOpen: false,
  setAddProjectOpen: () => {},
  newSession: async () => {},
  canCreate: true,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  FakeHostClient.reset(createWorld());
  beamStore.reset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("the spark in the rail", () => {
  it("is the one Beam control, last below Settings, and reflects the bubble", async () => {
    await act(async () =>
      root.render(
        <LaserProvider url="ws://test">
          <TooltipProvider>
            <WorkbenchProvider>
              <ShellContext.Provider value={shell}>
                <Rail />
              </ShellContext.Provider>
            </WorkbenchProvider>
          </TooltipProvider>
        </LaserProvider>,
      ),
    );
    await act(async () => settle(10));
    const sparks = container.querySelectorAll<HTMLButtonElement>('[data-slot="beam-spark"]');
    expect(sparks).toHaveLength(1);
    const spark = sparks[0]!;
    expect(spark.getAttribute("aria-label")).toBe("Beam");
    expect(spark.className).toContain("text-live");
    // Last in the bottom cluster: nothing follows it.
    expect(spark.nextElementSibling).toBeNull();
    expect(spark.previousElementSibling?.getAttribute("aria-label")).toBe("Settings");
    expect(spark.getAttribute("aria-expanded")).toBe("false");
    await act(async () => spark.click());
    expect(spark.getAttribute("aria-expanded")).toBe("true");
    expect(beamStore.getSnapshot().open).toBe(true);
    expect(beamStore.anchor()).toBe(spark);
    await act(async () => spark.click());
    expect(spark.getAttribute("aria-expanded")).toBe("false");
    expect(beamStore.getSnapshot().open).toBe(false);
  });
});
