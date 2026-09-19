// @vitest-environment happy-dom
/**
 * What the fleet column spends on itself, and what a row is allowed to be.
 *
 * These are the measurable claims of the column's redesign, and they are
 * measured off the rendered DOM rather than asserted in prose:
 *
 *   - the chrome above the session is at most 72px at 320px width;
 *   - there is one filter row, it scrolls rather than wraps, and a count that
 *     is zero is not drawn;
 *   - a row is a row: no border, no radius, no card ground of its own, with
 *     hairlines between siblings and a hairline rail for nesting;
 *   - the tile is 20px on both kinds and on a context ancestor;
 *   - a context ancestor is one quiet line.
 *
 * Heights are read back from the height utilities on the elements themselves
 * (`h-12` is 48px on the 4px spacing unit), because jsdom has no layout: the
 * paint and the number come from the same class, so neither can drift without
 * the other.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundTask } from "@lasercode/protocol";

import { FleetPanel } from "../../src/components/fleet/FleetPanel.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { FLEET_CHROME_BUDGET_PX } from "../../src/fleet/chrome.js";
import { resetFleetState } from "../../src/fleet/fleet-state.js";
import { createStateStore, LaserStoreProvider, type StateStore } from "../../src/runtime/LaserProvider.js";
import { initialState } from "../../src/store.js";
import { run, summary, view } from "../agents/fixtures.js";
import { testDescriptor } from "../runtime/environment-fixture.js";

const ROOT = "/p/root.jsonl";
const CHILD = "/p/child.jsonl";

const task = (over: Partial<BackgroundTask> & Pick<BackgroundTask, "id" | "sessionPath">): BackgroundTask => ({
  command: "pnpm vite dev --host --port 5173",
  title: "pnpm vite dev --host --port 5173",
  status: "running",
  origin: "background",
  startedAt: "2026-09-08T10:00:00.000Z",
  outputBytes: 189_000,
  activity: "ready in 412 ms",
  ...over,
});

const child = run({ runId: "r1", sessionPath: CHILD, subagentName: "explorer", task: "Read the router" });

const fixture = vi.hoisted(() => ({
  state: {
    current: "/p/root.jsonl" as string | undefined,
    sessions: [] as unknown[],
    sessionsLoaded: true,
    open: {} as Record<string, unknown>,
    agents: { runs: {} as Record<string, unknown> },
    tasks: { tasks: {} as Record<string, unknown>, listed: [] as string[] },
  },
  actions: {
    openSession: vi.fn(async () => undefined),
    toast: vi.fn(),
    tasks: {
      stop: vi.fn(async () => undefined),
      list: vi.fn(async () => undefined),
      output: vi.fn(async (_path = "", _id = "", from = 0) => ({ id: "t1", from, bytes: 11, chunk: "ready", eof: true })),
    },
  },
  endAgent: vi.fn(),
  removeWorktree: vi.fn(),
  request: vi.fn(),
  openChanges: vi.fn(),
}));

vi.mock("@/source-control/store.js", () => ({
  openChanges: (...args: unknown[]) => fixture.openChanges(...args),
}));

vi.mock("@/runtime", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useLaserState: (selector: (s: unknown) => unknown) => selector(fixture.state),
  useLaserStable: () => ({ actions: fixture.actions, client: { request: fixture.request } }),
}));
vi.mock("@/components/agents/end-agent", () => ({ requestEndAgent: fixture.endAgent }));
vi.mock("@/agents/worktree", () => ({ requestRemoveWorktree: fixture.removeWorktree }));

let container: HTMLDivElement;
let root: Root;
let store: StateStore;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  resetFleetState();
  fixture.state.current = ROOT;
  fixture.state.sessions = [summary({ path: ROOT, name: "Root session" }), summary({ path: CHILD })];
  fixture.state.open = { [ROOT]: view({ path: ROOT }) };
  fixture.state.agents.runs = {};
  fixture.state.tasks.tasks = {};
  store = createStateStore({ ...initialState, environment: testDescriptor() });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const render = async (): Promise<void> => {
  await act(async () => root.render(<LaserStoreProvider store={store}><TooltipProvider><FleetPanel variant="panel" /></TooltipProvider></LaserStoreProvider>));
};
const rows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-slot="fleet-row"]')];
const rowFor = (text: string): HTMLElement => rows().find((row) => row.textContent?.includes(text))!;

/** The 4px spacing unit, the way a `h-*` utility resolves it. */
const SPACING_PX = 4;
/** The paint on a fine pointer: a `pointer-coarse:` variant is a target, not a band. */
const heightPx = (element: Element): number => {
  const match = /(?:^|\s)h-(\d+(?:\.\d+)?)(?:\s|$)/.exec(element.className);
  if (!match) throw new Error(`no fixed height utility on ${element.getAttribute("data-fleet-chrome") ?? element.tagName}`);
  return Number(match[1]) * SPACING_PX;
};

describe("the fleet column's chrome budget", () => {
  it("spends at most 72px before the session, in exactly two bands", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: CHILD }) };
    await render();

    const chrome = [...container.querySelectorAll<HTMLElement>("[data-fleet-chrome]")];
    expect(chrome.map((band) => band.dataset.fleetChrome)).toEqual(["header", "filters"]);
    const total = chrome.reduce((sum, band) => sum + heightPx(band), 0);
    expect(total).toBeLessThanOrEqual(FLEET_CHROME_BUDGET_PX);
    expect(total).toBe(72);

    // And nothing else stands between them and the work: the "In progress"
    // band is gone from the tree, because the header and the filter row both
    // already carry its count.
    expect(container.querySelector('[data-slot="fleet-section-header"]')).toBeNull();
    const group = container.querySelector('[data-slot="fleet-group"]')!;
    expect(group.previousElementSibling?.getAttribute("data-slot")).toBe("fleet-filters");
    expect(group.querySelector('[data-slot="fleet-row"]')).not.toBeNull();
  });

  it("keeps the header aligned with the other columns and the filter row touchable", async () => {
    fixture.state.agents.runs = { r1: child };
    await render();
    const header = container.querySelector<HTMLElement>('[data-fleet-chrome="header"]')!;
    const filters = container.querySelector<HTMLElement>('[data-fleet-chrome="filters"]')!;
    expect(heightPx(header)).toBe(48);
    expect(heightPx(filters)).toBe(24);
    // Smaller paint, same target: 44px on a finger (DESIGN.md legibility floor).
    expect(filters.className).toContain("pointer-coarse:h-11");
    for (const control of filters.querySelectorAll("button")) {
      expect(control.className).toContain("pointer-coarse:h-11");
    }
  });
});

describe("one filter row", () => {
  it("puts every filter on one scrolling row and draws no zero", async () => {
    // One agent, going: Asking and Ended are zero, and Commands is zero.
    fixture.state.agents.runs = { r1: child };
    await render();

    const rowsOfFilters = container.querySelectorAll('[data-slot="fleet-filters"]');
    expect(rowsOfFilters).toHaveLength(1);
    const filters = rowsOfFilters[0] as HTMLElement;
    expect(filters.className).not.toContain("flex-wrap");
    expect(filters.className).toContain("overflow-x-auto");
    // Six controls, and all six are in this one row.
    const controls = [...filters.querySelectorAll("button")];
    expect(controls).toHaveLength(6);
    expect(container.querySelectorAll('[data-slot="fleet-filters"] button')).toHaveLength(6);
    for (const control of controls) expect(control.className).not.toContain("flex-wrap");

    const text = (slot: string): string => filters.querySelector(`[data-slot="${slot}"]`)!.textContent ?? "";
    expect(text("fleet-filter-going")).toBe("Going1");
    expect(text("fleet-filter-asking")).toBe("Asking");
    expect(text("fleet-filter-ended")).toBe("Ended");
    expect(text("fleet-filter-kind-agents")).toBe("Agents1");
    expect(text("fleet-filter-kind-commands")).toBe("Commands");
    expect(filters.textContent).not.toContain("0");
  });

  it("still cuts the list by pointer and by keyboard from that one row", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT }) };
    await render();
    const going = container.querySelector<HTMLButtonElement>('[data-slot="fleet-filter-going"]')!;
    const kinds = container.querySelector<HTMLElement>('[role="radiogroup"]')!;

    await act(async () => going.click());
    expect(going.getAttribute("aria-pressed")).toBe("false");
    // Off is struck through as well as dimmed: colour alone never carries state.
    expect(going.className).toContain("line-through");
    expect(rows()).toHaveLength(0);
    await act(async () => going.click());
    expect(rows().length).toBeGreaterThan(0);

    container.querySelector<HTMLButtonElement>('[data-slot="fleet-filter-kind-all"]')!.focus();
    await act(async () => {
      kinds.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[data-slot="fleet-filter-kind-agents"]')?.getAttribute("aria-checked")).toBe("true");
    expect(rows().map((row) => row.getAttribute("data-kind"))).toEqual(["agent"]);
  });
});

describe("a row is a row", () => {
  it("carries no card: no border, no radius, no shadow, and a hairline between siblings", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT }) };
    await render();
    expect(rows()).toHaveLength(2);
    for (const row of rows()) {
      expect(row.className).not.toMatch(/(^|\s)(border|rounded|shadow)(-|$)/);
      expect(row.className).not.toContain("bg-surface ");
    }
    // The separation is the list's, and it is one hairline.
    const list = container.querySelector('[data-slot="fleet-group"] ul')!;
    expect(list.className).toContain("divide-y");
    expect(list.className).not.toMatch(/gap-/);
    expect(list.className).not.toMatch(/rounded|border(?!-)/);
  });

  it("expresses nesting with a hairline rail and no second box", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: CHILD }) };
    await render();
    const nested = rowFor("Explorer").closest('[data-slot="fleet-branch"]')!.querySelector(":scope > ul")!;
    expect(nested.className).toContain("border-s");
    expect(nested.className).not.toMatch(/rounded/);
    expect(nested.querySelector('[data-slot="fleet-row"][data-kind="task"]')).not.toBeNull();
  });

  it("grounds hover and the open row from the token set, and marks the open one with a live rule", async () => {
    fixture.state.agents.runs = { r1: child };
    await render();
    const row = rowFor("Explorer");
    expect(row.className).toContain("hover:bg-surface-2");
    await act(async () => row.querySelector("button")!.click());
    expect(row.getAttribute("data-expanded")).toBe("true");
    expect(row.className).toContain("bg-surface-2");
    expect(row.className).toContain("before:bg-live");
  });

  it("keeps the tile at 20px on both kinds and on a context ancestor", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = {
      t1: task({ id: "t1", sessionPath: CHILD, status: "completed", exitCode: 0, endedAt: "2026-09-08T10:04:00.000Z" }),
    };
    await render();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.startsWith("Finished"))!.click());
    const tiles = [...container.querySelectorAll<HTMLElement>('[data-slot="fleet-kind-tile"]')];
    expect(tiles.length).toBeGreaterThanOrEqual(3);
    for (const tile of tiles) expect(tile.className).toContain("size-5");
    // Eyebrow size, mono, tracked: the one sub-12px exception, and taken from
    // the utility that owns it rather than spelled as a size class.
    for (const tile of tiles) expect(tile.className).toContain("eyebrow");
  });

  it("draws a context ancestor as one quiet line with no sentence under it", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = {
      t1: task({ id: "t1", sessionPath: CHILD, status: "completed", exitCode: 0, endedAt: "2026-09-08T10:04:00.000Z" }),
    };
    await render();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.startsWith("Finished"))!.click());
    const context = [...container.querySelectorAll<HTMLElement>('[data-slot="fleet-row"][data-context="true"]')][0]!;
    expect(context.getAttribute("data-quiet")).toBe("true");
    expect(context.className).toContain("text-ink-3");
    expect(context.textContent).not.toContain("Parent of work shown here.");
    // No line 2, no line 3, no elapsed: a title, the word context, a chevron.
    expect(context.querySelector('[data-slot="fleet-headline"]')).toBeNull();
    expect(context.querySelector('[data-slot="fleet-strip"]')).toBeNull();
    expect(context.querySelector('[data-slot="fleet-elapsed"]')).toBeNull();
    // Still openable, and still says what it is to a screen reader.
    const expand = context.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(expand.getAttribute("aria-label")).toContain("Parent of work shown here.");
    await act(async () => expand.click());
    expect(context.getAttribute("data-expanded")).toBe("true");
  });
});
