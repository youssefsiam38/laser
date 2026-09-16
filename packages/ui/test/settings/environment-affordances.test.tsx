// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const request = vi.fn(async (method: string, params: { cwd?: string } = {}) => {
    calls.push(method);
    if (method === "pi/settings/list") return { catalog: { sections: [], fields: [] } };
    if (method === "pi/settings/get") return { snapshot: { global: { values: {} }, project: { values: {} }, effective: {}, projectTrust: { writable: true } } };
    if (method === "pi/models/catalog") return { models: [] };
    if (method === "pi/providers/list") return { providers: [] };
    if (method === "pi/transcribe/status") return { available: false };
    if (method === "mcp/list") return { servers: [] };
    if (method === "mcp/import/detect") return { sources: [] };
    if (method === "pi/project/env/status") return { status: { cwd: params.cwd, state: "not-configured", approved: false } };
    if (method === "resource/snapshot") return { snapshot: { capturedAt: new Date().toISOString(), pressure: "normal", totals: {}, projects: [] } };
    if (method === "resource/history") return { samples: [] };
    return {};
  });
  return { calls, request };
});

vi.mock("@/runtime", async (original) => ({
  ...(await original<typeof import("../../src/runtime/index.js")>()),
  useLaserStable: () => ({
    client: { request: mocks.request, subscribe: () => () => {} },
    actions: { toast: vi.fn(), refreshProjects: vi.fn(), answerTrust: vi.fn() },
    projects: ["/repo"], currentProject: "/repo", setCurrentProject: vi.fn(),
    projectInfo: { "/repo": { cwd: "/repo", name: "Repo", addedAt: "2026-01-01T00:00:00.000Z", trust: "trusted", pinned: true, sessionCount: 1 } },
  }),
}));
vi.mock("../../src/components/settings/SettingsForm.js", () => ({
  SettingsForm: ({ audience, writable }: { audience: string; writable?: boolean }) => <section>{audience} configuration <input aria-label={`${audience} mutation`} disabled={!writable} /></section>,
}));
vi.mock("../../src/components/settings/ModelsTab.js", async () => {
  const { useCapability } = await import("../../src/runtime/LaserProvider.js");
  return { ModelsTab: () => { const write = useCapability("pi/settings/set", { presentation: "explained" }); return <section>Models readable {write.state === "explained" ? write.explanation : "writable"}</section>; } };
});
vi.mock("../../src/components/settings/mcp/McpServersTab.js", () => ({
  McpServersTab: ({ writable }: { writable?: boolean }) => <section>MCP servers readable <button disabled={!writable}>Add a server</button></section>,
}));
vi.mock("../../src/components/settings/ProjectsTab.js", async () => {
  const { useCapability } = await import("../../src/runtime/LaserProvider.js");
  return { ProjectsTab: () => { const write = useCapability("pi/project/env/set", { presentation: "explained" }); return <section>Projects readable {write.state === "explained" ? "Project setup changes are unavailable here" : "writable"}</section>; } };
});
vi.mock("../../src/components/settings/resources/ResourceDiagnostics.js", async () => {
  const { useCapability } = await import("../../src/runtime/LaserProvider.js");
  return { ResourceDiagnostics: () => { const read = useCapability("resource/snapshot"); return <section>{read.state === "available" ? "Resources readable" : "Resources hidden"}</section>; } };
});

import { SettingsScreen } from "../../src/components/settings/SettingsScreen.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { createStateStore, LaserStoreProvider, type StateStore } from "../../src/runtime/LaserProvider.js";
import { initialState, type AppState } from "../../src/store.js";
import { testDescriptor } from "../runtime/environment-fixture.js";

type Tab = "general" | "models" | "mcp" | "projects" | "advanced";
let root: Root;
let container: HTMLDivElement;
let state: AppState;
let store: StateStore;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  mocks.calls.length = 0;
  mocks.request.mockClear();
  state = { ...initialState, environment: testDescriptor({ actor: { class: "paired_device", id: "phone" }, scopes: ["handshake", "read", "diagnostics"], capabilities: { diagnostics: true, logs: false, push: false } }) };
  store = createStateStore(state);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount(tab: Tab) {
  await act(async () => {
    root.render(<LaserStoreProvider store={store}><TooltipProvider><SettingsScreen cwd="/repo" initialTab={tab} /></TooltipProvider></LaserStoreProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
}

it("keeps General and Advanced configuration readable while disabling their mutations", async () => {
  await mount("general");
  expect(container.textContent).toContain("read these settings");
  expect([...container.querySelectorAll("input,select,button")].filter((element) => element.textContent?.includes("Reload settings") === false).some((element) => (element as HTMLInputElement).disabled)).toBe(true);
  expect(mocks.calls).not.toContain("pi/settings/set");
});

it("keeps Models, MCP, Projects, and Resources readable without denied writes", async () => {
  await mount("models");
  expect(container.textContent).toContain("read these settings");
  expect(container.textContent).not.toContain("Sign in");
  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
    expect(button, label).toBeDefined();
    await act(async () => { button!.click(); await Promise.resolve(); await Promise.resolve(); });
  };
  await click("MCP servers");
  expect(container.textContent).toContain("MCP servers");
  expect([...container.querySelectorAll("button")].find((entry) => entry.textContent === "Add a server")?.disabled).toBe(true);
  await click("Projects");
  expect(container.textContent).toContain("Project setup changes are unavailable here");
  await click("Advanced");
  expect(container.textContent).toContain("Resources");
  expect(container.textContent).toContain("Resources readable");
  for (const denied of ["pi/settings/set", "pi/providers/login/start", "mcp/save", "pi/project/env/set", "resource/export"]) {
    expect(mocks.calls, denied).not.toContain(denied);
  }
});
