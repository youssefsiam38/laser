// @vitest-environment happy-dom
/**
 * The pending tray above the composer (M13-T28), over the real provider and
 * the real thread runtime, with the host replaced by an in-memory peer.
 *
 * What is under test is the promise the row makes: leaving a message alone is
 * the default and it says so, and each of the three ways to change that is one
 * act that names exactly this message. Pointer and keyboard both, because the
 * row is a keyboard path as much as a mouse one — and the tray must come back
 * after a reload, because it lives in the worker, not in this browser.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../beam/fake-host.js")).FakeHostClient,
}));

import { ComposerPrimitive } from "@assistant-ui/react";
import type { PendingMessage } from "@lasercode/protocol";
import { ComposerQueue } from "../../src/components/assistant-ui/elements/message-queue.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserProvider, useLaserStable } from "../../src/runtime/LaserProvider.js";
import { addSession, createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "../beam/fake-host.js";
import { useEffect } from "react";

const PATH = `${PROJECT_CWD}/s.jsonl`;

const pending = (id: string, text: string, over: Partial<PendingMessage> = {}): PendingMessage => ({
  id,
  content: [{ type: "text", text }],
  text,
  images: 0,
  createdAt: "2026-09-08T00:00:00.000Z",
  state: "waiting",
  ...over,
});

function Open() {
  const { actions } = useLaserStable();
  useEffect(() => {
    void actions.openSession(PATH);
  }, [actions]);
  return null;
}

function Harness() {
  return (
    <LaserProvider url="ws://test">
      <TooltipProvider>
        <Open />
        <ComposerPrimitive.Root>
          <ComposerPrimitive.Input data-slot="composer-input" />
          <ComposerQueue />
        </ComposerPrimitive.Root>
      </TooltipProvider>
    </LaserProvider>
  );
}

let container: HTMLDivElement;
let root: Root;
let world: World;
let seq = 0;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  seq = 0;
  world = createWorld();
  addSession(world, PATH, PROJECT_CWD);
  world.states[PATH] = { ...world.states[PATH]!, isStreaming: true };
  FakeHostClient.reset(world);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const mount = async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => settle(20));
};

/** The worker publishing its tray, exactly as `session/update` carries it. */
const publish = async (messages: PendingMessage[]) => {
  await act(async () => {
    FakeHostClient.current.notify("session/update", {
      sessionPath: PATH,
      seq: ++seq,
      update: { kind: "pending_update", pending: messages },
      at: "2026-09-08T00:00:00.000Z",
    });
  });
  await act(async () => settle(0));
};

const rows = () => [...container.querySelectorAll<HTMLElement>('[data-slot="queued-row"]')];
const tray = () => container.querySelector<HTMLElement>('[data-slot="message-queue"]');
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
/** Radix opens on pointerdown, not click; a plain `.click()` never gets there. */
const openMenu = async (row: HTMLElement) => {
  await act(async () => control(row, "More").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })));
  await act(async () => settle(10));
};
const calls = (method: string) => world.calls.filter((call) => call.method === method);
const composerText = () => container.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "";

const control = (row: HTMLElement, label: string) =>
  [...row.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => (button.textContent ?? "").trim() === label || button.getAttribute("aria-label") === label,
  )!;

/** What a keyboard actually does to a focused button: focus it, then activate. */
const pressEnter = async (button: HTMLButtonElement) => {
  await act(async () => {
    button.focus();
    expect(document.activeElement).toBe(button);
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    // happy-dom does not synthesise the activation a browser does, so the
    // click that Enter produces on a focused button is dispatched here. What
    // the test is proving is that the control is a real, focusable button
    // with a click handler — not a div with a pointer listener.
    button.click();
  });
  await act(async () => settle(0));
};

describe("the pending tray", () => {
  it("draws nothing at all when nothing is waiting", async () => {
    await mount();
    expect(tray()).toBeNull();
  });

  it("says what happens if the row is left alone, and offers the three acts", async () => {
    await mount();
    await publish([pending("p-1", "run the tests")]);
    const [row] = rows();
    expect(row).toBeTruthy();
    expect(row!.textContent).toContain("run the tests");
    // The default outcome, stated on the row itself, with no legend.
    expect(row!.textContent).toContain("After this turn");
    expect(row!.dataset["lane"]).toBe("waiting");
    expect(control(row!, "Steer")).toBeTruthy();
    expect(control(row!, "Drop this message")).toBeTruthy();
    expect(control(row!, "More")).toBeTruthy();
    // The whole tray is announced, so a screen reader is not left counting rows.
    expect(tray()!.getAttribute("aria-label")).toBe("1 message waiting to go to the agent");
  });

  it("keeps many rows in the order they were written", async () => {
    await mount();
    await publish([pending("p-1", "first"), pending("p-2", "second"), pending("p-3", "third")]);
    expect(rows().map((row) => row.querySelector("button")!.textContent)).toEqual(["first", "second", "third"]);
    expect(tray()!.getAttribute("aria-label")).toBe("3 messages waiting to go to the agent");
  });

  it("steers exactly one message, by pointer and by keyboard, and stops nothing", async () => {
    await mount();
    await publish([pending("p-1", "use the other file"), pending("p-2", "then commit")]);
    await act(async () => control(rows()[0]!, "Steer").click());
    await act(async () => settle(0));
    expect(calls("session/pending/steer")).toEqual([{ method: "session/pending/steer", params: { path: PATH, id: "p-1" } }]);

    await pressEnter(control(rows()[1]!, "Steer"));
    expect(calls("session/pending/steer").map((call) => (call.params as { id: string }).id)).toEqual(["p-1", "p-2"]);
    // Steering is not stopping: nothing on this path cancels the run.
    expect(calls("session/cancel")).toEqual([]);
  });

  it("drops exactly one message, by pointer and by keyboard", async () => {
    await mount();
    await publish([pending("p-1", "never mind"), pending("p-2", "this one too")]);
    await act(async () => control(rows()[0]!, "Drop this message").click());
    await act(async () => settle(0));
    await pressEnter(control(rows()[1]!, "Drop this message"));
    expect(calls("session/pending/remove").map((call) => (call.params as { id: string }).id)).toEqual(["p-1", "p-2"]);
  });

  it("edits a row back into the composer through the overflow menu, and takes it out of the queue", async () => {
    await mount();
    await publish([pending("p-1", "run the tests")]);
    await openMenu(rows()[0]!);
    const edit = menuItems().find((item) => item.textContent?.includes("Edit in the composer"))!;
    expect(edit).toBeTruthy();
    await act(async () => edit.click());
    await act(async () => settle(10));
    expect(composerText()).toBe("run the tests");
    expect(calls("session/pending/remove").map((call) => (call.params as { id: string }).id)).toEqual(["p-1"]);
  });

  it("offers a single Clear only when more than one message is waiting", async () => {
    await mount();
    await publish([pending("p-1", "one")]);
    await openMenu(rows()[0]!);
    expect(menuItems().some((item) => item.textContent?.includes("Drop all"))).toBe(false);
    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    await publish([pending("p-1", "one"), pending("p-2", "two")]);
    await openMenu(rows()[0]!);
    const clear = menuItems().find((item) => item.textContent?.includes("Drop all"))!;
    await act(async () => clear.click());
    await act(async () => settle(10));
    // "Clear queue" means both queues, or the control is lying about its name.
    expect(calls("session/pending/clear")).toHaveLength(1);
    expect(calls("pi/session/clear_queue")).toHaveLength(1);
  });

  it("shows the whole message on demand, so a truncated row is never the only copy", async () => {
    const long = "check the migration, then the seed script, then the fixtures, then run everything twice";
    await mount();
    await publish([pending("p-1", long)]);
    const text = rows()[0]!.querySelector<HTMLButtonElement>("button")!;
    expect(text.getAttribute("aria-expanded")).toBe("false");
    expect(text.className).toContain("truncate");
    await pressEnter(text);
    expect(text.getAttribute("aria-expanded")).toBe("true");
    expect(text.className).not.toContain("truncate");
    expect(text.textContent).toBe(long);
  });

  it("draws a message on its way with no controls, because there is nothing left to change", async () => {
    await mount();
    await publish([pending("p-1", "going in now", { state: "delivering" })]);
    const [row] = rows();
    expect(row!.dataset["lane"]).toBe("sending");
    expect(row!.textContent).toContain("Sending now");
    expect(control(row!, "Steer")).toBeUndefined();
    expect(control(row!, "Drop this message")).toBeUndefined();
  });

  it("keeps a failed delivery with its reason, and still lets the person act on it", async () => {
    await mount();
    await publish([pending("p-1", "run the tests", { state: "failed", error: "The provider is not reachable." })]);
    const [row] = rows();
    expect(row!.dataset["lane"]).toBe("failed");
    expect(row!.textContent).toContain("The provider is not reachable.");
    expect(control(row!, "Steer")).toBeTruthy();
    expect(control(row!, "Drop this message")).toBeTruthy();
  });

  it("draws a message the engine already holds as up next, with none of the three", async () => {
    await mount();
    await act(async () => {
      FakeHostClient.current.notify("session/update", {
        sessionPath: PATH,
        seq: ++seq,
        update: { kind: "queue_update", steering: ["already on its way"], followUp: [] },
        at: "2026-09-08T00:00:00.000Z",
      });
    });
    await act(async () => settle(0));
    const [row] = rows();
    expect(row!.dataset["lane"]).toBe("steer");
    expect(row!.textContent).toContain("Up next");
    // The engine has no verb for one item, so no control claims otherwise.
    expect(control(row!, "Steer")).toBeUndefined();
    expect(control(row!, "Drop this message")).toBeUndefined();
    expect(control(row!, "More")).toBeUndefined();
  });

  it("puts the steered lane above the waiting one, which is also the order they reach the agent", async () => {
    await mount();
    await publish([pending("p-1", "waiting here")]);
    await act(async () => {
      FakeHostClient.current.notify("session/update", {
        sessionPath: PATH,
        seq: ++seq,
        update: { kind: "queue_update", steering: ["going in next"], followUp: [] },
        at: "2026-09-08T00:00:00.000Z",
      });
    });
    await act(async () => settle(0));
    expect(rows().map((row) => row.dataset["lane"])).toEqual(["steer", "waiting"]);
  });

  it("comes back after a reload, because it lives in the worker and not in this browser", async () => {
    // The worker answers `session/pending/list` for a client that has just
    // arrived; a reload has no watermark to replay from, and the run the tray
    // belongs to is still going.
    world.overrides["session/pending/list"] = (() => ({ messages: [pending("p-7", "survived the reload")] })) as never;

    await mount();
    await act(async () => settle(10));
    expect(rows()[0]?.textContent).toContain("survived the reload");
    expect(calls("session/pending/list")).toHaveLength(1);

    // A reload is a new client against the same worker: everything in this
    // browser goes, and the row is still there afterwards.
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    await act(async () => settle(10));
    expect(rows()[0]?.textContent).toContain("survived the reload");
  });
});
