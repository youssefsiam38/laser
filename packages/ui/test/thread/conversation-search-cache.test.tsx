// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessage, type ThreadMessageLike } from "@assistant-ui/react";
import { afterEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { createConversationSearch } from "../../src/components/thread/conversation-search-cache.js";
import { useConversationFind } from "../../src/components/thread/use-conversation-find.js";
import { partSearchContent } from "../../src/components/thread/search-text.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("reuses settled matches and projections while the last of 2,000 messages streams", () => {
  const project = vi.fn(partSearchContent), search = createConversationSearch(project);
  const messages = Array.from({ length: 2000 }, (_, i) => ({ id: String(i), role: "assistant", content: [{ type: "text", text: "Apple" }] } as ThreadMessage));
  const first = search(messages, "Apple");
  expect(project).toHaveBeenCalledTimes(2000);
  project.mockClear();
  const next = [...messages.slice(0, -1), { ...messages.at(-1)!, content: [{ type: "text" as const, text: "Apple Apple" }] }];
  const hits = search(next, "Apple");
  expect(project).toHaveBeenCalledTimes(1);
  expect(hits).toEqual(createConversationSearch()(next, "Apple"));
  expect(hits[0]).toBe(first[0]);
  expect(hits).toHaveLength(2001);
  search(next, "absent");
  expect(project).toHaveBeenCalledTimes(1);
});

it("keeps native ranges through scroll/selection and only traverses changed or remounted messages", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList);
  const geometry = vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 200, 100, 20));
  vi.stubGlobal("Highlight", class extends Set<Range> { constructor(...ranges: Range[]) { super(ranges); } });
  const highlights = new Map<string, Set<Range>>();
  vi.stubGlobal("CSS", { ...CSS, highlights });
  const nodes = Array.from({ length: 240 }, (_, i): ThreadMessageLike => ({ id: String(i), role: "user", content: [{ type: "text", text: "Apple" }] }));
  function Body({ revision }: { revision: number }) {
    const find = useConversationFind();
    return <div ref={find.root}>{find.bar}<div data-slot="thread-viewport">{nodes.map((m, i) =>
      <div key={i === 239 ? revision : m.id} data-message-id={m.id}>Apple</div>)}</div></div>;
  }
  function Fixture({ revision = 0 }) {
    const runtime = useExternalStoreRuntime({ messages: nodes, convertMessage: (m: ThreadMessageLike) => m, isRunning: false, onNew: async () => {} });
    return <AssistantRuntimeProvider runtime={runtime}><TooltipProvider><Body revision={revision} /></TooltipProvider></AssistantRuntimeProvider>;
  }
  const container = document.createElement("div"), root = createRoot(container);
  document.body.append(container);
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); }); };
  try {
    await act(async () => root.render(<Fixture />));
    await act(async () => window.dispatchEvent(new CustomEvent("conversation-find", { detail: { query: "Apple" } })));
    await settle();
    await act(async () => { await vi.waitFor(() => expect(geometry).toHaveBeenCalled()); });
    expect(highlights.get("conversation-matches")?.size).toBe(240);
    const first = [...highlights.get("conversation-matches")!][0];
    const walks = vi.spyOn(document, "createTreeWalker");
    const viewport = container.querySelector('[data-slot="thread-viewport"]')!;
    for (let i = 0; i < 20; i++) viewport.dispatchEvent(new Event("scroll"));
    await settle();
    expect(walks).not.toHaveBeenCalled();
    const last = container.querySelector('[data-message-id="239"]')!;
    last.firstChild!.textContent = "Apple Apple";
    await settle();
    expect(walks).toHaveBeenCalledTimes(1);
    expect(highlights.get("conversation-matches")?.size).toBe(241);
    expect([...highlights.get("conversation-matches")!][0]).toBe(first);
    walks.mockClear();
    await act(async () => root.render(<Fixture revision={1} />));
    await settle();
    expect(walks).toHaveBeenCalledTimes(1);
    expect(highlights.get("conversation-matches")?.size).toBe(240);
    walks.mockClear(); geometry.mockClear();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.click());
    await act(async () => { await vi.waitFor(() => expect(geometry).toHaveBeenCalled()); });
    // One selected-result geometry traversal, not 240 highlight traversals.
    expect(walks).toHaveBeenCalledTimes(1);
    expect([...highlights.get("conversation-matches")!][0]).toBe(first);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close search"]')!.click());
    expect(highlights.size).toBe(0);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
