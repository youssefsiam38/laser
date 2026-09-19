// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const stable = vi.hoisted(() => ({
  currentProject: "/p", projects: ["/p"],
  actions: { compact: vi.fn(), fork: vi.fn(), expandCatalog: vi.fn(), goProject: vi.fn(), openSession: vi.fn(), toast: vi.fn() },
  client: { request: vi.fn() },
}));
vi.mock("@/runtime", async (original) => ({ ...(await original<typeof import("../../src/runtime/index.js")>()), useLaserStable: () => stable, useSessionMeta: () => ({ running: false, compacting: false }) }));

import { CommandPaletteDialog } from "../../src/components/shell/CommandPalette.js";
import { GlobalSearch } from "../../src/components/shell/GlobalSearch.js";
import { ShellContext, type ShellContextValue } from "../../src/components/shell/shell-context.js";
import { WorkbenchProvider } from "../../src/components/workbench/workbench-context.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { createStateStore, LaserStoreProvider } from "../../src/runtime/LaserProvider.js";
import { initialState } from "../../src/store.js";
import { view } from "../agents/fixtures.js";
import { testDescriptor } from "../runtime/environment-fixture.js";

let root: Root; let container: HTMLDivElement;
const shell = { layout: "desktop", sessionsOpen: true, fleetOpen: false, telemetryOpen: false, historyOpen: false, addProjectOpen: false, canCreate: true,
  setSessionsOpen: vi.fn(), setFleetOpen: vi.fn(), setTelemetryOpen: vi.fn(), setHistoryOpen: vi.fn(), setAddProjectOpen: vi.fn(), toggleSessions: vi.fn(), toggleFleet: vi.fn(), toggleTelemetry: vi.fn(), openHistory: vi.fn(), newSession: vi.fn(), showChat: vi.fn(), returnToChat: vi.fn() } satisfies ShellContextValue;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; Object.values(stable.actions).forEach(fn => fn.mockClear()); stable.client.request.mockClear(); shell.openHistory.mockClear(); shell.newSession.mockClear(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.querySelectorAll('[role="dialog"]').forEach(node => node.remove()); });

it("omits denied new, compact and fork palette commands while keeping read navigation", async () => {
  const path = "/p/s.jsonl"; const base = view({ path }); const opened = { ...base, state: { ...base.state, name: "Existing work" } };
  const store = createStateStore({ ...initialState, current: path, open: { [path]: opened }, sessions: [], environment: testDescriptor({ actor: { class: "paired_device", id: "phone" }, scopes: ["handshake", "read", "diagnostics"], localOnly: ["session/search"] }) });
  await act(async () => root.render(<LaserStoreProvider store={store}><TooltipProvider><WorkbenchProvider><ShellContext.Provider value={shell}><CommandPaletteDialog open onOpenChange={vi.fn()} /><GlobalSearch /></ShellContext.Provider></WorkbenchProvider></TooltipProvider></LaserStoreProvider>));
  const text = document.querySelector('[role="dialog"]')?.textContent ?? "";
  expect(text).toContain("Open history"); expect(text).toContain("Settings");
  expect(text).not.toMatch(/New session|Compact context|Fork from last prompt/);
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", ctrlKey: true, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, shiftKey: true, bubbles: true }));
  });
  expect([...document.querySelectorAll('[role="dialog"]')].some((dialog) => dialog.textContent?.includes("Search all sessions"))).toBe(false);
  expect(shell.newSession).not.toHaveBeenCalled(); expect(stable.actions.compact).not.toHaveBeenCalled(); expect(stable.actions.fork).not.toHaveBeenCalled(); expect(stable.client.request).not.toHaveBeenCalled();
});
