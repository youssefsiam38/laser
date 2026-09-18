// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkbenchProvider, useWorkbench, type WorkbenchState } from "../../../src/components/workbench/index.js";
import { deviceStore } from "../../../src/runtime/device-storage.js";
import { OTHER_ENVIRONMENT_KEY, testDescriptor } from "../../runtime/environment-fixture.js";

let container: HTMLDivElement;
let root: Root;
let latest: WorkbenchState | undefined;

function Probe() {
  latest = useWorkbench();
  return null;
}

function escapeFrom(element: Element): void {
  element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  deviceStore.deactivate();
  localStorage.clear();
  deviceStore.activate(testDescriptor());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  deviceStore.deactivate();
  latest = undefined;
});

describe("workbench.open", () => {
  it("keeps the settings form and adds the agents deep link beside it", async () => {
    await act(async () => root.render(<WorkbenchProvider><Probe /></WorkbenchProvider>));
    expect(latest?.page).toBeNull();
    await act(async () => latest!.open("settings", "models"));
    expect(latest?.page).toBe("settings");
    expect(latest?.tab).toBe("models");
    expect(latest?.agents).toBeUndefined();

    await act(async () => latest!.open("agents", { agent: "reviewer", field: "skills" }));
    expect(latest?.page).toBe("agents");
    expect(latest?.agents).toEqual({ agent: "reviewer", field: "skills" });
    expect(latest?.tab).toBeUndefined();

    // The same request twice is two objects, so a screen can re-run the scroll.
    const first = latest?.agents;
    await act(async () => latest!.open("agents", { agent: "reviewer", field: "skills" }));
    expect(latest?.agents).toEqual(first);
    expect(latest?.agents).not.toBe(first);

    await act(async () => latest!.open("agents"));
    expect(latest?.agents).toBeUndefined();
    await act(async () => latest!.open("logs"));
    expect(latest?.page).toBe("logs");
    await act(async () => latest!.close());
    expect(latest?.page).toBeNull();
  });
});

describe("Settings scope navigation", () => {
  it("lands name-only agent links in Global and gates the whole explicit deep link", async () => {
    await act(async () => root.render(<WorkbenchProvider><Probe /></WorkbenchProvider>));
    await act(async () => latest!.open("agents", { agent: "reviewer", field: "skills" }));
    await act(async () => { expect(await latest!.requestSettingsScope({ view: "project", projectCwd: "/one" })).toBe(true); });
    expect(latest?.settingsScope).toEqual({ view: "project", projectCwd: "/one" });

    const sourceAgents = latest?.agents;
    const unregister = latest!.registerSettingsScopeGuard(() => false);
    let accepted = true;
    await act(async () => {
      accepted = await latest!.open("settings", {
        tab: "features",
        scope: { view: "effective", projectCwd: "/two" },
      });
    });
    expect(accepted).toBe(false);
    expect(latest?.page).toBe("agents");
    expect(latest?.agents).toBe(sourceAgents);
    expect(latest?.tab).toBeUndefined();
    expect(latest?.settingsScope).toEqual({ view: "project", projectCwd: "/one" });
    unregister();

    await act(async () => { expect(await latest!.open("agents", { agent: "reviewer" })).toBe(true); });
    expect(latest?.settingsScope).toEqual({ view: "global" });

    await act(async () => latest!.open("settings", "models"));
    expect(latest?.page).toBe("settings");
    expect(latest?.tab).toBe("models");
    expect(latest?.settingsScope).toEqual({ view: "global" });
  });

  it("moves an exact Agents source and Settings scope as one guarded destination", async () => {
    await act(async () => root.render(<WorkbenchProvider><Probe /></WorkbenchProvider>));
    const exact = { agent: "reviewer", location: { scope: "project" as const, projectCwd: "/p" }, field: "skills" };
    await act(async () => { expect(await latest!.open("agents", exact)).toBe(true); });
    expect(latest?.page).toBe("agents");
    expect(latest?.agents).toEqual(exact);
    expect(latest?.settingsScope).toEqual({ view: "project", projectCwd: "/p" });

    const unregister = latest!.registerSettingsScopeGuard(() => false);
    const previous = latest?.agents;
    await act(async () => { expect(await latest!.open("agents", { agent: "default", location: { scope: "global" } })).toBe(false); });
    expect(latest?.agents).toBe(previous);
    expect(latest?.settingsScope).toEqual({ view: "project", projectCwd: "/p" });
    unregister();
  });

  it("fences a delayed guard decision when a newer same-scope link wins", async () => {
    await act(async () => root.render(<WorkbenchProvider><Probe /></WorkbenchProvider>));
    await act(async () => latest!.open("agents", { agent: "reviewer" }));
    const decisions: Array<(accepted: boolean) => void> = [];
    latest!.registerSettingsScopeGuard(() => new Promise<boolean>((resolve) => { decisions.push(resolve); }));

    const older = latest!.open("settings", {
      tab: "features",
      scope: { view: "project", projectCwd: "/older" },
    });
    const newer = latest!.open("settings", { tab: "models", scope: { view: "global" } });
    await act(async () => { decisions[1]?.(true); await newer; });
    await expect(newer).resolves.toBe(true);
    await act(async () => { decisions[0]?.(true); });
    await expect(older).resolves.toBe(false);
    expect(latest?.page).toBe("settings");
    expect(latest?.tab).toBe("models");
    expect(latest?.settingsScope).toEqual({ view: "global" });
  });

  it("keeps the mounted guard on a same-environment reconnect and clears it on deactivation", async () => {
    await act(async () => root.render(<WorkbenchProvider><Probe /></WorkbenchProvider>));
    let guarded = 0;
    latest!.registerSettingsScopeGuard(() => {
      guarded += 1;
      return false;
    });

    await act(async () => { deviceStore.activate(testDescriptor()); });
    await act(async () => {
      expect(await latest!.requestSettingsScope({ view: "project", projectCwd: "/guarded" })).toBe(false);
    });
    expect(guarded).toBe(1);

    await act(async () => { deviceStore.deactivate(); });
    await act(async () => { deviceStore.activate(testDescriptor()); });
    await act(async () => {
      expect(await latest!.requestSettingsScope({ view: "project", projectCwd: "/after-reconnect" })).toBe(true);
    });
    expect(guarded).toBe(1);
  });

  it("fences delayed guard decisions on environment changes", async () => {
    await act(async () => root.render(<WorkbenchProvider><Probe /></WorkbenchProvider>));
    await act(async () => latest!.open("agents", { agent: "reviewer" }));
    let settle: ((accepted: boolean) => void) | undefined;
    latest!.registerSettingsScopeGuard(() => new Promise<boolean>((resolve) => { settle = resolve; }));

    const pending = latest!.open("settings", {
      tab: "features",
      scope: { view: "project", projectCwd: "/old-environment" },
    });
    await act(async () => { deviceStore.activate(testDescriptor({ environmentKey: OTHER_ENVIRONMENT_KEY })); });
    await act(async () => { settle?.(true); });
    await expect(pending).resolves.toBe(false);
    expect(latest?.page).toBe("agents");
    expect(latest?.settingsScope).toEqual({ view: "global" });

    // The environment transition discarded the stale registration. A fresh
    // request in the new namespace is not held by the source draft.
    await act(async () => { expect(await latest!.requestSettingsScope({ view: "effective" })).toBe(true); });
    expect(latest?.settingsScope).toEqual({ view: "effective" });
  });

  it("does not commit an explicit link after a same-tick close or newer navigation", async () => {
    await act(async () => root.render(<WorkbenchProvider><Probe /></WorkbenchProvider>));
    await act(async () => latest!.open("agents", { agent: "reviewer" }));

    let closed: Promise<boolean> | undefined;
    await act(async () => {
      closed = latest!.open("settings", { tab: "features", scope: { view: "global" } });
      latest!.close();
    });
    await expect(closed).resolves.toBe(false);
    expect(latest?.page).toBeNull();

    await act(async () => latest!.open("agents", { agent: "reviewer" }));
    let superseded: Promise<boolean> | undefined;
    await act(async () => {
      superseded = latest!.open("settings", { tab: "features", scope: { view: "global" } });
      latest!.open("logs");
    });
    await expect(superseded).resolves.toBe(false);
    expect(latest?.page).toBe("logs");
  });

  it("rechecks the environment in the microtask between scope acceptance and opening", async () => {
    await act(async () => root.render(<WorkbenchProvider><Probe /></WorkbenchProvider>));
    await act(async () => latest!.open("agents", { agent: "reviewer" }));
    let accept: (() => void) | undefined;
    latest!.registerSettingsScopeGuard(() => new Promise<boolean>((resolve) => {
      accept = () => {
        resolve(true);
        queueMicrotask(() => deviceStore.activate(testDescriptor({ environmentKey: OTHER_ENVIRONMENT_KEY })));
      };
    }));

    const pending = latest!.open("settings", {
      tab: "features",
      scope: { view: "project", projectCwd: "/old-environment" },
    });
    await act(async () => { accept?.(); await pending; });
    await expect(pending).resolves.toBe(false);
    expect(latest?.page).toBe("agents");
    expect(latest?.settingsScope).toEqual({ view: "global" });
  });
});

describe("workbench Escape", () => {
  it("leaves the workbench open while Escape belongs to a text field, and closes it otherwise", async () => {
    await act(async () =>
      root.render(
        <WorkbenchProvider>
          <Probe />
          <input data-testid="text" />
          <textarea data-testid="area" />
          <div contentEditable data-testid="rich" />
          <div role="dialog" data-testid="dialog"><button type="button" data-testid="in-dialog" /></div>
          <button type="button" data-testid="plain" />
        </WorkbenchProvider>,
      ),
    );
    await act(async () => latest!.open("settings"));

    for (const id of ["text", "area", "rich", "in-dialog"]) {
      const target = container.querySelector(`[data-testid="${id}"]`)!;
      await act(async () => escapeFrom(target));
      expect(latest?.page, `Escape from ${id} must not close the workbench`).toBe("settings");
    }

    await act(async () => escapeFrom(container.querySelector('[data-testid="plain"]')!));
    expect(latest?.page).toBeNull();
  });
});
