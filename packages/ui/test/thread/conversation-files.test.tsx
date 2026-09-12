import { FileOpenerProvider } from "../../src/components/thread/FileOpener.js";
import type { ThreadMessageLike } from "@assistant-ui/react";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, TextMessagePartProvider, useExternalStoreRuntime } from "@assistant-ui/react";
import type { ProjectFileContent } from "@lasercode/protocol";
import { MarkdownText } from "../../src/components/assistant-ui/elements/markdown-text.js";
import { FileLinkDirectory } from "../../src/components/ui/source-file-link.js";
import { looksLikeFilePath, projectDirectivePath, projectReferencePath } from "../../src/components/ui/project-file-link.js";
import { findTextRanges } from "../../src/components/thread/use-conversation-find.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { toast } from "sonner";
const observed = new Map<Element, (visible: boolean) => void>();
class VisibilityObserver {
  private targets = new Set<Element>();
  constructor(private callback: IntersectionObserverCallback) {}
  observe(target: Element) { this.targets.add(target); observed.set(target, visible => this.callback([{ target, isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
  disconnect() { for (const target of this.targets) observed.delete(target); }
}
const visibility = async (visible: boolean) => { await act(async () => { for (const change of observed.values()) change(visible); }); };
const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/runtime", () => ({ useLaserStable: () => ({ client: transport }) }));
let container: HTMLDivElement, root: Root;
const image: ProjectFileContent = { path: "images/view.png", name: "view.png", mediaType: "image/png", encoding: "base64", content: "cGlj", size: 3, modifiedAt: "", truncated: false };
const file: ProjectFileContent = { ...image, path: "docs/guide.md", name: "guide.md", mediaType: "text/markdown", encoding: "utf8", content: "# The guide" };
beforeEach(() => { vi.stubGlobal("IntersectionObserver", VisibilityObserver); observed.clear(); globalThis.IS_REACT_ACT_ENVIRONMENT = true; transport.request.mockReset().mockResolvedValue(file); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function Fixture({ text, cwd = "/project", native = true }: { text: string; cwd?: string; native?: boolean }) {
  const runtime = useExternalStoreRuntime({ convertMessage: (message: ThreadMessageLike) => message, messages: [], onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><TooltipProvider><FileOpenerProvider scope={cwd}><FileLinkDirectory value={cwd}><TextMessagePartProvider text={text}><MarkdownText nativeFiles={native} /></TextMessagePartProvider></FileLinkDirectory></FileOpenerProvider></TooltipProvider></AssistantRuntimeProvider>;
}
const mount = async (text: string, cwd?: string, native?: boolean) => { await act(async () => root.render(<Fixture text={text} {...(cwd ? { cwd } : {})} {...(native !== undefined ? { native } : {})} />)); };
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); };

it("recognises machine file targets and conservative code paths without treating URLs as files", () => {
  expect(projectReferencePath("docs/guide.md:12", "/project")).toBe("/project/docs/guide.md");
  expect(projectReferencePath("/project/src/a.ts", "/project")).toBe("/project/src/a.ts");
  expect(projectReferencePath("../outside.md", "/project")).toBe("/outside.md");
  expect(projectReferencePath("/project-other/a.md", "/project")).toBe("/project-other/a.md");
  for (const target of ["https://example.test/a.md", "//example.test/a.md", "#heading", "javascript:alert(1)"]) expect(projectReferencePath(target, "/project")).toBeUndefined();
  expect(projectReferencePath("docs/guide.md")).toBeUndefined();
  expect(projectDirectivePath("docs/with%20literal.md", "/project")).toBe("/project/docs/with%20literal.md");
  for (const target of ["../../etc/passwd", "/etc/passwd"]) expect(projectDirectivePath(target, "/project")).toBe("/etc/passwd");
  expect(looksLikeFilePath("packages/a/b.ts:12")).toBe(true);
  for (const text of ["words", "foo.bar", "x / y", "https://example.test/a.ts", "run src/file.ts"]) expect(looksLikeFilePath(text)).toBe(false);
});
it("opens a Markdown file link with one lazy owning-project read and returns focus", async () => {
  await mount("Read [docs/guide.md](docs/guide.md:12).");
  const chip = container.querySelector<HTMLButtonElement>('[data-slot="file-chip"]')!;
  expect(chip.textContent).toBe("docs/guide.md");
  expect(findTextRanges(container, "docs/guide.md").map(range => range.toString())).toEqual(["docs/guide.md"]);
  expect(transport.request).not.toHaveBeenCalled();
  await act(async () => { chip.focus(); chip.click(); });
  expect(transport.request).toHaveBeenCalledExactlyOnceWith("pi/project/read", { cwd: "/project", path: "/project/docs/guide.md" });
  expect(document.querySelector('[role="dialog"] h1')?.textContent).toBe("The guide");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await settle();
  expect(document.activeElement).toBe(chip);
});
it("opens an outside Markdown link in the viewer and labels its absolute host path", async () => {
  transport.request.mockResolvedValue({ ...file, path: "/outside/guide.md" });
  await mount("[outside guide](/outside/guide.md)");
  await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="file-chip"]')!.click());
  expect(transport.request).toHaveBeenCalledExactlyOnceWith("pi/project/read", { cwd: "/project", path: "/outside/guide.md" });
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("/outside/guide.md");
  expect(document.querySelector('[role="dialog"] h1')?.textContent).toBe("The guide");
});
it("retains Open in editor as a second explicit action", async () => {
  const openSourceFile = vi.fn(async () => ({ opened: true })); vi.stubGlobal("desktop", { openSourceFile });
  await mount("[guide](docs/guide.md)");
  await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="file-chip"]')!.click());
  expect(openSourceFile).not.toHaveBeenCalled();
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent === "Open in editor")!.click());
  expect(openSourceFile).toHaveBeenCalledWith("/project/docs/guide.md");
});
it("turns path code into a chip without guessing from prose or nesting interactive code in a link", async () => {
  await mount('Plain docs/guide.md and `docs/guide.md` and `variable` and [`src/a.ts`](src/a.ts).');
  expect(container.querySelectorAll('[data-slot="file-chip"]')).toHaveLength(2);
  expect(container.querySelector('button button')).toBeNull();
  expect(container.textContent).toContain("Plain docs/guide.md");
  expect(container.querySelector('code')?.textContent).toBe("variable");
});
it("keeps a failed chip mounted and focused, reporting failure only on activation and allowing retry", async () => {
  const error = vi.spyOn(toast, "error").mockImplementation(() => "test");
  transport.request.mockRejectedValue(new Error("Missing file"));
  await mount("[missing](docs/missing.md)");
  const chip = container.querySelector<HTMLButtonElement>('[data-slot="file-chip"]')!;
  await act(async () => chip.focus());
  expect(container.querySelector('[data-slot="file-chip"]')).toBe(chip);
  expect(document.activeElement).toBe(chip);
  expect(error).not.toHaveBeenCalled();
  await act(async () => chip.click());
  expect(error).toHaveBeenCalledExactlyOnceWith("Missing file");
  expect(document.activeElement).toBe(chip);
  transport.request.mockResolvedValue(file);
  await act(async () => chip.click());
  expect(document.querySelector('[role="dialog"] h1')?.textContent).toBe("The guide");
  error.mockRestore();
});
it("fetches a project Markdown image as bounded base64 data and opens the same bytes", async () => {
  transport.request.mockResolvedValue(image);
  await mount("![Landscape](images/view.png)");
  expect(transport.request).not.toHaveBeenCalled();
  await visibility(true);
  expect(transport.request).toHaveBeenCalledExactlyOnceWith("pi/project/read", { cwd: "/project", path: "/project/images/view.png" });
  expect(container.querySelector('img')?.getAttribute("src")).toBe("data:image/png;base64,cGlj");
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open Landscape"]')!.click());
  expect(document.querySelector('[role="dialog"] img')?.getAttribute("src")).toBe("data:image/png;base64,cGlj");
  expect(transport.request).toHaveBeenCalledTimes(1);
});
it.each(["missing", "truncated", "not-image"])("shows alt text for %s project images", async kind => {
  if (kind === "missing") transport.request.mockRejectedValue(new Error("Gone"));
  else transport.request.mockResolvedValue(kind === "truncated" ? { ...image, truncated: true } : file);
  await mount("![Unavailable landscape](images/view.png)");
  await visibility(true);
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toBe("Unavailable landscape");
});
it("keeps remote images and links unchanged and leaves capture source links opening the editor", async () => {
  await mount("![Remote](https://example.test/image.png) [Website](https://example.test)");
  expect(container.querySelector('img')?.getAttribute("src")).toBe("https://example.test/image.png");
  expect(container.querySelector('a')?.getAttribute("href")).toBe("https://example.test");
  expect(transport.request).not.toHaveBeenCalled();
  const openSourceFile = vi.fn(async () => ({ opened: true })); vi.stubGlobal("desktop", { openSourceFile });
  await mount("[source](docs/guide.md)", "/capture", false);
  expect(container.querySelector('[data-slot="file-chip"]')).toBeNull();
  await act(async () => container.querySelector('a')!.click());
  expect(openSourceFile).toHaveBeenCalledWith("/capture/docs/guide.md");
});
it("deduplicates visible images, releases offscreen bytes and reuses the cache on return", async () => {
  transport.request.mockResolvedValue(image);
  await mount("![One](images/view.png) ![Two](images/view.png)");
  expect(transport.request).not.toHaveBeenCalled();
  await visibility(true);
  expect(transport.request).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll("img")).toHaveLength(2);
  await visibility(false);
  expect(container.querySelectorAll("img")).toHaveLength(0);
  await visibility(true);
  expect(container.querySelectorAll("img")).toHaveLength(2);
  expect(transport.request).toHaveBeenCalledTimes(1);
});
it("does not open a late chip result after its owning reference unmounts", async () => {
  let finish!: (value: ProjectFileContent) => void;
  transport.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await mount("[guide](docs/guide.md)");
  await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="file-chip"]')!.click());
  await mount("Reference removed");
  await act(async () => finish(file));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it("ignores an image reply from the previous owning directory", async () => {
  let finish!: (value: ProjectFileContent) => void;
  transport.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await mount("![Old](images/view.png)", "/old");
  await visibility(true);
  transport.request.mockResolvedValue({ ...image, content: "bmV3" });
  await mount("![New](images/view.png)", "/new");
  await visibility(true);
  await act(async () => finish(image));
  expect(container.querySelector('img')?.getAttribute("src")).toBe("data:image/png;base64,bmV3");
});
