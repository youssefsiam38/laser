// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialState, reduce } from "../../../src/store.js";
import { snapshot } from "../fixtures.js";

/** The phone layout: the list first, the editor as a full-height view with a way back. */
const mocks = vi.hoisted(() => {
  const agents = {
    refresh: vi.fn(async () => undefined),
    validate: vi.fn(async () => []),
    save: vi.fn(),
    remove: vi.fn(),
    setDefault: vi.fn(),
    setPolicy: vi.fn(),
    skills: vi.fn(async () => ({ skills: [], roots: [] })),
    engineInstructions: vi.fn(async () => "engine"),
    runs: vi.fn(),
    stopRun: vi.fn(),
    setBeamModel: vi.fn(),
    setNamerModel: vi.fn(),
    qualifyNamer: vi.fn(),
    dismissBeamChoice: vi.fn(),
  };
  const request = vi.fn(async (method: string) => {
    if (method === "pi/models/catalog") return { models: [], enabledPatterns: null, refreshedAt: "", errors: [] };
    if (method === "feature/list") return { features: [] };
    throw new Error(`unexpected ${method}`);
  });
  return { stable: { client: { request }, currentProject: "/p", actions: { agents, toast: vi.fn(), newSession: vi.fn() } } };
});

vi.mock("../../../src/runtime/LaserProvider.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/runtime/LaserProvider.js")>()),
  useLaserStable: () => mocks.stable,
}));
vi.mock("../../../src/hooks/use-mobile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/hooks/use-mobile.js")>()),
  useIsMobile: () => true,
}));

import { AgentsScreen } from "../../../src/components/agents/page/AgentsScreen.js";
import { TooltipProvider } from "../../../src/components/ui/tooltip.js";
import { WorkbenchProvider, useWorkbench } from "../../../src/components/workbench/index.js";
import { LaserStoreProvider, createStateStore } from "../../../src/runtime/LaserProvider.js";

let container: HTMLDivElement;
let root: Root;
let workbench: ReturnType<typeof useWorkbench> | undefined;
function Probe() {
  workbench = useWorkbench();
  return null;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const q = (selector: string) => container.querySelector<HTMLElement>(selector);
const click = (el: Element | null) => act(async () => (el as HTMLElement).click());

describe("Agents page on a phone", () => {
  it("shows the list first, then the editor as a full view with a way back, and Escape returns to the list", async () => {
    const store = createStateStore(reduce(initialState, { type: "agents/loaded", snapshot: snapshot() }));
    await act(async () =>
      root.render(
        <LaserStoreProvider store={store}>
          <TooltipProvider>
            <WorkbenchProvider>
              <Probe />
              <AgentsScreen cwd="/p" />
            </WorkbenchProvider>
          </TooltipProvider>
        </LaserStoreProvider>,
      ),
    );
    await act(async () => workbench!.open("agents"));
    // The list is the page; nothing else is drawn beside it.
    expect(q('[data-slot="agent-list"]')).not.toBeNull();
    expect(q('[data-slot="agents-editor-column"]')).toBeNull();
    expect(q('[data-slot="agents-back"]')).toBeNull();

    await click(q('[data-slot="agent-row"][data-agent="reviewer"]'));
    expect(q('[data-slot="agent-list"]')).toBeNull();
    expect(q('[data-slot="agent-editor"]')?.dataset.agent).toBe("reviewer");
    expect(q('[data-slot="agents-back"]')).not.toBeNull();
    expect(container.textContent).toContain("reviewer");

    // Escape inside the editor goes back to the list and leaves the workbench open.
    const field = q('[data-slot="agent-editor"] textarea[name="description"]')!;
    field.focus();
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(q('[data-slot="agent-list"]')).not.toBeNull();
    expect(q('[data-slot="agent-editor"]')).toBeNull();
    expect(workbench?.page).toBe("agents");

    // The back control does the same.
    await click(q('[data-slot="agent-row"][data-agent="beam"]'));
    expect(q('[data-slot="agent-card"][data-agent="beam"]')).not.toBeNull();
    await click(q('[data-slot="agents-back"]'));
    expect(q('[data-slot="agent-list"]')).not.toBeNull();

    // With only the list on screen, Escape is the workbench's: it closes the page.
    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(workbench?.page).toBeNull();
  });
});
