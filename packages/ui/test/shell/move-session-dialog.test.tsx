// @vitest-environment happy-dom
/**
 * Moving a Chat session into a project (M13-T58), from the row menu to the
 * moment the Code tab shows it under its project. Interaction tests over the
 * real sessions panel, the real thread list and the real dialog: the item is
 * only in the Chat tab, the dialog lists the projects in the right order and
 * offers a new one, the desktop's picker and the browser's typed path both
 * lead to the same request, a refusal stays in the dialog, and a finished
 * move lands the person on the moved session under its project in Code.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, useExternalStoreRuntime, useRemoteThreadListRuntime, type RemoteThreadListAdapter } from "@assistant-ui/react";
import type { SessionSummary } from "@lasercode/protocol";

import { SessionsPanel } from "../../src/components/shell/SessionsPanel.js";
import { MoveSessionDialog } from "../../src/components/shell/MoveSessionDialog.js";
import { ShellContext, type ShellContextValue } from "../../src/components/shell/shell-context.js";
import { clearMoveSessionRequest, orderProjectsForMove, useMoveSessionRequest } from "../../src/components/shell/move-session.js";
import { sessionsList } from "../../src/components/shell/session-groups.js";
import { sessionFolds } from "../../src/components/assistant-ui/elements/session-folds.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserStoreProvider, createStateStore, type StateStore } from "../../src/runtime/LaserProvider.js";
import { toThreadMetadata } from "../../src/runtime/threadList.js";
import { initialState, reduce, type AppState } from "../../src/store.js";
import { snapshot, summary } from "../agents/fixtures.js";

const CHAT = "/state/chat/c1.jsonl";
const MOVED = "/agent/sessions/--one--/c1.jsonl";

const stable = vi.hoisted(() => ({
  projects: ["/one", "/two", "/three"],
  currentProject: "/two",
  projectInfo: {
    "/one": { lastUsedAt: "2026-09-08T00:00:00Z" },
    "/three": { lastUsedAt: "2026-09-09T00:00:00Z" },
  },
  setCurrentProject: vi.fn(),
  actions: {
    toast: vi.fn(),
    removeProject: vi.fn(),
    newSession: vi.fn(async () => "/state/chat/new.jsonl"),
    openSession: vi.fn(async () => undefined),
    moveSession: vi.fn(async () => MOVED),
  },
  archive: { add: vi.fn(), has: () => false },
  client: { request: vi.fn(async () => ({ hits: [], unreadable: 0 })) },
}));
vi.mock("@/runtime", async (importActual) => ({ ...(await importActual<typeof import("../../src/runtime/index.js")>()), useLaserStable: () => stable }));

const sessions: SessionSummary[] = [
  summary({ path: "/one/root.jsonl", cwd: "/one", name: "Ship the release", modifiedAt: "2026-09-08T03:00:00Z" }),
  summary({ path: CHAT, cwd: "/state/chat", name: "Recipe ideas", modifiedAt: "2026-09-08T04:00:00Z", agent: { agentName: "chat", kind: "chat" } }),
  summary({ path: "/state/chat/child.jsonl", cwd: "/state/chat", name: "Counting", modifiedAt: "2026-09-08T04:01:00Z", agent: { agentName: "default", kind: "child", subagentName: "explorer", parentPath: CHAT, rootPath: CHAT } }),
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
const shell: ShellContextValue = {
  layout: "desktop", sessionsOpen: true, fleetOpen: false, telemetryOpen: false, setSessionsOpen: () => {}, setFleetOpen: () => {}, setTelemetryOpen: () => {}, toggleSessions: () => {}, toggleFleet: () => {}, toggleTelemetry: () => {},
  historyOpen: false, setHistoryOpen: () => {}, openHistory: () => {}, toolsOpen: false, setToolsOpen: () => {}, addProjectOpen: false, setAddProjectOpen: () => {},
  newSession: async () => {}, canCreate: true, showChat, returnToChat: () => {},
};
let request: ReturnType<typeof useMoveSessionRequest>;
function RequestProbe() { request = useMoveSessionRequest(); return null; }
function Fixture({ store }: { store: StateStore }) {
  const runtime = useRemoteThreadListRuntime({ adapter, runtimeHook: useEmptyRuntime });
  return (
    <LaserStoreProvider store={store}>
      <AssistantRuntimeProvider runtime={runtime}>
        <TooltipProvider>
          <ShellContext.Provider value={shell}>
            <SessionsPanel variant="panel" />
            <MoveSessionDialog />
            <RequestProbe />
          </ShellContext.Provider>
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
  clearMoveSessionRequest();
  stable.actions.moveSession.mockReset().mockResolvedValue(MOVED);
  stable.actions.openSession.mockClear();
  stable.actions.toast.mockClear();
  stable.setCurrentProject.mockClear();
  showChat.mockClear();
  delete (globalThis as { desktop?: unknown }).desktop;
  store = createStateStore(seed());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.querySelectorAll("[data-radix-popper-content-wrapper]").forEach((n) => n.remove());
  delete (globalThis as { desktop?: unknown }).desktop;
});

const mount = async (node: ReactNode = <Fixture store={store} />) => act(async () => root.render(node));
const tab = (kind: "chat" | "code") => container.querySelector<HTMLButtonElement>(`[role="tab"][data-tab="${kind}"]`)!;
const tick = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const openMenu = async (label: string) => {
  const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  expect(trigger, label).not.toBeNull();
  await act(async () => trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })));
  await tick();
  return document.querySelector<HTMLElement>('[data-slot="aui_thread-list-item-more-content"]');
};
const menuItems = (menu: HTMLElement | null) => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].map((item) => item.textContent?.trim());
const dialog = () => document.body.querySelector<HTMLElement>('[data-slot="move-session-dialog"]');
const projectRows = () => [...(dialog()?.querySelectorAll<HTMLElement>('[data-slot="move-session-project"]') ?? [])];
const confirmButton = () => dialog()!.querySelector<HTMLButtonElement>('[data-slot="move-session-confirm"]')!;

/** Chat tab → the row's menu → "Move to a project…". */
async function openDialog(): Promise<void> {
  await mount();
  await act(async () => tab("chat").click());
  const menu = await openMenu("Actions for Recipe ideas");
  const item = [...menu!.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent?.includes("Move to a project"))!;
  await act(async () => item.click());
  await tick();
  expect(dialog()).not.toBeNull();
}

describe("the row menu", () => {
  it("offers Move to a project… in the Chat tab only, and never for a child", async () => {
    await mount();
    expect(menuItems(await openMenu("Actions for Ship the release"))).not.toContain("Move to a project…");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => tab("chat").click());
    expect(menuItems(await openMenu("Actions for Recipe ideas"))).toEqual(["Pin chat", "Rename", "Move to a project…", "Copy path", "Archive"]);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    // The child an agent started under the chat moves with its parent's tree, never on its own.
    expect(menuItems(await openMenu("Actions for explorer"))).not.toContain("Move to a project…");
  });
});

describe("the move dialog", () => {
  it("names the session, says what happens, and lists the projects current-first then most recent, with New project last", async () => {
    await openDialog();
    const d = dialog()!;
    expect(d.textContent).toContain("Move “Recipe ideas” to a project");
    expect(d.textContent).toContain("Its history and name come with it. It leaves Chat and appears under the project you choose in Code.");
    expect(projectRows().map((row) => row.dataset["cwd"])).toEqual(["/two", "/three", "/one"]);
    expect(projectRows()[0]?.textContent).toContain("Current");
    const items = [...d.querySelectorAll<HTMLElement>("[cmdk-item]")];
    expect(items.at(-1)?.dataset["slot"]).toBe("move-session-new");
    expect(items.at(-1)?.textContent).toContain("New project…");
    // Nothing chosen yet: the verb is plain and disabled.
    expect(confirmButton().textContent).toBe("Move");
    expect(confirmButton().disabled).toBe(true);
    expect(request?.path).toBe(CHAT);
  });

  it("choosing a project names it on the button and in the sentence; Move asks the host, then lands on the session under that project in Code", async () => {
    await openDialog();
    await act(async () => projectRows()[2]!.click());
    expect(projectRows()[2]?.dataset["chosen"]).toBe("true");
    expect(confirmButton().textContent).toBe("Move to one");
    expect(dialog()!.textContent).toContain("appears under one in Code");
    expect(document.activeElement).toBe(confirmButton());

    await act(async () => confirmButton().click());
    await tick();
    expect(stable.actions.moveSession).toHaveBeenCalledWith(CHAT, "/one");
    expect(stable.setCurrentProject).toHaveBeenCalledWith("/one");
    expect(sessionsList.get().tab).toBe("code");
    expect(sessionsList.get().jump?.cwd).toBe("/one");
    expect(stable.actions.openSession).toHaveBeenCalledWith(MOVED);
    expect(showChat).toHaveBeenCalled();
    expect(stable.actions.toast).toHaveBeenCalledWith("info", "Moved “Recipe ideas” to one. Find it under one in Code.");
    expect(dialog()).toBeNull();
    expect(request).toBeUndefined();
  });

  it("keeps a refusal in the dialog with its reason, and offers to try again", async () => {
    stable.actions.moveSession.mockRejectedValueOnce(new Error("This chat is still answering. Wait for it to finish, or stop it, then move it."));
    await openDialog();
    await act(async () => projectRows()[0]!.click());
    await act(async () => confirmButton().click());
    await tick();
    const alert = dialog()!.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Could not move “Recipe ideas”.");
    expect(alert?.textContent).toContain("This chat is still answering.");
    expect(confirmButton().textContent).toBe("Try again");
    expect(confirmButton().disabled).toBe(false);
    expect(stable.actions.openSession).not.toHaveBeenCalled();
    expect(stable.setCurrentProject).not.toHaveBeenCalled();
    expect(sessionsList.get().tab).toBe("chat");
  });

  it("in a browser, New project… asks for a path, and Enter in the field moves there", async () => {
    await openDialog();
    expect(dialog()!.dataset["picker"]).toBe("typed");
    await act(async () => dialog()!.querySelector<HTMLElement>('[data-slot="move-session-new"]')!.click());
    const field = dialog()!.querySelector<HTMLInputElement>('[data-slot="move-session-path"] input')!;
    expect(field).not.toBeNull();
    expect(dialog()!.textContent).toContain("Folder on the computer running");
    expect(confirmButton().disabled).toBe(true);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(field, "  /home/me/new-app  ");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(confirmButton().textContent).toBe("Move to new-app");
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await tick();
    expect(stable.actions.moveSession).toHaveBeenCalledWith(CHAT, "/home/me/new-app");
    expect(stable.setCurrentProject).toHaveBeenCalledWith("/home/me/new-app");
  });

  it("in the desktop app, New project… runs the native picker; a chosen folder is listed as new and a cancelled picker changes nothing", async () => {
    const chooseDirectory = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce("/home/me/picked");
    (globalThis as { desktop?: unknown }).desktop = { chooseDirectory };
    await openDialog();
    expect(dialog()!.dataset["picker"]).toBe("native");
    const newRow = () => dialog()!.querySelector<HTMLElement>('[data-slot="move-session-new"]')!;
    await act(async () => newRow().click());
    await tick();
    expect(chooseDirectory).toHaveBeenCalledTimes(1);
    expect(dialog()!.querySelector('[data-slot="move-session-path"]')).toBeNull();
    expect(confirmButton().disabled).toBe(true);

    await act(async () => newRow().click());
    await tick();
    expect(projectRows().map((row) => row.dataset["cwd"])).toEqual(["/home/me/picked", "/two", "/three", "/one"]);
    expect(projectRows()[0]?.textContent).toContain("New");
    expect(projectRows()[0]?.dataset["chosen"]).toBe("true");
    expect(confirmButton().textContent).toBe("Move to picked");
    await act(async () => confirmButton().click());
    await tick();
    expect(stable.actions.moveSession).toHaveBeenCalledWith(CHAT, "/home/me/picked");
  });

  it("Escape and Cancel close it without moving anything", async () => {
    await openDialog();
    await act(async () => [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Cancel")!.click());
    expect(dialog()).toBeNull();
    expect(stable.actions.moveSession).not.toHaveBeenCalled();
  });
});

describe("orderProjectsForMove", () => {
  it("puts the current project first, then the most recently used, then sidebar order", () => {
    expect(orderProjectsForMove(["/a", "/b", "/c", "/d"], "/c", { "/a": { lastUsedAt: "2026-01-01T00:00:00Z" }, "/d": { lastUsedAt: "2026-02-01T00:00:00Z" }, "/b": { lastUsedAt: "not a date" } })).toEqual(["/c", "/d", "/a", "/b"]);
    expect(orderProjectsForMove(["/a", "/b"], undefined)).toEqual(["/a", "/b"]);
    expect(orderProjectsForMove([], "/x")).toEqual([]);
  });
});
