// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, useAuiState, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranscriptViewportProvider, WindowedMessages } from "../../src/components/thread/transcript-viewport.js";
import { createStateStore, LaserStoreProvider } from "../../src/runtime/LaserProvider.js";
import { initialState } from "../../src/store.js";

// The rendering cost of a row is orthogonal to provider/canonical-data ownership.
// Keep the real external runtime and identity-keyed message providers under test.
vi.mock("../../src/components/thread/messages.js", async () => {
  const { useAuiState } = await import("@assistant-ui/react");
  return { ThreadMessage: function Message() { const id = useAuiState(s => s.message.id); return <button>{id}</button>; } };
});
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); host.style.fontSize = "14px"; host.style.lineHeight = "21px";
  document.body.append(host); root = createRoot(host);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    // Deterministic measured row geometry; no skipped/intrinsic content boxes.
    return new DOMRect(0, 0, 600, this.hasAttribute("data-window-message") ? 100 : 700);
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const convert = (message: ThreadMessageLike) => message;
function CanonicalCount() { const count = useAuiState(s => s.thread.messages.length); return <output>{count}</output>; }
function Fixture({ count }: { count: number }) {
  const messages: ThreadMessageLike[] = Array.from({ length: count }, (_, i) => ({ id: `row-${i}`, role: i % 2 ? "assistant" : "user", content: `Row ${i}` }));
  const runtime = useExternalStoreRuntime({ messages, convertMessage: convert, isRunning: false, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><TranscriptViewportProvider><CanonicalCount /><WindowedMessages /></TranscriptViewportProvider></AssistantRuntimeProvider>;
}
it.each([40, 240, 2000, 10000])("mounts a bounded provider window without slicing %i canonical messages", async count => {
  const store = createStateStore({ ...initialState, current: "/canonical" });
  await act(async () => root.render(<LaserStoreProvider store={store}><Fixture count={count} /></LaserStoreProvider>));
  for (let frame = 0; frame < 4; frame++) await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
  expect(host.querySelector("output")!.textContent).toBe(String(count));
  const rows = [...host.querySelectorAll("[data-window-message]")];
  expect(rows.length).toBeGreaterThan(1);
  expect(rows.length).toBeLessThan(40);
  expect(rows.at(-1)?.textContent).toBe(`row-${count - 1}`);
  expect(rows[0]?.textContent).not.toBe("row-0");
});
