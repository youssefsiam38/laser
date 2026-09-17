// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";

import { MessageActions } from "../../src/components/assistant-ui/elements/message-actions.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("keeps the whole-history action visible but disabled with the refusal explanation", async () => {
  const refusal = "This window is low on memory, so loading a whole conversation at once is paused. Earlier messages still load a page at a time.";
  const load = vi.fn();
  function Fixture() {
    const runtime = useExternalStoreRuntime({ messages: [], isRunning: false, onNew: async () => {} });
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <TooltipProvider>
          <ThreadPrimitive.Root data-slot="thread">
            <MessageActions copied={false} onCopy={() => {}} onLoadHistory={load} loadHistoryRefusal={refusal} />
          </ThreadPrimitive.Root>
        </TooltipProvider>
      </AssistantRuntimeProvider>
    );
  }
  await act(async () => root.render(<Fixture />));
  await act(async () => {
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="More"]')!;
    const event = new PointerEvent("pointerdown", { bubbles: true, button: 0 });
    Object.defineProperty(event, "pointerType", { value: "mouse" });
    trigger.dispatchEvent(event);
  });
  const quote = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(candidate => candidate.textContent?.includes("Quote selection"));
  expect(quote?.getAttribute("data-disabled")).not.toBeNull();
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(candidate => candidate.textContent?.includes("Load history and versions"));
  expect(item).toBeDefined();
  expect(item?.getAttribute("data-disabled")).not.toBeNull();
  expect(item?.textContent).toContain(refusal);
  await act(async () => item?.click());
  expect(load).not.toHaveBeenCalled();
});
