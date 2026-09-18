// @vitest-environment happy-dom
/**
 * M16-T84: the whole of a reply, a reasoning trail or a prompt reads as the
 * document it is.
 *
 * Before this, opening "Full reasoning" showed the body in a monospace pane:
 * `**Designing the lifecycle**` was three words and four asterisks, a list was
 * hyphens, and a fenced block was indented text. The viewer now draws a
 * document body with the transcript's own renderer, keeps Find, Copy, Download
 * and the reading keys working on what is drawn, offers Plain text for the
 * characters themselves, and leaves terminal bodies exactly as they were.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { sliceUtf8RangeFrom, utf8ByteLength } from "@lasercode/protocol";

import { LargeBodyViewer } from "../../src/components/thread/LargeBodyViewer.js";
import { MARKDOWN_BODY_MAX_BYTES } from "../../src/components/thread/MarkdownBodyReader.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { FileOpenerProvider } from "../../src/components/thread/FileOpener.js";
import { LaserStoreProvider, createStateStore, type StateStore } from "../../src/runtime/LaserProvider.js";
import { initialState, reduce } from "../../src/store.js";
import type { BodyRef } from "../../src/runtime/body-excerpt.js";
import { sessionState } from "../agents/fixtures.js";

const PATH = "/p/session.jsonl";

async function digestOf(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** An authority over one body, answering exactly as the real one does. */
function authority(body: string) {
  const total = utf8ByteLength(body);
  const whole = digestOf(body);
  return vi.fn(async (params: Record<string, unknown>) => {
    const slice = sliceUtf8RangeFrom(body, params.offset as number, (params.limit as number | undefined) ?? 65536);
    if (!slice) throw Object.assign(new Error("not a boundary"), { code: -32602 });
    const end = slice.offset + slice.bytes;
    return {
      authority: "durable", revision: params.revision, entryId: params.entryId, component: params.component, totalBytes: total,
      offset: slice.offset, bytes: slice.bytes, ...(end < total ? { next: end } : {}), truncated: end < total,
      sliceDigest: await digestOf(slice.text), contentDigest: await whole, text: slice.text,
    };
  });
}

const bodyRef = (body: string, component: BodyRef["component"]): BodyRef & { entryId: string } => ({
  entryId: "e1",
  component,
  totalBytes: utf8ByteLength(body),
  revision: "r1.env.1",
  excerpt: { offset: 0, bytes: 2048 },
});

const REPLY = [
  "# Feature scope",
  "",
  "**Designing FeatureScopeProps lifecycle and draft management**",
  "",
  "- first consideration",
  "- second consideration",
  "",
  "```ts",
  "export const answer = 42;",
  "```",
  "",
  "| Field | Meaning |",
  "| --- | --- |",
  "| scope | who reads it |",
  "",
  "Read [the notes](https://example.invalid/notes) before changing it.",
].join("\n");

/** Two reasoning summaries as the model wrote them: separate segments. */
const REASONING = [
  "**Handling loading state and save callbacks**",
  "",
  "The draft is held until the person saves it.",
  "",
  "**Implementing safe fallback for provider selection**",
  "",
  "A missing provider falls back to the default.",
].join("\n");

const TERMINAL = Array.from({ length: 400 }, (_, i) => `**not markdown** line ${i}`).join("\n");

const client = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/runtime", async (importActual) => ({
  ...(await importActual<typeof import("../../src/runtime/index.js")>()),
  useLaserStable: () => ({ client, actions: { send: vi.fn(), openSession: vi.fn() } }),
}));
vi.mock("@/dialogs", () => ({ ToolRowDialog: () => null, useRegisterToolRow: () => {}, DialogBody: () => null, dialogFormOf: () => ({}), uiResponseFor: () => ({}) }));

describe("reading the whole of a document body", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: StateStore;

  const serve = (body: string) => {
    const served = authority(body);
    client.request.mockReset();
    client.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === "session/revision") return { revision: "r1.env.1" };
      if (method === "session/entry_range") return served(params);
      return {};
    });
    return served;
  };

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    serve(REPLY);
    let state = reduce(initialState, { type: "opened", state: sessionState({ path: PATH }) });
    state = reduce(state, { type: "destination", destination: { phase: "ready-code", intent: 0, code: { kind: "project-session", project: "/p", path: PATH } } });
    store = createStateStore(state);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function Fixture({ children }: { children: ReactNode }) {
    const runtime = useExternalStoreRuntime({
      convertMessage: (message: ThreadMessageLike) => message,
      messages: [] as ThreadMessageLike[],
      isRunning: false,
      onNew: async () => {},
    });
    return <AssistantRuntimeProvider runtime={runtime}><FileOpenerProvider>{children}</FileOpenerProvider></AssistantRuntimeProvider>;
  }

  const open = (props: { body: string; label: string; tone: "document" | "terminal"; component?: BodyRef["component"]; initialQuery?: string }) =>
    act(async () => root.render(
      <LaserStoreProvider store={store}><TooltipProvider><Fixture>
        <LargeBodyViewer
          ref_={bodyRef(props.body, props.component ?? { kind: "assistant_text" })}
          path={PATH}
          label={props.label}
          open
          onOpenChange={() => {}}
          tone={props.tone}
          {...(props.initialQuery ? { initialQuery: props.initialQuery } : {})}
        />
      </Fixture></TooltipProvider></LaserStoreProvider>,
    ));

  const flush = async () => { for (let i = 0; i < 25; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
  const viewer = () => document.querySelector<HTMLElement>('[data-slot="output-viewer"]')!;
  const document_ = () => viewer().querySelector<HTMLElement>('[data-slot="body-viewer-document"]');
  const control = (name: string | RegExp) =>
    [...viewer().querySelectorAll<HTMLButtonElement>("button")].find(button => {
      const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
      return typeof name === "string" ? label.includes(name) : name.test(label);
    });
  const press = async (button: HTMLButtonElement | undefined) => { expect(button).toBeDefined(); await act(async () => button!.click()); await flush(); };
  /** Type into the find field the way a person does, through the value React tracks. */
  const type = async (value: string) => {
    const field = viewer().querySelector<HTMLInputElement>('input[type="search"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  const count = () => viewer().querySelector('[data-slot="output-viewer-find-count"]')?.textContent?.replace(/\s+/g, " ").trim();

  it("draws the reply the way the transcript draws it, with nothing left as source", async () => {
    await open({ body: REPLY, label: "reply", tone: "document" });
    await flush();

    const body = document_();
    expect(body, viewer().innerHTML.slice(0, 400)).not.toBeNull();
    expect(body!.querySelector("h1")?.textContent).toBe("Feature scope");
    expect(body!.querySelector("strong")?.textContent).toBe("Designing FeatureScopeProps lifecycle and draft management");
    expect([...body!.querySelectorAll("li")].map(item => item.textContent)).toEqual(["first consideration", "second consideration"]);
    expect(body!.querySelector("pre code")?.textContent).toContain("export const answer = 42;");
    expect(body!.querySelector('[data-slot="code-header"]')?.textContent).toContain("ts");
    expect([...body!.querySelectorAll("th")].map(cell => cell.textContent)).toEqual(["Field", "Meaning"]);
    const link = body!.querySelector("a");
    expect(link?.textContent).toBe("the notes");
    // The characters the model wrote are not what a reader sees.
    expect(body!.textContent).not.toContain("**");
    expect(body!.textContent).not.toContain("| Field |");
    expect(body!.textContent).not.toContain("```");
    // The reading area is still a focusable region with its own label.
    const region = viewer().querySelector<HTMLElement>('[data-slot="output-viewer-scroller"]')!;
    expect(region.getAttribute("role")).toBe("region");
    expect(region.tabIndex).toBe(0);
    expect(region.getAttribute("aria-label")).toMatch(/^reply, /);
  });

  it("reads the whole body once, through the range contract, and nothing else", async () => {
    const served = serve(REPLY);
    await open({ body: REPLY, label: "reply", tone: "document" });
    await flush();

    expect(document_()).not.toBeNull();
    const methods = new Set(client.request.mock.calls.map(([method]) => method));
    expect([...methods].every(method => method === "session/entry_range" || method === "session/revision")).toBe(true);
    expect(served.mock.calls.length).toBeGreaterThan(0);
    for (const [params] of served.mock.calls) {
      expect((params as { entryId: string }).entryId).toBe("e1");
      expect((params as { revision: string }).revision).toBe("r1.env.1");
      expect((params as { limit: number }).limit).toBeLessThanOrEqual(64 * 1024);
    }
  });

  it("finds every match in what is drawn, counts them, and steps both ways", async () => {
    await open({ body: REPLY, label: "reply", tone: "document" });
    await flush();

    await type("consideration");
    await press(control(/^Find in reply$/));

    expect(count()).toBe("1 of 2");
    await press(control(/Next match/));
    expect(count()).toBe("2 of 2");
    await press(control(/Previous match/));
    expect(count()).toBe("1 of 2");

    // Something that is not there says so, in the person's words.
    await type("not in this reply at all");
    expect(count()).toBeUndefined();
    await press(control(/^Find in reply$/));
    expect(viewer().querySelector('[data-slot="output-viewer-footer"]')?.textContent).toContain("is not in this reply");
  });

  it("opens straight at what the conversation was looking for", async () => {
    await open({ body: REPLY, label: "reply", tone: "document", initialQuery: "second consideration" });
    await flush();
    expect(viewer().querySelector('[data-slot="output-viewer-find-count"]')?.textContent?.replace(/\s+/g, " ").trim()).toBe("1 of 1");
  });

  it("shows the characters themselves when the person asks for Plain text, and goes back", async () => {
    await open({ body: REPLY, label: "reply", tone: "document" });
    await flush();
    expect(document_()).not.toBeNull();

    await press(control("Plain text"));
    expect(document_()).toBeNull();
    const plain = viewer().querySelector<HTMLElement>('[data-slot="output-viewer-scroller"]')!;
    expect(plain.querySelector("pre")).not.toBeNull();
    expect(plain.textContent).toContain("**Designing FeatureScopeProps lifecycle and draft management**");
    expect(control("Wrap lines")).toBeDefined();

    await press(control("Plain text"));
    await flush();
    expect(document_()).not.toBeNull();
  });

  it("keeps separate reasoning summaries as separate paragraphs", async () => {
    serve(REASONING);
    await open({ body: REASONING, label: "reasoning", tone: "document", component: { kind: "reasoning" } });
    await flush();

    const body = document_()!;
    const paragraphs = [...body.querySelectorAll("p")].map(node => node.textContent);
    expect(paragraphs[0]).toBe("Handling loading state and save callbacks");
    expect(paragraphs).toContain("Implementing safe fallback for provider selection");
    // Never two summaries glued into one line.
    expect(body.textContent).not.toContain("callbacks**Implementing");
    expect(body.textContent).not.toContain("**");
  });

  it("says in the person's words when a body is too long to format, and offers no toggle", async () => {
    const huge = `${"long reply paragraph. ".repeat(20_000)}`;
    expect(utf8ByteLength(huge)).toBeGreaterThan(MARKDOWN_BODY_MAX_BYTES);
    serve(huge);
    await open({ body: huge, label: "reply", tone: "document" });
    await flush();

    expect(document_()).toBeNull();
    expect(viewer().querySelector('[data-slot="output-viewer-note"]')?.textContent)
      .toBe("This reply is too long to format; showing plain text.");
    expect(control("Plain text")).toBeUndefined();
    expect(viewer().querySelector('[data-slot="output-viewer-scroller"] pre')).not.toBeNull();
  });

  it("leaves a tool's output exactly as it was: the terminal ground, no formatting, no toggle", async () => {
    serve(TERMINAL);
    await open({ body: TERMINAL, label: "output", tone: "terminal", component: { kind: "tool_output" } });
    await flush();

    const region = viewer().querySelector<HTMLElement>('[data-slot="output-viewer-scroller"]')!;
    expect(document_()).toBeNull();
    expect(region.className).toContain("terminal");
    expect(region.querySelector("pre")).not.toBeNull();
    expect(region.textContent).toContain("**not markdown** line 0");
    expect(control("Plain text")).toBeUndefined();
    expect(control("Wrap lines")).toBeDefined();
    expect(control(/Previous match/)).toBeUndefined();
  });

  it("copies and saves the whole body as the characters it is made of", async () => {
    await open({ body: REPLY, label: "reply", tone: "document" });
    await flush();
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { written.push(text); } } });

    await press(control(/Copy full reply/));
    expect(written).toHaveLength(1);
    expect(written[0]).toBe(REPLY);
    expect(control("Download .txt")).toBeDefined();
  });
});
