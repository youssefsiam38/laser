// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ScopeDraftGuard, type ScopeDraft } from "../../src/components/settings/ScopeDraftGuard.js";
import { WorkbenchProvider, useWorkbench, type WorkbenchState } from "../../src/components/workbench/index.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { deviceStore } from "../../src/runtime/device-storage.js";
import { OTHER_ENVIRONMENT_KEY, testDescriptor } from "../runtime/environment-fixture.js";

let root: Root;
let container: HTMLDivElement;
let workbench: WorkbenchState | undefined;

function Probe() {
  workbench = useWorkbench();
  return null;
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

async function mount(drafts: ScopeDraft[]) {
  await act(async () => root.render(
    <TooltipProvider>
      <WorkbenchProvider>
        <Probe />
        <ScopeDraftGuard drafts={drafts} />
      </WorkbenchProvider>
    </TooltipProvider>,
  ));
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === label);
  expect(found, label).toBeDefined();
  return found!;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  deviceStore.deactivate();
  deviceStore.activate(testDescriptor());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  deviceStore.deactivate();
  workbench = undefined;
  vi.restoreAllMocks();
});

it("aggregates simultaneous drafts and Keep editing cancels the scope change", async () => {
  const discardA = vi.fn();
  const discardB = vi.fn();
  await mount([
    { id: "provider", label: "Provider sign-in", discard: discardA },
    { id: "search", label: "Search connection", discard: discardB },
  ]);

  act(() => { workbench!.open("settings", { tab: "models" }); });
  let result!: Promise<boolean>;
  await act(async () => {
    result = workbench!.open("settings", {
      tab: "general",
      scope: { view: "project", projectCwd: "/one" },
    });
    await Promise.resolve();
  });
  expect(document.body.textContent).toContain("2 drafts belong to the current Settings target");
  expect(document.body.textContent).toContain("Provider sign-in");
  await act(async () => button("Keep editing").click());
  expect(await result).toBe(false);
  expect(discardA).not.toHaveBeenCalled();
  expect(discardB).not.toHaveBeenCalled();
  expect(workbench?.settingsScope).toEqual({ view: "global" });
  expect(workbench?.page).toBe("settings");
  expect(workbench?.tab).toBe("models");
});

it("discards every nested draft before switching, while a failed Save keeps the target", async () => {
  const discardA = vi.fn();
  const discardB = vi.fn();
  const saveA = vi.fn(async () => true);
  const saveB = vi.fn(async () => false);
  const drafts: ScopeDraft[] = [
    { id: "fallback", label: "Fallback chain", save: saveA, discard: discardA },
    { id: "search", label: "Search connection", save: saveB, discard: discardB },
  ];
  await mount(drafts);

  let failed!: Promise<boolean>;
  await act(async () => {
    failed = workbench!.requestSettingsScope({ view: "project", projectCwd: "/one" });
    await Promise.resolve();
  });
  await act(async () => {
    button("Save and switch").click();
    await Promise.resolve();
  });
  expect(await failed).toBe(false);
  expect(saveA).toHaveBeenCalledOnce();
  expect(saveB).toHaveBeenCalledOnce();
  expect(workbench?.settingsScope).toEqual({ view: "global" });

  let discarded!: Promise<boolean>;
  await act(async () => {
    discarded = workbench!.requestSettingsScope({ view: "project", projectCwd: "/two" });
    await Promise.resolve();
  });
  await act(async () => {
    button("Discard and switch").click();
    await Promise.resolve();
  });
  expect(await discarded).toBe(true);
  expect(discardA).toHaveBeenCalledOnce();
  expect(discardB).toHaveBeenCalledOnce();
  expect(workbench?.settingsScope).toEqual({ view: "project", projectCwd: "/two" });
});

it("saves the draft snapshot captured by the original target", async () => {
  const saved: string[] = [];
  await mount([{
    id: "mcp",
    label: "MCP server for Global",
    save: async () => { saved.push("global"); return true; },
    discard: () => {},
  }]);
  let result!: Promise<boolean>;
  await act(async () => {
    result = workbench!.requestSettingsScope({ view: "project", projectCwd: "/one" });
    await Promise.resolve();
  });
  await mount([{
    id: "mcp",
    label: "MCP server for Project",
    save: async () => { saved.push("project"); return true; },
    discard: () => {},
  }]);
  await act(async () => button("Save and switch").click());
  expect(await result).toBe(true);
  expect(saved).toEqual(["global"]);
});

it("keeps drafts on same-environment reconnect and abandons them on environment replacement", async () => {
  const discard = vi.fn();
  await mount([{ id: "mcp", label: "MCP server", discard }]);

  await act(async () => { deviceStore.activate(testDescriptor()); });
  expect(discard).not.toHaveBeenCalled();

  await act(async () => { deviceStore.activate(testDescriptor({ environmentKey: OTHER_ENVIRONMENT_KEY })); });
  expect(discard).toHaveBeenCalledOnce();
});

it("lets the newer scope request win while the first confirmation is open", async () => {
  const discard = vi.fn();
  await mount([{ id: "provider", label: "Provider sign-in", discard }]);
  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  await act(async () => {
    first = workbench!.requestSettingsScope({ view: "project", projectCwd: "/one" });
    await Promise.resolve();
    second = workbench!.requestSettingsScope({ view: "project", projectCwd: "/two" });
    await Promise.resolve();
  });
  expect(await first).toBe(false);
  await act(async () => button("Discard and switch").click());
  expect(await second).toBe(true);
  expect(workbench?.settingsScope).toEqual({ view: "project", projectCwd: "/two" });
});
