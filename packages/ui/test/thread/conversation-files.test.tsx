// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, TextMessagePartProvider, useExternalStoreRuntime } from "@assistant-ui/react";
import type { ProjectFileContent } from "@lasercode/protocol";
import { MarkdownText } from "../../src/components/assistant-ui/elements/markdown-text.js";
import { FileLinkDirectory } from "../../src/components/ui/source-file-link.js";
import { looksLikeFilePath, projectReferencePath } from "../../src/components/ui/project-file-link.js";
import { findTextRanges } from "../../src/components/thread/use-conversation-find.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/runtime", () => ({ useLaserStable: () => ({ client: transport }) }));
let container: HTMLDivElement, root: Root;
const image: ProjectFileContent = { path: "images/view.png", name: "view.png", mediaType: "image/png", encoding: "base64", content: "cGlj", size: 3, modifiedAt: "", truncated: false };
const file: ProjectFileContent = { ...image, path: "docs/guide.md", name: "guide.md", mediaType: "text/markdown", encoding: "utf8", content: "# The guide" };
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; transport.request.mockReset().mockResolvedValue(file); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function Fixture({ text, cwd = "/project", native = true }: { text: string; cwd?: string; native?: boolean }) {
  const runtime = useExternalStoreRuntime({ messages: [], onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><TooltipProvider><FileLinkDirectory value={cwd}><TextMessagePartProvider text={text}><MarkdownText nativeFiles={native} /></TextMessagePartProvider></FileLinkDirectory></TooltipProvider></AssistantRuntimeProvider>;
}
const mount = async (text: string, cwd?: string, native?: boolean) => { await act(async () => root.render(<Fixture text={text} {...(cwd ? { cwd } : {})} {...(native !== undefined ? { native } : {})} />)); };
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); };

it("recognises only project-contained file targets and conservative code paths", () => {
  expect(projectReferencePath("docs/guide.md:12", "/project")).toBe("/project/docs/guide.md");
  expect(projectReferencePath("/project/src/a.ts", "/project")).toBe("/project/src/a.ts");
  for (const target of ["../outside.md", "/project-other/a.md", "https://example.test/a.md", "//example.test/a.md", "#heading", "javascript:alert(1)"]) expect(projectReferencePath(target, "/project")).toBeUndefined();
  expect(projectReferencePath("docs/guide.md")).toBeUndefined();
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
it("leaves a failed reference as authored text without requesting a web-origin URL", async () => {
  transport.request.mockRejectedValue(new Error("Missing file"));
  await mount("[missing](docs/missing.md)");
  await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="file-chip"]')!.focus());
  expect(container.querySelector('[data-slot="file-chip"]')).toBeNull();
  expect(container.textContent).toBe("missing");
  expect(container.querySelector("a")).toBeNull();
});
it("fetches a project Markdown image as bounded base64 data and opens the same bytes", async () => {
  transport.request.mockResolvedValue(image);
  await mount("![Landscape](images/view.png)");
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
it("ignores an image reply from the previous owning directory", async () => {
  let finish!: (value: ProjectFileContent) => void;
  transport.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await mount("![Old](images/view.png)", "/old");
  transport.request.mockResolvedValue({ ...image, content: "bmV3" });
  await mount("![New](images/view.png)", "/new");
  await act(async () => finish(image));
  expect(container.querySelector('img')?.getAttribute("src")).toBe("data:image/png;base64,bmV3");
});
