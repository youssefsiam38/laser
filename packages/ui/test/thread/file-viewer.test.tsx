// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";
import type { ProjectFileContent } from "@lasercode/protocol";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { FileCard } from "../../src/components/thread/FileCard.js";
import { FileViewer } from "../../src/components/thread/FileViewer.js";

const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/runtime", () => ({ useLaserStable: () => ({ client: transport }), useLaserState: (selector: (state: unknown) => unknown) => selector({ current: "/session", open: { "/session": { state: { cwd: "/project" } } } }) }));
let root: Root;
let container: HTMLDivElement;
const file = (overrides: Partial<ProjectFileContent> = {}): ProjectFileContent => ({ path: "src/example.ts", name: "example.ts", mediaType: "application/octet-stream", size: 29, modifiedAt: "2026-09-11T00:00:00.000Z", encoding: "utf8", content: 'const answer: number = 42;', truncated: false, ...overrides });
function Fixture({ children }: { children: React.ReactNode }) {
  const runtime = useExternalStoreRuntime({ messages: [], isRunning: false, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><TooltipProvider>{children}</TooltipProvider></AssistantRuntimeProvider>;
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  transport.request.mockReset().mockResolvedValue(file());
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === name || node.getAttribute("aria-label") === name)!;
const click = async (element: HTMLElement) => { await act(async () => { element.focus(); element.click(); }); };
const mount = async () => { await act(async () => root.render(<Fixture><FileCard path="src/example.ts" /></Fixture>)); await click(button("Open")); };
const until = async (assertion: () => void) => { await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); assertion(); }, { timeout: 5000 }); };

it("reads with the owning cwd, highlights code, closes on Escape and restores focus", async () => {
  await mount();
  expect(transport.request).toHaveBeenCalledExactlyOnceWith("pi/project/read", { cwd: "/project", path: "src/example.ts" });
  await until(() => expect(document.querySelector('[role="dialog"] code')?.textContent).toContain("const answer"));
  await until(() => expect(document.querySelector('[role="dialog"] code span[style*="--syntax-"]')).not.toBeNull());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Copy path");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await until(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(document.activeElement).toBe(button("Open"));
});
it("defaults Markdown to safe Preview and switches to highlighted Source", async () => {
  transport.request.mockResolvedValue(file({ path: "readme.md", name: "readme.md", mediaType: "text/markdown", content: '# A document\n\n<script>globalThis.compromised = true</script>' }));
  await mount();
  expect(document.querySelector('[role="dialog"] h1')?.textContent).toBe("A document");
  expect(document.querySelector('[role="dialog"] script')).toBeNull();
  expect(button("Preview").getAttribute("aria-selected")).toBe("true");
  await click(button("Source"));
  await until(() => expect(document.querySelector('[role="tabpanel"] code')?.textContent).toContain("# A document"));
  expect(button("Source").getAttribute("aria-selected")).toBe("true");
});
it("draws an image from base64 and does not fetch transcript bytes", async () => {
  await act(async () => root.render(<Fixture><FileViewer open source={{ name: "Attached image", mediaType: "image/png", data: "iVBORw0KGgo=" }} onOpenChange={() => {}} /></Fixture>));
  expect(document.querySelector('img')?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
  expect(transport.request).not.toHaveBeenCalled();
});
it("draws project PNGs as images and labels a truncated text preview", async () => {
  transport.request.mockResolvedValue(file({ name: "image.png", path: "image.png", mediaType: "image/png", encoding: "base64", content: "iVBORw0KGgo=" }));
  await mount();
  expect(document.querySelector('[role="dialog"] img')?.getAttribute("src")).toContain("data:image/png;base64,");
  await click(button("Close"));
  transport.request.mockResolvedValue(file({ truncated: true }));
  await click(button("Open"));
  expect(document.querySelector('[role="status"]')?.textContent).toContain("This preview is truncated");
});
it("does not try to decode an incomplete image or claim PNG is unsupported", async () => {
  transport.request.mockResolvedValue(file({ name: "image.png", path: "image.png", mediaType: "image/png", encoding: "base64", content: "iVBORw0KGgo=", truncated: true }));
  await mount();
  expect(document.querySelector('[role="dialog"] img')).toBeNull();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("This image is too large to preview here");
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("does not draw PNG");
});
it("shows loading, a readable failure and a working retry", async () => {
  let reject!: (reason: Error) => void;
  transport.request.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await mount();
  expect(document.querySelector('[role="status"]')?.textContent).toContain("Opening file");
  await act(async () => reject(new Error("That file is outside this project.")));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("That file is outside this project.");
  await click(button("Try again"));
  await until(() => expect(document.querySelector('[role="dialog"] code')?.textContent).toContain("const answer"));
});
it("ignores an old reply after closing and reopening", async () => {
  let resolve!: (value: ProjectFileContent) => void;
  transport.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await mount(); await click(button("Close")); await click(button("Open"));
  await act(async () => resolve(file({ content: "stale reply" })));
  await until(() => expect(document.querySelector('[role="dialog"] code')?.textContent).toContain("const answer"));
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("stale reply");
});
it("preserves literal filename characters when opening the native editor", async () => {
  const openSourceFile = vi.fn(async () => ({ opened: true }));
  vi.stubGlobal("desktop", { openSourceFile });
  const path = "notes#100%?:3.ts";
  await act(async () => root.render(<Fixture><FileCard path={path} /></Fixture>));
  await click(button("Open in editor"));
  expect(openSourceFile).toHaveBeenCalledWith(`/project/${path}`);
  await click(button("Open"));
  expect(transport.request).toHaveBeenCalledWith("pi/project/read", { cwd: "/project", path });
  const editor = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === "Open in editor")!;
  await click(editor);
  expect(openSourceFile).toHaveBeenLastCalledWith(`/project/${path}`);
});
it("does not interpret HTML or binary content as a document", async () => {
  transport.request.mockResolvedValue(file({ path: "unsafe.html", mediaType: "text/html", content: '<iframe src="https://example.invalid"></iframe>' }));
  await mount();
  await until(() => expect(document.querySelector('[role="dialog"] code')?.textContent).toContain("<iframe"));
  expect(document.querySelector('[role="dialog"] iframe')).toBeNull();
  await click(button("Close"));
  transport.request.mockResolvedValue(file({ path: "archive.zip", mediaType: "application/zip", content: "\0bytes" }));
  await click(button("Open"));
  expect(document.querySelector('[data-slot="open-externally"]')?.textContent).toContain("does not draw archive");
});
