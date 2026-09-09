/**
 * M13-T52 — a jump or a fork hands the prompt's text back through
 * `setEditorText`; the store parks it on the view and the composer takes it.
 * Until this test the store kept the text and nothing ever read it, so a jump
 * left the composer empty.
 */
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../beam/fake-host.js")).FakeHostClient,
}));

import { ComposerPrimitive, useAui } from "@assistant-ui/react";
import { useEffect } from "react";
import { useHandedBackText } from "../../src/components/thread/Composer.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserProvider, useLaserStable, useLaserView } from "../../src/runtime/LaserProvider.js";
import { addSession, createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "../beam/fake-host.js";

const PATH = `${PROJECT_CWD}/s.jsonl`;
let stored: string | undefined;
let typed: ((text: string) => void) | undefined;

function Open() {
  const { actions } = useLaserStable();
  useEffect(() => {
    void actions.openSession(PATH);
  }, [actions]);
  return null;
}

function Taker() {
  useHandedBackText();
  const aui = useAui();
  stored = useLaserView()?.editorText;
  typed = (text) => aui.composer.setText(text);
  return null;
}

function Harness() {
  return (
    <LaserProvider url="ws://test">
      <TooltipProvider>
        <Open />
        <ComposerPrimitive.Root>
          <ComposerPrimitive.Input data-slot="composer-input" />
          <Taker />
        </ComposerPrimitive.Root>
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
  stored = undefined;
  world = createWorld();
  addSession(world, PATH, PROJECT_CWD);
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
/** The engine answering a jump with the prompt's text, as `pi/ui/event` carries it. */
const handBack = async (text: string) => {
  await act(async () => {
    FakeHostClient.current.notify("pi/ui/event", { path: PATH, method: "setEditorText", text });
  });
  await act(async () => settle(0));
};
const composerText = () => container.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "";

describe("text handed back by a jump", () => {
  it("becomes the composer's text and is then cleared from the view", async () => {
    await mount();
    expect(composerText()).toBe("");
    await handBack("make the tests green");
    expect(composerText()).toBe("make the tests green");
    expect(stored).toBeUndefined();
  });

  it("never overwrites something the person has since typed", async () => {
    await mount();
    await act(async () => typed?.("half a thought"));
    await handBack("make the tests green");
    expect(composerText()).toBe("half a thought");
    expect(stored).toBeUndefined();
  });

  it("is taken once: a second identical hand-back applies again only because it is a new event", async () => {
    await mount();
    await handBack("first");
    await act(async () => typed?.(""));
    await handBack("first");
    expect(composerText()).toBe("first");
  });
});
