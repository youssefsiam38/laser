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
import { buildFleet, createFleetSelector, projectFleetSections, scopeFleet, selectFleet, type FleetGroup, type FleetItem, type FleetProjectedItem, type FleetSections } from "../../src/fleet/model.js";
import { resetFleetState } from "../../src/fleet/fleet-state.js";
import { createStateStore, LaserStoreProvider, type StateStore } from "../../src/runtime/LaserProvider.js";
import { initialState, type SessionView } from "../../src/store.js";
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

/** The child's own chat, held open: how the client knows the session itself. */
const childView = (): SessionView => {
  const held = view({ path: CHILD });
  return { ...held, state: { ...held.state, agent: { agentName: "default", kind: "child", subagentName: "explorer", parentPath: ROOT, rootPath: ROOT } } };
};

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

/**
 * The second flicker, and the one that survived the first fix.
 *
 * The shape is the one the column was measured in: an *ended* child agent,
 * drawn as a context row only because a *running* command of its own hangs
 * off it. The command's row is nested inside the agent's `li`; the agent's
 * `li` is a child of the group's `ul`.
 *
 * A command hangs off its session while the tree has a node for that session,
 * and off the nearest ancestor it does have otherwise. The tree's nodes come
 * from two places that can both go quiet under a command that is still
 * writing — the run registry (`agents/runs` replaces it wholesale) and the
 * catalog page (`pi/session/list` returns a bounded page). When they do, the
 * command leaves its agent's list for the group's own: one `li` removed here,
 * one added there, back again on the next update, with the same two pieces of
 * work present the whole time. Nothing above sees a change; React replaces
 * the row rather than updating it.
 */
const sectionKeys = (sections: FleetSections): string[] => [
  ...sections.active.groups.flatMap((group) => projectedKeys(group.items).map((key) => `active ${group.group.path} ${key}`)),
  ...sections.finished.groups.flatMap((group) => projectedKeys(group.items).map((key) => `finished ${group.group.path} ${key}`)),
];

describe("where a row is drawn never moves while a command writes", () => {
  const fleet = createFleetSelector();
  const sections = (options: { thin: boolean; bytes: number; now: number }): FleetSections => {
    const groups = fleet({
      // The thin snapshot is not a different fleet: it is the same fleet with
      // the child's run and catalog row momentarily missing.
      sessions: options.thin ? [summary({ path: ROOT, name: "Root session" })] : [summary({ path: ROOT, name: "Root session" }), childRow],
      runs: options.thin ? {} : { r1: explorer },
      tasks: { t1: task({ id: "t1", sessionPath: CHILD, outputBytes: options.bytes, activity: `page reload ${options.bytes}` }) },
      views: { [ROOT]: view({ path: ROOT }), [CHILD]: childView() },
      sessionsLoaded: true,
      currentPath: ROOT,
      now: options.now,
    });
    const scope = scopeFleet(groups, ROOT);
    return projectFleetSections(scope.tree ? [scope.tree] : []);
  };

  it("gives every row the same section and the same key across ten output ticks", () => {
    const first = sectionKeys(sections({ thin: false, bytes: 4096, now: 5_000 }));
    expect(first).toEqual([
      `active ${ROOT} agent:${CHILD} (context)`,
      `active ${ROOT} ·task:t1`,
      `finished ${ROOT} agent:${CHILD}`,
    ]);
    for (let tick = 1; tick <= 10; tick += 1) {
      expect(sectionKeys(sections({ thin: false, bytes: 4096 * (tick + 1), now: 5_000 + tick * 1_200 }))).toEqual(first);
    }
  });

  it("keeps a running command under its agent when the snapshot forgets that session", () => {
    const first = sectionKeys(sections({ thin: false, bytes: 4096, now: 5_000 }));
    for (let tick = 1; tick <= 10; tick += 1) {
      // Every other tick the registry and the catalog both go quiet about the
      // child, exactly as a scoped reload or a bounded page does.
      const drawn = sectionKeys(sections({ thin: tick % 2 === 1, bytes: 4096 * (tick + 1), now: 5_000 + tick * 1_200 }));
      expect(drawn, `tick ${tick}`).toEqual(first);
    }
  });

  it("holds a row open for the session that started the command, and for nothing else", () => {
    const held = createFleetSelector();
    const of = (input: Parameters<typeof held>[0]): string[] => keyTree(scopeFleet(held(input), ROOT).tree?.items ?? []);
    expect(of({
      sessions: [summary({ path: ROOT, name: "Root session" }), childRow],
      runs: { r1: explorer },
      tasks: { t1: task({ id: "t1", sessionPath: CHILD }) },
      views: { [ROOT]: view({ path: ROOT }) },
      sessionsLoaded: true,
      currentPath: ROOT,
      now: 5_000,
    })).toEqual([`agent:${CHILD}`, "·task:t1"]);
    // The next snapshot's command runs in the root session. Same id, different
    // work: nothing may put it back under an agent it never belonged to.
    expect(of({
      sessions: [summary({ path: ROOT, name: "Root session" })],
      runs: {},
      tasks: { t1: task({ id: "t1", sessionPath: ROOT }) },
      views: { [ROOT]: view({ path: ROOT }) },
      sessionsLoaded: true,
      currentPath: ROOT,
      now: 6_200,
    })).toEqual(["task:t1"]);
  });

  it("lets go the moment the command ends", () => {
    sections({ thin: false, bytes: 4096, now: 5_000 });
    const ended = fleet({
      sessions: [summary({ path: ROOT, name: "Root session" })],
      runs: {},
      tasks: { t1: task({ id: "t1", sessionPath: CHILD, status: "completed", exitCode: 0, endedAt: "2026-09-08T10:05:00.000Z", terminalReason: "exit code 0" }) },
      views: { [ROOT]: view({ path: ROOT }), [CHILD]: childView() },
      sessionsLoaded: true,
      currentPath: ROOT,
      now: 9_000,
    });
    // Nothing is held open for work that is over: the build is the truth again.
    expect(keyTree(scopeFleet(ended, ROOT).tree?.items ?? [])).toEqual(["task:t1"]);
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

  it("keeps every row node when the snapshot forgets the session under a running command", async () => {
    // The child's chat is held open, so the client still knows which tree the
    // command belongs to; what it loses is the row and the run behind the
    // agent's own line.
    const full = { sessions: [summary({ path: ROOT, name: "Root session" }), childRow], runs: { r1: explorer } };
    fixture.state.open = { [ROOT]: view({ path: ROOT }), [CHILD]: childView() };
    await render();
    const before = rows();
    const items = [...container.querySelectorAll("li")];
    const list = container.querySelector("ul");
    expect(before.map((row) => row.dataset.kind)).toEqual(["agent", "task"]);
    expect(items).toHaveLength(2);

    for (let tick = 1; tick <= 10; tick += 1) {
      const thin = tick % 2 === 1;
      fixture.state.sessions = thin ? [summary({ path: ROOT, name: "Root session" })] : full.sessions;
      fixture.state.agents.runs = thin ? {} : full.runs;
      // A whole new map with a whole new record, the way `tasks/loaded` and
      // `tasks/update` both hand it over.
      fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: CHILD, outputBytes: tick * 4096, activity: `page reload ${tick}` }) };
      await render();
      const now = rows();
      expect(now.map((row) => row.dataset.kind), `tick ${tick}`).toEqual(["agent", "task"]);
      // The same nodes: the container survived before this fix too, the rows
      // did not.
      expect(container.querySelector("ul"), `tick ${tick}`).toBe(list);
      expect([...container.querySelectorAll("li")].map((node, index) => node === items[index]), `tick ${tick}`).toEqual([true, true]);
      expect(now.map((node, index) => node === before[index]), `tick ${tick}`).toEqual([true, true]);
      // The command stays inside its agent's list, and that agent stays quiet.
      expect([...container.querySelectorAll("li")][1]!.dataset.nested, `tick ${tick}`).toBe("true");
      expect(now[0]!.dataset.context, `tick ${tick}`).toBe("true");
      expect(container.querySelector('[data-slot="fleet-strays"]'), `tick ${tick}`).toBeNull();
    }
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
