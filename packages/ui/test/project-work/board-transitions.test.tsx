// @vitest-environment happy-dom
/**
 * The Tasks board's transitions (M21-T16, D-355 "Structure" → Board).
 *
 * Every column is a Task state, a move performs a **real transition**, an
 * illegal one is refused with the missing keys named before anything is sent,
 * and `done` is the host's rule: a completion with no acceptance evidence
 * comes back refused and that sentence is what a person reads.
 *
 * The drop *gesture* is not simulated: dnd-kit measures real layout rectangles
 * and happy-dom has none, so what a pointer drag resolves to is proven as the
 * pure mapping the drag handler calls (`dropFor`), and the request it then
 * makes is proven through the board's own per-card menu — the same `move`,
 * and the path a keyboard and a coarse pointer take. Naming that proxy rather
 * than dressing it up is the point (AGENTS.md, D-342).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Board } from "../../src/components/project-work/Board.js";
import { dropFor } from "../../src/project-work/board.js";
import { ProjectWorkStore, type ProjectWorkMethod } from "../../src/project-work/store.js";
import { BOARD_COLUMNS, boardColumnLabel } from "../../src/project-work/vocabulary.js";
import { resetWorkspaceUi } from "../../src/project-work/workspace-state.js";

import { countsOf, item } from "./fixture.js";

let breakpoint: "mobile" | "tablet" | "desktop" = "desktop";

vi.mock("../../src/runtime", async (original) => {
  const actual = await original<typeof import("../../src/runtime/index.js")>();
  return { ...actual, useLaserStable: () => ({ actions: { toast: () => {} } }), useCapability: () => ({ state: "available" }) };
});

vi.mock("../../src/hooks", async (original) => {
  const actual = await original<typeof import("../../src/hooks/index.js")>();
  return { ...actual, useBreakpoint: () => breakpoint };
});

let root: Root;
let container: HTMLDivElement;
let calls: Array<{ method: ProjectWorkMethod; params: Record<string, unknown> }>;
let refusal: Error | undefined;
let result: unknown;

const tasks = [
  item({ entityId: "t1", kind: "task", number: 1, title: "The store", state: "done" }),
  item({ entityId: "t2", kind: "task", number: 2, title: "The shell", state: "ready" }),
  item({ entityId: "t3", kind: "task", number: 3, title: "The board", state: "draft", unmetDependencies: ["TASK-1", "TASK-2"] }),
  item({ entityId: "t4", kind: "task", number: 4, title: "The detail", state: "needs_review" }),
];

const snapshot = () => ({
  projectId: "p1",
  phase: "ready" as const,
  error: undefined,
  seq: 7,
  eventSeq: 7,
  items: tasks,
  counts: countsOf(tasks),
  attention: { needsYou: 0, seq: 7 },
  recent: [],
  behind: false,
  loading: false,
  resets: 0,
  more: false,
});

const settle = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const makeStore = (): ProjectWorkStore =>
  new ProjectWorkStore({
    projectId: "p1",
    request: (async (method: ProjectWorkMethod, params: unknown) => {
      calls.push({ method, params: params as Record<string, unknown> });
      if (method === "project/task/action" && refusal) throw refusal;
      if (method === "project/work/list") return { projectId: "p1", seq: 7, items: tasks, counts: countsOf(tasks) };
      return result ?? {};
    }) as never,
  });

const text = (): string => document.body.textContent ?? "";
const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll("button")];
const byLabel = (label: string): HTMLButtonElement | undefined => buttons().find((node) => node.getAttribute("aria-label") === label);
const menuItem = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((node) => (node.textContent ?? "").trim() === label);

/** Radix opens on pointerdown, not click; a plain `.click()` never gets there. */
const openMenu = async (label: string): Promise<void> => {
  await act(async () => {
    byLabel(label)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await settle(10);
  });
};
const click = async (element: Element | null | undefined): Promise<void> => {
  expect(element).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
    await settle(5);
  });
};

const mount = async (store: ProjectWorkStore): Promise<void> => {
  await act(async () => root.render(<Board store={store} work={snapshot()} />));
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  breakpoint = "desktop";
  calls = [];
  refusal = undefined;
  result = undefined;
  resetWorkspaceUi();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll("[role='menu']").forEach((node) => node.remove());
  resetWorkspaceUi();
});

describe("what a drop resolves to", () => {
  it("is the dragged task and the state of the column it landed on", () => {
    expect(dropFor(tasks, "t2", "in_progress")).toMatchObject({ to: "in_progress", row: { key: "TASK-2" } });
  });

  it("is nothing when the card came home, or landed on nothing", () => {
    expect(dropFor(tasks, "t2", "ready")).toBeUndefined();
    expect(dropFor(tasks, "t2", undefined)).toBeUndefined();
    expect(dropFor(tasks, "nope", "ready")).toBeUndefined();
  });
});

describe("the board", () => {
  it("gives every task state a column of its own", async () => {
    await mount(makeStore());
    const columns = [...container.querySelectorAll("section[aria-label]")].map((node) => node.getAttribute("aria-label"));
    expect(columns).toEqual(BOARD_COLUMNS.map(boardColumnLabel));
  });

  it("performs the transition the move asks for", async () => {
    result = { entity: {}, transition: { from: "ready", to: "in_progress" }, seq: 8 };
    await mount(makeStore());
    await openMenu("Move TASK-2");
    await click(menuItem("Running"));
    const action = calls.find((call) => call.method === "project/task/action");
    expect(action?.params).toMatchObject({ projectId: "p1", entityId: "t2", expectedRevisionId: "t2r1", action: "start" });
  });

  it("refuses an illegal move by naming the keys, and sends nothing", async () => {
    await mount(makeStore());
    await openMenu("Move TASK-3");
    await click(menuItem("Ready"));
    expect(text()).toContain("TASK-1, TASK-2 must be done first.");
    expect(calls.filter((call) => call.method === "project/task/action")).toHaveLength(0);
  });

  it("renders the host's refusal when only the host can know — `done` needs acceptance evidence", async () => {
    refusal = new Error("TASK-4 has no passing acceptance evidence. A finished attempt is evidence, not a completed task.");
    await mount(makeStore());
    await openMenu("Move TASK-4");
    await click(menuItem("Done"));
    // The client sends it on purpose: a list row cannot see evidence, and
    // refusing a completion it cannot check would be inventing a fact.
    expect(calls.filter((call) => call.method === "project/task/action")).toHaveLength(1);
    expect(text()).toContain("A finished attempt is evidence, not a completed task.");
    expect(text()).toContain("Nothing moved.");
  });

  it("asks why before it cancels, because the engine keeps the reason", async () => {
    result = { entity: {}, transition: { from: "ready", to: "cancelled" }, seq: 8 };
    await mount(makeStore());
    await openMenu("Move TASK-2");
    await click(menuItem("Cancelled"));
    // Nothing is sent until there is a reason to send with it.
    expect(calls.filter((call) => call.method === "project/task/action")).toHaveLength(0);
    expect(text()).toContain("Why is TASK-2 cancelled?");
    const field = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
    const stop = [...document.body.querySelectorAll("button")].find((node) => node.textContent === "Cancel this task")!;
    expect(stop.disabled).toBe(true);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(field, "Superseded by TASK-9");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(5);
    });
    await click([...document.body.querySelectorAll("button")].find((node) => node.textContent === "Cancel this task"));
    const action = calls.find((call) => call.method === "project/task/action");
    expect(action?.params).toMatchObject({ action: "cancel", note: "Superseded by TASK-9" });
  });

  it("keeps every transition reachable without a drag, on every card", async () => {
    await mount(makeStore());
    expect(byLabel("Move TASK-1")).toBeTruthy();
    expect(byLabel("Drag TASK-1")).toBeTruthy();
    expect(byLabel("Move TASK-4")).toBeTruthy();
  });

  it("becomes the compact list on a phone, with the same moves in reach", async () => {
    breakpoint = "mobile";
    await mount(makeStore());
    expect(container.querySelectorAll("[data-slot='todo-list']").length).toBe(BOARD_COLUMNS.length);
    expect(container.querySelector("[data-slot='board-card']")).toBeNull();
    expect(byLabel("Move TASK-2")).toBeTruthy();
    // The columns scroll sideways; the page does not.
    expect(container.querySelector(".overflow-x-auto")).not.toBeNull();
  });
});
