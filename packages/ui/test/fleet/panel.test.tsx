// @vitest-environment happy-dom
/**
 * The fleet column, as a person meets it: two kinds of work in one list, a row
 * that opens in place, "Open chat" that navigates, Stop that ends a task, and
 * an empty state that is a real state.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundTask } from "@lasercode/protocol";

import { FleetPanel } from "../../src/components/fleet/FleetPanel.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { resetFleetState, revealInFleet } from "../../src/fleet/fleet-state.js";
import { run, summary, view } from "../agents/fixtures.js";

const ROOT = "/p/root.jsonl";
const CHILD = "/p/child.jsonl";

const task = (over: Partial<BackgroundTask> & Pick<BackgroundTask, "id" | "sessionPath">): BackgroundTask => ({
  command: "pnpm vite dev --host",
  title: "pnpm vite dev --host",
  status: "running",
  origin: "background",
  startedAt: "2026-09-08T10:00:00.000Z",
  outputBytes: 11,
  activity: "ready in 412 ms",
  ...over,
});

const child = run({ runId: "r1", sessionPath: CHILD, subagentName: "explorer", task: "Read the router" });

const fixture = vi.hoisted(() => ({
  state: {
    current: "/p/root.jsonl",
    sessions: [] as unknown[],
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
      output: vi.fn(async () => ({ id: "t1", from: 0, bytes: 11, chunk: "ready in 412 ms", eof: true })),
    },
  },
  endAgent: vi.fn(),
}));

vi.mock("@/runtime", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useLaserState: (selector: (s: unknown) => unknown) => selector(fixture.state),
  useLaserStable: () => ({ actions: fixture.actions }),
}));
vi.mock("@/components/agents/end-agent", () => ({ requestEndAgent: fixture.endAgent }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  resetFleetState();
  fixture.state.sessions = [summary({ path: ROOT, name: "Root session" }), summary({ path: CHILD })];
  fixture.state.open = { [ROOT]: view({ path: ROOT }) };
  fixture.state.agents.runs = {};
  fixture.state.tasks.tasks = {};
  for (const spy of [fixture.actions.openSession, fixture.actions.tasks.stop, fixture.actions.tasks.output, fixture.endAgent]) spy.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const render = async (): Promise<void> => {
  await act(async () => root.render(<TooltipProvider><FleetPanel variant="panel" /></TooltipProvider>));
};
const rows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-slot="fleet-row"]')];
const rowFor = (title: string): HTMLElement => rows().find((row) => row.textContent?.includes(title))!;

describe("the fleet column", () => {
  it("draws an empty state that says what would fill it", async () => {
    await render();
    expect(container.textContent).toContain("Nothing is running");
    expect(container.textContent).toContain("appear here");
    expect(rows()).toHaveLength(0);
  });

  it("lists agent runs and background commands together, under their session", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: CHILD }) };
    await render();
    expect(container.querySelector("h4")?.textContent).toBe("Root session");
    const kinds = rows().map((row) => [row.getAttribute("data-kind"), row.querySelector("span")?.parentElement?.textContent]);
    expect(kinds.map(([kind]) => kind)).toEqual(["agent", "task"]);
    // The command is inside the agent's branch: it is that agent's command.
    expect(rowFor("explorer").parentElement?.querySelector('[data-slot="fleet-row"][data-kind="task"]')).not.toBeNull();
    // A live row says what it is doing, in the work's own words.
    expect(rowFor("pnpm vite dev").textContent).toContain("ready in 412 ms");
    expect(container.textContent).toContain("2 going");
  });

  it("opens one row at a time, in place, and closes it again", async () => {
    fixture.state.agents.runs = { r1: child };
    await render();
    expect(rowFor("explorer").getAttribute("data-expanded")).toBeNull();
    await act(async () => rowFor("explorer").querySelector("button")!.click());
    expect(rowFor("explorer").getAttribute("data-expanded")).toBe("true");
    expect(rowFor("explorer").textContent).toContain("Read the router");
    await act(async () => rowFor("explorer").querySelector("button")!.click());
    expect(rowFor("explorer").getAttribute("data-expanded")).toBeNull();
    // Collapsed really hides: the detail is gone from the DOM, not merely
    // unseen. The row's own one-line summary stays, which is the point of it.
    expect(rowFor("explorer").querySelector("dl")).toBeNull();
    expect(rowFor("explorer").textContent).toContain("Read the router");
  });

  it("names the branch of an agent that has a worktree", async () => {
    fixture.state.agents.runs = {
      r1: run({ runId: "r1", sessionPath: CHILD, subagentName: "explorer", task: "Read the router", worktree: { path: "/p/.worktrees/explorer-1", branch: "agents/explorer-1", baseCommit: "abc" }, cwd: "/p/.worktrees/explorer-1" }),
    };
    await render();
    await act(async () => rowFor("explorer").querySelector("button")!.click());
    expect(rowFor("explorer").textContent).toContain("Worktree");
    expect(rowFor("explorer").textContent).toContain("agents/explorer-1");
  });

  it("names the directory of an agent that has none, instead of an empty branch row", async () => {
    fixture.state.agents.runs = { r1: run({ runId: "r1", sessionPath: CHILD, subagentName: "explorer", task: "Read the router", cwd: "/p" }) };
    await render();
    await act(async () => rowFor("explorer").querySelector("button")!.click());
    expect(rowFor("explorer").textContent).not.toContain("Worktree");
    expect(rowFor("explorer").textContent).toContain("Working in");
    expect(rowFor("explorer").textContent).toContain("Shares its parent’s checkout");
  });

  it("says nothing at all for a run recorded before runs carried a directory", async () => {
    fixture.state.agents.runs = { r1: child };
    await render();
    await act(async () => rowFor("explorer").querySelector("button")!.click());
    expect(rowFor("explorer").querySelector("dl")).not.toBeNull();
    expect(rowFor("explorer").textContent).not.toContain("Worktree");
    expect(rowFor("explorer").textContent).not.toContain("Working in");
  });

  it("navigates to a run's chat and asks the one End agent question", async () => {
    fixture.state.agents.runs = { r1: child };
    await render();
    await act(async () => rowFor("explorer").querySelector("button")!.click());
    const buttons = [...rowFor("explorer").querySelectorAll<HTMLButtonElement>("button")];
    await act(async () => buttons.find((b) => b.textContent?.includes("Open chat"))!.click());
    expect(fixture.actions.openSession).toHaveBeenCalledWith(CHILD);
    await act(async () => buttons.find((b) => b.textContent?.includes("End agent"))!.click());
    expect(fixture.endAgent).toHaveBeenCalledWith("r1");
  });

  it("does not promise a command a chat it has not got", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT }) };
    await render();
    // One row opens at a time, so each kind is asked its own question.
    const labels = async (name: string) => {
      await act(async () => rowFor(name).querySelector("button")!.click());
      return [...rowFor(name).querySelectorAll<HTMLButtonElement>("button")].map((b) => b.textContent ?? "");
    };
    // An agent has a chat of its own; a command only has the session whose
    // agent ran it, and the two must never converge on one label again.
    expect((await labels("explorer")).some((text) => text.includes("Open chat"))).toBe(true);
    expect((await labels("pnpm vite dev")).some((text) => text.includes("Open chat"))).toBe(false);
    const open = [...rowFor("pnpm vite dev").querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("Open its session"),
    )!;
    await act(async () => open.click());
    expect(fixture.actions.openSession).toHaveBeenCalledWith(ROOT);
  });

  it("draws no way in when the work's session is gone from the catalog", async () => {
    fixture.state.sessions = [summary({ path: CHILD })];
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT }) };
    await render();
    await act(async () => rowFor("pnpm vite dev").querySelector("button")!.click());
    const labels = [...rowFor("pnpm vite dev").querySelectorAll<HTMLButtonElement>("button")].map((b) => b.textContent ?? "");
    // A button that navigates nowhere is the defect this column inherited from
    // the panels (M13-T25). Stop still shows: it does not need the session.
    expect(labels.some((text) => text.includes("Open its session"))).toBe(false);
    expect(labels.some((text) => text.includes("Stop"))).toBe(true);
  });

  it("puts finished work away without touching what is still going", async () => {
    fixture.state.agents.runs = { r1: child };
    fixture.state.tasks.tasks = {
      t1: task({ id: "t1", sessionPath: ROOT }),
      t2: task({ id: "t2", sessionPath: ROOT, command: "pnpm build", title: "pnpm build", status: "completed", endedAt: "2026-09-08T10:05:00.000Z", exitCode: 0 }),
    };
    await render();
    const clear = () => [...container.querySelectorAll<HTMLButtonElement>('[data-slot="fleet-clear-finished"]')][0];
    expect(clear()).toBeTruthy();
    await act(async () => clear()!.click());
    // The finished command is out of sight; the running one and the agent are
    // untouched, and nothing was deleted — this is a per-viewer "I have read
    // these", not a destructive control.
    expect(container.textContent).not.toContain("pnpm build");
    expect(container.textContent).toContain("pnpm vite dev");
    expect(container.textContent).toContain("explorer");
    expect(clear()).toBeUndefined();
  });

  it("keeps work that ended after the clear, and work whose end it does not know", async () => {
    fixture.state.tasks.tasks = {
      old: task({ id: "old", sessionPath: ROOT, command: "pnpm build", title: "pnpm build", status: "completed", endedAt: "2026-09-08T10:00:00.000Z", exitCode: 0 }),
      // Ends after any mark Clear can write, so it is new work, not cleared work.
      fresh: task({ id: "fresh", sessionPath: ROOT, command: "pnpm lint", title: "pnpm lint", status: "completed", endedAt: "2099-01-01T00:00:00.000Z", exitCode: 0 }),
      // No end at all: not knowing when something finished is not a reason to hide it.
      unknown: task({ id: "unknown", sessionPath: ROOT, command: "pnpm docs", title: "pnpm docs", status: "completed", exitCode: 0 }),
    };
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="fleet-clear-finished"]')!.click());
    // Two survive the clear, and the fold has to be opened to read them.
    expect(container.querySelector('[data-slot="subagent-list"]')!.textContent).toContain("Finished2");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.startsWith("Finished"))!.click());
    expect(container.textContent).not.toContain("pnpm build");
    expect(container.textContent).toContain("pnpm lint");
    expect(container.textContent).toContain("pnpm docs");
  });

  it("offers no Clear when nothing has finished", async () => {
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT }) };
    await render();
    // A control that would do nothing is not drawn.
    expect(container.querySelector('[data-slot="fleet-clear-finished"]')).toBeNull();
  });

  it("stops a background command, and offers no Stop once it has ended", async () => {
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT }) };
    await render();
    await act(async () => rowFor("pnpm vite dev").querySelector("button")!.click());
    const stop = [...rowFor("pnpm vite dev").querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Stop"))!;
    await act(async () => stop.click());
    expect(fixture.actions.tasks.stop).toHaveBeenCalledWith(ROOT, "t1");
    // Its output arrives through the ranged read, never a panel ref.
    expect(fixture.actions.tasks.output).toHaveBeenCalledWith(ROOT, "t1", 0);
    expect(rowFor("pnpm vite dev").querySelector('[data-slot="task-output"]')?.textContent).toContain("ready in 412 ms");

  });

  it("folds finished work away, and offers no Stop once a command has ended", async () => {
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT, status: "completed", exitCode: 0, endedAt: "2026-09-08T10:01:00.000Z" }) };
    await render();
    expect(container.textContent).toContain("Nothing is in progress.");
    expect(rows()).toHaveLength(0);
    await act(async () => [...container.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.includes("Finished"))!.click());
    await act(async () => rowFor("pnpm vite dev").querySelector("button")!.click());
    expect([...rowFor("pnpm vite dev").querySelectorAll("button")].some((b) => b.textContent?.includes("Stop"))).toBe(false);
    expect(rowFor("pnpm vite dev").textContent).toContain("Exit code");
  });

  it("opens the row something else asked for, including one inside the finished fold", async () => {
    fixture.state.tasks.tasks = { t1: task({ id: "t1", sessionPath: ROOT, status: "completed", exitCode: 0, endedAt: "2026-09-08T10:01:00.000Z" }) };
    await render();
    await act(async () => revealInFleet("task:t1", { sheet: false }));
    await act(async () => {});
    expect(rowFor("pnpm vite dev").getAttribute("data-expanded")).toBe("true");
  });
});
