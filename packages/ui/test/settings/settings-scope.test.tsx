// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PROJECT_DIR_NAME } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const request = vi.fn();
  const stable = {
    client: { request, subscribe: () => () => {} },
    actions: { toast: vi.fn(), restartWorker: vi.fn(), refreshProjects: vi.fn(), answerTrust: vi.fn() },
    projects: ["/app-project", "/settings-one", "/settings-two"],
    currentProject: "/app-project",
    setCurrentProject: vi.fn(),
    projectInfo: {
      "/app-project": { cwd: "/app-project", name: "App project", addedAt: "2026-01-01T00:00:00.000Z", trust: "trusted", pinned: true, sessionCount: 1 },
      "/settings-one": { cwd: "/settings-one", name: "Settings one", addedAt: "2026-01-01T00:00:00.000Z", trust: "trusted", pinned: true, sessionCount: 1 },
      "/settings-two": { cwd: "/settings-two", name: "Settings two", addedAt: "2026-01-01T00:00:00.000Z", trust: "trusted", pinned: true, sessionCount: 1 },
    },
  };
  return { request, stable };
});

vi.mock("@/runtime", async (original) => ({
  ...(await original<typeof import("../../src/runtime/index.js")>()),
  useLaserStable: () => mocks.stable,
}));

import { SettingsScreen } from "../../src/components/settings/SettingsScreen.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { WorkbenchProvider, useWorkbench, type WorkbenchState } from "../../src/components/workbench/index.js";
import { deviceStore } from "../../src/runtime/device-storage.js";
import { createStateStore, LaserStoreProvider, type StateStore } from "../../src/runtime/LaserProvider.js";
import { initialState } from "../../src/store.js";
import { testDescriptor } from "../runtime/environment-fixture.js";
import { settingsScopeStore } from "../../src/runtime/settings-scope.js";

const catalog = { sections: [], fields: [] };
const snapshot = (cwd: string, reason = cwd) => ({
  global: { path: "/global/settings.json", exists: true, writable: true, values: {} },
  project: { path: `${cwd}/${PROJECT_DIR_NAME}/settings.json`, exists: true, writable: true, values: {} },
  effective: {},
  projectTrust: { trusted: true, writable: true, reason },
});
const feature = (name: string, id = "goals", globalEnabled = true) => ({
  manifest: {
    id,
    name,
    description: `${name} description`,
    defaultEnabled: true,
    scopes: ["global", "project"],
    dependencies: [],
    capabilities: ["planning"],
    restart: "worker",
  },
  globalEnabled,
  globalSource: "default",
  enabled: globalEnabled,
  source: "default",
  health: "ready",
});

let root: Root;
let container: HTMLDivElement;
let store: StateStore;
let workbench: WorkbenchState | undefined;

function Probe() {
  workbench = useWorkbench();
  return null;
}

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  deviceStore.deactivate();
  localStorage.clear();
  deviceStore.activate(testDescriptor());
  mocks.request.mockReset();
  mocks.stable.projects.splice(0, mocks.stable.projects.length, "/app-project", "/settings-one", "/settings-two");
  mocks.stable.setCurrentProject.mockReset();
  mocks.stable.actions.toast.mockReset();
  mocks.request.mockImplementation(async (method: string, params: { cwd?: string } = {}) => {
    if (method === "pi/setup/state") return { cwd: "/neutral-settings-route" };
    if (method === "pi/settings/list") return { catalog };
    if (method === "pi/settings/get") return { snapshot: snapshot(params.cwd ?? "missing") };
    if (method === "pi/models/catalog") return { models: [], enabledPatterns: null, refreshedAt: "", errors: [] };
    if (method === "pi/providers/list") return { providers: [] };
    if (method === "pi/keybindings/get") return {
      keybindings: {
        path: "/agent/keybindings.json",
        engineVersion: "1.0.0",
        bindings: [{ id: "app.interrupt", description: "Interrupt", defaultKeys: ["ctrl+c"], keys: ["ctrl+c"], overridden: false, section: "app" }],
        conflicts: [],
        writable: true,
      },
    };
    if (method === "feature/list") return { features: [feature(params.cwd ?? "Global feature")] };
    return {};
  });
  store = createStateStore({ ...initialState, environment: testDescriptor() });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  deviceStore.deactivate();
  workbench = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(initialTab: "general" | "features" | "keyboard" = "general") {
  act(() => root.render(
    <LaserStoreProvider store={store}>
      <TooltipProvider>
        <WorkbenchProvider>
          <Probe />
          <SettingsScreen initialTab={initialTab} />
        </WorkbenchProvider>
      </TooltipProvider>
    </LaserStoreProvider>,
  ));
  await flush();
}

function calls(method: string) {
  return mocks.request.mock.calls.filter(([called]) => called === method).map(([, params]) => params);
}

describe("shared explicit Settings scope", () => {
  it("defaults Global, uses the neutral route, and keeps Project unselected", async () => {
    await mount();
    expect(workbench?.settingsScope).toEqual({ view: "global" });
    expect(calls("pi/settings/get")).toContainEqual({ cwd: "/neutral-settings-route" });
    expect(calls("pi/settings/get")).not.toContainEqual({ cwd: "/app-project" });

    await act(async () => { expect(await workbench!.requestSettingsScope({ view: "project" })).toBe(true); });
    await flush();
    expect(container.textContent).toContain("Choose a project for Project settings");
    expect(container.textContent).toContain("never borrow the project open in Code");
    expect(mocks.stable.setCurrentProject).not.toHaveBeenCalled();

    await act(async () => { expect(await workbench!.requestSettingsScope({ view: "project", projectCwd: "/removed" })).toBe(true); });
    await flush();
    expect(container.textContent).toContain("This project is unavailable");
    expect(calls("pi/settings/get")).not.toContainEqual({ cwd: "/removed" });
  });

  it("keeps keyboard focus on the requested scope while its guard is pending", async () => {
    await mount();
    let settle: ((accepted: boolean) => void) | undefined;
    workbench!.registerSettingsScopeGuard(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    const global = container.querySelector<HTMLButtonElement>('[role="radio"][data-scope-view="global"]')!;
    const project = container.querySelector<HTMLButtonElement>('[role="radio"][data-scope-view="project"]')!;
    await act(async () => {
      global.focus();
      global.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(project);
    expect(project.disabled).toBe(false);
    expect(project.closest('[role="radiogroup"]')?.getAttribute("aria-busy")).toBe("true");
    await act(async () => { settle?.(false); await Promise.resolve(); });
  });

  it("shows the connection state instead of letting an inactive scope control snap back", async () => {
    await mount();
    await act(async () => { deviceStore.deactivate(); });
    expect(container.textContent).toContain("Settings scope is unavailable while this environment reconnects.");
    const radios = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios).toHaveLength(3);
    expect(radios.every((radio) => radio.disabled)).toBe(true);
  });

  it("keeps a delayed old settings response from replacing the newer target", async () => {
    let resolveOld: ((value: { snapshot: ReturnType<typeof snapshot> }) => void) | undefined;
    mocks.request.mockImplementation(async (method: string, params: { cwd?: string } = {}) => {
      if (method === "pi/setup/state") return { cwd: "/neutral-settings-route" };
      if (method === "pi/settings/list") return { catalog };
      if (method === "pi/settings/get" && params.cwd === "/settings-one") {
        return await new Promise((resolve) => { resolveOld = resolve; });
      }
      if (method === "pi/settings/get") return { snapshot: snapshot(params.cwd ?? "missing", params.cwd === "/settings-two" ? "SECOND TARGET" : "GLOBAL") };
      if (method === "pi/models/catalog") return { models: [], enabledPatterns: null, refreshedAt: "", errors: [] };
      if (method === "pi/providers/list") return { providers: [] };
      return {};
    });
    await mount();
    await act(async () => { await workbench!.requestSettingsScope({ view: "project", projectCwd: "/settings-one" }); });
    await act(async () => { await workbench!.requestSettingsScope({ view: "project", projectCwd: "/settings-two" }); });
    await flush();
    expect(container.textContent).toContain("SECOND TARGET");

    await act(async () => { resolveOld?.({ snapshot: snapshot("/settings-one", "FIRST TARGET") }); });
    await flush();
    expect(container.textContent).toContain("SECOND TARGET");
    expect(container.textContent).not.toContain("FIRST TARGET");
  });

  it("shows a route failure and retries the real setup request", async () => {
    let setupAttempts = 0;
    mocks.request.mockImplementation(async (method: string, params: { cwd?: string } = {}) => {
      if (method === "pi/setup/state") {
        setupAttempts += 1;
        if (setupAttempts === 1) throw new Error("Settings service unavailable");
        return { cwd: "/neutral-settings-route" };
      }
      if (method === "pi/settings/list") return { catalog };
      if (method === "pi/settings/get") return { snapshot: snapshot(params.cwd ?? "missing") };
      if (method === "pi/models/catalog") return { models: [], enabledPatterns: null, refreshedAt: "", errors: [] };
      if (method === "pi/providers/list") return { providers: [] };
      return {};
    });

    await mount();
    expect(container.textContent).toContain("Could not prepare Global settings");
    expect(container.textContent).toContain("Settings service unavailable");
    const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Retry"));
    expect(retry).toBeDefined();
    await act(async () => { retry!.click(); });
    await flush();
    expect(setupAttempts).toBe(2);
    expect(calls("pi/settings/get")).toContainEqual({ cwd: "/neutral-settings-route" });
  });

  it("loads global keybindings through the neutral route with no project selected", async () => {
    mocks.stable.projects.splice(0);
    await mount("keyboard");
    expect(calls("pi/keybindings/get")).toEqual([{ cwd: "/neutral-settings-route" }]);
    expect(container.textContent).toContain("Agent keybindings are global and stay in force for every project.");
    expect(container.textContent).toContain("Interrupt");
    expect(container.textContent).not.toContain("need a project open");
  });

  it("keeps global keybindings editable under a remembered Effective scope", async () => {
    expect(settingsScopeStore.set({ view: "effective", projectCwd: "/settings-two" })).toBe(true);
    await mount("keyboard");
    expect(calls("pi/keybindings/get")).toEqual([{ cwd: "/neutral-settings-route" }]);
    const change = container.querySelector<HTMLButtonElement>('button[aria-label="Change the key for Interrupt"]');
    expect(change?.disabled).toBe(false);
    expect(container.textContent).not.toContain("Effective settings are a read-only preview");
  });

  it("routes a Global Feature write through the neutral service route", async () => {
    await mount("features");
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Disable Global feature"]');
    expect(toggle).not.toBeNull();
    await act(async () => { toggle!.click(); await Promise.resolve(); });
    expect(calls("feature/set")).toContainEqual({
      id: "goals",
      enabled: false,
      scope: "global",
      cwd: "/neutral-settings-route",
    });
    expect(mocks.stable.setCurrentProject).not.toHaveBeenCalled();
  });

  it("turns Global Web Search off without a neutral route", async () => {
    mocks.request.mockImplementation(async (method: string, params: { cwd?: string } = {}) => {
      if (method === "pi/setup/state") throw new Error("No Settings service route");
      if (method === "feature/list") return { features: [feature("Web Search", "web-search", true)] };
      if (method === "feature/set") return { restartPending: false };
      return {};
    });
    await mount("features");
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Disable Web Search"]');
    expect(toggle?.disabled).toBe(false);
    await act(async () => { toggle!.click(); await Promise.resolve(); });
    expect(calls("feature/set")).toContainEqual({
      id: "web-search",
      enabled: false,
      scope: "global",
    });
  });

  it("loads Features through the same scope and makes Effective read-only", async () => {
    await mount("features");
    expect(calls("feature/list")).toContainEqual({});
    await act(async () => { await workbench!.requestSettingsScope({ view: "effective", projectCwd: "/settings-two" }); });
    await flush();
    expect(calls("feature/list")).toContainEqual({ cwd: "/settings-two" });
    expect(container.textContent).toContain("Resolved feature choices are read-only here");
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Disable /settings-two"]');
    expect(toggle?.disabled).toBe(true);
  });
});
