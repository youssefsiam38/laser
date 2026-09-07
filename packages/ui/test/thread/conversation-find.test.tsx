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
import { ToolFallbackResult } from "../../src/components/assistant-ui/elements/tool-fallback.aui.js";
import { toolSearchContent } from "@lasercode/protocol";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList);
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 200, 100, 20));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const messages: ThreadMessageLike[] = [{ id: "first", role: "user", content: [{ type: "text", text: "Apple Apple" }] }, { id: "last", role: "assistant", content: [{ type: "reasoning", text: "Apple thought" }] }];
function Body() {
  const find = useConversationFind();
  return <div ref={find.root}>{find.bar}<div data-slot="thread-viewport"><div data-message-id="first">Apple Apple</div><SearchMessageContext value={find.selectedMessage === "last"}><div data-message-id="last"><ToolGroupRoot><ToolGroupTrigger>Reasoning</ToolGroupTrigger><ToolGroupContent>Apple thought</ToolGroupContent></ToolGroupRoot></div></SearchMessageContext></div></div>;
}
function Fixture({ data = messages }: { data?: ThreadMessageLike[] }) {
  const runtime = useExternalStoreRuntime({ messages: data, convertMessage: (m: ThreadMessageLike) => m, isRunning: false, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><TooltipProvider><Body /></TooltipProvider></AssistantRuntimeProvider>;
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
it("highlights across markup boundaries without indexing hidden controls or changing DOM", () => {
  container.innerHTML = '<p>Ap<strong>ple</strong></p><button>Apple</button><div hidden>Apple</div>';
  const original = container.innerHTML;
  const ranges = findTextRanges(container, "Apple");
  expect(ranges.map(r => r.toString())).toEqual(["Apple"]);
  expect(container.innerHTML).toBe(original);
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
