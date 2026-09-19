// @vitest-environment happy-dom
/**
 * A page as the producers actually serve it, rendered (M16-T92).
 *
 * Every other image fixture in this suite hands the view an `ImageContent` and
 * a `BodyRef` built by hand, which is why a shape change on the wire — every
 * `image` part served as a reference with no bytes (M16-T89) — made every
 * picture in a loaded conversation unviewable with a green suite. This file is
 * the missing seam: the records go through `@lasercode/protocol`'s own
 * `elideOversizedEntries`, which is what a host serves a page with, and *that*
 * page goes through the view — `retainEntries`, the store's hydration, the
 * message projection, the rendered row.
 *
 * So what is pinned here is the wire's shape, not a fixture's: a 5 KB avatar,
 * a 2.4 MB screenshot and a picture inside a tool result all arrive as
 * references, are kept rather than stubbed, reserve their own box, and reach
 * the row as openable pictures. The next shape change fails here instead of in
 * somebody's conversation.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { elideOversizedEntries } from "@lasercode/protocol";

import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserStoreProvider, createStateStore, type StateStore } from "../../src/runtime/LaserProvider.js";
import { projectMessages } from "../../src/runtime/projection.js";
import { retainEntries } from "../../src/runtime/retained-entries.js";
import { initialState, reduce, type Block } from "../../src/store.js";

const stable = vi.hoisted(() => ({ actions: { openSession: vi.fn(async () => undefined), toast: vi.fn() } }));
vi.mock("@/runtime", async (importActual) => ({ ...(await importActual<typeof import("../../src/runtime/index.js")>()), useLaserStable: () => stable }));
vi.mock("@/dialogs", () => ({ ToolRowDialog: () => null, useRegisterToolRow: () => {}, DialogBody: () => null, dialogFormOf: () => ({}), uiResponseFor: () => ({}) }));
vi.mock("@/components/preview/MarkdownPreview", () => ({ MarkdownPreview: ({ text }: { text: string }) => <p data-slot="markdown">{text}</p> }));

const { UserMessage } = await import("../../src/components/thread/messages.js");

const SESSION = "/project/session.jsonl";
/** The per-body bound a host passes, and the one this view admits with. */
const BODY_LIMIT = 16 * 1024;

/** A PNG header of the declared size, padded to the declared payload length. */
function png(width: number, height: number, bytes: number): string {
  const header = new Uint8Array(33);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  header.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(header.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  let binary = "";
  for (const byte of header) binary += String.fromCharCode(byte);
  const base = btoa(binary);
  return base + "A".repeat(Math.max(0, bytes - base.length));
}

const digest = (text: string) => `sha256-${text.length}`;

/** The small one, the big one, and one inside a tool result. */
const AVATAR = png(64, 64, 5_508);
const SCREENSHOT = png(2560, 1440, 2_400_000);
const IN_TOOL = png(800, 600, 40_000);

const records = (): unknown[] => [
  {
    type: "message", id: "e0", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: [
      { type: "text", text: "Two pictures" },
      { type: "image", mimeType: "image/png", data: AVATAR },
      { type: "image", mimeType: "image/png", data: SCREENSHOT },
    ] },
  },
  {
    type: "message", id: "e1", parentId: "e0", timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "c1", toolName: "screenshot", args: {} }] },
  },
  {
    type: "message", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:02.000Z",
    message: { role: "toolResult", toolCallId: "c1", content: [
      { type: "text", text: "captured" },
      { type: "image", mimeType: "image/png", data: IN_TOOL },
    ] },
  },
];

/** The page a host serves: every image a reference, nothing else changed. */
const servedPage = () => elideOversizedEntries(records(), BODY_LIMIT, digest);

type ServedImage = { type: "image"; data: string; ref: { entryId: string; totalBytes: number; mimeType: string; contentDigest: string; width?: number; height?: number } };
const imagesOf = (entries: readonly unknown[]): ServedImage[] =>
  entries.flatMap(entry => {
    const content = (entry as { message?: { content?: unknown } }).message?.content;
    return Array.isArray(content) ? content.filter((part): part is ServedImage => (part as { type?: string }).type === "image") : [];
  });

describe("the page the producers serve", () => {
  it("serves every image as a reference and no bytes, at both sizes and inside a tool result", () => {
    const page = servedPage();
    // With its pictures referenced, every record here is small enough to
    // travel whole: nothing is pointed at.
    expect(page.elided).toEqual([]);
    const images = imagesOf(page.entries);
    expect(images).toHaveLength(3);
    for (const image of images) {
      expect(image.data, "a served image still carries bytes").toBe("");
      expect(image.ref.totalBytes).toBeGreaterThan(0);
      expect(image.ref.contentDigest).not.toBe("");
    }
    expect(images.map(image => image.ref.totalBytes)).toEqual([AVATAR.length, SCREENSHOT.length, IN_TOOL.length]);
    // The intrinsic size travels with the reference, which is the only path by
    // which a row can reserve the box before a byte arrives
    // (`docs/transcript-parity.md` §1).
    expect(images.map(image => [image.ref.width, image.ref.height])).toEqual([[64, 64], [2560, 1440], [800, 600]]);
  });

  it("keeps every record of that page, because a referenced picture weighs nothing here", () => {
    const retained = retainEntries(servedPage().entries, BODY_LIMIT);
    // The rule the wire deleted may not live on in the client: a 2.4 MB
    // screenshot served as a reference must not turn its record into a stub,
    // or its media type and intrinsic size never reach the row that draws it.
    expect(retained.stubs).toEqual([]);
    expect(retained.entries).toHaveLength(3);
  });

  it("still bounds a record that really is carrying bytes", () => {
    // The guard is the reference, not where the record came from: a live
    // `session/update` arrives whole and is still bounded by its real bytes.
    const retained = retainEntries(records(), BODY_LIMIT);
    expect(retained.stubs.map(stub => stub.id)).toEqual(["e0", "e2"]);
  });

  it("gives the prompt a reference for every picture, at every size", () => {
    const page = servedPage();
    let state = reduce(initialState, { type: "opened", state: { path: SESSION, cwd: "/project" } as never });
    state = reduce(state, { type: "hydrate", path: SESSION, entries: page.entries } as never);
    const prompt = state.open[SESSION]!.blocks.find((block): block is Extract<Block, { kind: "user" }> => block.kind === "user")!;
    expect(prompt.images).toHaveLength(2);
    // This is the exact step that computed `utf8ByteLength("")`, decided the
    // picture was small enough to keep inline, and minted no reference at all
    // — which is what left every image under sixteen kilobytes unviewable.
    const refs = prompt.bodies?.images ?? [];
    expect(refs.filter(Boolean)).toHaveLength(2);
    const [small, large] = refs as Array<{ entryId?: string; totalBytes: number; contentDigest?: string; image?: { width?: number; height?: number; decodedBytes: number } }>;
    expect(small!.entryId).toBe("e0");
    expect(small!.totalBytes).toBe(AVATAR.length);
    expect(small!.contentDigest).toBe(digest(AVATAR));
    expect(small!.image).toEqual({ width: 64, height: 64, decodedBytes: 64 * 64 * 4 });
    expect(large!.totalBytes).toBe(SCREENSHOT.length);
    expect(large!.image).toEqual({ width: 2560, height: 1440, decodedBytes: 2560 * 1440 * 4 });
  });

  it("gives the tool result's picture a reference of its own", () => {
    const page = servedPage();
    const [, , result] = imagesOf(page.entries);
    expect(result!.ref.entryId).toBe("e2");
    expect(result!.ref.mimeType).toBe("image/png");
    expect(result!.ref.width).toBe(800);
  });
});

describe("the row that draws it", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: StateStore;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    let state = reduce(initialState, { type: "opened", state: { path: SESSION, cwd: "/project" } as never });
    state = reduce(state, { type: "hydrate", path: SESSION, entries: servedPage().entries } as never);
    // The row reads the pictures back through the conversation it belongs to.
    store = createStateStore({ ...state, current: SESSION });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it("draws an openable tile for every picture, and never says the window lost them", async () => {
    const blocks = store.getSnapshot().open[SESSION]!.blocks;
    function Fixture() {
      const { messages } = projectMessages({ blocks, running: false, dialogs: [] });
      const runtime = useExternalStoreRuntime({ messages, isRunning: false, onNew: async () => {} });
      return <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Messages>{() => <UserMessage />}</ThreadPrimitive.Messages>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>;
    }
    await act(async () => root.render(<LaserStoreProvider store={store}><TooltipProvider><Fixture /></TooltipProvider></LaserStoreProvider>));
    const tiles = [...container.querySelectorAll('[data-slot="message-image-tile"]')];
    expect(tiles).toHaveLength(2);
    // "Not kept in this window" is what a row says about a picture it has no
    // reference for. Every picture on this page has one.
    expect(container.textContent).not.toContain("Not kept in this window");
    for (const tile of tiles) {
      const open = tile.querySelector("button");
      expect(open, "a referenced picture is still an openable tile").not.toBeNull();
    }
  });
});
