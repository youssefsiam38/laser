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

const catalog = { sections: [], fields: [] };
const snapshot = (cwd: string, reason = cwd) => ({
  global: { path: "/global/settings.json", exists: true, writable: true, values: {} },
  project: { path: `${cwd}/${PROJECT_DIR_NAME}/settings.json`, exists: true, writable: true, values: {} },
  effective: {},
  projectTrust: { trusted: true, writable: true, reason },
});
const feature = (name: string) => ({
  manifest: {
    id: "goals",
    name,
    description: `${name} description`,
    defaultEnabled: true,
    scopes: ["global", "project"],
    dependencies: [],
    capabilities: ["planning"],
    restart: "worker",
  },
  globalEnabled: true,
  globalSource: "default",
  enabled: true,
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
  mocks.stable.setCurrentProject.mockReset();
  mocks.stable.actions.toast.mockReset();
  mocks.request.mockImplementation(async (method: string, params: { cwd?: string } = {}) => {
    if (method === "pi/setup/state") return { cwd: "/neutral-settings-route" };
    if (method === "pi/settings/list") return { catalog };
    if (method === "pi/settings/get") return { snapshot: snapshot(params.cwd ?? "missing") };
    if (method === "pi/models/catalog") return { models: [], enabledPatterns: null, refreshedAt: "", errors: [] };
    if (method === "pi/providers/list") return { providers: [] };
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

async function mount(initialTab: "general" | "features" = "general") {
  act(() => root.render(
    <LaserStoreProvider store={store}>
      <TooltipProvider>
        <WorkbenchProvider>
          <Probe />
          <SettingsScreen ambientCwd="/app-project" initialTab={initialTab} />
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
