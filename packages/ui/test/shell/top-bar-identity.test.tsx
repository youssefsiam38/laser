// @vitest-environment happy-dom
import type { SessionAgentInfo, SessionSummary } from "@lasercode/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stable = vi.hoisted(() => ({
  currentProject: "/project",
  actions: {
    toast: vi.fn(), rename: vi.fn(), restartWorker: vi.fn(), compact: vi.fn(), fork: vi.fn(), openSession: vi.fn(),
  },
  client: { request: vi.fn() },
}));
vi.mock("@/runtime", async (original) => ({
  ...(await original<typeof import("../../src/runtime/index.js")>()),
  useLaserStable: () => stable,
}));
vi.mock("@/components/assistant-ui/elements/context-display", () => ({ ContextRingButton: () => <button type="button">Context</button> }));

import { SessionIdentity } from "../../src/components/shell/SessionIdentity.js";
import { ShellContext, type ShellContextValue } from "../../src/components/shell/shell-context.js";
import { TopBar } from "../../src/components/shell/TopBar.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { createStateStore, LaserStoreProvider, type StateStore } from "../../src/runtime/LaserProvider.js";
import { initialState, reduce, type AppState } from "../../src/store.js";
import { sessionState, snapshot, summary, view } from "../agents/fixtures.js";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  container.remove();
  document.querySelectorAll('[data-slot="tooltip-content"],[data-slot="dropdown-menu-content"]').forEach((node) => node.remove());
});

const renderIdentity = async (agentName: string | undefined, model: { provider: string; id: string } | null) => {
  await act(async () => root.render(<TooltipProvider><SessionIdentity agentName={agentName} model={model} /></TooltipProvider>));
};
const agentLabel = () => container.querySelector<HTMLButtonElement>('[data-slot="session-agent-identity"]');
const modelLabel = () => container.querySelector<HTMLElement>('[data-slot="session-model-identity"]');
const detail = () => document.querySelector<HTMLElement>('[data-slot="session-agent-detail"]');

const pointer = (element: Element, type: "pointerover" | "pointerout" | "pointerdown" | "pointerup", pointerType: "mouse" | "touch") => {
  const event = new PointerEvent(type, { bubbles: true, button: 0 });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  element.dispatchEvent(event);
};
const touchTap = async (element: HTMLElement) => act(async () => {
  pointer(element, "pointerdown", "touch");
  element.focus();
  pointer(element, "pointerup", "touch");
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
});

const shell: ShellContextValue = {
  layout: "mobile", sessionsOpen: false, fleetOpen: false, telemetryOpen: false,
  setSessionsOpen: vi.fn(), setFleetOpen: vi.fn(), setTelemetryOpen: vi.fn(), toggleSessions: vi.fn(), toggleFleet: vi.fn(), toggleTelemetry: vi.fn(),
  historyOpen: false, setHistoryOpen: vi.fn(), openHistory: vi.fn(), toolsOpen: false, setToolsOpen: vi.fn(), addProjectOpen: false, setAddProjectOpen: vi.fn(),
  newSession: vi.fn(), canCreate: true, showChat: vi.fn(), returnToChat: vi.fn(),
};
const A = "/project/a.jsonl";
const B = "/project/b.jsonl";
const C = "/project/c.jsonl";
const D = "/project/d.jsonl";
const writer: SessionAgentInfo = { agentName: "writer", kind: "root" };
const reviewer: SessionAgentInfo = { agentName: "reviewer", kind: "root" };
const child: SessionAgentInfo = { agentName: "reviewer", kind: "child", subagentName: "reviewer-third-pass", parentPath: A, rootPath: A };
const summaries: SessionSummary[] = [
  summary({ path: A, cwd: "/project", name: "A very long session title that must remain meaningful", agent: reviewer }),
  summary({ path: B, cwd: "/project", name: "Catalog attribution", agent: reviewer }),
  summary({ path: C, cwd: "/project", name: "Old unattributed history" }),
  summary({ path: D, cwd: "/project", name: "Child session", agent: child }),
];
const seed = (): AppState => {
  let state = reduce(initialState, { type: "agents/loaded", snapshot: snapshot({ defaultAgent: "default" }) });
  state = reduce(state, { type: "sessions", sessions: summaries });
  const open = {
    [A]: view({ path: A, state: sessionState({ path: A, cwd: "/project", name: summaries[0]!.name, agent: writer, model: { provider: "anthropic", id: "a-model-name-long-enough-to-truncate" } }) }),
    [B]: view({ path: B, state: sessionState({ path: B, cwd: "/project", name: summaries[1]!.name }) }),
    [C]: view({ path: C, state: sessionState({ path: C, cwd: "/project", name: summaries[2]!.name }) }),
    [D]: view({ path: D, state: sessionState({ path: D, cwd: "/project", name: summaries[3]!.name, agent: child }) }),
  };
  return { ...state, connection: "open", current: A, open };
};
const select = (store: StateStore, path: string) => store.dispatch({ type: "destination", destination: { phase: "ready-code", intent: store.getSnapshot().destination.intent + 1, code: { kind: "project-session", project: "/project", path } } });
const mountTopBar = async (store: StateStore) => {
  await act(async () => root.render(
    <LaserStoreProvider store={store}>
      <TooltipProvider>
        <ShellContext.Provider value={shell}><TopBar /></ShellContext.Provider>
      </TooltipProvider>
    </LaserStoreProvider>,
  ));
};

// The focused renderer owns disclosure and compact presentation. Store wiring is
// covered separately below so a default-agent fallback cannot pass these tests.
describe("session identity renderer", () => {
  it("shows full identity on hover, focus and tap without a native title or picker", async () => {
    const name = "long-agent-name-for-responsive-header-ui";
    await renderIdentity(name, { provider: "anthropic", id: "claude-sonnet-with-a-long-version" });
    const agent = agentLabel()!;
    expect(agent.textContent).toBe(name);
    expect(agent.getAttribute("title")).toBeNull();
    expect(agent.getAttribute("aria-label")).toBe(`Session agent: ${name}. Show full name`);
    expect(agent.className).toContain("max-w-20");
    expect(agent.querySelector("span")?.className).toContain("truncate");
    expect(container.querySelector('[role="combobox"],[role="listbox"]')).toBeNull();

    // A real touch activation focuses between pointerdown and click. The first
    // sequence opens; the second deliberately toggles it closed.
    await touchTap(agent);
    expect(detail()?.textContent).toBe(`Agent: ${name}`);
    await touchTap(agent);
    expect(detail()).toBeNull();

    await act(async () => { agent.blur(); agent.focus(); });
    expect(detail()?.textContent).toBe(`Agent: ${name}`);
    await act(async () => agent.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(detail()).toBeNull();
    await act(async () => agent.blur());

    await act(async () => pointer(agent, "pointerover", "mouse"));
    expect(detail()?.textContent).toBe(`Agent: ${name}`);
    await act(async () => pointer(agent, "pointerout", "mouse"));
    expect(detail()).toBeNull();

    await touchTap(agent);
    expect(detail()?.textContent).toBe(`Agent: ${name}`);
    await act(async () => agent.blur());
    expect(detail()).toBeNull();
  });

  it("keeps built-in labels and places the canonical model after the agent", async () => {
    await renderIdentity("beam", { provider: "openai", id: "gpt-5" });
    expect(agentLabel()?.textContent).toBe("Beam");
    expect(modelLabel()?.textContent).toBe("gpt-5");
    expect(agentLabel()!.compareDocumentPosition(modelLabel()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await renderIdentity("chat", null);
    expect(agentLabel()?.textContent).toBe("Chat");
  });

  it("does not invent an identity for unattributed history", async () => {
    await renderIdentity(undefined, { provider: "openai", id: "gpt-5" });
    expect(agentLabel()).toBeNull();
    expect(modelLabel()?.textContent).toBe("gpt-5");
  });
});

describe("connected top-bar identity", () => {
  it("reads open then catalog attribution, never current default or child instance, across switches", async () => {
    const store = createStateStore(seed());
    await mountTopBar(store);
    // Open-session attribution wins over the conflicting catalog and default,
    // and remains the same when the live session starts streaming.
    expect(agentLabel()?.textContent).toBe("writer");
    await act(async () => store.dispatch({ type: "opened", state: sessionState({ path: A, cwd: "/project", name: summaries[0]!.name, agent: writer, isStreaming: true }) }));
    expect(agentLabel()?.textContent).toBe("writer");

    await act(async () => select(store, B));
    expect(agentLabel()?.textContent).toBe("reviewer");

    await act(async () => select(store, C));
    expect(agentLabel()).toBeNull();

    await act(async () => select(store, D));
    expect(agentLabel()?.textContent).toBe("reviewer");
    expect(agentLabel()?.textContent).not.toContain("reviewer-third-pass");
    const crumb = container.querySelector('[data-slot="parent-crumb"]');
    expect(crumb?.textContent).toContain("A very long session title");
    expect(crumb?.textContent).not.toContain("reviewer-third-pass");
  });

  it("keeps compact actions in one touch-reachable More menu instead of duplicating header controls", async () => {
    const nativeGetComputedStyle = globalThis.getComputedStyle;
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation((element, pseudoElement) => {
      if ((element as HTMLElement).dataset.slot === "topbar-room-marker") return { display: "none" } as CSSStyleDeclaration;
      return nativeGetComputedStyle(element, pseudoElement);
    });
    const store = createStateStore(seed());
    await mountTopBar(store);
    expect(container.querySelector('[aria-label="Find in conversation"]')).toBeNull();
    expect(container.querySelectorAll('[data-slot="agent-map-toggle"]')).toHaveLength(0);

    const more = container.querySelector<HTMLButtonElement>('[aria-label="More"]')!;
    await act(async () => {
      const event = new PointerEvent("pointerdown", { bubbles: true, button: 0 });
      Object.defineProperty(event, "pointerType", { value: "mouse" });
      more.dispatchEvent(event);
    });
    const menu = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]')!;
    expect(menu.textContent).toContain("Show the fleet");
    expect(menu.textContent).toContain("Show telemetry");
    expect(menu.textContent).toContain("Rename session");
    expect(menu.textContent).toContain("Find in conversation");
    expect(menu.textContent).toContain("Show agent map");
    expect(menu.querySelectorAll('[data-slot="agent-map-toggle"]')).toHaveLength(1);
    for (const item of menu.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')) {
      if (["Show the fleet", "Show telemetry", "Rename session", "Find in conversation", "Show agent map"].some((label) => item.textContent?.includes(label))) {
        expect(item.className).toContain("pointer-coarse:min-h-11");
      }
    }

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => select(store, D));
    await act(async () => {
      const event = new PointerEvent("pointerdown", { bubbles: true, button: 0 });
      Object.defineProperty(event, "pointerType", { value: "mouse" });
      container.querySelector<HTMLButtonElement>('[aria-label="More"]')!.dispatchEvent(event);
    });
    expect(document.querySelector('[data-slot="dropdown-menu-content"]')?.textContent).toContain("Open parent: A very long session title");
  });
});
