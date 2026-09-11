// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";
import type { ProjectFileContent } from "@lasercode/protocol";
import { MAX_DIFF_LINES } from "../../src/components/thread/diff.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { FileCard } from "../../src/components/thread/FileCard.js";
import { FileViewer } from "../../src/components/thread/FileViewer.js";
import { attachmentFile } from "../../src/components/preview/media.js";
import { MAX_PREVIEW_CHARS } from "../../src/components/preview/display.js";

const highlighted = vi.hoisted(() => ({ inputs: [] as string[] }));
vi.mock("@/components/assistant-ui/elements/shiki-highlighter", async original => {
  const actual = await original<typeof import("../../src/components/assistant-ui/elements/shiki-highlighter.js")>();
  return { ...actual, SyntaxHighlighter: (props: Parameters<typeof actual.SyntaxHighlighter>[0]) => {
    highlighted.inputs.push(props.code);
    return <actual.SyntaxHighlighter {...props} />;
  } };
});

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
  highlighted.inputs = [];
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
it("uses Shiki's extension grammar when the worker only identifies plain text", async () => {
  transport.request.mockResolvedValue(file({ path: "example.svelte", name: "example.svelte", mediaType: "text/plain", content: "<script>const answer = 42;</script>\n<h1>{answer}</h1>" }));
  await act(async () => root.render(<Fixture><FileViewer open source={{ request: { cwd: "/project", path: "example.svelte" } }} onOpenChange={() => {}} /></Fixture>));
  await until(() => expect(document.querySelector('[role="dialog"] code')?.textContent).toContain("const answer"));
  await until(() => expect(document.querySelector('[role="dialog"] code span[style*="--syntax-"]')).not.toBeNull());
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
  await act(async () => root.render(<Fixture><FileViewer open source={{ file: attachmentFile({ mimeType: "image/png", data: "iVBORw0KGgo=" }, "Attached image") }} onOpenChange={() => {}} /></Fixture>));
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
  expect(document.querySelector('[data-slot="open-externally"]')?.textContent).toContain("archive preview is not available");
});

it.each(["LICENSE", "notes.unfamiliar"])("renders readable %s even with a generic media type", async path => {
  transport.request.mockResolvedValue(file({ path, name: path, content: "Readable document body" }));
  await mount();
  expect(document.querySelector('[data-slot="text-preview"]')?.textContent).toContain("Readable document body");
  expect(document.querySelector('[data-slot="open-externally"]')).toBeNull();
});
it("keeps metadata-only PDFs out of the text preview", async () => {
  transport.request.mockResolvedValue(file({ path: "report.pdf", name: "report.pdf", encoding: "base64", content: "" }));
  await mount();
  expect(document.querySelector('[data-slot="open-externally"]')?.textContent).toContain("binary file preview is not available");
  expect(document.querySelector('[data-slot="text-preview"]')).toBeNull();
});
it("bounds 300 KB of source before the real highlighter and offers the editor", async () => {
  const openSourceFile = vi.fn(async () => ({ opened: true }));
  vi.stubGlobal("desktop", { openSourceFile });
  transport.request.mockResolvedValue(file({ content: "// " + "x".repeat(300_000) + "TAIL_NOT_SHOWN" }));
  await mount();
  expect(highlighted.inputs.length).toBeGreaterThan(0);
  expect(highlighted.inputs.every(text => text.length <= MAX_PREVIEW_CHARS)).toBe(true);
  await until(() => expect(document.querySelector('[role="dialog"] code')?.textContent?.length).toBe(MAX_PREVIEW_CHARS));
  expect(document.querySelector('[role="status"]')?.textContent).toContain("This preview is truncated");
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("TAIL_NOT_SHOWN");
  const editor = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === "Open in editor")!;
  await click(editor);
  expect(openSourceFile).toHaveBeenCalledWith("/project/src/example.ts");
});
it("bounds Markdown before previewing and uses the same head for Source", async () => {
  transport.request.mockResolvedValue(file({ path: "readme.md", name: "readme.md", mediaType: "text/markdown", content: "# Head\n\n" + "word ".repeat(60_000) + "TAIL_NOT_SHOWN" }));
  await mount();
  expect(document.querySelector('[role="tabpanel"] h1')?.textContent).toBe("Head");
  expect(document.querySelector('[role="tabpanel"]')?.textContent?.length).toBeLessThanOrEqual(MAX_PREVIEW_CHARS);
  expect(document.querySelector('[role="status"]')?.textContent).toContain("This preview is truncated");
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("TAIL_NOT_SHOWN");
  await click(button("Source"));
  expect(highlighted.inputs.length).toBeGreaterThan(0);
  expect(highlighted.inputs.every(text => text.length <= MAX_PREVIEW_CHARS)).toBe(true);
});
it("bounds a diff through the canonical line budget and reports truncation", async () => {
  const patch = "@@ -0,0 +1,650 @@\n" + Array.from({ length: 650 }, (_, i) => `+added-line-${i}`).join("\n");
  transport.request.mockResolvedValue(file({ path: "changes.patch", mediaType: "text/x-patch", content: patch }));
  await mount();
  const body = document.querySelector('[role="dialog"]')?.textContent;
  expect(body).toContain(`added-line-${MAX_DIFF_LINES - 1}`);
  expect(body).not.toContain(`added-line-${MAX_DIFF_LINES}`);
  expect(document.querySelector('[role="status"]')?.textContent).toContain("This preview is truncated");
});
