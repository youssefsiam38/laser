// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mapUi } from "../../../src/components/agents/map/map-state.js";
import { family, installBrowserShims, mountMap, resize, ROOT, seededStore, type Mounted } from "./harness.js";

let mounted: Mounted | undefined;
beforeEach(() => installBrowserShims());
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  mapUi.reset();
  vi.useRealTimers();
});

const body = (container: HTMLElement) => container.querySelector('[data-slot="agent-map-body"]');
const composition = (container: HTMLElement) => container.querySelector('[data-slot="agent-map"]')?.getAttribute("data-composition");

describe("composition by measured size", () => {
  it("lists in a constrained box, draws a concise canvas in a panel, and adds the inspector column when full", async () => {
    const { runs, sessions } = family();
    mounted = await mountMap({ store: seededStore({ runs, sessions }) });
    const { container } = mounted;
    // Nothing is drawn before the first measurement lands.
    expect(composition(container)).toBeNull();

    await resize(body(container), 400, 600);
    expect(composition(container)).toBe("constrained");
    expect(container.querySelector('[data-slot="agent-map-list"]')).not.toBeNull();
    expect(container.querySelector(".react-flow")).toBeNull();
    expect(container.querySelector('[data-slot="agent-map-open"]')?.textContent).toContain("Open map");
    // The list is the same tree: root, its live child, the grandchild under it, the ended one folded.
    expect([...container.querySelectorAll('[data-slot="agent-map-card"]')].map((c) => c.getAttribute("data-path"))).toEqual([ROOT, "/p/a.jsonl", "/p/c.jsonl"]);

    await resize(body(container), 700, 500);
    expect(composition(container)).toBe("panel");
    expect(container.querySelector(".react-flow")).not.toBeNull();
    expect(container.querySelector('[data-slot="agent-map-list"]')).toBeNull();
    expect(container.querySelector('[data-slot="agent-map-inspector-column"]')).toBeNull();
    expect(container.querySelector(".react-flow__minimap")).toBeNull();
    expect(container.querySelector('[data-slot="agent-map-legend"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="agent-map-controls"]')).not.toBeNull();
    expect(container.querySelector('[data-map-node]')?.getAttribute("data-drawing")).toBe("concise");

    await resize(body(container), 1280, 720);
    expect(composition(container)).toBe("full");
    expect(container.querySelector('[data-slot="agent-map-inspector-column"]')).not.toBeNull();
    expect(container.querySelector('[data-map-node]')?.getAttribute("data-drawing")).toBe("rich");
    expect(container.querySelector('[data-slot="agent-map-edge-label"]')?.textContent).toBe("started");

    // Too short for a canvas: a list again, whatever the width.
    await resize(body(container), 1280, 300);
    expect(composition(container)).toBe("constrained");
  });

  it("selects and inspects in place in the list, and opens the chat from a card", async () => {
    const { runs, sessions } = family();
    mounted = await mountMap({ store: seededStore({ runs, sessions }), size: { width: 400, height: 600 } });
    const { container, host } = mounted;
    const card = container.querySelector<HTMLElement>('[data-slot="agent-map-card"][data-path="/p/a.jsonl"]')!;
    const select = card.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(select.getAttribute("aria-label")).toBe("reviewer, reviewer-1, Working, 5 minutes");
    await act(async () => select.click());
    expect(card.getAttribute("data-selected")).toBe("true");
    expect(card.querySelector('[data-slot="agent-map-inspector"]')?.getAttribute("data-path")).toBe("/p/a.jsonl");
    expect(card.querySelector('[data-slot="agent-map-inspector"]')?.textContent).toContain("Review the auth diff");
    await act(async () => select.click());
    expect(card.querySelector('[data-slot="agent-map-inspector"]')).toBeNull();
    await act(async () => card.querySelector<HTMLButtonElement>('[data-slot="agent-map-chat"]')!.click());
    expect(host.openChat).toHaveBeenCalledWith("/p/a.jsonl");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="agent-map-open"]')!.click());
    expect(host.openFullscreen).toHaveBeenCalled();
  });

  it("inspects where an agent works: its branch, or the checkout it shares with its parent", async () => {
    const { runs, sessions } = family();
    const isolated = { ...runs[0]!, worktree: { path: "/p/.worktrees/reviewer-1", branch: "agents/reviewer-1", baseCommit: "abc" }, cwd: "/p/.worktrees/reviewer-1" };
    const shared = { ...runs[2]!, worktree: null, cwd: "/p" };
    mounted = await mountMap({ store: seededStore({ runs: [isolated, runs[1]!, shared], sessions }), size: { width: 400, height: 600 } });
    const { container } = mounted;
    const inspect = async (path: string): Promise<HTMLElement> => {
      const card = container.querySelector<HTMLElement>(`[data-slot="agent-map-card"][data-path="${path}"]`)!;
      await act(async () => card.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
      return card.querySelector<HTMLElement>('[data-slot="agent-map-inspector"]')!;
    };
    const withWorktree = await inspect("/p/a.jsonl");
    expect(withWorktree.textContent).toContain("Worktree");
    expect(withWorktree.textContent).toContain("agents/reviewer-1");
    expect(withWorktree.textContent).not.toContain("Working in");

    const withoutWorktree = await inspect("/p/c.jsonl");
    expect(withoutWorktree.textContent).toContain("Working in");
    expect(withoutWorktree.textContent).toContain("Shares its parent’s checkout");
    expect(withoutWorktree.textContent).not.toContain("Worktree");
  });

  it("keeps the canvas on a narrow fullscreen, with touch-sized controls and a sheet for details", async () => {
    const { runs, sessions } = family();
    mounted = await mountMap({ store: seededStore({ runs, sessions }), host: { frame: "fullscreen" }, size: { width: 390, height: 780 } });
    const { container } = mounted;
    expect(composition(container)).toBe("panel");
    expect(container.querySelector(".react-flow")).not.toBeNull();
    expect(container.querySelector('[data-slot="agent-map-controls"] button')?.className).toContain("size-11");
    expect(container.querySelector('[data-slot="agent-map-open"]')).toBeNull();
    await act(async () => container.querySelector<HTMLElement>('.react-flow__node[data-id="/p/a.jsonl"]')!.click());
    expect(document.querySelector('[data-slot="agent-map-inspector-sheet"] [data-slot="agent-map-inspector"]')?.getAttribute("data-path")).toBe("/p/a.jsonl");
    expect(container.querySelector('[data-slot="agent-map-inspector-card"]')).toBeNull();
  });
});
