// @vitest-environment happy-dom
/**
 * The Beam bubble over the real provider and scope, with the transcript
 * replaced by a light stub (`thread-stub.tsx`) and the host by an in-memory
 * peer (`fake-host.tsx`). What is under test: the spark opens and closes the
 * bubble; the empty state and its chips; the first message creating a Beam
 * session in Beam's workspace without moving the main view; the remembered
 * session; a fresh chat on every spark press; Escape and focus.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("./fake-host.js")).FakeHostClient,
}));
vi.mock("@/components/thread/Thread", async () => ({ Thread: (await import("./thread-stub.js")).ThreadStub }));

import { BeamBubble } from "../../src/components/beam/BeamBubble.js";
import { BeamSpark } from "../../src/components/beam/BeamSpark.js";
import { startBeamSession } from "../../src/components/beam/beam-model.js";
import { useLaserStable } from "../../src/runtime/LaserProvider.js";
import { BEAM_SESSION_STORAGE_KEY, beamStore } from "../../src/components/beam/beam-store.js";
import { ShellContext, type ShellContextValue } from "../../src/components/shell/shell-context.js";
import { sessionsList } from "../../src/components/shell/session-groups.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserProvider, useLaserState } from "../../src/runtime/LaserProvider.js";
import { addSession, BEAM_CWD, createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "./fake-host.js";

const shell = (layout: ShellContextValue["layout"]): ShellContextValue => ({
  layout,
  sessionsOpen: false,
  telemetryOpen: false,
  setSessionsOpen: () => {},
  setTelemetryOpen: () => {},
  toggleSessions: () => {},
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
  showChat: () => {},
  returnToChat: () => {},
});

/** The main view's session, read outside the bubble: it must never move because of Beam. */
function MainCurrent() {
  const { actions } = useLaserStable();
  const current = useLaserState((s) => s.current);
  const toasts = useLaserState((s) => s.toasts.map((toast) => `${toast.level}:${toast.text}`).join("\n"));
  return (
    <>
      <button data-slot="sidebar-beam-new" onClick={() => void startBeamSession(actions, FakeHostClient.world.snapshot)}>New Beam chat</button>
      <span data-slot="main-current">{current ?? ""}</span>
      <span data-slot="main-toasts">{toasts}</span>
    </>
  );
}

function Harness({ layout = "desktop" as ShellContextValue["layout"] }) {
  return (
    <LaserProvider url="ws://test">
      <TooltipProvider>
        <ShellContext.Provider value={shell(layout)}>
          <MainCurrent />
          <BeamSpark side="right" size="icon" />
          <BeamBubble />
        </ShellContext.Provider>
      </TooltipProvider>
    </LaserProvider>
  );
}

let container: HTMLDivElement;
let root: Root;
let world: World;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  world = createWorld();
  FakeHostClient.reset(world);
  beamStore.reset();
  sessionsList.reset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const mount = async (layout?: ShellContextValue["layout"]) => {
  await act(async () => root.render(<Harness {...(layout ? { layout } : {})} />));
  // The socket "opens" on a microtask; the catalog and agents list follow.
  await act(async () => settle(10));
};
const spark = () => container.querySelector<HTMLButtonElement>('[data-slot="beam-spark"]')!;
const bubble = () => document.querySelector<HTMLElement>('[data-slot="beam-bubble"]');
const textarea = () => bubble()?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
const calls = (method: string) => world.calls.filter((call) => call.method === method);
const openBubble = async () => {
  await act(async () => spark().click());
  await act(async () => settle(40));
};
const closeAndSettle = async () => {
  await act(async () => settle(400));
};

async function typeAndSend(text: string) {
  const input = textarea()!;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => bubble()!.querySelector<HTMLButtonElement>('[data-slot="composer-send"]')!.click());
  await act(async () => settle(30));
}

describe("the Beam bubble", () => {
  it("opens from the spark into the empty state, focuses the composer, and leaves the main view alone", async () => {
    await mount();
    expect(spark().getAttribute("aria-expanded")).toBe("false");
    expect(bubble()).toBeNull();
    await openBubble();
    expect(spark().getAttribute("aria-expanded")).toBe("true");
    expect(spark().getAttribute("aria-controls")).toBe("beam-bubble");
    const panel = bubble()!;
    expect(panel.getAttribute("aria-label")).toBe("Beam");
    expect(panel.querySelector('[data-slot="beam-empty-state"]')?.textContent).toContain("Beam");
    expect(panel.querySelector('[data-slot="beam-empty-state"]')?.textContent).toContain("Ask about your sessions, logs, agents or settings.");
    expect(panel.querySelectorAll('[data-slot="beam-suggestion"]')).toHaveLength(3);
    expect(document.activeElement).toBe(textarea());
    expect(container.querySelector('[data-slot="main-current"]')?.textContent).toBe("");
    expect(calls("session/new")).toHaveLength(1);
    expect(beamStore.getSnapshot().path).toBeTruthy();
  });

  it("fills the composer from a chip without sending", async () => {
    await mount();
    await openBubble();
    const chip = bubble()!.querySelector<HTMLButtonElement>('[data-slot="beam-suggestion"]')!;
    await act(async () => chip.click());
    expect(textarea()!.value).toBe(chip.textContent);
    expect(calls("session/new")).toHaveLength(1);
    expect(calls("session/prompt")).toHaveLength(0);
  });

  it("prompts the session prepared on open without creating another", async () => {
    addSession(world, `${PROJECT_CWD}/main.jsonl`, PROJECT_CWD);
    await mount();
    // The main view is on a project session; Beam must not replace it.
    await act(async () => FakeHostClient.current.options.onNotification("pi/session/attention", { path: `${PROJECT_CWD}/main.jsonl`, attention: "idle" }));
    await openBubble();
    await typeAndSend("Which sessions need me?");
    const created = calls("session/new");
    expect(created).toHaveLength(1);
    expect(created[0]!.params).toEqual({ cwd: BEAM_CWD, agentName: "beam" });
    const path = `${BEAM_CWD}/session-1.jsonl`;
    const prompts = calls("session/prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.params).toMatchObject({ path, content: [{ type: "text", text: "Which sessions need me?" }] });
    // Adopted by the bubble and this browser, not by the main view.
    expect(beamStore.getSnapshot().path).toBe(path);
    expect(localStorage.getItem(BEAM_SESSION_STORAGE_KEY)).toBe(path);
    expect(container.querySelector('[data-slot="main-current"]')?.textContent).toBe("");
    expect(bubble()!.querySelector('[data-slot="thread-path"]')?.textContent).toBe(path);
    expect(bubble()!.querySelector('[data-slot="beam-empty-state"]')).toBeNull();
  });

  it("starts fresh on every spark press while the previous session remains available", async () => {
    await mount();
    await openBubble();
    await typeAndSend("Hello");
    const path = beamStore.getSnapshot().path!;
    await act(async () => bubble()!.querySelector<HTMLButtonElement>('[data-slot="beam-close"]')!.click());
    await closeAndSettle();
    expect(bubble()).toBeNull();
    expect(spark().getAttribute("aria-expanded")).toBe("false");
    await openBubble();
    expect(beamStore.getSnapshot().path).toBeTruthy();
    expect(beamStore.getSnapshot().path).not.toBe(path);
    expect(bubble()!.querySelector('[data-slot="beam-empty-state"]')).not.toBeNull();
    expect(bubble()!.querySelector<HTMLButtonElement>('[data-slot="beam-new-chat"]')!.disabled).toBe(false);
    expect(world.states[path]).toBeDefined();
    expect(calls("pi/session/delete")).toHaveLength(0);

    await typeAndSend("Another question");
    expect(beamStore.getSnapshot().path).not.toBe(path);
    await act(async () => spark().click());
    await act(async () => settle(20));
    expect(beamStore.getSnapshot().open).toBe(true);
    expect(beamStore.getSnapshot().path).toBeTruthy();
    expect(bubble()!.querySelector('[data-slot="beam-empty-state"]')).not.toBeNull();
  });

  it("clears a session remembered by an older build when the spark opens", async () => {
    const kept = `${BEAM_CWD}/kept.jsonl`;
    addSession(world, kept, BEAM_CWD);
    localStorage.setItem(BEAM_SESSION_STORAGE_KEY, kept);
    beamStore.reset();
    await mount();
    await openBubble();
    expect(beamStore.getSnapshot().path).toBeTruthy();
    expect(beamStore.getSnapshot().path).not.toBe(kept);
    expect(bubble()!.querySelector('[data-slot="beam-empty-state"]')).not.toBeNull();
    expect(calls("pi/session/delete")).toHaveLength(0);
    expect(world.states[kept]).toBeDefined();
  });

  it("closes on Escape from inside and hands focus back to the spark; a taken Escape is left alone", async () => {
    await mount();
    await openBubble();
    const taken = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    taken.preventDefault();
    await act(async () => textarea()!.dispatchEvent(taken));
    expect(bubble()).not.toBeNull();
    await act(async () => textarea()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await closeAndSettle();
    expect(bubble()).toBeNull();
    expect(spark().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(spark());
  });

  it("opens the session in the main view from the header and closes", async () => {
    await mount();
    await openBubble();
    await typeAndSend("Hello");
    const path = beamStore.getSnapshot().path!;
    await act(async () => bubble()!.querySelector<HTMLButtonElement>('[data-slot="beam-open-full"]')!.click());
    await closeAndSettle();
    expect(container.querySelector('[data-slot="main-current"]')?.textContent).toBe(path);
    expect(sessionsList.get().tab).toBe("code");
    expect(bubble()).toBeNull();
  });

  it("starts a chat in the window when the bubble is empty and maximize is pressed", async () => {
    await mount();
    await openBubble();
    // Nothing said yet: opening already prepared the session.
    const prepared = beamStore.getSnapshot().path;
    expect(prepared).toBeTruthy();
    const maximize = bubble()!.querySelector<HTMLButtonElement>('[data-slot="beam-open-full"]')!;
    expect(maximize.disabled).toBe(false);
    expect(maximize.getAttribute("aria-label") ?? maximize.getAttribute("title")).toContain("full view");
    await act(async () => maximize.click());
    await closeAndSettle();
    const opened = container.querySelector('[data-slot="main-current"]')?.textContent;
    expect(opened).toBe(prepared);
    expect(calls("session/new")).toHaveLength(1);
    // A Beam chat, in Beam's workspace, in the window rather than the bubble.
    expect(opened!.startsWith(`${BEAM_CWD}/`)).toBe(true);
    expect(world.states[opened!]?.agent?.kind).toBe("beam");
    expect(sessionsList.get().tab).toBe("code");
    expect(bubble()).toBeNull();
  });

  it("shows an eager-start refusal inside the bubble and offers an explicit retry", async () => {
    const refusal = "The model acme/fast is not available: connect acme in Settings → Providers and models, or choose another model for beam.";
    world.overrides["session/new"] = () => {
      throw new Error(refusal);
    };
    await mount();
    await openBubble();
    await act(async () => settle(50));
    expect(calls("session/new")).toHaveLength(1);
    expect(calls("session/prompt")).toHaveLength(0);
    expect(beamStore.getSnapshot().path).toBeUndefined();
    expect(bubble()!.querySelector('[role="alert"]')?.textContent).toContain(refusal);
    expect(textarea()).toBeNull();
    // And not only as a corner toast: the refusal is the bubble's to explain.
    expect(container.querySelector('[data-slot="main-toasts"]')?.textContent).toBe("");
    delete world.overrides["session/new"];
    await act(async () => bubble()!.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    await act(async () => settle(40));
    expect(bubble()!.querySelector('[role="alert"]')).toBeNull();
    expect(textarea()).not.toBeNull();
  });

  it("reuses the bubble's empty session from sidebar + and across repeated opens", async () => {
    await mount(); await openBubble();
    const path = beamStore.getSnapshot().path;
    await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="sidebar-beam-new"]')!.click());
    await act(async () => settle(30));
    expect(container.querySelector('[data-slot="main-current"]')?.textContent).toBe(path);
    await act(async () => spark().click()); await act(async () => settle(40));
    expect(beamStore.getSnapshot().path).toBe(path);
    expect(calls("session/new")).toHaveLength(1);
    expect(calls("session/prompt")).toHaveLength(0);
  });

  it("is a full-height sheet on a phone, with the same header", async () => {
    await mount("mobile");
    await openBubble();
    const panel = bubble()!;
    expect(panel.getAttribute("data-side")).toBe("bottom");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.querySelector('[data-slot="beam-close"]')).not.toBeNull();
    expect(panel.querySelector('[data-slot="beam-empty-state"]')).not.toBeNull();
    await act(async () => panel.querySelector<HTMLButtonElement>('[data-slot="beam-close"]')!.click());
    await closeAndSettle();
    expect(bubble()).toBeNull();
  });
});
