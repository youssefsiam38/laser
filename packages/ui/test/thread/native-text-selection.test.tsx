/** @vitest-environment happy-dom */
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { MessageActions } from "../../src/components/assistant-ui/elements/message-actions.js";
import {
  ComposerQuotePreview,
  TranscriptQuoteShortcut,
  transcriptSelectionQuote,
} from "../../src/components/assistant-ui/elements/quote.aui.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

let container: HTMLDivElement;
let root: Root;

function Fixture() {
  const runtime = useExternalStoreRuntime({
    convertMessage: (message: ThreadMessageLike) => message,
    messages: [] as ThreadMessageLike[],
    isRunning: false,
    onNew: async () => {},
  });
  const thread = useRef<HTMLDivElement>(null);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
      <ThreadPrimitive.Root ref={thread} data-slot="thread">
        <div data-message-id="assistant-one">
          <p>Native selection keeps every selected word.</p>
          <p>Triple click keeps the whole paragraph.</p>
          <MessageActions copied={false} onCopy={() => {}} />
        </div>
        <div data-message-id="assistant-two">A second message.</div>
        <ComposerPrimitive.Root data-slot="composer">
          <ComposerQuotePreview />
          <ComposerPrimitive.Input aria-label="Message" />
        </ComposerPrimitive.Root>
        <TranscriptQuoteShortcut thread={thread} />
      </ThreadPrimitive.Root>
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Fixture />));
});

afterEach(async () => {
  window.getSelection()?.removeAllRanges();
  await act(async () => root.unmount());
  container.remove();
});

function select(node: Node, from: number, to: number): Selection {
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

it("leaves pointer selection native and never mounts a custom toolbar", async () => {
  const text = container.querySelector("p")!.firstChild!;
  const selection = select(text, 7, 16);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  await act(async () => undefined);

  expect(selection.toString()).toBe("selection");
  expect(container.querySelector('[data-slot="selection-toolbar"]')).toBeNull();
  expect(document.body.querySelector('[data-slot="selection-toolbar"]')).toBeNull();
});

it("quotes only a same-message native selection through Ctrl/Cmd+Shift+9", async () => {
  const text = container.querySelector("p")!.firstChild!;
  const selection = select(text, 0, text.textContent!.length);
  expect(transcriptSelectionQuote(selection, container.querySelector('[data-slot="thread"]'))).toEqual({
    text: "Native selection keeps every selected word.",
    messageId: "assistant-one",
  });

  let accepted = true;
  await act(async () => {
    accepted = document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "(",
      code: "Digit9",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));
    await new Promise(resolve => requestAnimationFrame(resolve));
  });

  expect(accepted).toBe(false);
  expect(container.querySelector('[data-slot="composer-quote-text"]')?.textContent)
    .toBe("Native selection keeps every selected word.");
  expect(window.getSelection()?.isCollapsed).toBe(true);
  expect(document.activeElement).toBe(container.querySelector('textarea[aria-label="Message"]'));
});

it("does not consume the shortcut for a selection spanning messages", () => {
  const first = container.querySelector('[data-message-id="assistant-one"] p')!.firstChild!;
  const second = container.querySelector('[data-message-id="assistant-two"]')!.firstChild!;
  const range = document.createRange();
  range.setStart(first, 0);
  range.setEnd(second, second.textContent!.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);

  expect(transcriptSelectionQuote(selection, container.querySelector('[data-slot="thread"]'))).toBeUndefined();
  expect(document.dispatchEvent(new KeyboardEvent("keydown", {
    key: "(",
    code: "Digit9",
    metaKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  }))).toBe(false);
  expect(container.querySelector('[data-slot="composer-quote"]')).toBeNull();
  expect(selection.isCollapsed).toBe(false);
});

it("captures the selected message when its touch menu opens", async () => {
  const text = container.querySelector("p")!.firstChild!;
  const selection = select(text, 7, 16);
  const more = container.querySelector<HTMLButtonElement>('[aria-label="More"]')!;

  await act(async () => {
    more.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch" }));
  });
  selection.removeAllRanges();

  const item = document.body.querySelector<HTMLElement>('[role="menuitem"]')!;
  expect(item.textContent).toContain("Quote selection");
  expect(item.getAttribute("data-disabled")).toBeNull();
  await act(async () => {
    item.click();
    await new Promise(resolve => requestAnimationFrame(resolve));
  });

  expect(container.querySelector('[data-slot="composer-quote-text"]')?.textContent).toBe("selection");
});

it("remembers selection after composer focus and explains an unusable chord", async () => {
  const text = container.querySelector("p")!.firstChild!;
  select(text, 0, 6);
  document.dispatchEvent(new Event("selectionchange"));
  const composer = container.querySelector<HTMLTextAreaElement>('[data-slot="composer"] textarea')!;
  composer.focus();
  window.getSelection()?.removeAllRanges();

  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "(", code: "Digit9", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
    }));
    await new Promise(resolve => requestAnimationFrame(resolve));
  });
  expect(container.querySelector('[data-slot="composer-quote-text"]')?.textContent).toBe("Native");
});
