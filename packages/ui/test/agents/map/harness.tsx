/**
 * What every map test needs: the polyfills a canvas library expects from a
 * browser (`ResizeObserver`, element dimensions), a seeded store, and a mount
 * that puts the map inside the providers the app puts it in.
 */
import type { AgentRun } from "@lasercode/protocol";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

import { useAgentTree } from "../../../src/agents/index.js";
import { AgentMap, type AgentMapProps } from "../../../src/components/agents/map/AgentMap.js";
import { MapHostProvider, type MapHost } from "../../../src/components/agents/map/map-context.js";
import { mapUi } from "../../../src/components/agents/map/map-state.js";
import { TooltipProvider } from "../../../src/components/ui/tooltip.js";
import { LaserStoreProvider, createStateStore, type StateStore } from "../../../src/runtime/LaserProvider.js";
import { initialState, reduce, type AppState } from "../../../src/store.js";
import { run, snapshot, summary } from "../fixtures.js";

export const ROOT = "/p/root.jsonl";

/** A ResizeObserver a test drives by hand: `resize(element, width, height)`. */
export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
  }
}

export function installBrowserShims(options: { clock?: boolean } = {}): void {
  FakeResizeObserver.instances = [];
  // Elapsed times and bubbles read the clock; the fixtures are stamped 10:00.
  if (options.clock !== false) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-08T10:05:00.000Z"));
  }
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  // Motion is a token; a test runs it at the reduced-motion value so every fit
  // lands at once instead of tweening through a canvas with no real extent.
  for (const token of ["--motion-instant", "--motion-fast", "--motion-slow", "--motion-morph"]) document.documentElement.style.setProperty(token, "0ms");
  // React Flow measures a node — and its own wrapper — through `offsetWidth`
  // / `offsetHeight`; happy-dom answers 0. The map sets each node's box in its
  // style, so read it back; the wrapper gets a desk-sized box so a fit lands
  // at a legible zoom rather than the floor.
  const px = (el: HTMLElement, prop: "width" | "height"): number => {
    const raw = el.style[prop];
    const own = raw.endsWith("px") ? Number.parseFloat(raw) : Number.NaN;
    if (Number.isFinite(own) && own > 0) return own;
    if (el.classList.contains("react-flow") || el.classList.contains("react-flow__renderer")) return prop === "width" ? 1000 : 700;
    return prop === "width" ? 200 : 60;
  };
  for (const name of ["offsetWidth", "clientWidth"] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get() { return px(this as HTMLElement, "width"); } });
  }
  for (const name of ["offsetHeight", "clientHeight"] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get() { return px(this as HTMLElement, "height"); } });
  }
  if (typeof globalThis.requestAnimationFrame !== "function") {
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
    globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
  }
}

const entryFor = (target: Element, width: number, height: number): ResizeObserverEntry => {
  const rect = { width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, toJSON: () => ({}) } as DOMRectReadOnly;
  return { target, contentRect: rect, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] } as unknown as ResizeObserverEntry;
};

/**
 * React Flow measures a node when its observer fires; a browser fires it on
 * mount, so the harness does the same for every observed node element.
 */
export async function measureNodes(): Promise<void> {
  await act(async () => {
    for (const observer of FakeResizeObserver.instances) {
      const entries = [...observer.targets]
        .filter((t) => t.classList.contains("react-flow__node"))
        .map((t) => entryFor(t, (t as HTMLElement).offsetWidth, (t as HTMLElement).offsetHeight));
      if (entries.length > 0) observer.callback(entries, observer as unknown as ResizeObserver);
    }
  });
}

/** Fire every observer watching `element` with a size, then let the canvas measure its nodes. */
export async function resize(element: Element | null, width: number, height: number): Promise<void> {
  await act(async () => {
    for (const observer of FakeResizeObserver.instances) {
      if (!element || !observer.targets.has(element)) continue;
      observer.callback([entryFor(element, width, height)], observer as unknown as ResizeObserver);
    }
  });
  await measureNodes();
}

/** A root with two live children and one ended child; the first child has a grandchild. */
export function family(): { runs: AgentRun[]; sessions: ReturnType<typeof summary>[] } {
  const runs = [
    run({ runId: "r-a", sessionPath: "/p/a.jsonl", subagentName: "reviewer-1", startedAt: "2026-09-08T10:00:00.000Z", task: "Review the auth diff", model: { provider: "stub", id: "stub-1" } }),
    run({
      runId: "r-b",
      sessionPath: "/p/b.jsonl",
      agentName: "tester",
      subagentName: "tester-1",
      startedAt: "2026-09-08T10:01:00.000Z",
      status: "completed",
      endedAt: "2026-09-08T10:20:00.000Z",
      result: { status: "completed", message: "All green." },
    }),
    run({
      runId: "r-c",
      sessionPath: "/p/c.jsonl",
      agentName: "reader",
      subagentName: "reader-1",
      depth: 2,
      parent: { sessionPath: "/p/a.jsonl", sessionId: "/p/a.jsonl", runId: "r-a" },
      startedAt: "2026-09-08T10:02:00.000Z",
    }),
  ];
  const sessions = [
    summary({ path: ROOT, name: "Ship the feature", attention: "working" }),
    summary({ path: "/p/a.jsonl", agent: { agentName: "reviewer", kind: "child", subagentName: "reviewer-1", parentPath: ROOT, rootPath: ROOT } }),
    summary({ path: "/p/b.jsonl", agent: { agentName: "tester", kind: "child", subagentName: "tester-1", parentPath: ROOT, rootPath: ROOT } }),
  ];
  return { runs, sessions };
}

export function seededStore(options: { runs?: AgentRun[]; sessions?: ReturnType<typeof summary>[] } = {}): StateStore {
  let state: AppState = reduce(initialState, { type: "agents/loaded", snapshot: snapshot() });
  state = { ...state, sessions: options.sessions ?? [summary({ path: ROOT, name: "Ship the feature", attention: "working" })] };
  if (options.runs) state = reduce(state, { type: "agents/runs/loaded", runs: options.runs });
  return createStateStore(state);
}

export function makeHost(over: Partial<MapHost> = {}): MapHost & { openChat: ReturnType<typeof vi.fn>; openFullscreen: ReturnType<typeof vi.fn>; closeFullscreen: ReturnType<typeof vi.fn> } {
  return {
    frame: "column",
    openChat: vi.fn(),
    openFullscreen: vi.fn(),
    closeFullscreen: vi.fn(),
    requestEndAgent: vi.fn(),
    ...over,
  } as MapHost & { openChat: ReturnType<typeof vi.fn>; openFullscreen: ReturnType<typeof vi.fn>; closeFullscreen: ReturnType<typeof vi.fn> };
}

/** The map, fed from the store the way the connected view feeds it. */
export function StoreMap(props: Omit<AgentMapProps, "tree" | "rootPath"> & { rootPath?: string }) {
  const rootPath = props.rootPath ?? ROOT;
  const tree = useAgentTree(rootPath);
  if (!tree) return null;
  return <AgentMap {...props} rootPath={rootPath} tree={tree} />;
}

export interface Mounted {
  container: HTMLDivElement;
  root: Root;
  store: StateStore;
  host: ReturnType<typeof makeHost>;
  render(node: ReactNode): Promise<void>;
  unmount(): Promise<void>;
}

export async function mountMap(options: { store?: StateStore; host?: Partial<MapHost>; children?: ReactNode; size?: { width: number; height: number } } = {}): Promise<Mounted> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mapUi.reset();
  const store = options.store ?? seededStore();
  const host = makeHost(options.host);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (node: ReactNode) =>
    act(async () =>
      root.render(
        <LaserStoreProvider store={store}>
          <TooltipProvider>
            <MapHostProvider value={host}>{node}</MapHostProvider>
          </TooltipProvider>
        </LaserStoreProvider>,
      ),
    );
  await render(options.children ?? <StoreMap />);
  if (options.size) await resize(container.querySelector('[data-slot="agent-map-body"]'), options.size.width, options.size.height);
  return {
    container,
    root,
    store,
    host,
    render,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

export const dispatch = async (store: StateStore, ...actions: Parameters<StateStore["dispatch"]>[0][]) => {
  await act(async () => {
    for (const action of actions) store.dispatch(action);
  });
  await measureNodes();
};
