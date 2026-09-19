// @vitest-environment happy-dom
/**
 * What the fleet column spends across, and what has to fit inside 288px.
 *
 * `chrome.test.tsx` is the same idea in the other axis: it reads heights back
 * off the rendered DOM. Widths are harder — happy-dom lays nothing out — so
 * these measure the real elements through `layout-rig.ts`, a small flex
 * measurer with a pessimistic text model that is itself pinned, in the first
 * test below, against six control widths measured in the running app.
 *
 * The two claims:
 *
 *   - the filter row **fits its column**. No horizontal scroller, no control
 *     sliced by the panel border, at 288px, with three-digit counts, and at
 *     the larger text-size setting.
 *   - a row's **leading gutter is the same for both kinds** and is as small as
 *     two initials allow, so sibling titles line up and a command's string
 *     gets the width back.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundTask } from "@lasercode/protocol";

import { FleetFilters } from "../../src/components/fleet/FleetFilters.js";
import { FleetPanel } from "../../src/components/fleet/FleetPanel.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { DEFAULT_FLEET_FILTER, type FleetFilter, type FleetFilterCounts } from "../../src/fleet/filter.js";
import { FLEET_MARK_GUTTER_PX } from "../../src/fleet/chrome.js";
import { resetFleetState } from "../../src/fleet/fleet-state.js";
import { createStateStore, LaserStoreProvider, type StateStore } from "../../src/runtime/LaserProvider.js";
import { initialState } from "../../src/store.js";
import { run, summary, view } from "../agents/fixtures.js";
import { testDescriptor } from "../runtime/environment-fixture.js";
import { installFleetWidths, layout, overflow, type Box } from "./layout-rig.js";

const ROOT = "/p/root.jsonl";
const CHILD = "/p/child.jsonl";
const FILTERS = '[data-fleet-chrome="filters"]';
/** The column's usable width: `w-80` minus the chrome either side of it. */
const COLUMN = 288;
/** The row's own padding, which a control may not cross. */
const ROW_PADDING = 12;

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
let uninstall: (() => void) | undefined;

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
  uninstall?.();
  uninstall = undefined;
});

const renderPanel = async (): Promise<void> => {
  await act(async () => root.render(
    <LaserStoreProvider store={store}><TooltipProvider><FleetPanel variant="panel" /></TooltipProvider></LaserStoreProvider>,
  ));
};

/** The filter row on its own, with counts a fleet of any size could produce. */
async function renderFilters(counts: FleetFilterCounts, filter: FleetFilter = DEFAULT_FLEET_FILTER): Promise<void> {
  await act(async () => root.render(
    <TooltipProvider>
      <FleetFilters filter={filter} counts={counts} onChange={() => undefined} />
    </TooltipProvider>,
  ));
}

const filterRow = (): HTMLElement => container.querySelector<HTMLElement>(FILTERS)!;
const controls = (): HTMLElement[] => [...filterRow().querySelectorAll<HTMLElement>("button")];
const rows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-slot="fleet-row"]')];
const rowFor = (text: string): HTMLElement => rows().find((row) => row.textContent?.includes(text))!;

const counts = (over: Partial<FleetFilterCounts> = {}): FleetFilterCounts => ({
  going: 3,
  asking: 1,
  ended: 12,
  agents: 9,
  commands: 7,
  ...over,
});

/** Every control's box, measured inside a row of `width`. */
function controlBoxes(width: number, textScale = 1): Array<{ label: string; box: Box }> {
  const row = filterRow();
  const boxes = layout(row, { width, textScale });
  return controls().map((control) => ({
    label: control.getAttribute("aria-label") ?? control.textContent ?? "",
    box: boxes.get(control)!,
  }));
}

describe("the width model", () => {
  /**
   * The six controls, measured in the running app at a 320px column with the
   * row spelled out in full. The model must be at least as wide as the app on
   * every one of them — a model that under-measures would pass a row that is
   * actually sliced — and close enough that the budget it computes is a
   * budget, not a caricature.
   */
  const MEASURED = [
    { slot: "fleet-filter-going", width: 56 },
    { slot: "fleet-filter-asking", width: 49 },
    { slot: "fleet-filter-ended", width: 58 },
    { slot: "fleet-filter-kind-all", width: 25 },
    { slot: "fleet-filter-kind-agents", width: 51 },
    { slot: "fleet-filter-kind-commands", width: 87 },
  ];

  it("is never narrower than the running app, and never more than 5px wider", async () => {
    // The counts the app was measured with: Going 1 · Asking · Ended 1, and
    // Commands 2 with no agent count.
    await renderFilters({ going: 1, asking: 0, ended: 1, agents: 0, commands: 2 });
    // No shim installed: a headless DOM reports no overflow, so the row is
    // still spelled out in full — which is the state the app was measured in.
    expect(filterRow().dataset["fit"]).toBe("0");
    const boxes = layout(filterRow(), { width: 320 });
    for (const { slot, width } of MEASURED) {
      const box = boxes.get(container.querySelector(`[data-slot="${slot}"]`)!)!;
      expect(box, slot).toBeDefined();
      expect(box.width, slot).toBeGreaterThanOrEqual(width);
      expect(box.width, slot).toBeLessThanOrEqual(width + 5);
    }
  });

  it("agrees with the app that the row spelled out does not fit the column", async () => {
    await renderFilters({ going: 1, asking: 0, ended: 1, agents: 0, commands: 2 });
    // The app measured 372px of content in a 319px row. The model is
    // pessimistic by a few percent and says the same thing louder.
    const full = overflow(filterRow(), { width: COLUMN });
    expect(full.scrollWidth).toBeGreaterThan(370);
    expect(full.scrollWidth - full.clientWidth).toBeGreaterThan(50);
  });
});

describe("the filter row fits its column", () => {
  const fits = (width = COLUMN, textScale = 1): void => {
    const row = filterRow();
    const box = overflow(row, { width, textScale });
    expect(box.scrollWidth, `row of ${width}px at ${textScale}x`).toBeLessThanOrEqual(box.clientWidth);
    const measured = controlBoxes(width, textScale);
    expect(measured.length).toBeGreaterThan(0);
    for (const { label, box: control } of measured) {
      expect(control.width, label).toBeGreaterThan(0);
      expect(control.x, label).toBeGreaterThanOrEqual(ROW_PADDING);
      // The whole control, not most of it: the defect was a chip whose right
      // edge was past the panel border by 40px.
      expect(control.x + control.width, label).toBeLessThanOrEqual(width - ROW_PADDING);
    }
  };

  it("fits at 288px inside the real column, with every control whole", async () => {
    uninstall = installFleetWidths(FILTERS, { width: COLUMN });
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: CHILD }) };
    await renderPanel();
    expect(filterRow().className).not.toContain("overflow-x-auto");
    fits();
  });

  it("fits with three-digit counts, and keeps every count visible", async () => {
    uninstall = installFleetWidths(FILTERS, { width: COLUMN });
    await renderFilters(counts({ going: 128, asking: 104, ended: 376, agents: 402, commands: 106 }));
    fits();
    const row = filterRow();
    for (const slot of ["fleet-filter-going", "fleet-filter-asking", "fleet-filter-ended"]) {
      expect(row.querySelector(`[data-slot="${slot}"]`)?.textContent, slot).toMatch(/\d{3}$/);
    }
  });

  it("fits at the larger text-size setting, with three-digit counts", async () => {
    uninstall = installFleetWidths(FILTERS, { width: COLUMN, textScale: 1.2 });
    await renderFilters(counts({ going: 128, asking: 104, ended: 376, agents: 402, commands: 106 }));
    fits(COLUMN, 1.2);
    // The last thing to go is the number, and it goes into the name and the
    // hint rather than off the edge.
    const going = filterRow().querySelector('[data-slot="fleet-filter-going"]')!;
    expect(going.textContent).toBe("Going");
    expect(going.getAttribute("aria-label")).toBe("Going, 128");
  });

  it("fits with the widest labels this row can be asked to draw", async () => {
    // Every lifecycle count three digits, the kind cut on the longest word,
    // and the larger text-size setting on top of both.
    uninstall = installFleetWidths(FILTERS, { width: COLUMN, textScale: 1.2 });
    await renderFilters(counts({ going: 888, asking: 888, ended: 888, agents: 888, commands: 888 }), {
      ...DEFAULT_FLEET_FILTER,
      kind: "task",
    });
    fits(COLUMN, 1.2);
    expect(filterRow().querySelector('[data-slot="fleet-filter-kind"]')?.getAttribute("aria-label")).toBe("Kind: Commands");
  });

  it("keeps the words and both questions at 288px, and gives up the least it can", async () => {
    uninstall = installFleetWidths(FILTERS, { width: COLUMN });
    await renderFilters(counts());
    const row = filterRow();
    // Step 1: the lifecycle question is still spelled out, with its counts.
    expect(row.dataset["fit"]).toBe("1");
    expect(row.querySelector('[data-slot="fleet-filter-going"]')?.textContent).toBe("Going3");
    expect(row.querySelector('[data-slot="fleet-filter-ended"]')?.textContent).toBe("Ended12");
    // And the kind question is one control that says which kind is on.
    const kind = row.querySelector('[data-slot="fleet-filter-kind"]')!;
    expect(kind.getAttribute("aria-label")).toBe("Kind: All");
    expect(row.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it("spells everything out again when the row is given the width for it", async () => {
    uninstall = installFleetWidths(FILTERS, { width: 520 });
    await renderFilters(counts());
    expect(filterRow().dataset["fit"]).toBe("0");
    expect(controls()).toHaveLength(6);
    fits(520);
  });
});

describe("the kind cut, once it is one control", () => {
  it("opens a menu whose items carry the counts, and picks a kind from it", async () => {
    uninstall = installFleetWidths(FILTERS, { width: COLUMN });
    const chosen: FleetFilter[] = [];
    await act(async () => root.render(
      <TooltipProvider>
        <FleetFilters filter={DEFAULT_FLEET_FILTER} counts={counts()} onChange={(next) => chosen.push(next)} />
      </TooltipProvider>,
    ));
    const trigger = filterRow().querySelector<HTMLButtonElement>('[data-slot="fleet-filter-kind"]')!;
    await act(async () => trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(items.map((item) => item.textContent)).toEqual(["All", "Agents9", "Commands7"]);
    expect(items[0]?.getAttribute("aria-checked")).toBe("true");
    await act(async () => items[1]!.click());
    expect(chosen).toEqual([{ ...DEFAULT_FLEET_FILTER, kind: "agent" }]);
  });

  it("still cuts the list by lifecycle from the narrow row", async () => {
    uninstall = installFleetWidths(FILTERS, { width: COLUMN });
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT }) };
    await renderPanel();
    const going = filterRow().querySelector<HTMLButtonElement>('[data-slot="fleet-filter-going"]')!;
    expect(rows().length).toBeGreaterThan(0);
    await act(async () => going.click());
    expect(going.getAttribute("aria-pressed")).toBe("false");
    expect(rows()).toHaveLength(0);
  });
});

describe("a row's leading gutter", () => {
  /** Where line 1's first character starts, measured inside a 288px row. */
  const titleX = (row: HTMLElement): number => {
    const boxes = layout(row, { width: COLUMN });
    return boxes.get(row.querySelector('[data-slot="fleet-name"]')!)!.x;
  };

  it("costs the same on an agent and on a command, and starts the title at 36px", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT }) };
    await renderPanel();
    const agent = titleX(rowFor("Explorer"));
    const command = titleX(rows().find((row) => row.getAttribute("data-kind") === "task")!);
    // The alignment rule: sibling titles line up whichever kind they are.
    expect(command).toBe(agent);
    // The budget: the row's own padding plus the mark plus its air, and no
    // more. It was 40px, of which 28px was the mark and its gap.
    expect(agent).toBe(ROW_PADDING + FLEET_MARK_GUTTER_PX);
  });

  it("indents line 3 to exactly the same column", async () => {
    fixture.state.agents.runs = { r1: child };
    await renderPanel();
    const row = rowFor("Explorer");
    const boxes = layout(row, { width: COLUMN });
    const title = boxes.get(row.querySelector('[data-slot="fleet-name"]')!)!;
    const strip = boxes.get(row.querySelector('[data-slot="fleet-strip"]')!)!;
    expect(strip.x).toBe(title.x);
  });

  it("keeps two initials, and the same box, on both kinds", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT }) };
    await renderPanel();
    const agent = rowFor("Explorer").querySelector<HTMLElement>('[data-slot="fleet-kind-tile"]')!;
    const command = rows().find((row) => row.getAttribute("data-kind") === "task")!.querySelector<HTMLElement>('[data-slot="fleet-kind-tile"]')!;
    expect(agent.textContent).toHaveLength(2);
    expect(agent.className).toContain("size-4.5");
    expect(command.className).toContain("size-4.5");
    // Tracking is air between two letters the tile has no room to buy.
    expect(agent.className).toContain("tracking-normal");
  });
});
