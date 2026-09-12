import { FileOpenerProvider } from "../../src/components/thread/FileOpener.js";
import type { ThreadMessageLike } from "@assistant-ui/react";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserStoreProvider, createStateStore } from "../../src/runtime/LaserProvider.js";
import { projectMessages } from "../../src/runtime/projection.js";
import { blocksFromEntries, initialState, reduce } from "../../src/store.js";
import { sessionState } from "../agents/fixtures.js";
import { wrapFileAttachment } from "../../src/runtime/attachments.js";
import { ThreadMessage } from "../../src/components/thread/messages.js";

const stable = vi.hoisted(() => ({ client: { request: vi.fn(async () => ({ models: [] })) }, actions: { listModels: vi.fn(async () => []), send: vi.fn(), openSession: vi.fn() } }));
vi.mock("@/runtime", async original => ({ ...await original<typeof import("../../src/runtime/index.js")>(), useLaserStable: () => stable, useActivityDetailLevel: () => "everything" }));
vi.mock("@/dialogs", () => ({ ToolRowDialog: () => null, useRegisterToolRow: () => {}, DialogBody: () => null, dialogFormOf: () => ({}), uiResponseFor: () => ({}) }));
let root: Root;
let container: HTMLDivElement;
const SESSION = "/project/session.jsonl";
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; stable.client.request.mockClear(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function mount(entries: unknown[], leafId: string) {
  let state = reduce(initialState, { type: "opened", state: sessionState({ path: SESSION, cwd: "/project" }) });
  state = reduce(state, { type: "destination", destination: { phase: "ready-code", intent: 0, code: { kind: "project-session", project: "/project", path: SESSION } } });
  state = reduce(state, { type: "hydrate", path: SESSION, entries, leafId });
  const store = createStateStore(state);
  function Fixture() {
    const { messages } = projectMessages({ blocks: blocksFromEntries(entries, leafId), running: false, dialogs: [] });
    const runtime = useExternalStoreRuntime({ convertMessage: (message: ThreadMessageLike) => message, messages, isRunning: false, onNew: async () => {} });
    return <AssistantRuntimeProvider runtime={runtime}><FileOpenerProvider><ThreadPrimitive.Root><ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages></ThreadPrimitive.Root></FileOpenerProvider></AssistantRuntimeProvider>;
  }
  await act(async () => root.render(<LaserStoreProvider store={store}><TooltipProvider><Fixture /></TooltipProvider></LaserStoreProvider>));
}
it("mounts a derived file card above the existing write diff without eager file reads", async () => {
  await mount([
    { id: "a", parentId: null, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "src/example.ts", content: "const answer = 42;\nexport { answer };" } }] } },
    { id: "r", parentId: "a", type: "message", message: { role: "toolResult", toolCallId: "write-1", toolName: "write", isError: false, content: [{ type: "text", text: "Wrote file" }] } },
  ], "r");
  const card = container.querySelector('[data-slot="artifact-card"]')!;
  expect(card?.textContent).toContain("TypeScript source · 2 lines");
  const open = [...card.querySelectorAll("button")].find(node => node.textContent === "Open")!;
  expect(open).toBeDefined();
  expect(open.getAttribute("data-variant")).toBe("outline");
  expect(container.querySelector('[data-slot="code-diff"]')?.textContent).toContain("const answer");
  expect(stable.client.request.mock.calls.some(call => (call as unknown[])[0] === "pi/project/read")).toBe(false);
});
it.each([false, true])("offers an edited file only after a successful edit (failed=%s)", async failed => {
  await mount([
    { id: "a", parentId: null, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "src/example.ts", edits: [{ oldText: "before", newText: "after" }] } }] } },
    { id: "r", parentId: "a", type: "message", message: { role: "toolResult", toolCallId: "edit-1", toolName: "edit", isError: failed, content: [{ type: "text", text: failed ? "Could not find text" : "Updated file" }] } },
  ], "r");
  expect(container.querySelectorAll('[data-slot="artifact-card"]')).toHaveLength(failed ? 0 : 1);
  expect(container.querySelector('[data-slot="code-diff"]')?.textContent).toContain("after");
});
it("opens an image attachment from the matching persisted entry without reading a file", async () => {
  const png = "iVBORw0KGgo=";
  await mount([{ id: "u", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "Look at this" }, { type: "image", mimeType: "image/png", data: png }] } }], "u");
  const imageButton = container.querySelector<HTMLButtonElement>('[data-slot="message-images"] button')!;
  expect(imageButton).not.toBeNull();
  expect(container.querySelector('[data-slot="message-image"]')?.getAttribute("alt")).toBe("Image 1");
  expect(container.textContent).not.toContain("image attached");
  // Safari-style pointer activation does not focus the trigger before opening.
  expect(document.activeElement).not.toBe(imageButton);
  await act(async () => { imageButton.click(); });
  expect(document.querySelector('[role="dialog"] img')?.getAttribute("src")).toBe(`data:image/png;base64,${png}`);
  expect(stable.client.request.mock.calls.some(call => (call as unknown[])[0] === "pi/project/read")).toBe(false);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(imageButton);
});

it("renders three retained images above the words", async () => {
  await mount([{ id: "u", type: "message", message: { role: "user", content: [{ type: "text", text: "Three pictures" }, ...[1, 2, 3].map(() => ({ type: "image", mimeType: "image/png", data: "cGlj" }))] } }], "u");
  const images = [...container.querySelectorAll('[data-slot="message-image"]')];
  expect(images.map(image => image.getAttribute("alt"))).toEqual(["Image 1", "Image 2", "Image 3"]);
  expect(images[0]!.compareDocumentPosition(container.querySelector('[data-role="user"] p')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it("hides the wrapper, opens attached file content and returns focus to its chip", async () => {
  const content = "# Attached document";
  const wrapper = wrapFileAttachment({ name: "notes.md", mediaType: "text/markdown", size: content.length, content });
  await mount([{ id: "u", type: "message", message: { role: "user", content: [{ type: "text", text: `Read this\n\n${wrapper}` }] } }], "u");
  expect(container.querySelector('[data-role="user"] p')?.textContent).toBe("Read this");
  expect(container.textContent).not.toContain("attached-file");
  const chip = container.querySelector<HTMLButtonElement>('[data-slot="file-chip"]')!;
  expect(chip.textContent).toContain("notes.md");
  await act(async () => chip.click());
  expect(document.querySelector('[role="dialog"] h1')?.textContent).toBe("Attached document");
  expect(stable.client.request.mock.calls.some(call => (call as unknown[])[0] === "pi/project/read")).toBe(false);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(document.activeElement).toBe(chip);
});
