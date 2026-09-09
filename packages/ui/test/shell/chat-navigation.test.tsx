// @vitest-environment happy-dom
/**
 * Two ways back to the chat that always work (M13-T50): the logo returns to
 * the last opened session from the map, the fullscreen map, Settings, Logs
 * and the sheets; a selection leaves every cover. Driven through the real
 * `LaserProvider` over the fake host, the real workbench and the real map
 * state, so what is asserted is what the shell does — not a spy on a verb.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../beam/fake-host.js")).FakeHostClient,
}));
// The rail also carries the Agents page's button (another lane); it is not under test here.
vi.mock("@/components/agents/page/AgentsButton", () => ({ AgentsButton: () => null }));

import { mapUi } from "../../src/components/agents/map/map-state.js";
import { useChatNavigation, rememberedSessionFor } from "../../src/components/shell/chat-navigation.js";
import { Rail } from "../../src/components/shell/Rail.js";
import { ShellContext, type ShellContextValue } from "../../src/components/shell/shell-context.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { WorkbenchProvider, useWorkbench, type Workbench } from "../../src/components/workbench/workbench-context.js";
import { closeFleetSheet, setFleetSheetOpen, useFleetSheetOpen } from "../../src/fleet/index.js";
import { LaserProvider, PROJECT_STORAGE_KEY, SESSION_STORAGE_KEY, useLaserStable, useLaserState, useLaserView } from "../../src/runtime/LaserProvider.js";
import { summary } from "../agents/fixtures.js";
import { addSession, createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "../beam/fake-host.js";

const A = `${PROJECT_CWD}/a.jsonl`;
const B = `${PROJECT_CWD}/b.jsonl`;

const base: Omit<ShellContextValue, "showChat" | "returnToChat"> = {
  layout: "desktop",
  sessionsOpen: true,
  fleetOpen: false,
  telemetryOpen: false,
  setSessionsOpen: () => {},
  setFleetOpen: () => {},
  setTelemetryOpen: () => {},
  toggleSessions: () => {},
  toggleFleet: () => {},
  toggleTelemetry: () => {},
  historyOpen: false,
  setHistoryOpen: () => {},
  openHistory: () => {},
  toolsOpen: false,
  setToolsOpen: () => {},
  addProjectOpen: false,
  setAddProjectOpen: () => {},
  newSession: async () => {},
  canCreate: true,
};

/** What the tests read and drive, captured from inside the providers. */
let probe: {
  path: string | undefined;
  workbench: Workbench;
  fleetSheet: boolean;
  toasts: number;
  dispatch: ReturnType<typeof useLaserStable>["dispatch"];
  shell: ShellContextValue;
};
const closeSheets = vi.fn();

function Frame() {
  const nav = useChatNavigation({ closeSheets });
  const shell: ShellContextValue = { ...base, ...nav };
  probe = {
    path: useLaserView()?.path,
    workbench: useWorkbench(),
    fleetSheet: useFleetSheetOpen(),
    toasts: useLaserState((s) => s.toasts.length),
    dispatch: useLaserStable().dispatch,
    shell,
  };
  return (
    <ShellContext.Provider value={shell}>
      <Rail />
    </ShellContext.Provider>
  );
}

let container: HTMLDivElement;
let root: Root;
let world: World;

/** Two sessions in the project, `A` remembered as the last one read. */
const seed = (remembered: string | null = A): void => {
  world = createWorld();
  addSession(world, A, PROJECT_CWD, { name: "First" });
  addSession(world, B, PROJECT_CWD, { name: "Second" });
  FakeHostClient.reset(world);
  localStorage.setItem(PROJECT_STORAGE_KEY, PROJECT_CWD);
  if (remembered !== null) localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ [PROJECT_CWD]: remembered }));
  else localStorage.removeItem(SESSION_STORAGE_KEY);
};

const mount = async (): Promise<void> => {
  await act(async () =>
    root.render(
      <LaserProvider url="ws://test">
        <TooltipProvider>
          <WorkbenchProvider>
            <Frame />
          </WorkbenchProvider>
        </TooltipProvider>
      </LaserProvider>,
    ),
  );
  await act(async () => settle(10));
};

const logo = (): HTMLButtonElement => container.querySelector<HTMLButtonElement>('[data-slot="back-to-chat"]')!;
const clickLogo = async (): Promise<void> => {
  await act(async () => logo().click());
  await act(async () => settle(10));
};
const calls = (method: string): number => world.calls.filter((call) => call.method === method).length;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  // The runtime writes the open session into the hash as a deep link; a
  // leftover one from the previous test would be an instruction, not a memory.
  history.replaceState(null, "", "/");
  mapUi.reset();
  closeFleetSheet();
  closeSheets.mockClear();
  seed();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  mapUi.reset();
  closeFleetSheet();
});

describe("the logo: back to your chat, from anywhere", () => {
  it("is one native button with a name that says what it does", async () => {
    await mount();
    expect(probe.path).toBe(A);
    const button = logo();
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-label")).toBe("Back to your chat");
    expect(button.getAttribute("title")).toBeNull();
    // Reachable by keyboard: in the tab order, and it takes focus.
    expect(button.tabIndex).toBeGreaterThanOrEqual(0);
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it("returns from the map to the session that was open", async () => {
    await mount();
    await act(async () => mapUi.setOpen(true));
    expect(mapUi.get().open).toBe(true);
    await clickLogo();
    expect(mapUi.get().open).toBe(false);
    expect(probe.path).toBe(A);
    expect(calls("session/new")).toBe(0);
  });

  it("returns from the fullscreen map", async () => {
    await mount();
    await act(async () => {
      mapUi.setOpen(true);
      mapUi.setFullscreen(true);
    });
    await clickLogo();
    expect(mapUi.get()).toMatchObject({ open: false, fullscreen: false });
    expect(probe.path).toBe(A);
  });

  it("returns from Settings and from Logs", async () => {
    await mount();
    await act(async () => probe.workbench.open("settings"));
    expect(probe.workbench.page).toBe("settings");
    await clickLogo();
    expect(probe.workbench.page).toBeNull();
    expect(probe.path).toBe(A);

    await act(async () => probe.workbench.open("logs"));
    expect(probe.workbench.page).toBe("logs");
    await clickLogo();
    expect(probe.workbench.page).toBeNull();
    expect(probe.path).toBe(A);
  });

  it("returns from Settings while the map is also open, in one click", async () => {
    await mount();
    await act(async () => {
      mapUi.setOpen(true);
      probe.workbench.open("agents");
    });
    await clickLogo();
    expect(mapUi.get().open).toBe(false);
    expect(probe.workbench.page).toBeNull();
    expect(probe.path).toBe(A);
  });

  it("closes the fleet sheet and the compact layouts' sheets", async () => {
    await mount();
    await act(async () => setFleetSheetOpen(true));
    expect(probe.fleetSheet).toBe(true);
    await clickLogo();
    expect(probe.fleetSheet).toBe(false);
    expect(closeSheets).toHaveBeenCalledTimes(1);
  });

  it("with no current session lands on the remembered one and creates nothing", async () => {
    await mount();
    expect(probe.path).toBe(A);
    await act(async () => probe.dispatch({ type: "select", path: undefined }));
    expect(probe.path).toBeUndefined();
    const before = world.sessions.length;

    await clickLogo();
    expect(probe.path).toBe(A);
    expect(calls("session/new")).toBe(0);
    expect(world.sessions).toHaveLength(before);
    expect(probe.toasts).toBe(0);
  });

  it("with nothing remembered lands on the project's new-session state and creates nothing", async () => {
    seed(null);
    await mount();
    expect(probe.path).toBeUndefined();
    const loads = calls("session/load");
    await act(async () => mapUi.setOpen(true));
    await clickLogo();
    expect(probe.path).toBeUndefined();
    expect(mapUi.get().open).toBe(false);
    expect(calls("session/new")).toBe(0);
    expect(calls("session/load")).toBe(loads);
    expect(probe.toasts).toBe(0);
  });

  it("treats a remembered session that no longer exists as nothing remembered", async () => {
    seed(`${PROJECT_CWD}/gone.jsonl`);
    await mount();
    expect(probe.path).toBeUndefined();
    await clickLogo();
    expect(probe.path).toBeUndefined();
    expect(calls("session/new")).toBe(0);
    expect(probe.toasts).toBe(0);
  });
});

describe("a selection leaves every cover", () => {
  it("closes the map, the fullscreen map, the workbench and the sheets without choosing a session", async () => {
    await mount();
    await act(async () => {
      mapUi.setOpen(true);
      mapUi.setFullscreen(true);
      setFleetSheetOpen(true);
      probe.workbench.open("settings");
    });
    await act(async () => probe.shell.showChat());
    expect(mapUi.get()).toMatchObject({ open: false, fullscreen: false });
    expect(probe.workbench.page).toBeNull();
    expect(probe.fleetSheet).toBe(false);
    expect(closeSheets).toHaveBeenCalledTimes(1);
    // The selection itself decides which session shows; the verb opens none.
    expect(probe.path).toBe(A);
    await act(async () => probe.dispatch({ type: "select", path: undefined }));
    const loads = calls("session/load");
    await act(async () => probe.shell.showChat());
    expect(probe.path).toBeUndefined();
    expect(calls("session/load")).toBe(loads);
  });
});

describe("rememberedSessionFor", () => {
  const sessions = [summary({ path: A }), summary({ path: B })];
  it("answers the remembered path only while it is in the catalog", () => {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ [PROJECT_CWD]: B, "/other": A }));
    expect(rememberedSessionFor(PROJECT_CWD, sessions)).toBe(B);
    expect(rememberedSessionFor("/other", sessions)).toBe(A);
    expect(rememberedSessionFor(PROJECT_CWD, [sessions[0]!])).toBeUndefined();
    expect(rememberedSessionFor("/unknown", sessions)).toBeUndefined();
    expect(rememberedSessionFor(undefined, sessions)).toBeUndefined();
  });
  it("survives a missing, malformed or wrongly shaped entry", () => {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    expect(rememberedSessionFor(PROJECT_CWD, sessions)).toBeUndefined();
    localStorage.setItem(SESSION_STORAGE_KEY, "{not json");
    expect(rememberedSessionFor(PROJECT_CWD, sessions)).toBeUndefined();
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify([A]));
    expect(rememberedSessionFor(PROJECT_CWD, sessions)).toBeUndefined();
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ [PROJECT_CWD]: 7 }));
    expect(rememberedSessionFor(PROJECT_CWD, sessions)).toBeUndefined();
  });
});
