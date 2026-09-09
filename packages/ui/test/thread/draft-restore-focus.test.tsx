// @vitest-environment happy-dom
/**
 * Restoring an unsent draft puts the person in the composer with the caret at
 * the end of the restored text — the next act is to finish the sentence, not
 * to click into the field. Found from the offer's own composer root, never the
 * first textarea in the document.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client.js", async (original) => ({
  ...(await original<typeof import("../../src/client.js")>()),
  HostClient: (await import("../beam/fake-host.js")).FakeHostClient,
}));

import { ComposerPrimitive } from "@assistant-ui/react";
import { useEffect } from "react";
import { ComposerDraftRestore, writeDraft } from "../../src/components/assistant-ui/elements/draft-restore.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserProvider, useLaserStable } from "../../src/runtime/LaserProvider.js";
import { addSession, createWorld, FakeHostClient, PROJECT_CWD, settle, type World } from "../beam/fake-host.js";

const PATH = `${PROJECT_CWD}/s.jsonl`;

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
        {/* A stray textarea first in the document: the wrong field to land in. */}
        <textarea data-slot="stray" />
        <ComposerPrimitive.Root data-slot="composer">
          <ComposerDraftRestore />
          <ComposerPrimitive.Input data-slot="composer-input" />
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

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe("restoring a draft", () => {
  it("puts the text back and the person in the field, caret at the end", async () => {
    writeDraft(PATH, "half a thought");
    await act(async () => root.render(<Harness />));
    await act(async () => settle(20));
    const restore = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Restore");
    expect(restore).toBeDefined();
    await act(async () => restore!.click());
    await act(async () => nextFrame());
    const field = container.querySelector<HTMLTextAreaElement>('[data-slot="composer-input"]')!;
    expect(field.value).toBe("half a thought");
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe("half a thought".length);
    expect(container.querySelector('[data-slot="stray"]')).not.toBe(document.activeElement);
    // The offer is spent.
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Restore")).toBe(false);
  });
});
