// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentMapFullscreen } from "../../../src/components/agents/map/AgentMapFullscreen.js";
import { EVENT_TTL_MS } from "../../../src/components/agents/map/EventBubbles.js";
import { mapUi } from "../../../src/components/agents/map/map-state.js";
import { event, run, summary } from "../fixtures.js";
import { dispatch, family, installBrowserShims, mountMap, resize, ROOT, seededStore, StoreMap, type Mounted } from "./harness.js";

// The connected hosts read the runtime; the store hooks underneath stay real.
const stable = vi.hoisted(() => ({
  actions: { openSession: vi.fn(async () => {}), agents: { runs: vi.fn(async () => {}), stopRun: vi.fn(async () => ({})) } },
}));
vi.mock("@/runtime", async () => ({
  ...(await import("../../../src/runtime/LaserProvider.js")),
  useLaserStable: () => stable,
  useLaserView: () => ({ path: ROOT, state: { cwd: "/p" } }),
}));

const PANEL = { width: 720, height: 520 };
const nodes = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>(".react-flow__node")];
const nodeAt = (container: HTMLElement, path: string) => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${path}"]`);

let mounted: Mounted | undefined;
beforeEach(() => installBrowserShims());
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  mapUi.reset();
  vi.useRealTimers();
});

describe("the live map", () => {
  it("draws the root alone, centred, with a designed empty state", async () => {
    mounted = await mountMap({ size: PANEL });
    const { container } = mounted;
    expect(container.querySelector('[data-slot="agent-map"]')?.getAttribute("data-composition")).toBe("panel");
    expect(nodes(container)).toHaveLength(1);
    expect(nodeAt(container, ROOT)?.getAttribute("aria-label")).toContain("Ship the feature");
    expect(container.querySelector('[data-slot="agent-map-empty"]')?.textContent).toContain("Agents this session starts will appear here");
    expect(container.querySelector('[data-slot="agent-map-summary"]')?.textContent).toContain("No agents yet");
    // Nothing to fold: the toggle stays quiet.
    expect(container.querySelector<HTMLButtonElement>('[data-slot="agent-map-show-ended"]')?.disabled).toBe(true);
  });

  it("draws a node per live agent, ancestry edges between them, and the status vocabulary on each", async () => {
    const { runs, sessions } = family();
    mounted = await mountMap({ store: seededStore({ runs, sessions }), size: PANEL });
    const { container } = mounted;
    expect(nodes(container).map((n) => n.getAttribute("data-id"))).toEqual([ROOT, "/p/a.jsonl", "/p/c.jsonl"]);
    expect([...container.querySelectorAll(".react-flow__edge")].map((e) => e.getAttribute("data-id"))).toEqual([`${ROOT}>/p/a.jsonl`, "/p/a.jsonl>/p/c.jsonl"]);
    const a = nodeAt(container, "/p/a.jsonl")!;
    expect(a.getAttribute("aria-label")).toBe("reviewer, reviewer-1, Working, 5 minutes");
    expect(a.querySelector('[data-slot="agent-map-status"]')?.textContent).toContain("Working");
    expect(a.querySelector('[data-slot="status-dot"]')?.getAttribute("data-status")).toBe("working");
    expect(a.querySelector('[data-slot="agent-map-elapsed"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="agent-map-summary"]')?.textContent).toContain("3 agents · 2 working");
    expect(container.querySelector('[data-slot="agent-map-empty"]')).toBeNull();
  });

  it("folds ended agents behind a counted toggle and reveals them on demand", async () => {
    const { runs, sessions } = family();
    mounted = await mountMap({ store: seededStore({ runs, sessions }), size: PANEL });
    const { container } = mounted;
    const toggle = container.querySelector<HTMLButtonElement>('[data-slot="agent-map-show-ended"]')!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('[data-slot="agent-map-ended-count"]')?.textContent).toBe("1 ended");
    expect(nodeAt(container, "/p/b.jsonl")).toBeNull();
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(nodeAt(container, "/p/b.jsonl")).not.toBeNull();
    expect(nodeAt(container, "/p/b.jsonl")?.querySelector('[data-slot="agent-map-status"]')?.textContent).toContain("Done");
    // A finished agent is muted on the map too, never green (D-154).
    expect(nodeAt(container, "/p/b.jsonl")?.querySelector('[data-slot="status-dot"]')?.getAttribute("data-tone")).toBe("muted");
    await act(async () => toggle.click());
    expect(nodeAt(container, "/p/b.jsonl")).toBeNull();
    expect(mapUi.get().roots[ROOT]?.showEnded).toBe(false);
  });

  it("opens the session's chat from a node and from the inspector", async () => {
    const { runs, sessions } = family();
    mounted = await mountMap({ store: seededStore({ runs, sessions }), size: PANEL });
    const { container, host } = mounted;
    const chat = nodeAt(container, "/p/a.jsonl")!.querySelector<HTMLButtonElement>('[data-slot="agent-map-chat"]')!;
    await act(async () => chat.click());
    expect(host.openChat).toHaveBeenCalledWith("/p/a.jsonl");
    // Selecting a node reveals its details; the card carries the same way in.
    await act(async () => nodeAt(container, "/p/c.jsonl")!.click());
    expect(mapUi.get().roots[ROOT]?.selected).toBe("/p/c.jsonl");
    const card = container.querySelector('[data-slot="agent-map-inspector-card"]')!;
    expect(card.querySelector('[data-slot="agent-map-inspector"]')?.getAttribute("data-path")).toBe("/p/c.jsonl");
    expect(card.querySelector('[data-slot="agent-map-inspector-timeline"]')?.textContent).toContain("Started");
    await act(async () => card.querySelector<HTMLButtonElement>('[data-slot="agent-map-chat"]')!.click());
    expect(host.openChat).toHaveBeenLastCalledWith("/p/c.jsonl");
    await act(async () => card.querySelector<HTMLButtonElement>('[data-slot="agent-map-end"]')!.click());
    expect(host.requestEndAgent).toHaveBeenCalledWith("r-c");
  });

  it("shows a fresh event as a bubble inside its node, then lets it go after the ttl", async () => {
    // The clock and the timers both fake here: the bubble's life is a timer.
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T10:05:00.000Z"));
    installBrowserShims({ clock: false });
    const { runs, sessions } = family();
    mounted = await mountMap({ store: seededStore({ runs, sessions }), size: PANEL });
    const { container, store } = mounted;
    const a = nodeAt(container, "/p/a.jsonl")!;
    expect(a.querySelector('[data-slot="agent-map-bubble"]')).toBeNull();
    await dispatch(store, {
      type: "notification",
      method: "agents/event",
      params: event({ id: "e1", kind: "message_received", sessionPath: "/p/a.jsonl", at: "2026-09-08T10:05:00.000Z", summary: "Heard from reader-1", counterpart: { sessionPath: "/p/c.jsonl", label: "reader-1" } }),
    });
    const bubble = a.querySelector('[data-slot="agent-map-bubble"]')!;
    expect(bubble.textContent).toContain("Heard from reader-1");
    expect(bubble.getAttribute("data-kind")).toBe("message_received");
    // The status line yields to the bubble and comes back after it.
    expect(a.querySelector('[data-slot="agent-map-status"]')).toBeNull();
    // A message between a and c lights their edge while it is young.
    expect(container.querySelector('.react-flow__edge[data-id="/p/a.jsonl>/p/c.jsonl"] .agent-map-edge-active')).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EVENT_TTL_MS + 100);
    });
    expect(a.querySelector('[data-slot="agent-map-bubble"]')).toBeNull();
    expect(a.querySelector('[data-slot="agent-map-status"]')?.textContent).toContain("Working");
    expect(container.querySelector(".agent-map-edge-active")).toBeNull();
  });

  it("keeps every node where it was when only a status changes, and moves the layout when a node arrives", async () => {
    // The arrival marker lives for one morph plus a settle, and the assertions
    // below sit inside that window: with a real clock a loaded machine can
    // spend longer than the window between two `await`s. Fake timers make the
    // window the test's to spend, not the machine's.
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T10:05:00.000Z"));
    installBrowserShims({ clock: false });
    const { runs, sessions } = family();
    mounted = await mountMap({ store: seededStore({ runs, sessions }), size: PANEL });
    // The spawn plays over one morph; give the token a length so the window is observable.
    document.documentElement.style.setProperty("--motion-morph", "40ms");
    const { container, store } = mounted;
    const before = Object.fromEntries(nodes(container).map((n) => [n.getAttribute("data-id"), n.style.transform]));
    await dispatch(store, { type: "notification", method: "agents/run", params: { run: run({ runId: "r-a", sessionPath: "/p/a.jsonl", subagentName: "reviewer-1", status: "blocked", updatedAt: "2026-09-08T10:09:00.000Z", startedAt: "2026-09-08T10:00:00.000Z" }) } });
    expect(nodeAt(container, "/p/a.jsonl")?.querySelector('[data-slot="agent-map-status"]')?.textContent).toContain("Needs you");
    for (const n of nodes(container)) expect(n.style.transform).toBe(before[n.getAttribute("data-id")!]);
    await dispatch(store, { type: "notification", method: "agents/run", params: { run: run({ runId: "r-d", sessionPath: "/p/d.jsonl", subagentName: "docs-1", startedAt: "2026-09-08T10:03:00.000Z" }) } });
    expect(nodes(container).map((n) => n.getAttribute("data-id"))).toEqual([ROOT, "/p/a.jsonl", "/p/c.jsonl", "/p/d.jsonl"]);
    // The newcomer arrives from its parent's position, then settles.
    const fresh = nodeAt(container, "/p/d.jsonl")!.querySelector<HTMLElement>("[data-map-node]")!;
    expect(fresh.hasAttribute("data-fresh")).toBe(true);
    expect(fresh.style.getPropertyValue("--map-from-y")).toBe("-120px");
    // The root re-centres over two children; the first child keeps its column.
    expect(nodeAt(container, ROOT)?.style.transform).not.toBe(before[ROOT]);
    expect(nodeAt(container, "/p/a.jsonl")?.style.transform).toBe(before["/p/a.jsonl"]);
    // Past the window: the node settles where the layout put it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fresh.hasAttribute("data-fresh")).toBe(false);
  });

  it("opens fullscreen, closes it with Escape, and keeps the selection across the switch", async () => {
    const { runs, sessions } = family();
    const store = seededStore({ runs, sessions: [...sessions, summary({ path: "/p/c.jsonl", agent: { agentName: "reader", kind: "child", subagentName: "reader-1", parentPath: "/p/a.jsonl", rootPath: ROOT } })] });
    mounted = await mountMap({
      store,
      size: PANEL,
      children: (
        <>
          <StoreMap />
          <AgentMapFullscreen />
        </>
      ),
    });
    const { container, host } = mounted;
    await act(async () => nodeAt(container, "/p/a.jsonl")!.click());
    expect(mapUi.get().roots[ROOT]?.selected).toBe("/p/a.jsonl");
    expect(container.querySelector('[data-slot="agent-map-fullscreen"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="agent-map-open"]')!.click());
    expect(host.openFullscreen).toHaveBeenCalled();
    await act(async () => mapUi.setFullscreen(true));
    const full = container.querySelector<HTMLElement>('[data-slot="agent-map-fullscreen"]')!;
    expect(full).not.toBeNull();
    await resize(full.querySelector('[data-slot="agent-map-body"]'), 1280, 800);
    expect(full.querySelector('[data-slot="agent-map"]')?.getAttribute("data-composition")).toBe("full");
    // The selection came along: the node is selected and the inspector column shows it.
    expect(full.querySelector('.react-flow__node[data-id="/p/a.jsonl"]')?.classList.contains("selected")).toBe(true);
    expect(full.querySelector('[data-slot="agent-map-inspector-column"] [data-slot="agent-map-inspector"]')?.getAttribute("data-path")).toBe("/p/a.jsonl");
    // Escape from the focused node itself: React Flow would unselect it, the
    // fullscreen host takes the key first and the selection comes back with it.
    const focusedNode = full.querySelector<HTMLElement>('.react-flow__node[data-id="/p/a.jsonl"]')!;
    await act(async () => focusedNode.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[data-slot="agent-map-fullscreen"]')).toBeNull();
    expect(mapUi.get().fullscreen).toBe(false);
    expect(mapUi.get().roots[ROOT]?.selected).toBe("/p/a.jsonl");
    expect(nodeAt(container, "/p/a.jsonl")?.classList.contains("selected")).toBe(true);
  });
});
