// @vitest-environment happy-dom
/**
 * The embedded workspace, inside the real shell, over the in-memory host.
 *
 * What is asserted is what D-355 promises a person: one control in the top
 * bar with live counts, a workspace that takes the main area **without
 * unmounting the conversation**, keys and type badges on every row, a queue
 * with a count, and a return that is a return.
 *
 * (AGENTS.md, D-342: this is a unit test over the real components. Nothing
 * here is a browser acceptance run, and none of it claims to be.)
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../world/fake-host.js")).FakeHostClient,
}));

import { LaserProvider } from "../../src/runtime/LaserProvider.js";
import { COLUMNS_STORAGE_KEY, Shell } from "../../src/components/shell/Shell.js";
import { resetProjectWork } from "../../src/project-work/registry.js";
import { resetWorkspaceUi, workspaceUi } from "../../src/project-work/workspace-state.js";
import { addSession, createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "../world/fake-host.js";
import { seedProject } from "../runtime/environment-fixture.js";

import { item } from "./fixture.js";

let root: Root;
let container: HTMLDivElement;
let world: World;

const query = <T extends Element = HTMLElement>(selector: string): T | null =>
  container.querySelector<T>(selector) ?? document.body.querySelector<T>(selector);
/** The container is inside the body, so the body covers portals and rows alike. */
const all = (selector: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(selector)];

const click = async (element: Element | null): Promise<void> => {
  expect(element).not.toBeNull();
  await act(async () => {
    (element as HTMLElement).click();
    await settle(20);
  });
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  globalThis.history.replaceState(null, "", "/");
  resetProjectWork();
  resetWorkspaceUi();
  world = createWorld();
  addSession(world, `${PROJECT_CWD}/code.jsonl`, PROJECT_CWD, { firstMessage: "yesterday's work" });
  world.projectWork = {
    pw_1: {
      seq: 7,
      paths: [PROJECT_CWD],
      items: [
        item({ entityId: "e1", kind: "spec", number: 1, title: "The relay", state: "needs_review", needsAttention: true, updatedAt: "2026-02-02T00:00:00.000Z" }),
        item({ entityId: "e2", kind: "task", number: 44, title: "Wire the board", updatedAt: "2026-02-01T00:00:00.000Z" }),
        item({ entityId: "e3", kind: "plan", number: 2, title: "Ship it", updatedAt: "2026-01-30T00:00:00.000Z" }),
      ],
      entities: {},
    },
  };
  FakeHostClient.reset(world);
  seedProject(PROJECT_CWD);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll('[role="dialog"]').forEach((node) => node.remove());
  resetProjectWork();
  resetWorkspaceUi();
});

async function mount(): Promise<void> {
  await act(async () => root.render(<LaserProvider url="ws://test"><Shell /></LaserProvider>));
  await act(async () => settle(80));
}

describe("the project work control", () => {
  it("reads the project through its directory and says what is in it", async () => {
    await mount();
    const toggle = query('[data-slot="project-work-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-label")).toBe("Project work — 3 items · 1 needs you");
    // One read per project, by folder, and the id is what everything else uses.
    expect(world.calls.filter((call) => call.method === "project/work/list").every((call) => (call.params as { cwd?: string; projectId?: string }).cwd === PROJECT_CWD || (call.params as { projectId?: string }).projectId === "pw_1")).toBe(true);
  });

  it("opens the workspace in the main area and keeps the conversation mounted", async () => {
    await mount();
    expect(query('[data-slot="thread"]')).not.toBeNull();

    await click(query('[data-slot="project-work-toggle"]'));

    // The workspace is on screen…
    expect(query('[data-slot="project-workspace"]')).not.toBeNull();
    // …and the conversation is still *mounted* underneath it, which is the
    // whole promise: its scroll, draft, stream and approvals are live state.
    const thread = query('[data-slot="thread"]');
    expect(thread).not.toBeNull();
    expect(thread?.closest("[hidden],[inert]")).not.toBeNull();
    expect(workspaceUi().open).toBe(true);

    // Back is a return, not a reload: the same element is still there.
    const back = all("button").find((button) => button.textContent?.includes("Back to the conversation"));
    await click(back ?? null);
    expect(query('[data-slot="project-workspace"]')).toBeNull();
    expect(query('[data-slot="thread"]')).toBe(thread);
  });

  it("shows every row with its key and its type badge, and the queue's count", async () => {
    await mount();
    await click(query('[data-slot="project-work-toggle"]'));

    const keys = all('[data-slot="work-key"]').map((node) => node.textContent);
    expect(keys).toEqual(expect.arrayContaining(["SPEC-1", "TASK-44", "PLAN-2"]));
    const badges = all('[data-slot="work-type-badge"]').map((node) => node.dataset.kind);
    expect(badges).toEqual(expect.arrayContaining(["spec", "task", "plan"]));

    const needsYou = all('[role="tab"]').find((tab) => tab.textContent?.startsWith("Needs you"));
    expect(needsYou?.textContent).toContain("1");
  });

  it("borrows the fleet and monitor room while it is open, and gives it back", async () => {
    await mount();
    const saved = localStorage.getItem(COLUMNS_STORAGE_KEY);
    expect(all('[data-slot="fleet-toggle"]')).toHaveLength(1);

    await click(query('[data-slot="project-work-toggle"]'));
    // Their room is borrowed, so neither toggle is offered — and nothing the
    // person saved about the layout was written.
    expect(all('[data-slot="fleet-toggle"]')).toHaveLength(0);
    expect(localStorage.getItem(COLUMNS_STORAGE_KEY)).toBe(saved);

    const back = all("button").find((button) => button.textContent?.includes("Back to the conversation"));
    await click(back ?? null);
    expect(all('[data-slot="fleet-toggle"]')).toHaveLength(1);
    expect(localStorage.getItem(COLUMNS_STORAGE_KEY)).toBe(saved);
  });
});
