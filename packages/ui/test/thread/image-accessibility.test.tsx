// @vitest-environment happy-dom
/**
 * M16-T82: every image a person asks for stays reachable.
 *
 * The window bounds what it decodes **at once**, never what a conversation can
 * show. These are the rules that makes that true: what is on screen is decoded
 * first, a full pool gives up the picture that has been off screen longest, a
 * picture that loses its decode says it will come back rather than that it
 * failed, and opening one reads its bytes back whatever the pool holds.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IMAGE_BLOB_MAX,
  IMAGE_PRIORITY,
  IMAGE_SURFACE_MAX_BYTES,
  ImageBlobs,
  type ImageState,
} from "../../src/runtime/image-blobs.js";
import { byStaleness, byUrgency, ImageWorkQueue } from "../../src/runtime/image-queue.js";
import { MessageImages, type MessageImageSource } from "../../src/components/assistant-ui/elements/message-attachment.js";

const SESSION = "/project/session.jsonl";
/** One 768 px PNG's decoded surface: the shape of the reported conversation. */
const PICTURE_SURFACE = 768 * 768 * 4;

async function digestOf(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

const CHARS = 64;
const WHOLE = "QUJD".repeat(CHARS / 4);

/** An authority that serves one small, verifiable image per entry. */
function authority(before?: () => Promise<void>) {
  return vi.fn(async (params: Record<string, unknown>) => {
    await before?.();
    const offset = params.offset as number;
    const bytes = Math.max(0, Math.min(params.limit as number, CHARS - offset));
    const text = "QUJD".repeat(bytes / 4);
    return {
      authority: "durable", revision: "r", entryId: params.entryId as string, component: params.component,
      totalBytes: CHARS, offset, bytes, truncated: offset + bytes < CHARS,
      ...(offset + bytes < CHARS ? { next: offset + bytes } : {}),
      sliceDigest: await digestOf(text), contentDigest: await digestOf(WHOLE), text,
    };
  });
}

const refOf = (index: number, decoded = PICTURE_SURFACE) => ({
  entryId: `e${index}`, component: { kind: "image" as const, index: 0 }, totalBytes: CHARS, revision: "r",
  excerpt: { offset: 0, bytes: 0 }, image: { decodedBytes: decoded },
});

/** Let the pool's deferred pass run: it decides what to read one microtask later. */
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Every pool a test makes, so the file can retire them all when that test ends.
 *
 * A pool is a live thing: a read it started keeps going until it lands, and a
 * release at the end of a test can start another one a microtask later. None
 * of that belongs to the next test, whose `URL.createObjectURL` is a different
 * spy writing into a different array — so every pool is made through here and
 * cleared when the test that made it ends, in the `afterEach` below. That
 * fence is what makes an assertion about what *this* test created, or did not
 * create, mean what it says. A pool made with `new ImageBlobs` directly is
 * outside it.
 */
const pools: ImageBlobs[] = [];
function pool(request: unknown, environmentKey = "env"): ImageBlobs {
  const blobs = new ImageBlobs(request as never, environmentKey);
  pools.push(blobs);
  return blobs;
}

/**
 * A conversation that has been asked and has not answered yet: the test says
 * when the bytes arrive, so a read can be left genuinely in flight rather than
 * hopefully still running.
 */
function deferredAuthority() {
  let arrived!: () => void;
  const asked = new Promise<void>(resolve => { arrived = resolve; });
  let answer!: () => void;
  const held = new Promise<void>(resolve => { answer = resolve; });
  const request = vi.fn(async (params: Record<string, unknown>) => {
    arrived();
    await held;
    const text = WHOLE;
    return {
      authority: "durable", revision: "r", entryId: params.entryId as string, component: params.component,
      totalBytes: CHARS, offset: 0, bytes: CHARS, truncated: false,
      sliceDigest: await digestOf(text), contentDigest: await digestOf(WHOLE), text,
    };
  });
  return {
    request,
    /** Resolves once the authority has actually been asked. */
    asked,
    /** Answer it, and say when the reply itself has been handed back. */
    answer: async (): Promise<void> => {
      answer();
      await (request.mock.results[0]?.value as Promise<unknown> | undefined);
    },
  };
}

/** Wait for one image to reach a state, through the pool's own notifications. */
function reaches(blobs: ImageBlobs, key: string, matches: (state: ImageState) => boolean): Promise<ImageState> {
  return new Promise((resolve, reject) => {
    const settled = blobs.stateOf(key);
    if (matches(settled)) { resolve(settled); return; }
    const timer = setTimeout(() => { stop(); reject(new Error(`${key} never reached the expected state (${JSON.stringify(blobs.stateOf(key))})`)); }, 2000);
    const stop = blobs.watch(key, () => {
      const state = blobs.stateOf(key);
      if (!matches(state)) return;
      clearTimeout(timer);
      stop();
      resolve(state);
    });
  });
}

let created: string[];
let revoked: string[];
const nativeCreateObjectURL = globalThis.URL.createObjectURL;
const nativeRevokeObjectURL = globalThis.URL.revokeObjectURL;

beforeEach(() => {
  created = []; revoked = [];
  let counter = 0;
  globalThis.URL.createObjectURL = vi.fn(() => { const url = `blob:${++counter}`; created.push(url); return url; });
  globalThis.URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
});

afterEach(() => {
  // Retire every pool this test made, before the next test's spy is installed.
  // `clear()` bumps the generation, and a read checks it again after its last
  // byte arrives and before it publishes anything — so work still out at the
  // authority gives its bytes up instead of allocating an object URL into
  // somebody else's window. Then the window's own helpers go back, so nothing
  // between tests is writing into a test's arrays at all.
  for (const blobs of pools.splice(0, pools.length)) blobs.clear();
  globalThis.URL.createObjectURL = nativeCreateObjectURL;
  globalThis.URL.revokeObjectURL = nativeRevokeObjectURL;
});

describe("the order a window decodes pictures in", () => {
  it("puts what a person is looking at ahead of what they are not", () => {
    const queue = new ImageWorkQueue<{ priority: 0 | 1 | 2 | 3; stamp: number; seq: number; key: string }>();
    const item = (key: string, priority: 0 | 1 | 2 | 3, stamp: number) => queue.set(key, { key, priority, stamp, seq: queue.next() });
    item("far", IMAGE_PRIORITY.background, 1);
    item("near", IMAGE_PRIORITY.nearby, 2);
    item("seen", IMAGE_PRIORITY.visible, 3);
    item("asked", IMAGE_PRIORITY.requested, 4);
    expect(queue.urgent(() => true).map(entry => entry.key)).toEqual(["asked", "seen", "near", "far"]);
    // And gives room up in the opposite order: longest off screen first.
    expect(queue.stalest(() => true).map(entry => entry.key)).toEqual(["far", "near", "seen", "asked"]);
  });

  it("keeps the order things were asked in when they are wanted equally", () => {
    const first = { priority: IMAGE_PRIORITY.visible, stamp: 5, seq: 1 };
    const second = { priority: IMAGE_PRIORITY.visible, stamp: 5, seq: 2 };
    expect(byUrgency(first, second)).toBeLessThan(0);
    expect(byStaleness(first, second)).toBeLessThan(0);
  });

  it("reads what is on screen before what is merely mounted", async () => {
    let open = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const asked: string[] = [];
    const request = vi.fn(async (params: Record<string, unknown>) => {
      asked.push(params.entryId as string);
      open += 1;
      await gate;
      open -= 1;
      const text = WHOLE;
      return { authority: "durable", revision: "r", entryId: params.entryId as string, component: params.component,
        totalBytes: CHARS, offset: 0, bytes: CHARS, truncated: false,
        sliceDigest: await digestOf(text), contentDigest: await digestOf(WHOLE), text };
    });
    const blobs = pool(request);
    // Eight rows mount in one pass: the offscreen ones happen to be asked for
    // first, which is exactly the case a queue exists for.
    const loads = [
      ...Array.from({ length: 6 }, (_, index) => blobs.load(`far-${index}`, SESSION, refOf(index), "image/png", IMAGE_PRIORITY.background)),
      blobs.load("seen", SESSION, refOf(10), "image/png", IMAGE_PRIORITY.visible),
      blobs.load("asked", SESSION, refOf(11), "image/png", IMAGE_PRIORITY.requested),
    ];
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(asked.slice(0, 2)).toEqual(["e11", "e10"]);
    // Never more reads in flight than the queue allows, whatever mounted.
    expect(open).toBeLessThanOrEqual(4);
    release!();
    await Promise.all(loads);
  });
});

/** Two of these fill the whole surface budget; a third needs room made. */
const HALF = Math.floor(IMAGE_SURFACE_MAX_BYTES / 2);

describe("a window that cannot decode everything at once", () => {

  it("takes room from the least recently visible picture, not from one on screen", async () => {
    const blobs = pool(authority());
    expect((await blobs.load("a", SESSION, refOf(1, HALF), "image/png", IMAGE_PRIORITY.background)).state).toBe("ready");
    expect((await blobs.load("b", SESSION, refOf(2, HALF), "image/png", IMAGE_PRIORITY.background)).state).toBe("ready");
    const before = blobs.url("a");
    expect(blobs.held.images).toBe(2);

    const visible = await blobs.load("c", SESSION, refOf(3, HALF), "image/png", IMAGE_PRIORITY.visible);
    expect(visible.state).toBe("ready");
    // The one that has been off screen longest gave its decode up, and says
    // it will come back — it did not fail.
    expect(blobs.stateOf("a")).toEqual({ state: "waiting", reason: "offscreen" });
    expect(revoked).toContain(before);
    expect(blobs.stateOf("b").state).toBe("ready");
    expect(blobs.held.images).toBe(2);
    expect(blobs.held.surface).toBeLessThanOrEqual(IMAGE_SURFACE_MAX_BYTES);
  });

  it("never refuses a picture for good: it comes back when there is room", async () => {
    const blobs = pool(authority());
    await blobs.load("held-1", SESSION, refOf(1, HALF), "image/png", IMAGE_PRIORITY.visible);
    await blobs.load("held-2", SESSION, refOf(2, HALF), "image/png", IMAGE_PRIORITY.visible);
    // A third visible picture: nothing off screen to give up, so it waits.
    const waiting = await blobs.load("third", SESSION, refOf(3, HALF), "image/png", IMAGE_PRIORITY.visible);
    expect(waiting).toEqual({ state: "waiting", reason: "room" });
    expect(blobs.stateOf("third")).toEqual({ state: "waiting", reason: "room" });

    // A row goes; the queue comes back to what it could not admit.
    blobs.release("held-1");
    expect(await reaches(blobs, "third", state => state.state === "ready")).toMatchObject({ state: "ready" });
    expect(blobs.held.images).toBe(2);
  });

  it("speculative work never takes a picture from a row that wants one", async () => {
    const blobs = pool(authority());
    await blobs.load("shown", SESSION, refOf(1, HALF), "image/png", IMAGE_PRIORITY.visible);
    await blobs.load("also-shown", SESSION, refOf(2, HALF), "image/png", IMAGE_PRIORITY.visible);
    const speculative = await blobs.load("ahead", SESSION, refOf(3, HALF), "image/png", IMAGE_PRIORITY.nearby);
    expect(speculative).toEqual({ state: "waiting", reason: "offscreen" });
    expect(blobs.stateOf("shown").state).toBe("ready");
    expect(blobs.stateOf("also-shown").state).toBe("ready");
  });

  it("shows a twenty-five picture prompt whole, and keeps only a bounded residue when it is gone", async () => {
    const blobs = pool(authority());
    const keys = Array.from({ length: 25 }, (_, index) => `shot-${index}`);
    const states = await Promise.all(keys.map((key, index) =>
      blobs.load(key, SESSION, refOf(index), "image/png", IMAGE_PRIORITY.visible)));

    // The reported defect: twenty-four decoded and the twenty-fifth disabled.
    expect(states.filter(state => state.state === "ready")).toHaveLength(25);
    expect(blobs.held.images).toBe(25);
    expect(blobs.held.surface).toBe(25 * PICTURE_SURFACE);
    expect(blobs.held.surface).toBeLessThanOrEqual(IMAGE_SURFACE_MAX_BYTES);

    // The conversation scrolls away: the offscreen residue returns to its own,
    // smaller budget, and what it gave up is waiting, never failed. Trimming
    // happens once for the whole batch, a microtask after the asking.
    for (const key of keys) blobs.prioritize(key, IMAGE_PRIORITY.background);
    await settled();
    expect(blobs.held.images).toBe(IMAGE_BLOB_MAX);
    const given = keys.filter(key => blobs.stateOf(key).state !== "ready");
    expect(given).toHaveLength(25 - IMAGE_BLOB_MAX);
    expect(blobs.stateOf(given[0]!)).toEqual({ state: "waiting", reason: "offscreen" });

    // Scrolling back to it reads it again; nothing needed a reload.
    blobs.prioritize(given[0]!, IMAGE_PRIORITY.visible);
    expect(await reaches(blobs, given[0]!, state => state.state === "ready")).toMatchObject({ state: "ready" });
  });

  it("keeps its lookahead working beside a screenful of pictures", async () => {
    // The residue budget bounds what nobody is looking at. A screen full of
    // pictures must not spend it, or the lookahead is dead in exactly the
    // conversation it exists for.
    const blobs = pool(authority());
    const visible = Array.from({ length: IMAGE_BLOB_MAX + 1 }, (_, index) => `seen-${index}`);
    const states = await Promise.all(visible.map((key, index) =>
      blobs.load(key, SESSION, refOf(index), "image/png", IMAGE_PRIORITY.visible)));
    expect(states.filter(state => state.state === "ready")).toHaveLength(IMAGE_BLOB_MAX + 1);

    const ahead = await blobs.load("ahead", SESSION, refOf(99), "image/png", IMAGE_PRIORITY.nearby);
    expect(ahead.state).toBe("ready");
    expect(blobs.held.images).toBe(IMAGE_BLOB_MAX + 2);
    // And the residue itself is still bounded: the screenful scrolls away, and
    // what is left behind is the residue budget, not the whole prompt.
    for (const key of visible) blobs.prioritize(key, IMAGE_PRIORITY.background);
    await settled();
    expect(blobs.held.images).toBe(IMAGE_BLOB_MAX);
  });

  it("gives the pictures nobody is looking at back under memory pressure", async () => {
    const blobs = pool(authority());
    await blobs.load("seen", SESSION, refOf(1), "image/png", IMAGE_PRIORITY.visible);
    await blobs.load("ahead", SESSION, refOf(2), "image/png", IMAGE_PRIORITY.nearby);
    await blobs.load("gone", SESSION, refOf(3), "image/png", IMAGE_PRIORITY.background);
    const held = await blobs.open("held-by-a-viewer", SESSION, refOf(4), "image/png");
    if ("failed" in held) throw new Error("the viewer's picture must be readable");
    expect(blobs.held.images).toBe(4);

    // Step 1 of the pressure pass: the offscreen residue, exactly counted.
    const released = blobs.releaseIdle();
    expect(released).toEqual({ count: 2, bytes: 2 * PICTURE_SURFACE });
    expect(blobs.held.images).toBe(2);
    // What a row is showing and what a viewer is holding are untouched.
    expect(blobs.stateOf("seen").state).toBe("ready");
    expect(blobs.url("held-by-a-viewer")).toBe(held.url);
    // What it gave up says it will come back, and does.
    expect(blobs.stateOf("ahead")).toEqual({ state: "waiting", reason: "offscreen" });
    blobs.prioritize("ahead", IMAGE_PRIORITY.visible);
    expect(await reaches(blobs, "ahead", state => state.state === "ready")).toMatchObject({ state: "ready" });
    // Nothing left to give is nothing, not a guess.
    held.release();
    blobs.release("seen");
    blobs.release("ahead");
    blobs.release("gone");
    await settled();
    expect(blobs.releaseIdle()).toEqual({ count: 0, bytes: 0 });
  });

  it("lets go of a picture again once the person closes it", async () => {
    const blobs = pool(authority());
    await blobs.load("opened", SESSION, refOf(1, HALF), "image/png", IMAGE_PRIORITY.background);
    const viewer = await blobs.open("opened", SESSION, refOf(1, HALF), "image/png");
    if ("failed" in viewer) throw new Error("the window was holding this picture");
    blobs.release("opened"); // the row scrolls away while the viewer is open

    // While it is open nothing may take it, however much room is wanted.
    await blobs.load("one", SESSION, refOf(2, HALF), "image/png", IMAGE_PRIORITY.visible);
    expect((await blobs.load("two", SESSION, refOf(3, HALF), "image/png", IMAGE_PRIORITY.visible)).state).toBe("waiting");
    expect(blobs.url("opened")).toBe(viewer.url);

    // The person closes it: it is an ordinary offscreen picture again, and the
    // one that was waiting takes its room. Nothing stays `requested` for ever.
    viewer.release();
    expect(await reaches(blobs, "two", state => state.state === "ready")).toMatchObject({ state: "ready" });
    expect(revoked).toContain(viewer.url);
  });

  it("gives every object URL back and never drives its counters negative", async () => {
    const blobs = pool(authority());
    await blobs.load("once", SESSION, refOf(1), "image/png");
    await blobs.load("once", SESSION, refOf(1), "image/png");
    const url = blobs.url("once");
    blobs.release("once");
    expect(revoked).not.toContain(url);
    blobs.release("once");
    expect(revoked).toEqual([url]);
    // A release nobody owns changes nothing at all.
    blobs.release("once");
    expect(revoked).toEqual([url]);
    expect(blobs.held).toEqual({ images: 0, bytes: 0, surface: 0 });
    expect(blobs.committed).toEqual(blobs.held);
  });
});

describe("opening an image a person asked for", () => {

  it("reads its bytes even when the pool has no room to decode it", async () => {
    const request = authority();
    const blobs = pool(request);
    await blobs.load("shown", SESSION, refOf(1, HALF), "image/png", IMAGE_PRIORITY.visible);
    await blobs.load("also-shown", SESSION, refOf(2, HALF), "image/png", IMAGE_PRIORITY.visible);
    const waiting = await blobs.load("wanted", SESSION, refOf(3, HALF), "image/png", IMAGE_PRIORITY.visible);
    expect(waiting.state).toBe("waiting");

    const opened = await blobs.open("wanted", SESSION, refOf(3, HALF), "image/png");
    expect("failed" in opened).toBe(false);
    if ("failed" in opened) return;
    expect(opened.url).toMatch(/^blob:/);
    expect(opened.bytes).toBeGreaterThan(0);
    // It is charged like every other picture: the window's own accounting
    // sees it, and the documented ceiling is the real one.
    expect(blobs.stateOf("wanted")).toEqual({ state: "ready", url: opened.url });
    expect(blobs.held.images).toBe(2);
    expect(blobs.held.surface).toBeLessThanOrEqual(IMAGE_SURFACE_MAX_BYTES);
    expect(blobs.committed.surface).toBeLessThanOrEqual(IMAGE_SURFACE_MAX_BYTES);
    // The room came from a picture on screen — the last resort, and only for
    // the one the person asked for by name. It says it will come back.
    expect(blobs.stateOf("shown")).toEqual({ state: "waiting", reason: "room" });

    // Closing the viewer gives the viewer's hold back and nothing else: the
    // row is still showing this picture. A second close takes nothing from it.
    opened.release();
    opened.release();
    expect(revoked).not.toContain(opened.url);
    expect(blobs.stateOf("wanted")).toEqual({ state: "ready", url: opened.url });
    // The row goes too: now the URL goes, exactly once, and the picture this
    // open displaced comes back without anyone asking for it again.
    blobs.release("wanted");
    expect(revoked.filter(url => url === opened.url)).toHaveLength(1);
    expect(await reaches(blobs, "shown", state => state.state === "ready")).toMatchObject({ state: "ready" });
  });

  it("reads a picture for a viewer once, however many times a person clicks", async () => {
    const request = authority();
    const blobs = pool(request);
    await blobs.load("shown", SESSION, refOf(1, HALF), "image/png", IMAGE_PRIORITY.visible);
    await blobs.load("also-shown", SESSION, refOf(2, HALF), "image/png", IMAGE_PRIORITY.visible);
    await blobs.load("wanted", SESSION, refOf(3, HALF), "image/png", IMAGE_PRIORITY.visible);
    const reads = request.mock.calls.length;

    const clicks = await Promise.all([
      blobs.open("wanted", SESSION, refOf(3, HALF), "image/png"),
      blobs.open("wanted", SESSION, refOf(3, HALF), "image/png"),
      blobs.open("wanted", SESSION, refOf(3, HALF), "image/png"),
    ]);
    for (const click of clicks) if ("failed" in click) throw new Error(`impatient clicking must not fail: ${click.failed}`);
    const handles = clicks as Exclude<(typeof clicks)[number], { failed: unknown }>[];
    // One read of the bytes, one blob, one URL — three holds on it.
    expect(request.mock.calls.length).toBe(reads + 1);
    expect(new Set(handles.map(handle => handle.url)).size).toBe(1);
    expect(blobs.held.images).toBe(2);

    // Closing every viewer leaves the picture with the row that is showing it;
    // releasing a handle twice does not consume the row's hold.
    for (const handle of handles) { handle.release(); handle.release(); }
    expect(revoked).not.toContain(handles[0]!.url);
    expect(blobs.stateOf("wanted")).toEqual({ state: "ready", url: handles[0]!.url });
    blobs.release("wanted");
    expect(revoked.filter(url => url === handles[0]!.url)).toHaveLength(1);
    // Leave nothing in flight behind this test: the picture displaced by the
    // open is read again as soon as there is room for it.
    blobs.release("shown");
    blobs.release("also-shown");
    await settled();
  });

  it("hands over the picture the window already has, without reading it again", async () => {
    const request = authority();
    const blobs = pool(request);
    await blobs.load("here", SESSION, refOf(1), "image/png");
    const reads = request.mock.calls.length;
    const opened = await blobs.open("here", SESSION, refOf(1), "image/png");
    if ("failed" in opened) throw new Error("the window had this picture");
    expect(opened.url).toBe(blobs.url("here"));
    expect(request.mock.calls.length).toBe(reads);
    // The row goes while the viewer is open: the picture stays until it closes.
    blobs.release("here");
    expect(revoked).not.toContain(opened.url);
    opened.release();
    expect(revoked).toContain(opened.url);
  });

  it("is never evicted under the viewer showing it", async () => {
    const blobs = pool(authority());
    await blobs.load("open-me", SESSION, refOf(1, HALF), "image/png", IMAGE_PRIORITY.background);
    const opened = await blobs.open("open-me", SESSION, refOf(1, HALF), "image/png");
    if ("failed" in opened) throw new Error("the window had this picture");
    blobs.release("open-me"); // the row scrolls away, the viewer stays
    await blobs.load("other", SESSION, refOf(2, HALF), "image/png", IMAGE_PRIORITY.visible);
    await blobs.load("another", SESSION, refOf(3, HALF), "image/png", IMAGE_PRIORITY.visible);
    expect(revoked).not.toContain(opened.url);
    opened.release();
  });
});

describe("an image that genuinely cannot be shown", () => {
  it("says so, keeps saying so, and tries again when a person asks", async () => {
    let moved = true;
    const good = authority();
    const request = vi.fn(async (params: Record<string, unknown>) => {
      if (moved) throw Object.assign(new Error("revision moved"), { code: -32007 });
      return good(params);
    });
    const blobs = pool(request);
    expect(await blobs.load("gone", SESSION, refOf(1), "image/png")).toEqual({ state: "failed", reason: "moved" });
    // A failure is remembered rather than re-read on every render.
    expect(await blobs.load("gone", SESSION, refOf(1), "image/png")).toEqual({ state: "failed", reason: "moved" });
    expect(request).toHaveBeenCalledTimes(1);

    moved = false;
    blobs.retry("gone");
    expect(await reaches(blobs, "gone", state => state.state === "ready")).toMatchObject({ state: "ready" });
  });

  it("separates bytes that are not this image from a picture it merely has no room for", async () => {
    const wrong = vi.fn(async (params: Record<string, unknown>) => ({
      authority: "durable", revision: "r", entryId: params.entryId as string, component: params.component,
      totalBytes: CHARS, offset: 0, bytes: CHARS, truncated: false,
      sliceDigest: await digestOf(WHOLE), contentDigest: await digestOf("another image entirely"), text: WHOLE,
    }));
    const blobs = pool(wrong);
    expect(await blobs.load("not-it", SESSION, refOf(1), "image/png")).toEqual({ state: "failed", reason: "corrupt" });
    expect(created).toHaveLength(0);
    // Nothing published, and opening it says the same thing rather than
    // showing an empty viewer.
    expect(await blobs.open("not-it", SESSION, refOf(1), "image/png")).toEqual({ failed: "corrupt" });
  });

  it("refuses a picture past what any window may rebuild, and does not offer a retry for it", async () => {
    const blobs = pool(authority());
    const huge = { ...refOf(1), image: { decodedBytes: IMAGE_SURFACE_MAX_BYTES + 1 } };
    expect(await blobs.load("huge", SESSION, huge, "image/png")).toEqual({ state: "failed", reason: "too-large" });
    expect(await blobs.open("huge", SESSION, huge, "image/png")).toEqual({ failed: "too-large" });
  });
});

describe("what the row says while a picture is not on screen", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  const images = [
    { type: "image" as const, mimeType: "image/png" },
    { type: "image" as const, mimeType: "image/png" },
    { type: "image" as const, mimeType: "image/png" },
    { type: "image" as const, mimeType: "image/png" },
  ];
  const states: MessageImageSource[] = [
    { src: "blob:one", state: "ready", openable: true },
    { state: "loading", message: "Loading image…", openable: true },
    { state: "waiting", message: "Shown when it scrolls into view", openable: true },
    { state: "failed", message: "Too large to show here", openable: false },
  ];

  const render = async (onOpen?: (index: number) => void, onRetry?: () => void) => {
    await act(async () => root.render(<MessageImages
      images={images}
      sourceFor={(index) => (index === 3 && onRetry ? { state: "failed", message: "Could not be read just now", openable: true, onRetry } : states[index]!)}
      onOpen={onOpen ? (index) => onOpen(index) : undefined}
    />));
  };

  it("keeps opening available while a picture is loading or waiting, and shows why", async () => {
    const opened: number[] = [];
    await render(index => opened.push(index));
    const buttons = [...container.querySelectorAll('button[aria-label^="Open Image"]')] as HTMLButtonElement[];
    expect(buttons.map(button => button.getAttribute("aria-label"))).toEqual(["Open Image 1", "Open Image 2", "Open Image 3", "Open Image 4"]);
    // Loading and waiting stay openable; only bytes this window can never
    // rebuild take the action away.
    expect(buttons.map(button => button.disabled)).toEqual([false, false, false, true]);

    // The picture that is not decoded says where it is, not that it is lost.
    const placeholders = [...container.querySelectorAll('[data-slot="message-image-placeholder"]')].map(node => node.textContent);
    expect(placeholders).toEqual(["Loading image…", "Shown when it scrolls into view", "Too large to show here"]);
    expect(container.textContent).not.toContain("Image not kept in this window");

    // The requested one opens, decoded here or not.
    await act(async () => { buttons[2]!.click(); });
    expect(opened).toEqual([2]);
  });

  it("offers a retry for an image that genuinely failed, outside the open action", async () => {
    const retried = vi.fn();
    await render(() => {}, retried);
    const retry = container.querySelector('[data-slot="message-image-retry"]') as HTMLButtonElement;
    // The tile is 112 px in a multi-image prompt: it shows the way out, and
    // its accessible name carries the sentence that will not fit beside it.
    expect(retry.getAttribute("aria-label")).toBe("Try image 4 again: Could not be read just now");
    expect(retry.textContent).toBe("Try again");
    expect(container.querySelector('button[aria-label="Open Image 4"]')).toBeNull();
    await act(async () => { retry.click(); });
    expect(retried).toHaveBeenCalledTimes(1);
    // A retry is a button of its own, never nested inside the open action.
    expect(retry.querySelector("button")).toBeNull();
  });

  it("tells the window where each picture is", async () => {
    const seen: Array<number | undefined> = [];
    await act(async () => root.render(<MessageImages
      images={images}
      sourceFor={(index) => states[index]!}
      observe={(index) => (element) => { if (element) seen.push(index); }}
    />));
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(container.querySelectorAll('[data-slot="message-image-tile"]')).toHaveLength(4);
  });
});

/**
 * The fixture's own contract, stated at a real test boundary.
 *
 * A pool outlives the test that made it unless the test retires it: the read
 * it had out at the authority lands later, into whatever window is installed
 * by then. That is correct of the pool and wrong of the fixture — it is how a
 * picture one test read arrived in the next test's `created` list and made
 * "separates bytes that are not this image…" above flicker under load.
 *
 * These two tests are one statement and only mean anything in this order: the
 * first leaves a read genuinely out at an authority that has not answered, and
 * the second answers it and then looks at its own, freshly installed, window.
 */
describe("what one test leaves half-read", () => {
  let inFlight: (ReturnType<typeof deferredAuthority> & { state: Promise<ImageState> }) | undefined;

  it("is still out at the authority when that test ends", async () => {
    const waiting = deferredAuthority();
    const blobs = pool(waiting.request);
    const state = blobs.load("still-reading", SESSION, refOf(1), "image/png", IMAGE_PRIORITY.visible);
    await waiting.asked;
    // Really in flight: charged against the pool, with nothing decoded yet.
    expect(blobs.committed.images).toBe(1);
    expect(blobs.held.images).toBe(0);
    expect(created).toEqual([]);
    inFlight = { ...waiting, state };
  });

  it("never reaches the next test's window", async () => {
    const left = inFlight;
    inFlight = undefined;
    if (!left) throw new Error("the previous test must leave a read in flight");
    // This test's window is its own: a new spy, and nothing in it yet.
    expect(created).toEqual([]);

    // The bytes the last test asked for arrive now — whole, verifiable, and
    // belonging to a pool that has been retired.
    await left.answer();
    // Everything that reply can still do is a microtask: one turn of the loop
    // is all of it, not a wait for something that might not happen.
    await settled();

    expect(left.request).toHaveBeenCalledTimes(1);
    expect(created).toEqual([]);
    expect(revoked).toEqual([]);
    // And the row that asked for it was told, at the moment the pool went.
    expect(await left.state).toEqual({ state: "waiting", reason: "retired" });
  });
});
