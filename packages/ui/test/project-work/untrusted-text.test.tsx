// @vitest-environment happy-dom
/**
 * Project and agent text is data, never markup (M21-T22, threat model §3;
 * AGENTS.md invariant 9).
 *
 * A Spec's Markdown, a Research finding's excerpt, a source file's contents
 * and an imported document all reach the same renderer the transcript uses.
 * This mounts that renderer over the payloads a hostile source would write and
 * proves the result is text: no element the payload asked for, no event
 * handler, no external load — and the characters themselves still on screen,
 * because refusing to draw them would be its own bug.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";

import { MarkdownDocument } from "../../src/components/assistant-ui/elements/markdown-document.js";
import { FileOpenerProvider } from "../../src/components/thread/FileOpener.js";
import { FileLinkDirectory } from "../../src/components/ui/source-file-link.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";

const client = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/runtime", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useLaserStable: () => ({ client, actions: { send: vi.fn(), openSession: vi.fn() } }),
}));
vi.mock("@/dialogs", () => ({ ToolRowDialog: () => null, useRegisterToolRow: () => {}, DialogBody: () => null, dialogFormOf: () => ({}), uiResponseFor: () => ({}) }));

const HOSTILE = [
  "# Imported spec",
  "",
  '<script>window.__owned = true</script>',
  '<img src=x onerror="window.__owned = true">',
  '<iframe src="https://evil.example"></iframe>',
  '<a href="javascript:window.__owned = true">click</a>',
  '<style>body { display: none }</style>',
  "",
  "A finding quoted from the source: `<script>alert(1)</script>`.",
  "",
  "[a link](javascript:window.__owned = true)",
].join("\n");

describe("text from a project, a source or an agent", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("CSS", { ...CSS, highlights: new Map<string, Set<Range>>() });
    vi.stubGlobal("Highlight", class extends Set<Range> { constructor(...ranges: Range[]) { super(ranges); } });
    client.request.mockReset().mockResolvedValue({});
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (window as unknown as Record<string, unknown>)["__owned"];
    vi.unstubAllGlobals();
  });

  function Fixture({ children }: { children: ReactNode }) {
    const runtime = useExternalStoreRuntime({
      convertMessage: (message: ThreadMessageLike) => message,
      messages: [] as ThreadMessageLike[],
      isRunning: false,
      onNew: async () => {},
    });
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <TooltipProvider>
          <FileOpenerProvider scope="/project">
            <FileLinkDirectory value="/project">{children}</FileLinkDirectory>
          </FileOpenerProvider>
        </TooltipProvider>
      </AssistantRuntimeProvider>
    );
  }

  const mount = (text: string) =>
    act(async () => root.render(<Fixture><MarkdownDocument text={text} measure="prose" nativeFiles /></Fixture>));
  const flush = async () => {
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };

  it("draws hostile markup as characters, not as elements", async () => {
    await mount(HOSTILE);
    await flush();

    const body = container.querySelector<HTMLElement>('[data-slot="markdown-document"]')!;
    expect(body.querySelector("script")).toBeNull();
    expect(body.querySelector("iframe")).toBeNull();
    expect(body.querySelector("style")).toBeNull();
    expect(body.querySelector("img")).toBeNull();
    // The characters are there, as characters: no element carries a handler.
    expect(body.querySelectorAll("[onerror], [onload], [onclick]")).toHaveLength(0);
    for (const element of body.querySelectorAll("*")) {
      for (const attribute of element.attributes) expect(attribute.name.startsWith("on")).toBe(false);
    }
    expect((window as unknown as Record<string, unknown>)["__owned"]).toBeUndefined();

    // The heading is the person's Markdown and is still a heading.
    expect(body.querySelector("h1")?.textContent).toBe("Imported spec");
    // The payload itself is readable, as the text it is.
    expect(body.textContent).toContain("<script>window.__owned = true</script>");
    expect(body.querySelector("code")?.textContent).toContain("<script>alert(1)</script>");

    // No link anywhere may carry a scheme that executes.
    for (const anchor of body.querySelectorAll("a")) {
      expect(anchor.getAttribute("href") ?? "").not.toMatch(/^\s*javascript:/i);
    }
  });

  it("keeps a source file's own contents as text, including its angle brackets", async () => {
    // What a source panel shows for `index.html`: the file, fenced.
    await mount(["```html", '<script>fetch("https://evil.example")</script>', "```"].join("\n"));
    await flush();
    const body = container.querySelector<HTMLElement>('[data-slot="markdown-document"]')!;
    expect(body.querySelector("script")).toBeNull();
    expect(body.querySelector("pre")?.textContent).toContain('<script>fetch("https://evil.example")</script>');
    expect((window as unknown as Record<string, unknown>)["__owned"]).toBeUndefined();
  });
});
