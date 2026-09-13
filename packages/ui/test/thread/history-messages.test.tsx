// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WindowedMessages, TranscriptViewportProvider } from "../../src/components/thread/transcript-viewport.js";
import { createStateStore, LaserStoreProvider } from "../../src/runtime/LaserProvider.js";
import { initialState } from "../../src/store.js";

// Isolate row rendering, not the message-id provider/runtime boundary under test.
// Local disclosure state must remain with its message when earlier rows arrive.
vi.mock("../../src/components/thread/messages.js", async () => {
  const { useAuiState } = await import("@assistant-ui/react");
  const { useState } = await import("react");
  return { ThreadMessage: function Message() {
    const id = useAuiState(s => s.message.id);
    const [open, setOpen] = useState(false);
    return <button aria-label={`${id} details`} aria-expanded={open} onClick={() => setOpen(value => !value)}>{id}</button>;
  } };
});
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); container.style.fontSize = "14px"; container.style.lineHeight = "21px";
  document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("keeps focus and a manual disclosure on the same message across an asynchronous prepend", async () => {
  let prepend!: () => void;
  const store = createStateStore({ ...initialState, current: "/history" });
  function Fixture() {
    const [messages, setMessages] = useState<ThreadMessageLike[]>([{ id: "tail", role: "assistant", content: "Tail message" }]);
    prepend = () => setMessages(previous => [{ id: "older", role: "user", content: "Earlier message" }, ...previous]);
    const runtime = useExternalStoreRuntime({ messages, convertMessage: (message: ThreadMessageLike) => message, isRunning: false, onNew: async () => {} });
    return <LaserStoreProvider store={store}><AssistantRuntimeProvider runtime={runtime}><TranscriptViewportProvider><WindowedMessages /></TranscriptViewportProvider></AssistantRuntimeProvider></LaserStoreProvider>;
  }
  await act(async () => root.render(<Fixture />));
  const tail = container.querySelector<HTMLButtonElement>('[aria-label="tail details"]')!;
  tail.focus();
  await act(async () => tail.click());
  expect(tail.getAttribute("aria-expanded")).toBe("true");
  await act(async () => { await Promise.resolve(); prepend(); });
  expect(container.querySelector('[aria-label="tail details"]')).toBe(tail);
  expect(document.activeElement).toBe(tail);
  expect(tail.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector('[aria-label="older details"]')?.getAttribute("aria-expanded")).toBe("false");
});
