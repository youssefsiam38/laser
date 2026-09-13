// @vitest-environment happy-dom
/**
 * M16-T32: a streamed token touches the row it is streaming into.
 *
 * Both cases are the real seam, not a stub: the real external-store runtime,
 * the real bounded window and the real find hook. Each fails on the behaviour
 * the browser profile found — settled rows re-rendered with the window, and
 * the find hook held a subscription to every message while it was closed, so
 * the thread column re-rendered on every streamed batch.
 */
import { act, memo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, useAuiState, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranscriptViewportProvider, WindowedMessages } from "../../src/components/thread/transcript-viewport.js";
import { useConversationFind } from "../../src/components/thread/use-conversation-find.js";
import { createStateStore, LaserStoreProvider } from "../../src/runtime/LaserProvider.js";
import { initialState } from "../../src/store.js";

const renders = new Map<string, number>();
vi.mock("../../src/components/thread/messages.js", async () => {
  const { useAuiState } = await import("@assistant-ui/react");
  return {
    ThreadMessage: function Message() {
      const id = useAuiState(s => s.message.id);
      const text = useAuiState(s => s.message.parts.map(part => (part.type === "text" ? part.text : "")).join(""));
      renders.set(id, (renders.get(id) ?? 0) + 1);
      return <p>{text}</p>;
    },
  };
});

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  renders.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 600, this.hasAttribute("data-window-message") ? 100 : 700);
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const convert = (message: ThreadMessageLike) => message;
const settled = (count: number): ThreadMessageLike[] =>
  Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, role: index % 2 ? "assistant" : "user", content: `Row ${index} of the transcript` }));

let findRenders = 0;
let selectedMessage: string | undefined;
/**
 * Memoised, and its props never change: it re-renders only when something it
 * subscribes to changes. That is what makes the closed-bar count meaningful —
 * the fixture around it re-renders for every delta, this does not have to.
 */
const FindProbe = memo(function FindProbe() {
  findRenders++;
  const find = useConversationFind({});
  selectedMessage = find.selectedMessage;
  return <div ref={find.root} />;
});

function Fixture({ count, live, withFind = false }: { count: number; live: string; withFind?: boolean }) {
  const messages: ThreadMessageLike[] = [...settled(count), { id: "live", role: "assistant", content: live, status: { type: "running" } }];
  const runtime = useExternalStoreRuntime({ messages, convertMessage: convert, isRunning: true, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><TranscriptViewportProvider>
    {withFind ? <FindProbe /> : null}
    <WindowedMessages />
  </TranscriptViewportProvider></AssistantRuntimeProvider>;
}

const frames = async (count = 3) => {
  for (let frame = 0; frame < count; frame++) await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
};

it("re-renders the streaming row and no settled row for each delta", async () => {
  const store = createStateStore({ ...initialState, current: "/streaming" });
  const render = (live: string) => act(async () => root.render(<LaserStoreProvider store={store}><Fixture count={12} live={live} /></LaserStoreProvider>));
  await render("Reviewing");
  await frames();
  const mounted = [...host.querySelectorAll("[data-window-message]")].map(row => row.getAttribute("data-window-message")!);
  expect(mounted).toContain("live");
  expect(mounted.length).toBeGreaterThan(1);
  const before = new Map(renders);

  let live = "Reviewing";
  for (let delta = 0; delta < 8; delta++) {
    live += ` step ${delta},`;
    await render(live);
  }
  await frames();

  for (const id of mounted) {
    if (id === "live") continue;
    expect(`${id}: ${renders.get(id) ?? 0}`).toBe(`${id}: ${before.get(id) ?? 0}`);
  }
  expect(renders.get("live")).toBeGreaterThan(before.get("live")!);
  expect(host.querySelector('[data-window-message="live"]')?.textContent).toBe(live);
});

it("holds no transcript subscription while find is closed, and reads the live transcript once it is open", async () => {
  const store = createStateStore({ ...initialState, current: "/streaming" });
  const render = (live: string) => act(async () => root.render(<LaserStoreProvider store={store}><Fixture count={4} live={live} withFind /></LaserStoreProvider>));
  // Only the transcript changes below; the owner is re-rendered by this test on
  // purpose, so the count that matters is taken from a settled render.
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 600, 40)] as unknown as DOMRectList);
  await render("Reviewing");
  await frames();

  const closedRenders = findRenders;
  let live = "Reviewing";
  for (let delta = 0; delta < 6; delta++) { live += ` step ${delta},`; await render(live); }
  await frames();
  // Six deltas through the real runtime, and the closed bar did not wake once.
  expect(findRenders).toBe(closedRenders);

  await act(async () => { window.dispatchEvent(new CustomEvent("conversation-find", { detail: { query: "step 5" } })); });
  await frames();
  expect(selectedMessage).toBe("live");
});
