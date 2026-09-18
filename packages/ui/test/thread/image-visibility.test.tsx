// @vitest-environment happy-dom
/**
 * The row that connects a transcript to the image pool (M16-T82).
 *
 * The pool's own rules are proved in `image-accessibility.test.tsx`; the two
 * mechanisms that made the reported defect are here, and neither of them is
 * visible from either side alone:
 *
 *  - **what a picture is** — the identity in the pool's key is the bytes, not
 *    the moment. A live turn advances its revision around unchanged images on
 *    every delta; if that released and re-read them, a busy conversation would
 *    spend its whole read budget rebuilding pictures it already had.
 *  - **where a picture is** — a mounted row is not a row anybody can see. The
 *    transcript keeps rows mounted far outside the viewport, so admission has
 *    to follow a measured `IntersectionObserver`, not a mount.
 *
 * Plus the two things that cost every message something: the observers are
 * built only for rows that carry pictures, and the residue this row keeps is
 * registered with the window's memory-pressure pass.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageContent } from "@lasercode/protocol";

import { MessageImages } from "../../src/components/assistant-ui/elements/message-attachment.js";
import { useImageBodies } from "../../src/components/thread/use-image-bodies.js";
import { releaseEphemeralCaches } from "../../src/runtime/pressure/ephemeral.js";
import type { BodyRef } from "../../src/runtime/body-excerpt.js";
import type { BlockBodies } from "../../src/store";

const SESSION = "/project/session.jsonl";
const CHARS = 64;
const WHOLE = "QUJD".repeat(CHARS / 4);
const PICTURE_SURFACE = 768 * 768 * 4;

async function digestOf(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

const transport = vi.hoisted(() => ({ request: vi.fn(), environmentKey: "" }));
vi.mock("@/runtime", () => ({
  useLaserStable: () => ({ client: transport }),
  useLaserState: (select: (state: unknown) => unknown) => select({ environment: { environmentKey: transport.environmentKey } }),
}));

/**
 * The two observers the row builds, controlled by hand: one for the viewport
 * and one for the 600 px lookahead, told apart by their root margin.
 */
class FakeObserver {
  static live: FakeObserver[] = [];
  readonly targets = new Set<Element>();
  readonly margin: string;
  constructor(private readonly callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.margin = options?.rootMargin ?? "";
    FakeObserver.live.push(this);
  }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); FakeObserver.live = FakeObserver.live.filter(observer => observer !== this); }
  takeRecords() { return []; }
  /** Report where the tiles are, the way a real observer would. */
  report(seen: (target: Element) => boolean) {
    const entries = [...this.targets].map(target => ({ target, isIntersecting: seen(target) } as IntersectionObserverEntry));
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

/** Say which tiles are inside the viewport, and which within the lookahead. */
async function place(visible: (index: number) => boolean, nearby: (index: number) => boolean = visible) {
  const tiles = [...document.querySelectorAll('[data-slot="message-image-tile"]')];
  const indexOf = (target: Element) => tiles.indexOf(target);
  await act(async () => {
    for (const observer of FakeObserver.live) {
      observer.report(target => (observer.margin ? nearby : visible)(indexOf(target)));
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

const refOf = (index: number, digest: string, revision: string): BodyRef => ({
  entryId: `e${index}`, component: { kind: "image", index: 0 }, totalBytes: CHARS, revision,
  excerpt: { offset: 0, bytes: 0 }, contentDigest: digest, image: { decodedBytes: PICTURE_SURFACE },
});

function Fixture({ refs, count }: { refs: readonly BodyRef[] | undefined; count: number }) {
  const images: ImageContent[] = Array.from({ length: count }, () => ({ type: "image", mimeType: "image/png" }));
  const bodies = (refs ? { images: refs } : {}) as BlockBodies;
  const source = useImageBodies(SESSION, images, bodies);
  return <>
    <MessageImages images={images} sourceFor={source.sourceFor} observe={source.observe}
      onOpen={(index) => { void source.openFor(index, `Image ${index + 1}`); }} />
    {source.problem ? <p data-slot="image-problem">{source.problem}</p> : null}
  </>;
}

let container: HTMLDivElement;
let root: Root;
let created: string[];
let revoked: string[];
let environments = 0;

beforeEach(() => {
  created = []; revoked = [];
  let counter = 0;
  globalThis.URL.createObjectURL = vi.fn(() => { const url = `blob:${++counter}`; created.push(url); return url; });
  globalThis.URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
  // A pool per test: the window keeps one per environment, and a fresh
  // environment is how a test gets one of its own.
  transport.environmentKey = `env-${++environments}`;
  transport.request.mockReset();
  payload = WHOLE;
  FakeObserver.live = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** The bytes the conversation is serving right now, for every image in it. */
let payload = WHOLE;

/** An authority that serves one small, verifiable image per entry. */
function serving(before?: (entryId: string) => Promise<void> | void) {
  return vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "session/revision") return { revision: "r1" };
    await before?.(params.entryId as string);
    const text = payload;
    return {
      authority: "durable", revision: params.revision ?? "r1", entryId: params.entryId, component: params.component,
      totalBytes: CHARS, offset: 0, bytes: CHARS, truncated: false,
      sliceDigest: await digestOf(text), contentDigest: await digestOf(text), text,
    };
  });
}

/** The window's memory-pressure step 1, with the re-render it causes. */
const pressurePass = async () => {
  let released!: ReturnType<typeof releaseEphemeralCaches>;
  await act(async () => { released = releaseEphemeralCaches(); });
  return released;
};

/** Let every read, every microtask pass and every render settle. */
const settle = async (rounds = 4) => {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
};

const mount = async (refs: readonly BodyRef[] | undefined, count: number) => {
  await act(async () => root.render(<Fixture refs={refs} count={count} />));
  await settle();
};

const tiles = () => [...container.querySelectorAll('[data-slot="message-image-tile"]')];
const pictures = () => [...container.querySelectorAll('[data-slot="message-image"]')].map(node => node.getAttribute("src"));
const placeholders = () => [...container.querySelectorAll('[data-slot="message-image-placeholder"]')].map(node => node.textContent);
const reads = () => transport.request.mock.calls.filter(call => call[0] === "session/entry_range").map(call => call[1].entryId as string);

describe("what a picture is", () => {
  it("keeps the picture when a live turn advances its revision around unchanged bytes", async () => {
    transport.request.mockImplementation(serving());
    const digest = await digestOf(WHOLE);
    await mount([refOf(0, digest, "r1")], 1);
    await place(() => true);
    expect(pictures()).toEqual([created[0]!]);
    expect(reads()).toEqual(["e0"]);

    // Every delta of a streaming turn rebuilds these references at a new
    // revision. The bytes did not change, so the picture must not be given
    // back and read again — and the row must not flash a placeholder.
    for (const revision of ["r2", "r3", "r4"]) {
      await mount([refOf(0, digest, revision)], 1);
      expect(pictures()).toEqual([created[0]!]);
    }
    expect(reads()).toEqual(["e0"]);
    expect(revoked).toEqual([]);

    // Bytes that really are different are a different picture, and are read.
    payload = "REVG".repeat(CHARS / 4);
    await mount([refOf(0, await digestOf(payload), "r5")], 1);
    await place(() => true);
    expect(reads()).toEqual(["e0", "e0"]);
    expect(pictures()).toEqual([created[1]!]);
    // The picture it replaced is given back exactly once.
    expect(revoked).toEqual([created[0]!]);
  });
});

describe("where a picture is", () => {
  it("tells the window which mounted rows a person can actually see", async () => {
    transport.request.mockImplementation(serving());
    const digest = await digestOf(WHOLE);
    await mount(Array.from({ length: 6 }, (_, index) => refOf(index, digest, "r1")), 6);
    expect(tiles()).toHaveLength(6);
    await place(() => true);
    expect(pictures().filter(Boolean)).toHaveLength(6);

    // The transcript keeps rows mounted far outside the viewport. The
    // observers say which is which: the last two are on screen, one more is
    // inside the 600 px lookahead, the first three are neither.
    await place(index => index >= 4, index => index >= 3);

    // Only what nobody is looking at is speculative, and only the speculative
    // is given back. A mounted row was once enough to be treated as a wanted
    // row; this is the difference, measured rather than assumed.
    expect(await pressurePass()).toEqual({ count: 4, bytes: 4 * PICTURE_SURFACE, failures: 0 });
    await settle();
    const rows = tiles();
    for (const index of [0, 1, 2, 3]) {
      expect(rows[index]!.querySelector('[data-slot="message-image"]')).toBeNull();
      expect(rows[index]!.textContent).toBe("Shown when it scrolls into view");
    }
    for (const index of [4, 5]) expect(rows[index]!.querySelector('[data-slot="message-image"]')).not.toBeNull();
  });

  it("builds observers for rows that carry pictures, and for no others", async () => {
    transport.request.mockImplementation(serving());
    await mount(undefined, 0);
    expect(FakeObserver.live).toHaveLength(0);

    await mount([refOf(0, await digestOf(WHOLE), "r1")], 1);
    // Exactly two: the viewport, and the 600 px lookahead.
    expect(FakeObserver.live).toHaveLength(2);
    expect(FakeObserver.live.map(observer => observer.margin).sort()).toEqual(["", "600px 0px"]);
  });
});

describe("what the window can give back", () => {
  it("hands the offscreen residue to the memory-pressure pass, and gets it again on demand", async () => {
    transport.request.mockImplementation(serving());
    const digest = await digestOf(WHOLE);
    await mount([refOf(0, digest, "r1"), refOf(1, digest, "r1")], 2);
    await place(() => true);
    expect(pictures().filter(Boolean)).toHaveLength(2);

    // Both rows scroll away. Nothing renders from them any more, so the
    // window's step 1 may have them (RP-8).
    await place(() => false);
    const released = await pressurePass();
    expect(released.failures).toBe(0);
    expect(released.count).toBe(2);
    expect(released.bytes).toBe(2 * PICTURE_SURFACE);
    await settle();
    expect(placeholders()).toEqual(["Shown when it scrolls into view", "Shown when it scrolls into view"]);

    // And it comes back by scrolling to it: a release is never a failure.
    await place(() => true);
    await settle();
    expect(pictures().filter(Boolean)).toHaveLength(2);
  });

  it("reads a picture once for an impatient person, and says the tile is busy", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    transport.request.mockImplementation(serving(async () => { await gate; }));
    await mount([refOf(0, await digestOf(WHOLE), "r1")], 1);
    await place(() => true);

    const open = container.querySelector<HTMLButtonElement>('button[aria-label="Open Image 1"]')!;
    await act(async () => { open.click(); open.click(); open.click(); });
    const busy = container.querySelector<HTMLButtonElement>('button[aria-label="Open Image 1"]')!;
    expect(busy.getAttribute("aria-busy")).toBe("true");
    release!();
    await settle();
    // One read of the bytes, however many times the tile was clicked.
    expect(reads()).toEqual(["e0"]);
    expect(container.querySelector('button[aria-label="Open Image 1"]')!.getAttribute("aria-busy")).toBeNull();
  });
});
