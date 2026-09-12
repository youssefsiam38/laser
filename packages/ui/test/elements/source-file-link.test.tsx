// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { fileLinkPath, markdownUrl } from "../../src/lib/file-links.js";
import { FileLinkDirectory, SourceFileLink } from "../../src/components/ui/source-file-link.js";
import { ConfidenceMarker } from "../../src/components/assistant-ui/elements/confidence-marker.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); vi.unstubAllGlobals(); });

it("resolves file locations against the owning project, never the web origin", () => {
  expect(fileLinkPath("src/app.ts:12:4", "/project")).toBe("/project/src/app.ts");
  expect(fileLinkPath("../other/a%20b.md#L4", "/project")).toBe("/other/a b.md");
  expect(fileLinkPath("file:///project/a%20b.md#L8")).toBe("/project/a b.md");
  for (const href of ["https://example.com/a.md", "mailto:hi@example.com", "#note", "file://other/a.md", "//example.com/a", "javascript:alert(1)", "a.md", "/bad%00.md"]) expect(fileLinkPath(href)).toBeUndefined();
});

it("preserves safe Markdown URLs without allowing local image loads or executable schemes", () => {
  expect(markdownUrl("file:///project/a.md", "href")).toBe("file:///project/a.md");
  for (const url of ["javascript:alert(1)", " data:text/html,hi", "vscode://file/x", "java\nscript:x"]) expect(markdownUrl(url, "href")).toBe("");
  expect(markdownUrl("file:///project/a.png", "src")).toBe("");
  expect(markdownUrl("https://example.com/a", "href")).toBe("https://example.com/a");
});

it("opens native paths on click and prevents browser navigation including middle clicks", async () => {
  const open = vi.fn().mockResolvedValue({ opened: true }); vi.stubGlobal("desktop", { openSourceFile: open });
  await act(async () => root.render(<FileLinkDirectory.Provider value="/captured-project"><SourceFileLink href="src/main.ts#L8">Source</SourceFileLink></FileLinkDirectory.Provider>));
  const link = container.querySelector("a")!;
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => { link.dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(true);
  expect(open).toHaveBeenCalledWith("/captured-project/src/main.ts");
  const middle = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
  link.dispatchEvent(middle); expect(middle.defaultPrevented).toBe(true);
  expect(link.dataset.filePath).toBe("/captured-project/src/main.ts");
});

it("copies the host path in browsers instead of opening a different computer's file", async () => {
  vi.stubGlobal("desktop", undefined);
  const copy = vi.fn().mockResolvedValue(undefined); vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
  await act(async () => root.render(<SourceFileLink href="/host/AGENTS.md">File</SourceFileLink>));
  await act(async () => container.querySelector("a")!.click());
  expect(copy).toHaveBeenCalledWith("/host/AGENTS.md");
});

it("source markers have component-only disclosure and keyboard file activation", async () => {
  const open = vi.fn().mockResolvedValue({ opened: true }); vi.stubGlobal("desktop", { openSourceFile: open });
  await act(async () => root.render(<ConfidenceMarker claims={[{id:"one",text:"Exact source text.",source:{kind:"file",label:"Project rules",path:"/project/AGENTS.md"}}]}/>));
  const marker = container.querySelector<HTMLButtonElement>('[aria-label="Inspect source: Project rules"]')!;
  expect(marker.hasAttribute("title")).toBe(false);
  expect(container.querySelectorAll("[title]")).toHaveLength(0);
  await act(async () => { marker.focus(); });
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Source identity retained");
  await act(async () => { window.dispatchEvent(new Event("resize")); });
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => { container.querySelector('[data-request-source-text]')!.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientX: 120, clientY: 80 })); });
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Source identity retained");
  await act(async () => { marker.click(); });
  expect(open).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Instruction source panel"]')?.textContent).toContain("/project/AGENTS.md");
  await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === "Open file")!.click(); });
  expect(open).toHaveBeenCalledWith("/project/AGENTS.md");
  expect(container.querySelector("[data-request-source-text]")?.textContent).toBe("Exact source text.");
});

it("does not invent an origin for an ambiguous legacy agent source", async () => {
  await act(async () => root.render(<ConfidenceMarker claims={[{ id: "legacy", text: "A retained custom template.", source: { kind: "agent", label: "Custom agent instructions" } }]}/>));
  const origin = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Recorded instruction sources"] button')].find(button => button.textContent?.startsWith("Not recorded"))!;
  expect(origin).toBeDefined();
  await act(async () => { origin.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(document.activeElement?.getAttribute("data-origin")).toBe("unrecorded");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Inspect source: Custom agent instructions"]')!.click());
  expect(container.querySelector('[data-source-panel]')?.textContent).toContain("Its origin category was not recorded.");
});

it("places a source label after its leading line breaks, beside its own text", async () => {
  await act(async () => root.render(<ConfidenceMarker claims={[
    { id: "first", text: "Tool list ends here.", source: { kind: "agent", origin: "engine", label: "Engine" } },
    { id: "second", text: "\n\nGuidelines:\nKeep changes focused.", source: { kind: "agent", origin: "agent", label: "Agent role" } },
  ]}/>));
  const region = container.querySelector('[data-request-search-content]')!;
  const label = container.querySelector('[aria-label="Inspect source: Agent role"]')!;
  const range = document.createRange(); range.setStart(region, 0); range.setEndBefore(label);
  const beforeLabel = range.cloneContents(); beforeLabel.querySelectorAll('[data-search-exclude]').forEach(node => node.remove());
  expect(beforeLabel.textContent).toBe("Tool list ends here.\n\n");
  expect([...region.querySelectorAll('[data-request-source-text]')].map(node => node.textContent).join("")).toBe("Tool list ends here.\n\nGuidelines:\nKeep changes focused.");
});

it("browses a long captured source panel and jumps back without opening a file", async () => {
  const claims = Array.from({length:25},(_,i)=>({id:String(i),text:`Instruction ${i}.\n`,source:{kind:"file" as const,label:`Source ${i}`,path:`/project/source-${i}.md`}}));
  await act(async () => root.render(<ConfidenceMarker claims={claims}/>));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Inspect source: Source 24"]')!.click());
  const panel = container.querySelector('[aria-label="Instruction source panel"]')!;
  expect(panel.textContent).toContain("/project/source-24.md");
  const selected = panel.querySelector('[data-source-selected="true"]')!;
  expect(selected.textContent).toContain("Instruction 24.");
  await act(async () => { [...selected.querySelectorAll("button")].find(button => button.textContent === "Show in text")!.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(container.querySelector('[aria-label="Instruction source panel"]')).toBeNull();
  expect(document.activeElement?.textContent).toContain("Instruction 24.");
  expect([...container.querySelectorAll("[data-request-source-text]")].map(node => node.textContent).join("")).toBe(claims.map(c=>c.text).join(""));
});
