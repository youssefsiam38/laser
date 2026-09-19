/** @vitest-environment happy-dom */
/**
 * "Jump to latest" has one writer (M16-T87, D-303, B1).
 *
 * The pill is `ThreadPrimitive.ScrollToBottom`, and that primitive carries a
 * scroll of its own: `threadViewportStore.scrollToBottom()` reaches the thread
 * viewport's `scrollTo({ top: scrollHeight })` — a raw write on the transcript
 * scroller, outside the engine — and leaves an intent behind that re-fires on
 * every content resize until the element reports bottom. That is a second
 * authority over the exact pixels the virtualizer is converging on, during the
 * measurement storm a jump sets off.
 *
 * `createActionButton` composes the two handlers with radix's
 * `composeEventHandlers`, which honours `defaultPrevented`, so the element's
 * own `preventDefault` leaves the primitive deciding whether the button exists
 * and the engine deciding where the transcript goes.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  useThreadViewportStore,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ScrollAnchor } from "../../src/components/assistant-ui/elements/scroll-anchor.js";
import { LaserStoreProvider, type StateStore } from "../../src/runtime/LaserProvider.js";
import { TranscriptPresentation } from "../../src/runtime/transcript-presentation.js";
import { initialState } from "../../src/store.js";
import {
  TranscriptViewportProvider,
  useTranscriptViewport,
  type TranscriptViewport,
} from "../../src/components/thread/transcript-viewport.js";

const store: StateStore = {
  presentation: new TranscriptPresentation(),
  getSnapshot: () => initialState,
  subscribe: () => () => {},
  dispatch() {},
};

let container: HTMLDivElement;
let root: Root;
let controller!: TranscriptViewport;
/** The primitive's own way of asking the viewport to move, for the control. */
let primitiveScrollToBottom!: () => void;
/** Every raw scroll write the thread viewport performed. */
const writes: number[] = [];

const MESSAGES: ThreadMessageLike[] = [
  { id: "m1", role: "user", content: "Where did we get to?" },
  { id: "m2", role: "assistant", content: "Here." },
];

function Capture() {
  controller = useTranscriptViewport();
  const store = useThreadViewportStore();
  primitiveScrollToBottom = () => store.getState().scrollToBottom({ behavior: "auto" });
  return null;
}

/** A scroller with real metrics: tall content, and the reader well above it. */
function install(node: HTMLElement | null) {
  if (!node || writes.length > 0 || Object.getOwnPropertyDescriptor(node, "scrollHeight")) return;
  let top = 0;
  Object.defineProperties(node, {
    clientHeight: { value: 600 },
    scrollHeight: { value: 3000 },
    scrollTop: { get: () => top, set: (value: number) => { top = value; } },
    scrollTo: { value: (arg: { top?: number } | number) => { const next = typeof arg === "number" ? arg : arg?.top ?? top; writes.push(next); top = next; } },
  });
}

function Fixture() {
  const runtime = useExternalStoreRuntime({
    convertMessage: (message: ThreadMessageLike) => message,
    messages: MESSAGES,
    isRunning: false,
    onNew: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TranscriptViewportProvider>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Viewport
            autoScroll={false}
            scrollToBottomOnRunStart={false}
            scrollToBottomOnInitialize={false}
            scrollToBottomOnThreadSwitch={false}
            data-slot="thread-viewport"
            ref={install}
          >
            <Capture />
            <ScrollAnchor />
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </TranscriptViewportProvider>
    </AssistantRuntimeProvider>
  );
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  writes.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<LaserStoreProvider store={store}><Fixture /></LaserStoreProvider>));
  // Away from the end, which is the only state in which the pill exists.
  const viewport = container.querySelector<HTMLElement>('[data-slot="thread-viewport"]')!;
  await act(async () => { viewport.dispatchEvent(new Event("scroll")); });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("takes the transcript to the newest turn through the engine, and lets nothing else write a scroll position", async () => {
  const button = container.querySelector<HTMLButtonElement>('[data-slot="scroll-anchor"]');
  expect(button, "the pill is hidden while the reader is at the end").not.toBeNull();
  const latest = vi.spyOn(controller, "latest");

  await act(async () => { button!.click(); });

  expect(latest).toHaveBeenCalledTimes(1);
  expect(writes, "assistant-ui wrote a scroll position of its own").toEqual([]);

  // The control: the primitive's scroll really does reach this scroller, so
  // the empty list above is a handler that did not run, not a spy that cannot
  // see it.
  await act(async () => { primitiveScrollToBottom(); });
  expect(writes).toEqual([3000]);
});
