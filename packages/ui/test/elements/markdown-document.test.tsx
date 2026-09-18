// @vitest-environment happy-dom
/**
 * M16-T84: `MarkdownDocument` is an element, not a part of one dialog.
 *
 * Everything the full-body viewer needs from it — the transcript's renderer,
 * find over what is drawn, marks that survive the highlighter replacing a
 * fence, file links that open through the project opener — a surface gets by
 * mounting it: a file preview, a note, an agent's instructions. So it is
 * mounted here with no dialog, no footer and no body reader anywhere near it,
 * and driven only through its published `DocumentFind`.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";

import { MarkdownDocument, type DocumentFind } from "../../src/components/assistant-ui/elements/markdown-document.js";
import { FileOpenerProvider } from "../../src/components/thread/FileOpener.js";
import { FileLinkDirectory } from "../../src/components/ui/source-file-link.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

const client = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/runtime", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useLaserStable: () => ({ client, actions: { send: vi.fn(), openSession: vi.fn() } }),
}));
vi.mock("@/dialogs", () => ({ ToolRowDialog: () => null, useRegisterToolRow: () => {}, DialogBody: () => null, dialogFormOf: () => ({}), uiResponseFor: () => ({}) }));

const TEXT = [
  "## What changed",
  "",
  "**Designing the lifecycle**, and the notes in [docs/guide.md](docs/guide.md).",
  "",
  "- first consideration",
  "- second consideration",
  "",
  "```ts",
  "export const guide = \"docs/guide.md\";",
  "```",
  "",
  "The rest of docs/guide.md is unchanged.",
].join("\n");

/** A surface's own pair of highlight names, which the element must use. */
const HIGHLIGHT = { matches: "preview-matches", current: "preview-current" };

describe("a document of Markdown, mounted by any surface", () => {
  let container: HTMLDivElement;
  let root: Root;
  let found: DocumentFind | undefined;
  let revealed: Range[];
  let positions: Array<{ index: number; total: number } | undefined>;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("CSS", { ...CSS, highlights: new Map<string, Set<Range>>() });
    vi.stubGlobal("Highlight", class extends Set<Range> { constructor(...ranges: Range[]) { super(ranges); } });
    client.request.mockReset().mockResolvedValue({
      path: "docs/guide.md", name: "guide.md", mediaType: "text/markdown", encoding: "utf8",
      content: "# The guide", size: 11, modifiedAt: "", truncated: false,
    });
    found = undefined;
    revealed = [];
    positions = [];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function Fixture({ children }: { children: ReactNode }) {
    const runtime = useExternalStoreRuntime({
      convertMessage: (message: ThreadMessageLike) => message,
      messages: [] as ThreadMessageLike[],
      isRunning: false,
      onNew: async () => {},
    });
    return <AssistantRuntimeProvider runtime={runtime}><TooltipProvider>
      <FileOpenerProvider scope="/project"><FileLinkDirectory value="/project">{children}</FileLinkDirectory></FileOpenerProvider>
    </TooltipProvider></AssistantRuntimeProvider>;
  }

  const mount = (text = TEXT) => act(async () => root.render(
    <Fixture>
      <MarkdownDocument
        text={text}
        measure="prose"
        nativeFiles
        find={{
          highlight: HIGHLIGHT,
          publish: controller => {
            found = controller;
            if (controller) controller.subscribe(position => positions.push(position));
          },
          reveal: range => { revealed.push(range); },
        }}
      />
    </Fixture>,
  ));
  const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
  const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 24)); }); };
  const body = () => container.querySelector<HTMLElement>('[data-slot="markdown-document"]')!;
  const marked = () => [...((CSS.highlights as unknown as Map<string, Set<Range>>).get(HIGHLIGHT.matches) ?? [])];
  const current = () => [...((CSS.highlights as unknown as Map<string, Set<Range>>).get(HIGHLIGHT.current) ?? [])];

  it("draws the text with the transcript's renderer and hands its find up to the surface", async () => {
    await mount();
    await flush();

    expect(body().querySelector("h2")?.textContent).toBe("What changed");
    expect(body().querySelector("strong")?.textContent).toBe("Designing the lifecycle");
    expect([...body().querySelectorAll("li")].map(item => item.textContent)).toEqual(["first consideration", "second consideration"]);
    expect(body().querySelector("pre code")?.textContent).toContain("export const guide");
    expect(body().textContent).not.toContain("**");
    // The column is the reading measure, centred, not a value of its own.
    expect(body().className).toContain("max-w-(--measure-prose)");

    // The surface holds a controller for as long as the document is mounted.
    expect(found).toBeDefined();
  });

  it("steps through matches under the surface's own highlight names, and reveals them", async () => {
    await mount();
    await flush();

    // The link's label is the person's text, so a file the document links to is
    // as findable here as it is in the transcript.
    const chip = body().querySelector<HTMLElement>('[data-slot="file-chip"]')!;
    expect(chip.textContent).toBe("docs/guide.md");

    const first = await act(async () => found!.step("docs/guide.md", 1));
    expect(first).toEqual({ index: 1, total: 3 });
    expect(marked().map(range => range.toString())).toEqual(["docs/guide.md", "docs/guide.md", "docs/guide.md"]);
    expect(current()).toHaveLength(1);
    expect(marked().some(range => chip.contains(range.startContainer))).toBe(true);
    // The surface owns the scrolling; the element only says which match.
    expect(revealed).toHaveLength(1);
    expect(revealed[0]!.toString()).toBe("docs/guide.md");

    expect(await act(async () => found!.step("docs/guide.md", 1))).toEqual({ index: 2, total: 3 });
    expect(await act(async () => found!.step("docs/guide.md", -1))).toEqual({ index: 1, total: 3 });
    expect(found!.step("nothing like this", 1)).toBeUndefined();
    expect(marked()).toHaveLength(0);

    // And clearing takes the marks off without touching anything else.
    await act(async () => { found!.step("consideration", 1); });
    expect(marked()).toHaveLength(2);
    await act(async () => found!.clear());
    expect(marked()).toHaveLength(0);
    expect(positions.at(-1)).toBeUndefined();
  });

  it("marks a match again after the highlighter replaces the block it is in", async () => {
    await mount();
    await flush();
    expect(await act(async () => found!.step("export const guide", 1))).toEqual({ index: 1, total: 1 });

    // What Shiki does when its tokenizer lands: the fence's nodes are replaced.
    const code = body().querySelector("pre code")!;
    const source = code.textContent!;
    await act(async () => {
      code.replaceChildren(...source.split(/(?=\s)/).map(token => {
        const span = document.createElement("span");
        span.textContent = token;
        return span;
      }));
    });
    await settle();

    const after = marked();
    expect(after.map(range => range.toString())).toEqual(["export const guide"]);
    expect(after[0]!.startContainer.isConnected).toBe(true);
    expect(code.contains(after[0]!.startContainer)).toBe(true);
    // The surface is told again where the search stands, so its count cannot
    // drift away from the marks.
    expect(positions.at(-1)).toEqual({ index: 1, total: 1 });
  });

  it("opens a file it links to through the project opener, and gives its find back when it goes away", async () => {
    await mount();
    await flush();
    await act(async () => { found!.step("consideration", 1); });
    expect(marked()).toHaveLength(2);

    const chip = body().querySelector<HTMLButtonElement>('[data-slot="file-chip"]')!;
    await act(async () => { chip.click(); });
    await flush();
    expect(client.request).toHaveBeenCalledWith("pi/project/read", { cwd: "/project", path: "/project/docs/guide.md" });
    expect(document.querySelector('[role="dialog"] h1')?.textContent).toBe("The guide");

    await act(async () => root.render(<Fixture><p>gone</p></Fixture>));
    expect(found).toBeUndefined();
    expect((CSS.highlights as unknown as Map<string, Set<Range>>).has(HIGHLIGHT.matches)).toBe(false);
  });
});
