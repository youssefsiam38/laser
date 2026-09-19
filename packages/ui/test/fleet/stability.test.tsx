// @vitest-environment happy-dom
/**
 * The fleet does not flicker.
 *
 * A background command writes output every second or so, and each write is a
 * new `tasks/update`. Nothing about *which* work exists changes — yet the
 * column was seen removing rows and adding them back, alternating, at exactly
 * that rate: the ended agent's context row and the running command's row
 * swapping places in identically-marked lists, with new DOM nodes each time.
 *
 * Three causes, each pinned below:
 *
 *   1. **Attribution followed the snapshot, not the work.** A command hung off
 *      its session only when that session had a node in the tree, and the tree
 *      is built from the runs and catalog rows the client happens to hold. A
 *      missing link in the chain moved the command out of its session's tree
 *      into a group of its own — which, having no catalog row, is drawn as
 *      "work from a deleted session" at the bottom of the column. The ended
 *      parent's context row exists only to carry that running child, so it
 *      left with it. Both lists are `ul`s of rows: the row is removed here and
 *      added there, and back when the link returns.
 *   2. **Order fell back to map order.** Two commands that started in the same
 *      millisecond were ordered by `Object.values`, and `tasks/loaded` rewrites
 *      that order for every session it lists.
 *   3. **Every object was rebuilt.** One changed task record replaced every
 *      `FleetItem` and `FleetGroup` in the column, so every row re-rendered on
 *      every tick of every command.
 *
 * The identities themselves are `agent:<sessionPath>` and `task:<id>` (R8) and
 * are asserted here to be exactly that, and to survive a record changing.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundTask } from "@lasercode/protocol";

import { FleetPanel } from "../../src/components/fleet/FleetPanel.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { buildFleet, projectFleetSections, scopeFleet, selectFleet, type FleetGroup, type FleetItem, type FleetProjectedItem } from "../../src/fleet/model.js";
import { resetFleetState } from "../../src/fleet/fleet-state.js";
import { createStateStore, LaserStoreProvider, type StateStore } from "../../src/runtime/LaserProvider.js";
import { initialState } from "../../src/store.js";
import { run, summary, view } from "../agents/fixtures.js";
import { testDescriptor } from "../runtime/environment-fixture.js";

const ROOT = "/p/root.jsonl";
const CHILD = "/p/child.jsonl";
const GRAND = "/p/grand.jsonl";
const OTHER = "/p/other.jsonl";

const task = (over: Partial<BackgroundTask> & Pick<BackgroundTask, "id" | "sessionPath">): BackgroundTask => ({
  command: "pnpm vite dev --host --port 5173",
  title: "pnpm vite dev --host --port 5173",
  status: "running",
  origin: "background",
  startedAt: "2026-09-08T10:00:00.000Z",
  outputBytes: 11,
  activity: "page reload",
  ...over,
});

const childRow = summary({ path: CHILD, agent: { agentName: "default", kind: "child", subagentName: "explorer", parentPath: ROOT, rootPath: ROOT } });
const explorer = run({ runId: "r1", sessionPath: CHILD, subagentName: "explorer", status: "completed", endedAt: "2026-09-08T10:02:00.000Z" });

/** Every key in a group, in draw order, with its nesting. */
const keyTree = (items: readonly FleetItem[], depth = 0): string[] =>
  items.flatMap((item) => [`${"·".repeat(depth)}${item.key}`, ...keyTree(item.children, depth + 1)]);
const groupKeys = (groups: readonly FleetGroup[]): string[] =>
  groups.flatMap((group) => [group.path, ...keyTree(group.items).map((key) => `  ${key}`)]);
const projectedKeys = (items: readonly FleetProjectedItem[], depth = 0): string[] =>
  items.flatMap((item) => [`${"·".repeat(depth)}${item.item.key}${item.contextOnly ? " (context)" : ""}`, ...projectedKeys(item.children, depth + 1)]);

describe("an output-only update does not reorder or remount the fleet", () => {
  const sessions = [summary({ path: ROOT, name: "Root session" }), childRow];
  const runs = { r1: explorer };
  const NOW = 5_000;
  const fleetWith = (bytes: number, activity: string, now = NOW): FleetGroup[] =>
    selectFleet({
      sessions,
      runs,
      tasks: { t1: task({ id: "t1", sessionPath: CHILD, outputBytes: bytes, activity }) },
      views: {},
      sessionsLoaded: true,
      currentPath: ROOT,
      now,
    });

  it("produces the same keys, in the same order, across five output ticks", () => {
    const first = groupKeys(fleetWith(11, "page reload"));
    expect(first).toEqual([ROOT, `  agent:${CHILD}`, "  ·task:t1"]);
    for (let tick = 1; tick <= 5; tick += 1) {
      expect(groupKeys(fleetWith(tick * 4096, `page reload ${tick}`, NOW + tick))).toEqual(first);
    }
  });

  it("keeps the context parent of a running command for every one of them", () => {
    for (let tick = 0; tick <= 5; tick += 1) {
      const scope = scopeFleet(fleetWith(tick * 4096, `page reload ${tick}`, NOW + tick), ROOT);
      const sections = projectFleetSections(scope.tree ? [scope.tree] : []);
      expect(sections.active.groups.flatMap((group) => projectedKeys(group.items))).toEqual([
        `agent:${CHILD} (context)`,
        "·task:t1",
      ]);
      // The parent is context, so it is never counted as work in this section.
      expect(sections.active.count).toBe(1);
    }
  });

  it("hands React the same item objects for everything the update did not touch", () => {
    const sessionsWithSibling = [...sessions, summary({ path: OTHER, agent: { agentName: "default", kind: "child", subagentName: "writer", parentPath: ROOT, rootPath: ROOT } })];
    const withSibling = {
      r1: explorer,
      r2: run({ runId: "r2", sessionPath: OTHER, subagentName: "writer", status: "completed", endedAt: "2026-09-08T10:03:00.000Z" }),
    };
    const settled = task({ id: "t2", sessionPath: OTHER, status: "completed", exitCode: 0, endedAt: "2026-09-08T10:03:30.000Z" });
    const build = (bytes: number): FleetGroup[] =>
      selectFleet({
        sessions: sessionsWithSibling,
        runs: withSibling,
        tasks: { t1: task({ id: "t1", sessionPath: CHILD, outputBytes: bytes }), t2: settled },
        views: {},
        sessionsLoaded: true,
        currentPath: ROOT,
        now: NOW,
      });
    const before = build(11);
    const after = build(4096);
    const writer = (groups: FleetGroup[]): FleetItem => groups[0]!.items.find((item) => item.key === `agent:${OTHER}`)!;
    // The sibling subtree the command's output has nothing to do with is the
    // same object, so React does not even re-render it.
    expect(writer(after)).toBe(writer(before));
    expect(writer(after).children[0]).toBe(writer(before).children[0]);
    // The command that did change is a new object, under the same key.
    const command = (groups: FleetGroup[]): FleetItem => groups[0]!.items.find((item) => item.key === `agent:${CHILD}`)!.children[0]!;
    expect(command(after)).not.toBe(command(before));
    expect(command(after).key).toBe(command(before).key);
  });

  it("gives every piece of work the one identity it is addressed by, whatever changes", () => {
    const keys = groupKeys(fleetWith(4096, "reload"));
    expect(keys.filter((key) => key.trim().startsWith("agent:") || key.trim().startsWith("·task:") || key.trim().startsWith("task:"))).toHaveLength(2);
    for (const group of fleetWith(8192, "reload again")) {
      for (const item of group.items) {
        expect(item.key).toBe(`agent:${item.sessionPath}`);
        for (const child of item.children) expect(child.key).toBe(`task:${child.task!.id}`);
      }
    }
  });
});

describe("what the fleet shows never depends on map order", () => {
  it("orders two commands that began in the same millisecond by a total order", () => {
    const a = task({ id: "a", sessionPath: ROOT, command: "pnpm a", title: "pnpm a" });
    const b = task({ id: "b", sessionPath: ROOT, command: "pnpm b", title: "pnpm b" });
    const of = (tasks: Record<string, BackgroundTask>): string[] =>
      groupKeys(buildFleet({ sessions: [summary({ path: ROOT })], runs: {}, tasks, views: {}, sessionsLoaded: true, now: 1 }));
    // `tasks/loaded` rewrites the map's insertion order for every session it
    // lists; the rows must not notice.
    expect(of({ b, a })).toEqual(of({ a, b }));
    expect(of({ a, b })).toEqual([ROOT, "  task:a", "  task:b"]);
  });

  it("puts two sessions with the same title in a stable order", () => {
    const rows = [summary({ path: ROOT, name: "Same" }), summary({ path: OTHER, name: "Same" })];
    const tasks = { a: task({ id: "a", sessionPath: ROOT }), b: task({ id: "b", sessionPath: OTHER }) };
    const of = (sessions: typeof rows): string[] =>
      buildFleet({ sessions, runs: {}, tasks, views: {}, sessionsLoaded: true, now: 1 }).map((group) => group.path);
    expect(of([...rows].reverse())).toEqual(of(rows));
  });
});

describe("a command belongs to the work that started it, not to the snapshot", () => {
  it("keeps a command in the tree its session declares when a link in the chain is missing", () => {
    // The grandchild's row knows its root; the session between them has no row
    // and no run in this snapshot. Before, the command left the tree for a
    // group of its own, which — having no catalog row — was drawn as work from
    // a deleted session at the bottom of every fleet.
    const groups = buildFleet({
      sessions: [
        summary({ path: ROOT, name: "Root session" }),
        summary({ path: GRAND, agent: { agentName: "default", kind: "child", subagentName: "deep", parentPath: CHILD, rootPath: ROOT } }),
      ],
      runs: {},
      tasks: { t1: task({ id: "t1", sessionPath: GRAND }) },
      views: {},
      sessionsLoaded: true,
      now: 1,
    });
    expect(groups.map((group) => group.path)).toEqual([ROOT]);
    expect(groups[0]!.deleted).toBe(false);
    // Attached to the nearest session the tree does have: one indent less,
    // never another list.
    expect(keyTree(groups[0]!.items)).toEqual(["task:t1"]);
  });

  it("keeps a command under its agent when the run registry no longer holds that run", () => {
    // The catalog still attributes the session; only the run is out of this
    // snapshot. The command must not change lists over that.
    const groups = buildFleet({
      sessions: [summary({ path: ROOT, name: "Root session" }), childRow],
      runs: {},
      tasks: { t1: task({ id: "t1", sessionPath: CHILD }) },
      views: {},
      sessionsLoaded: true,
      now: 1,
    });
    expect(groups.map((group) => group.path)).toEqual([ROOT]);
    expect(keyTree(groups[0]!.items)).toEqual([`agent:${CHILD}`, "·task:t1"]);
  });

  it("keeps a command under its agent when the catalog has no row for the session yet", () => {
    const groups = buildFleet({
      sessions: [summary({ path: ROOT, name: "Root session" })],
      runs: { r1: explorer },
      tasks: { t1: task({ id: "t1", sessionPath: CHILD }) },
      views: {},
      sessionsLoaded: true,
      now: 1,
    });
    expect(groups.map((group) => group.path)).toEqual([ROOT]);
    expect(keyTree(groups[0]!.items)).toEqual([`agent:${CHILD}`, "·task:t1"]);
  });

  it("draws a command exactly once across every group", () => {
    const groups = buildFleet({
      sessions: [summary({ path: ROOT }), childRow],
      runs: { r1: explorer },
      tasks: { t1: task({ id: "t1", sessionPath: CHILD }), t2: task({ id: "t2", sessionPath: ROOT, command: "pnpm build", title: "pnpm build" }) },
      views: {},
      sessionsLoaded: true,
      now: 1,
    });
    const keys = groups.flatMap((group) => keyTree(group.items)).map((key) => key.replaceAll("·", ""));
    expect(keys.filter((key) => key === "task:t1")).toHaveLength(1);
    expect(keys.filter((key) => key === "task:t2")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The same claim, through the component, where the flicker was seen.
// ---------------------------------------------------------------------------

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
    tasks: { stop: vi.fn(), list: vi.fn(), output: vi.fn(async () => ({ id: "t1", from: 0, bytes: 0, chunk: "", eof: true })) },
  },
  endAgent: vi.fn(),
  removeWorktree: vi.fn(),
  request: vi.fn(),
  openChanges: vi.fn(),
}));

vi.mock("@/source-control/store.js", () => ({ openChanges: (...args: unknown[]) => fixture.openChanges(...args) }));
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
  fixture.state.sessions = [summary({ path: ROOT, name: "Root session" }), childRow];
  fixture.state.open = { [ROOT]: view({ path: ROOT }) };
  fixture.state.agents.runs = { r1: explorer };
  fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: CHILD }) };
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

describe("the column itself, across a streaming command", () => {
  it("keeps every row node, in place, through ten output updates", async () => {
    await render();
    const before = rows();
    expect(before.map((row) => row.dataset.kind)).toEqual(["agent", "task"]);
    expect(before[0]!.dataset.context).toBe("true");

    for (let tick = 1; tick <= 10; tick += 1) {
      // A new tasks map with a new record: exactly what `tasks/update` does.
      fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: CHILD, outputBytes: tick * 4096, activity: `page reload ${tick}` }) };
      await render();
      const now = rows();
      expect(now).toHaveLength(before.length);
      // The same nodes, not merely the same shape: a remount would replace them.
      expect(now.map((node, index) => node === before[index])).toEqual(before.map(() => true));
      // And the context parent never blinks out from under its running child.
      expect(now[0]!.dataset.context).toBe("true");
      expect(container.querySelector('[data-slot="fleet-strays"]')).toBeNull();
    }
    // The row did update, it simply was not replaced to do it.
    expect(rows()[1]!.textContent).toContain("40 KB");
  });

  it("does not reshuffle two commands when the task map is rewritten", async () => {
    const a = task({ id: "a", sessionPath: ROOT, command: "pnpm a", title: "pnpm a" });
    const b = task({ id: "b", sessionPath: ROOT, command: "pnpm b", title: "pnpm b" });
    fixture.state.agents.runs = {};
    fixture.state.tasks.tasks = { a, b };
    await render();
    const order = () => rows().map((row) => row.querySelector('[data-slot="fleet-name"]')?.textContent);
    const first = order();
    const nodes = rows();
    // `tasks/loaded` rebuilds the map and re-appends what it listed.
    fixture.state.tasks.tasks = { b, a };
    await render();
    expect(order()).toEqual(first);
    expect(rows().map((node, index) => node === nodes[index])).toEqual([true, true]);
  });
});
