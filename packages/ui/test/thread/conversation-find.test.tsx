// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { useConversationFind, findTextRanges } from "../../src/components/thread/use-conversation-find.js";
import { SearchMessageContext, openConversationFind } from "../../src/components/thread/search-state.js";
import { ToolGroupRoot, ToolGroupTrigger, ToolGroupContent } from "../../src/components/assistant-ui/elements/tool-group.aui.js";
import { JsonViewer } from "../../src/components/assistant-ui/elements/json-viewer.js";
import { ToolFallbackContent, ToolFallbackResult, ToolFallbackRoot, ToolFallbackTrigger } from "../../src/components/assistant-ui/elements/tool-fallback.aui.js";
import { createConversationSearch } from "../../src/components/thread/conversation-search-cache.js";
import { toolSearchContent } from "@lasercode/protocol";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList);
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 200, 100, 20));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const messages: ThreadMessageLike[] = [{ id: "first", role: "user", content: [{ type: "text", text: "Apple Apple" }] }, { id: "last", role: "assistant", content: [{ type: "reasoning", text: "Apple thought" }] }];
type HistoryOptions = { partial?: boolean; loadAll?: () => Promise<boolean>; refusal?: string | undefined };
function Body(options: HistoryOptions) {
  const find = useConversationFind(options);
  return <div ref={find.root}>{find.bar}<div data-slot="thread-viewport"><div data-message-id="first">Apple Apple</div><SearchMessageContext value={find.selectedMessage === "last"}><div data-message-id="last"><ToolGroupRoot><ToolGroupTrigger>Reasoning</ToolGroupTrigger><ToolGroupContent>Apple thought</ToolGroupContent></ToolGroupRoot></div></SearchMessageContext></div></div>;
}
function Fixture({ data = messages, ...history }: { data?: ThreadMessageLike[] } & HistoryOptions) {
  const runtime = useExternalStoreRuntime({ messages: data, convertMessage: (m: ThreadMessageLike) => m, isRunning: false, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><TooltipProvider><Body {...history} /></TooltipProvider></AssistantRuntimeProvider>;
}
async function query(text: string) {
  await act(async () => {
    const input = container.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("finds full content, wraps both directions, reveals folded matches, and restores disclosure", async () => {
  await act(async () => root.render(<Fixture />));
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true })));
  await query("Apple");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("1 / 3");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Previous match"]')!.click());
  expect(container.querySelector('[role="status"]')?.textContent).toBe("3 / 3");
  expect(container.querySelector('[data-slot="tool-group-root"]')?.getAttribute("data-state")).toBe("open");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Next match"]')!.click());
  expect(container.querySelector('[role="status"]')?.textContent).toBe("1 / 3");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close search"]')!.click());
  expect(container.querySelector('[data-slot="conversation-search"]')).toBeNull();
  expect(container.querySelector('[data-slot="tool-group-root"]')?.getAttribute("data-state")).toBe("closed");
});
it("does not steal Ctrl+Shift+F and updates matches without replacing the focused input", async () => {
  await act(async () => root.render(<Fixture />));
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, shiftKey: true })));
  expect(container.querySelector("input")).toBeNull();
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true })));
  const input = container.querySelector("input")!;
  input.focus();
  await query("Apple");
  await act(async () => root.render(<Fixture data={[...messages, { id: "new", role: "user", content: [{ type: "text", text: "Apple" }] }]} />));
  expect(document.activeElement).toBe(input);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("1 / 4");
  await query("Missing");
  expect(container.querySelector('[aria-label="Next match"]')?.hasAttribute("disabled")).toBe(true);
});
it("makes partial search explicit, loads missing messages once, and restores keyboard focus after the reply", async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const data: ThreadMessageLike[] = [{ id: "tail", role: "user", content: "Recent only" }];
  const loadAll = vi.fn(async () => {
    await waiting;
    root.render(<Fixture data={[messages[0]!, ...data]} partial={false} loadAll={loadAll} />);
    return true;
  });
  await act(async () => root.render(<Fixture data={data} partial loadAll={loadAll} />));
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true })));
  await query("Apple");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("No matches");
  const button = [...container.querySelectorAll("button")].find(button => button.textContent === "Load all messages")!;
  expect(button).toBeDefined();
  await act(async () => { button.focus(); button.click(); button.click(); });
  expect(loadAll).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading…");
  await act(async () => { release(); await loadAll.mock.results[0]!.value; });
  expect(container.querySelector('[role="status"]')?.textContent).toBe("1 / 2");
  expect(document.activeElement).toBe(container.querySelector("input"));
});

it("explains a pressure refusal and never starts the whole-history read", async () => {
  const loadAll = vi.fn(async () => true);
  const refusal = "This window is low on memory, so loading a whole conversation at once is paused. Earlier messages still load a page at a time.";
  await act(async () => root.render(<Fixture partial loadAll={loadAll} refusal={refusal} />));
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true })));
  expect(container.textContent).toContain(refusal);
  const button = [...container.querySelectorAll("button")].find(candidate => candidate.textContent === "Load all messages")!;
  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(loadAll).not.toHaveBeenCalled();
});

it("keeps two mounted find fields and their native highlights independent", async () => {
  const highlights = new Map<string, { ranges: Range[] }>();
  vi.stubGlobal("CSS", { ...CSS, highlights });
  vi.stubGlobal("Highlight", class { constructor(...publicRanges: Range[]) { this.ranges = publicRanges; } ranges: Range[]; });
  try {
    // Two conversations on screen at once: each answers the find event with a
    // field of its own, over its own transcript.
    await act(async () => root.render(<><section data-test="main"><Fixture /></section><section data-test="second" tabIndex={-1}><Fixture /></section></>));
    await act(async () => openConversationFind("Apple"));
    const second = container.querySelector<HTMLElement>('[data-test="second"]')!;
    const input = second.querySelector("input")!;
    expect(container.querySelector<HTMLElement>('[data-test="main"]')!.querySelector("input")).not.toBe(input);
    await act(async () => { await vi.waitFor(() => expect(highlights.get("conversation-matches")?.ranges).toHaveLength(4)); });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-test="main"] [aria-label="Close search"]')!.click());
    expect(second.querySelector("input")).toBe(input);
    expect(highlights.get("conversation-matches")!.ranges).toHaveLength(2);
    await act(async () => second.querySelector<HTMLButtonElement>('[aria-label="Close search"]')!.click());
    expect(highlights.size).toBe(0);
  } finally { vi.unstubAllGlobals(); }
});
it("highlights across markup boundaries without indexing hidden controls or changing DOM", () => {
  container.innerHTML = '<p>Ap<strong>ple</strong></p><button>Apple</button><div hidden>Apple</div>';
  const original = container.innerHTML;
  const ranges = findTextRanges(container, "Apple");
  expect(ranges.map(r => r.toString())).toEqual(["Apple"]);
  expect(container.innerHTML).toBe(original);
});
it("keeps real labelled-row index occurrences aligned with paintable DOM ranges", async () => {
  const message = {
    id: "labelled", role: "assistant",
    content: [
      { type: "tool-call", toolName: "bash", toolCallId: "a", args: { command: "pnpm test packages/ui", activity_label: "checking-the-test-suite" }, result: "test run ok" },
      { type: "tool-call", toolName: "bash", toolCallId: "b", args: { command: "pnpm test packages/host", activity_label: "verifying_another_test" }, result: "host test ok" },
    ],
  } as never;
  await act(async () => root.render(
    <TooltipProvider>
      <div data-message-id="labelled">
        <ToolFallbackRoot defaultOpen>
          <ToolFallbackTrigger verb="Run" label="Checking the test suite" />
          <ToolFallbackContent>
            <pre data-search-content data-probe="command-a">pnpm test packages/ui</pre>
            <pre data-search-content data-probe="output-a">test run ok</pre>
          </ToolFallbackContent>
        </ToolFallbackRoot>
        <ToolFallbackRoot defaultOpen>
          <ToolFallbackTrigger verb="Run" label="Verifying another test" />
          <ToolFallbackContent>
            <pre data-search-content data-probe="command-b">pnpm test packages/host</pre>
            <pre data-search-content data-probe="output-b">host test ok</pre>
          </ToolFallbackContent>
        </ToolFallbackRoot>
      </div>
    </TooltipProvider>,
  ));

  const hits = createConversationSearch()([message], "test");
  const ranges = findTextRanges(container, "test");
  expect(hits).toHaveLength(6);
  expect(ranges).toHaveLength(hits.length);
  expect(hits.map(hit => hit.occurrence)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(ranges.map(range => range.startContainer.parentElement?.dataset.probe ?? range.startContainer.parentElement?.dataset.slot)).toEqual([
    "tool-fallback-trigger-label", "command-a", "output-a", "tool-fallback-trigger-label", "command-b", "output-b",
  ]);
  expect(findTextRanges(container, "Checking the test suite").map(range => range.toString())).toEqual(["Checking the test suite"]);
  expect(createConversationSearch()([message], "Checking the test suite")).toHaveLength(1);
  expect(createConversationSearch()([message], "checking-the-test-suite")).toHaveLength(0);
});
it("opens the excerpt's source instead of an earlier lower-priority mention", async () => {
  await act(async () => root.render(<Fixture data={[messages[1]!, messages[0]!]} />));
  await act(async () => openConversationFind("Apple", "user"));
  expect(container.querySelector('[role="status"]')?.textContent).toBe("2 / 3");
  expect(container.querySelector('[data-slot="tool-group-root"]')?.getAttribute("data-state")).toBe("closed");
});
it("reveals nested JSON values and highlights them, not identical keys, restoring folds after find", async () => {
  const args = { command: "hello", nested: { command: "command value", deeper: { text: "another command" } } };
  const render = (reveal: boolean) => <SearchMessageContext value={reveal}><div data-search-tool><span>command status</span><JsonViewer value={args} expandedDepth={1} /><ToolFallbackResult result={{ content: [{ type: "text", text: "command output" }], details: { hidden: "command" } }} /></div></SearchMessageContext>;
  await act(async () => root.render(render(false)));
  expect(findTextRanges(container, "command").map(r => r.toString())).toEqual(["command"]);
  await act(async () => root.render(render(true)));
  const content = toolSearchContent({ name: "future_tool", args, result: "command output" });
  expect(findTextRanges(container, "command").map(r => r.toString())).toEqual(content.flatMap(text => text.match(/command/g) ?? []));
  expect(findTextRanges(container, "helloanother")).toEqual([]);
  await act(async () => root.render(render(false)));
  expect(findTextRanges(container, "command")).toHaveLength(1);
});
