import { describe, expect, it, vi } from "vitest";
import type { ImageContent } from "@lasercode/protocol";

import {
  byteLength,
  entryBytes,
  IMAGE_PROBE_BYTES,
  imageDimensions,
  imageMeasure,
  measureView,
  UNKNOWN_IMAGE_DECODED_BYTES,
} from "../../src/runtime/view-measure.js";
import type { Block, SessionView } from "../../src/store.js";

const view = (over: Partial<SessionView> = {}): SessionView => ({
  path: "/p/a.jsonl",
  state: { path: "/p/a.jsonl", cwd: "/p", messageCount: 2, pendingMessageCount: 0, isStreaming: false, isCompacting: false } as SessionView["state"],
  blocks: [],
  lastSeq: 0,
  running: false,
  queue: { steering: [], followUp: [] },
  pending: [],
  dialogs: [],
  statuses: {},
  widgets: {},
  openedAt: "2026-09-15T00:00:00.000Z",
  hydrated: true,
  entries: [],
  capabilities: [],
  goal: null,
  ...over,
});

const base64 = (bytes: number[]): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const png = (width: number, height: number, padding = 0): string => {
  const be = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  return base64([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be(13), 0x49, 0x48, 0x44, 0x52,
    ...be(width), ...be(height),
    ...Array.from({ length: padding }, (_, index) => index % 251),
  ]);
};

const gif = (width: number, height: number): string =>
  base64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, width & 0xff, width >> 8, height & 0xff, height >> 8, 0, 0, 0, 0, 0, 0]);

const jpeg = (width: number, height: number): string =>
  base64([
    0xff, 0xd8,
    // One APP0 segment to walk past, then a real frame header.
    0xff, 0xe0, 0x00, 0x10, ...Array.from({ length: 14 }, () => 0x20),
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff,
    ...Array.from({ length: 8 }, () => 0),
  ]);

const webpLossy = (width: number, height: number): string =>
  base64([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x20, 0, 0, 0, 0,
    0x9d, 0x01, 0x2a, 0, 0, 0,
    width & 0xff, width >> 8, height & 0xff, height >> 8,
  ]);

const image = (data: string, mimeType = "image/png"): ImageContent => ({ type: "image", mimeType, data });

describe("exact bytes", () => {
  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    expect(byteLength("abc")).toBe(3);
    // Ten code units, thirteen bytes: a length-based estimate would say ten.
    expect("héllo — ok".length).toBe(10);
    expect(byteLength("héllo — ok")).toBe(13);
    expect(byteLength("🛰")).toBe(4);
  });

  it("measures one entry once, however often it is asked for", () => {
    const entry = { id: "e1", type: "message", message: { role: "user", content: [{ type: "text", text: "héllo" }] } };
    const first = entryBytes(entry);
    expect(first).toBe(byteLength(JSON.stringify(entry)));
    const stringify = vi.spyOn(JSON, "stringify");
    expect(entryBytes(entry)).toBe(first);
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
  });
});

describe("image size", () => {
  it("reads PNG, GIF, JPEG and WebP dimensions from their own headers", () => {
    expect(imageDimensions(png(2048, 1024))).toEqual({ width: 2048, height: 1024 });
    expect(imageDimensions(gif(320, 200))).toEqual({ width: 320, height: 200 });
    expect(imageDimensions(jpeg(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(webpLossy(300, 150))).toEqual({ width: 300, height: 150 });
  });

  it("charges encoded bytes plus the decoded surface an image really keeps", () => {
    const measure = imageMeasure(image(png(1024, 512, 4_096)));
    expect(measure.dimensions).toEqual({ width: 1024, height: 512 });
    expect(measure.decoded).toBe(1024 * 512 * 4);
    expect(measure.encoded).toBeGreaterThan(4_000);
  });

  it("says a size it cannot read is unavailable, and never zero", () => {
    const svg = image(btoa('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), "image/svg+xml");
    const measure = imageMeasure(svg);
    expect(measure.decoded).toBeUndefined();
    const measured = measureView(view({ blocks: [{ kind: "user", id: "b1", text: "", files: [], images: [svg] }] }));
    expect(measured.imagesEstimated).toBe(1);
    expect(measured.imagesBytes).toBeGreaterThanOrEqual(UNKNOWN_IMAGE_DECODED_BYTES);
  });

  it("decodes only a bounded prefix of a large image, and constructs no bitmap", () => {
    // 12 MiB of base64 in front of a header that is in the first bytes.
    const big = image(png(64, 64, 12 * 1024 * 1024));
    const decode = vi.spyOn(globalThis, "atob");
    const created = vi.fn();
    const originalImage = (globalThis as { Image?: unknown }).Image;
    (globalThis as { Image?: unknown }).Image = created;
    const measure = imageMeasure(big);
    expect(measure.dimensions).toEqual({ width: 64, height: 64 });
    expect(decode).toHaveBeenCalledTimes(1);
    expect(decode.mock.calls[0]![0]!.length).toBeLessThanOrEqual(Math.ceil(IMAGE_PROBE_BYTES / 3) * 4);
    expect(created).not.toHaveBeenCalled();
    decode.mockRestore();
    if (originalImage === undefined) delete (globalThis as { Image?: unknown }).Image;
    else (globalThis as { Image?: unknown }).Image = originalImage;
  });
});

describe("one view", () => {
  it("accounts entries, blocks and images separately", () => {
    const blocks: Block[] = [
      { kind: "user", id: "b1", text: "héllo", files: [], images: [image(png(8, 8))] },
      { kind: "assistant", id: "b2", text: "answer", thinking: "reasons", streaming: false },
      { kind: "tool", id: "b3", name: "bash", args: { command: "ls" }, result: "one\ntwo", done: true },
    ];
    const entries = [{ id: "e1", type: "message", message: { role: "user", content: [{ type: "text", text: "héllo" }] } }];
    const measure = measureView(view({ blocks, entries }));
    expect(measure.entriesBytes).toBe(byteLength(JSON.stringify(entries[0])));
    expect(measure.blocksBytes).toBeGreaterThan(0);
    expect(measure.images).toBe(1);
    expect(measure.imagesBytes).toBe(8 * 8 * 4 + Math.floor((png(8, 8).length * 3) / 4));
    expect(measure.bytes).toBe(measure.entriesBytes + measure.blocksBytes + measure.imagesBytes);
    // Block payloads are not charged twice: the image is in `imagesBytes`.
    expect(measure.blocksBytes).toBeLessThan(measure.imagesBytes);
  });

  it("costs the delta, not the transcript, when one block changes", () => {
    const blocks: Block[] = Array.from({ length: 200 }, (_, index) => ({
      kind: "assistant", id: `b${index}`, text: `line ${index}`, thinking: "", streaming: false,
    }));
    const first = measureView(view({ blocks }));
    const stringify = vi.spyOn(JSON, "stringify");
    const grown: Block[] = [...blocks.slice(0, -1), { ...blocks.at(-1)! as Extract<Block, { kind: "assistant" }>, text: "line 199 and more" }];
    const second = measureView(view({ blocks: grown }));
    // Only the replaced block is measured again; the 199 settled ones are not.
    expect(stringify).not.toHaveBeenCalled();
    expect(second.blocksBytes).toBeGreaterThan(first.blocksBytes);
    stringify.mockRestore();
  });
});

describe("counting UTF-8 without producing it", () => {
  const encoder = new TextEncoder();
  const cases = [
    "", "plain ascii", "héllo — ok", "🛰 orbit", "🇦🇶🇦🇶", "a\u0000b",
    "\u{10FFFF}", "mixed 🛰 héllo \u00ff\u0800\uffff",
    // Unpaired surrogates: a high one at the end, a low one alone, and a
    // high one followed by an ordinary character.
    "lone high \ud83d", "\udc96 lone low", "\ud83dx", "\ud83d\ud83d\ude00",
  ];

  it("agrees with TextEncoder on every shape, including unpaired surrogates", () => {
    for (const text of cases) expect([text, byteLength(text)]).toEqual([text, encoder.encode(text).length]);
  });

  it("allocates no buffer to answer", () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    const blocks: Block[] = [{ kind: "assistant", id: "b1", text: "x".repeat(200_000), thinking: "🛰".repeat(1_000), streaming: false }];
    const measure = measureView(view({ blocks }));
    expect(measure.blocksBytes).toBe(200_000 + 4_000);
    expect(encode).not.toHaveBeenCalled();
    encode.mockRestore();
  });
});
