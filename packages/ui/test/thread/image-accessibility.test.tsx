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

beforeEach(() => {
  created = []; revoked = [];
  let counter = 0;
  globalThis.URL.createObjectURL = vi.fn(() => { const url = `blob:${++counter}`; created.push(url); return url; });
  globalThis.URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
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
    const blobs = new ImageBlobs(request as never, "env");
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

describe("a window that cannot decode everything at once", () => {
  /** Two of these fill the whole surface budget; a third needs room made. */
  const HALF = Math.floor(IMAGE_SURFACE_MAX_BYTES / 2);

  it("takes room from the least recently visible picture, not from one on screen", async () => {
    const blobs = new ImageBlobs(authority() as never, "env");
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
    const blobs = new ImageBlobs(authority() as never, "env");
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
    const blobs = new ImageBlobs(authority() as never, "env");
    await blobs.load("shown", SESSION, refOf(1, HALF), "image/png", IMAGE_PRIORITY.visible);
    await blobs.load("also-shown", SESSION, refOf(2, HALF), "image/png", IMAGE_PRIORITY.visible);
    const speculative = await blobs.load("ahead", SESSION, refOf(3, HALF), "image/png", IMAGE_PRIORITY.nearby);
    expect(speculative).toEqual({ state: "waiting", reason: "offscreen" });
    expect(blobs.stateOf("shown").state).toBe("ready");
    expect(blobs.stateOf("also-shown").state).toBe("ready");
  });

  it("shows a twenty-five picture prompt whole, and keeps only a bounded residue when it is gone", async () => {
    const blobs = new ImageBlobs(authority() as never, "env");
    const keys = Array.from({ length: 25 }, (_, index) => `shot-${index}`);
    const states = await Promise.all(keys.map((key, index) =>
      blobs.load(key, SESSION, refOf(index), "image/png", IMAGE_PRIORITY.visible)));

    // The reported defect: twenty-four decoded and the twenty-fifth disabled.
    expect(states.filter(state => state.state === "ready")).toHaveLength(25);
    expect(blobs.held.images).toBe(25);
    expect(blobs.held.surface).toBe(25 * PICTURE_SURFACE);
    expect(blobs.held.surface).toBeLessThanOrEqual(IMAGE_SURFACE_MAX_BYTES);

    // The conversation scrolls away: the offscreen residue returns to its own,
    // smaller budget, and what it gave up is waiting, never failed.
    for (const key of keys) blobs.prioritize(key, IMAGE_PRIORITY.background);
    expect(blobs.held.images).toBe(IMAGE_BLOB_MAX);
    const given = keys.filter(key => blobs.stateOf(key).state !== "ready");
    expect(given).toHaveLength(25 - IMAGE_BLOB_MAX);
    expect(blobs.stateOf(given[0]!)).toEqual({ state: "waiting", reason: "offscreen" });

    // Scrolling back to it reads it again; nothing needed a reload.
    blobs.prioritize(given[0]!, IMAGE_PRIORITY.visible);
    expect(await reaches(blobs, given[0]!, state => state.state === "ready")).toMatchObject({ state: "ready" });
  });

  it("gives every object URL back and never drives its counters negative", async () => {
    const blobs = new ImageBlobs(authority() as never, "env");
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
  const HALF = Math.floor(IMAGE_SURFACE_MAX_BYTES / 2);

  it("reads its bytes even when the pool has no room to decode it", async () => {
    const request = authority();
    const blobs = new ImageBlobs(request as never, "env");
    await blobs.load("shown", SESSION, refOf(1, HALF), "image/png", IMAGE_PRIORITY.visible);
    await blobs.load("also-shown", SESSION, refOf(2, HALF), "image/png", IMAGE_PRIORITY.visible);
    const waiting = await blobs.load("wanted", SESSION, refOf(3, HALF), "image/png", IMAGE_PRIORITY.visible);
    expect(waiting.state).toBe("waiting");

    const opened = await blobs.open("wanted", SESSION, refOf(3, HALF), "image/png");
    expect("failed" in opened).toBe(false);
    if ("failed" in opened) return;
    expect(opened.url).toMatch(/^blob:/);
    expect(opened.bytes).toBeGreaterThan(0);
    // The pool is untouched: nothing a row is showing was taken for the viewer.
    expect(blobs.held.images).toBe(2);
    expect(blobs.stateOf("shown").state).toBe("ready");
    // Closing the viewer gives its bytes back.
    opened.release();
    expect(revoked).toContain(opened.url);
    opened.release();
    expect(revoked.filter(url => url === opened.url)).toHaveLength(1);
  });

  it("hands over the picture the window already has, without reading it again", async () => {
    const request = authority();
    const blobs = new ImageBlobs(request as never, "env");
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
    const blobs = new ImageBlobs(authority() as never, "env");
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
    const blobs = new ImageBlobs(request as never, "env");
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
    const blobs = new ImageBlobs(wrong as never, "env");
    expect(await blobs.load("not-it", SESSION, refOf(1), "image/png")).toEqual({ state: "failed", reason: "corrupt" });
    expect(created).toHaveLength(0);
    // Nothing published, and opening it says the same thing rather than
    // showing an empty viewer.
    expect(await blobs.open("not-it", SESSION, refOf(1), "image/png")).toEqual({ failed: "corrupt" });
  });

  it("refuses a picture past what any window may rebuild, and does not offer a retry for it", async () => {
    const blobs = new ImageBlobs(authority() as never, "env");
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
    expect(retry.getAttribute("aria-label")).toBe("Try image 4 again");
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
