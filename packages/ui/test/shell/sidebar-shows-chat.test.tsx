// @vitest-environment happy-dom
/**
 * Selecting a session in the sidebar shows that session's chat (M13-T50):
 * the row's click reaches the shell's `showChat`, which closes the map and
 * everything else covering the chat, and in the sheet the sheet closes too.
 * The list is the real element over a real store and a real thread list.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, useExternalStoreRuntime, useRemoteThreadListRuntime, type RemoteThreadListAdapter } from "@assistant-ui/react";
import type { SessionSummary } from "@lasercode/protocol";

import { SessionsPanel } from "../../src/components/shell/SessionsPanel.js";
import { ShellContext, type ShellContextValue } from "../../src/components/shell/shell-context.js";
import { sessionsList } from "../../src/components/shell/session-groups.js";
import { sessionFolds } from "../../src/components/assistant-ui/elements/session-folds.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { WorkbenchProvider } from "../../src/components/workbench/workbench-context.js";
import { LaserStoreProvider, createStateStore, type StateStore } from "../../src/runtime/LaserProvider.js";
import { toThreadMetadata } from "../../src/runtime/threadList.js";
import { initialState, reduce, type AppState } from "../../src/store.js";
import { snapshot, summary } from "../agents/fixtures.js";

const stable = vi.hoisted(() => ({
  projects: ["/one"],
  currentProject: "/one",
  setCurrentProject: vi.fn(),
  actions: { toast: vi.fn(), removeProject: vi.fn(), newSession: vi.fn(async () => "/one/new.jsonl"), openSession: vi.fn(async () => undefined) },
  archive: { add: vi.fn(), has: () => false },
  client: { request: vi.fn(async () => ({ hits: [], unreadable: 0 })) },
}));
vi.mock("@/runtime", async (importActual) => ({ ...(await importActual<typeof import("../../src/runtime/index.js")>()), useLaserStable: () => stable }));
vi.mock("@/components/agents/page/AgentsButton", () => ({ AgentsButton: () => null }));

const sessions: SessionSummary[] = [
  summary({ path: "/one/current.jsonl", cwd: "/one", name: "Current work", modifiedAt: "2026-09-08T03:00:00Z" }),
  summary({ path: "/one/older.jsonl", cwd: "/one", name: "Older work", modifiedAt: "2026-09-07T03:00:00Z" }),
];
const adapter: RemoteThreadListAdapter = {
  list: async () => ({ threads: sessions.map((s) => toThreadMetadata(s, undefined, false)) }),
  initialize: async (id) => ({ remoteId: id, externalId: id }),
  fetch: async (id) => toThreadMetadata(sessions.find((s) => s.path === id)!, undefined, false),
  rename: async () => {}, archive: async () => {}, unarchive: async () => {}, delete: async () => {},
  generateTitle: async () => { throw new Error("Not used"); },
};
function useEmptyRuntime() { return useExternalStoreRuntime({ messages: [], isRunning: false, onNew: async () => {} }); }

const showChat = vi.fn();
const setSessionsOpen = vi.fn();
const shellFor = (layout: ShellContextValue["layout"]): ShellContextValue => ({
  layout, sessionsOpen: true, fleetOpen: false, telemetryOpen: false, setSessionsOpen, setFleetOpen: () => {}, setTelemetryOpen: () => {}, toggleSessions: () => {}, toggleFleet: () => {}, toggleTelemetry: () => {},
  historyOpen: false, setHistoryOpen: () => {}, openHistory: () => {}, toolsOpen: false, setToolsOpen: () => {}, addProjectOpen: false, setAddProjectOpen: () => {},
  newSession: async () => {}, canCreate: true, showChat, returnToChat: () => {},
});
function Fixture({ store, variant }: { store: StateStore; variant: "panel" | "sheet" }) {
  const runtime = useRemoteThreadListRuntime({ adapter, runtimeHook: useEmptyRuntime });
  return (
    <LaserStoreProvider store={store}>
      <AssistantRuntimeProvider runtime={runtime}>
        <TooltipProvider>
          <WorkbenchProvider>
            <ShellContext.Provider value={shellFor(variant === "sheet" ? "mobile" : "desktop")}>
              <SessionsPanel variant={variant} />
            </ShellContext.Provider>
          </WorkbenchProvider>
        </TooltipProvider>
      </AssistantRuntimeProvider>
    </LaserStoreProvider>
  );
}

let container: HTMLDivElement;
let root: Root;
let store: StateStore;
const seed = (): AppState => {
  let state = reduce(initialState, { type: "agents/loaded", snapshot: snapshot() });
  state = reduce(state, { type: "sessions", sessions });
  return { ...state, connection: "open" };
};
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  sessionsList.reset();
  sessionFolds.reset();
  showChat.mockClear();
  setSessionsOpen.mockClear();
  stable.actions.newSession.mockClear();
  store = createStateStore(seed());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const mount = async (node: ReactNode) => act(async () => root.render(node));
const rowTrigger = (text: string): HTMLButtonElement => {
  const row = [...container.querySelectorAll<HTMLElement>('[data-slot="aui_thread-list-item"]')].find((r) => r.textContent?.includes(text));
  expect(row, text).toBeDefined();
  return row!.querySelector<HTMLButtonElement>('[data-slot="aui_thread-list-item-trigger"]')!;
};

describe("selecting a session in the sidebar shows its chat", () => {
  it("in the docked column: the row's click leaves every cover", async () => {
    await mount(<Fixture store={store} variant="panel" />);
    const trigger = rowTrigger("Older work");
    // A native button: one click, one keyboard activation.
    expect(trigger.tagName).toBe("BUTTON");
    await act(async () => trigger.click());
    expect(showChat).toHaveBeenCalledTimes(1);
    expect(setSessionsOpen).not.toHaveBeenCalled();
    // The row that is already current is still a navigation to its chat.
    await act(async () => rowTrigger("Older work").click());
    expect(showChat).toHaveBeenCalledTimes(2);
  });

  it("in the phone's sheet: the row's click leaves every cover and closes the sheet", async () => {
    await mount(<Fixture store={store} variant="sheet" />);
    await act(async () => rowTrigger("Current work").click());
    expect(showChat).toHaveBeenCalledTimes(1);
    expect(setSessionsOpen).toHaveBeenCalledWith(false);
  });

  it("a new session started from the list is shown the same way", async () => {
    await mount(<Fixture store={store} variant="sheet" />);
    const create = container.querySelector<HTMLButtonElement>('[data-cwd="/one"] button[aria-label^="New session"]');
    expect(create).not.toBeNull();
    await act(async () => create!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(stable.actions.newSession).toHaveBeenCalledWith("/one");
    expect(showChat).toHaveBeenCalledTimes(1);
    expect(setSessionsOpen).toHaveBeenCalledWith(false);
  });
});
