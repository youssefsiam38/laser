import { createHash } from "node:crypto";
/**
 * M16-T89: the bytes of a picture never travel inside a message.
 *
 * A person's 27 MB conversation stopped paging for ever at two `toolResult`
 * screenshots of about 2.4 MB each: no page could hold one, so every older page
 * was refused. The fix is not a bigger page or a cleverer threshold — it is that
 * an `image` part is *always* served as a reference, at every size and in every
 * role, and its bytes are read back with `session/entry_range` exactly as an
 * elided body is.
 *
 * These tests pin the three things that has to mean: one rule with no
 * threshold, a self-describing reference, and a page whose size no longer
 * depends on what somebody screenshotted.
 */
import { describe, expect, it } from "vitest";
import {
  HISTORY_PAGE_BYTE_LIMIT,
  REFERENCE_DIGEST_HEX_LENGTH,
  bodyRangeSlice,
  boundedHistoryWindow,
  createImageReferenceCache,
  elideOversizedEntries,
  entryBodies,
  entryBody,
  entryBodyIdentities,
  entryBodyMetadata,
  entryWithImageReferences,
  historyContentSerializedBytes,
  imageHeaderSize,
  mcpContentBlocks,
  servedEntryWireBytes,
  toolSearchContent,
  utf8ByteLength,
  type HistoryWindowScope,
  type ImagePartReference,
} from "../src/index.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const bytesOf = (value: unknown): number => utf8ByteLength(JSON.stringify(value) ?? "");

/**
 * A payload large enough for the pixels its header declares.
 *
 * The parser refuses a size its own payload could not carry, so a fixture that
 * claims a megapixel in forty bytes is refused — correctly. Real images are
 * nowhere near this compressible; a byte per five hundred pixels is still far
 * more compressed than anything a person screenshots.
 */
const plausibleBytes = (width: number, height: number): number => Math.max(64, Math.ceil((width * height) / 500));

/** A PNG of `width × height`, with a valid header and nothing else real in it. */
function png(width: number, height: number, payloadBytes = plausibleBytes(width, height)): string {
  const bytes = Buffer.alloc(Math.max(32, payloadBytes), 0x7a);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

function jpeg(width: number, height: number, payloadBytes = plausibleBytes(width, height)): string {
  const bytes = Buffer.alloc(Math.max(32, payloadBytes), 0x11);
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]).copy(bytes, 0);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes.toString("base64");
}

function gif(width: number, height: number, payloadBytes = plausibleBytes(width, height)): string {
  const bytes = Buffer.alloc(Math.max(32, payloadBytes), 0x00);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes.toString("base64");
}

function webp(width: number, height: number, payloadBytes = plausibleBytes(width, height)): string {
  const bytes = Buffer.alloc(Math.max(40, payloadBytes), 0x00);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes.toString("base64");
}

/** The same payload, written in wrapped lines as a mail-safe encoder writes it. */
const wrapped = (base64: string, columns = 76): string =>
  (base64.match(new RegExp(`.{1,${columns}}`, "g")) ?? []).join("\r\n");

const imagePart = (data: string, mimeType = "image/png") => ({ type: "image", mimeType, data });

const promptWith = (id: string, data: string) => ({
  id, parentId: null, type: "message",
  message: { role: "user", content: [{ type: "text", text: "look at this" }, imagePart(data)] },
});
const assistantWith = (id: string, data: string) => ({
  id, parentId: "u", type: "message",
  message: { role: "assistant", content: [{ type: "text", text: "here it is" }, imagePart(data)] },
});
const toolResultWith = (id: string, data: string) => ({
  id, parentId: "a", type: "message",
  message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "screenshot taken" }, imagePart(data)] },
});

/** Every reference a served record carries, in content order. */
function refsOf(entry: unknown): ImagePartReference[] {
  const value = entry as { content?: unknown[]; message?: { content?: unknown[] } };
  const content = value.message?.content ?? value.content ?? [];
  return content.flatMap(part => {
    const row = part as { ref?: ImagePartReference };
    return row.ref ? [row.ref] : [];
  });
}

const dataOf = (entry: unknown): unknown[] => {
  const value = entry as { content?: unknown[]; message?: { content?: unknown[] } };
  return (value.message?.content ?? value.content ?? []).map(part => (part as { data?: unknown }).data);
};

describe("an image is served as a reference, at every size and in every role", () => {
  it("references a few hundred bytes of picture exactly as it references a screenshot", () => {
    const tiny = png(16, 16, 300);
    expect(utf8ByteLength(tiny)).toBeGreaterThan(300);
    const screenshot = png(2560, 1440, 2_400_000);
    expect(utf8ByteLength(tiny)).toBeLessThan(600);
    expect(utf8ByteLength(screenshot)).toBeGreaterThan(2_400_000);
    for (const [name, data, size] of [["tiny", tiny, { width: 16, height: 16 }], ["screenshot", screenshot, { width: 2560, height: 1440 }]] as const) {
      const entry = promptWith("u", data);
      const page = elideOversizedEntries([entry], undefined, sha256);
      expect(page.elided, name).toEqual([]);
      // The text part keeps its text and has no `data`; the picture's is gone.
      expect(dataOf(page.entries[0]), name).toEqual([undefined, ""]);
      expect(refsOf(page.entries[0]), name).toEqual([{
        entryId: "u", component: { kind: "image", index: 0 }, mimeType: "image/png",
        totalBytes: utf8ByteLength(data), contentDigest: sha256(data), ...size,
      }]);
    }
  });

  it("references a picture in a prompt, an assistant message and a tool result alike", () => {
    const data = png(800, 600, 40_000);
    const entries = [promptWith("u", data), assistantWith("a", data), toolResultWith("t", data)];
    const page = elideOversizedEntries(entries, 16 * 1024, sha256);
    expect(page.elided).toEqual([]);
    expect(page.entries.map(entry => refsOf(entry).map(ref => ref.entryId))).toEqual([["u"], ["a"], ["t"]]);
    for (const entry of page.entries) {
      expect(refsOf(entry)[0]).toMatchObject({ component: { kind: "image", index: 0 }, totalBytes: utf8ByteLength(data), width: 800, height: 600 });
      expect(JSON.stringify(entry)).not.toContain(data.slice(0, 64));
    }
  });

  it("references every image of a record, in its own content order", () => {
    const first = png(10, 20, 400);
    const second = gif(30, 40);
    const entry = {
      id: "many", parentId: null, type: "message",
      message: { role: "user", content: [imagePart(first), { type: "text", text: "two" }, imagePart(second, "image/gif")] },
    };
    const served = entryWithImageReferences(entry, sha256);
    expect(refsOf(served).map(ref => [ref.component, ref.mimeType, ref.width, ref.height]))
      .toEqual([[{ kind: "image", index: 0 }, "image/png", 10, 20], [{ kind: "image", index: 1 }, "image/gif", 30, 40]]);
    // The same components the body projection names, in the same order.
    expect(entryBodyMetadata(entry).filter(row => row.component.kind === "image"))
      .toEqual([{ component: { kind: "image", index: 0 }, totalBytes: utf8ByteLength(first) }, { component: { kind: "image", index: 1 }, totalBytes: utf8ByteLength(second) }]);
  });

  it("keeps the bytes where nothing could read them back", () => {
    const data = png(4, 4, 200);
    const anonymous = { parentId: null, type: "message", message: { role: "user", content: [imagePart(data)] } };
    // No entry id, so no reference could be addressed: the bytes stay put
    // rather than becoming a pointer at nothing.
    expect(entryWithImageReferences(anonymous, sha256)).toBe(anonymous);
  });

  it("leaves a record it has already served exactly as it is", () => {
    const entry = promptWith("u", png(8, 8, 300));
    const once = entryWithImageReferences(entry, sha256);
    expect(entryWithImageReferences(once, sha256)).toEqual(once);
    expect(refsOf(entryWithImageReferences(once, sha256))).toEqual(refsOf(once));
  });

  it("never serves a record from a projection of what it used to hold", () => {
    // A page's own cache lives for exactly one synchronous page build; nothing
    // caches a projection between them, because a record can change in between
    // — a module-level memo returned the previous content of a mutated record.
    const entry = promptWith("u", png(8, 8, 300)) as { message: { content: unknown[] } };
    const second = png(16, 16, 400);
    expect(refsOf(entryWithImageReferences(entry, sha256))).toHaveLength(1);
    entry.message.content.push(imagePart(second));
    const again = entryWithImageReferences(entry, sha256);
    expect(refsOf(again).map(ref => ref.totalBytes)).toEqual([utf8ByteLength(png(8, 8, 300)), utf8ByteLength(second)]);
    // Inside one page build the projection is reused rather than rehashed.
    const cache = createImageReferenceCache();
    const once = entryWithImageReferences(entry, sha256, cache);
    expect(entryWithImageReferences(entry, sha256, cache)).toBe(once);
  });
});

describe("pricing a record a planner has not read", () => {
  const screenshot = png(2560, 1440, 2_400_000);

  /** What a page will actually send for this record, with the real digest. */
  const actual = (entry: unknown): number => bytesOf(entryWithImageReferences(entry, sha256));

  it("prices a reference exactly, whatever the record's own strings are", () => {
    // The digest is the only field a placeholder stands in for, and it is the
    // one field with a fixed width. Everything else is copied from the record.
    expect(sha256("anything")).toHaveLength(REFERENCE_DIGEST_HEX_LENGTH);
    const cases: Array<[string, unknown]> = [
      ["uuid id", toolResultWith("f47ac10b-58cc-4372-a567-0e02b2c3d479", screenshot)],
      ["400-character id", toolResultWith("i".repeat(400), screenshot)],
      ["400-character media type", {
        id: "t", parentId: null, type: "message",
        message: { role: "toolResult", toolCallId: "c1", content: [imagePart(screenshot, `image/${"x".repeat(394)}`)] },
      }],
      ["many images", {
        id: "many", parentId: null, type: "message",
        message: { role: "user", content: Array.from({ length: 12 }, () => imagePart(screenshot)) },
      }],
      ["no dimensions", promptWith("u", Buffer.from("<svg></svg>").toString("base64"))],
      ["custom message", { id: "c", parentId: null, type: "custom_message", content: [imagePart(screenshot)] }],
    ];
    for (const [name, entry] of cases) {
      expect(servedEntryWireBytes(entry), name).toBe(actual(entry));
    }
  });

  it("prices a record whose images cannot be referenced with the bytes it will send", () => {
    // No `id`, so the projection leaves the payload in place. A price that
    // assumed a reference here was three megabytes short, and the exact check
    // then refused the page — the failure this milestone deletes.
    const anonymous = { parentId: null, type: "message", message: { role: "user", content: [imagePart(screenshot)] } };
    expect(servedEntryWireBytes(anonymous)).toBe(bytesOf(anonymous));
    expect(servedEntryWireBytes(anonymous)).toBeGreaterThan(3_000_000);
    expect(servedEntryWireBytes(anonymous)).toBe(actual(anonymous));
  });

  it("hashes nothing to price a page, and leaves an ordinary record alone", () => {
    const plain = { id: "u", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } };
    expect(servedEntryWireBytes(plain)).toBe(bytesOf(plain));
    // Pricing twelve 2.4 MB screenshots is a projection, not twelve hashes.
    // Proved by what it does, not by how long it takes: a wall clock measures
    // the machine's load as much as this function, and a page's price must be
    // the same answer on a busy machine as on an idle one.
    const heavy = { id: "many", parentId: null, type: "message", message: { role: "user", content: Array.from({ length: 12 }, () => imagePart(screenshot)) } };
    let measured = "";
    const priced = servedEntryWireBytes(heavy, text => { measured = text; return text.length; });
    expect(priced).toBeLessThan(8 * 1024);
    // The text a price is taken from carries no picture: twelve references and
    // a placeholder digest, never a payload to hash.
    expect(measured).not.toContain(screenshot.slice(0, 64));
    expect(measured.split("\"ref\":").length - 1).toBe(12);
  });
});

describe("both authorities describe the same bodies before and after the reference", () => {
  const data = png(640, 480, 120_000);
  const entry = toolResultWith("t", data);
  const served = entryWithImageReferences(entry, sha256);

  it("derives the same structured tool result from the stored record and the served one", () => {
    // The guard against `total-changed`: a client derives `tool_result` from the
    // record it was given, and the authority derives it from the record it
    // stores. One holds the bytes and the other holds a reference, so the body
    // both produce has to be the same string.
    expect(entryBody(served, { kind: "tool_result" })).toBe(entryBody(entry, { kind: "tool_result" }));
    expect(entryBody(served, { kind: "tool_output" })).toBe(entryBody(entry, { kind: "tool_output" }));
    expect(entryBody(entry, { kind: "tool_result" })).not.toContain(data.slice(0, 32));
    expect(entryBodyMetadata(served)).toEqual(entryBodyMetadata(entry));
  });

  it("serves identical bytes and digest for a whole read and a mid-payload range", () => {
    const whole = bodyRangeSlice(entry, { entryId: "t", component: { kind: "image", index: 0 }, offset: 0, limit: 64 * 1024 }, "r1", "durable", sha256);
    if (!whole.ok) throw new Error("expected the image body");
    expect(whole.result.totalBytes).toBe(utf8ByteLength(data));
    expect(whole.result.contentDigest).toBe(sha256(data));
    expect(whole.result.contentDigest).toBe(refsOf(served)[0]!.contentDigest);

    const middle = { entryId: "t", component: { kind: "image", index: 0 } as const, offset: 40_000, limit: 1_024 };
    const live = bodyRangeSlice(entry, middle, "r1", "live", sha256);
    const durable = bodyRangeSlice(entry, middle, "r1", "durable", sha256);
    if (!live.ok || !durable.ok) throw new Error("expected a mid-payload range");
    expect(live.result.text).toBe(data.slice(40_000, 41_024));
    expect(live.result.text).toBe(durable.result.text);
    expect(live.result.sliceDigest).toBe(durable.result.sliceDigest);
    expect(live.result.contentDigest).toBe(durable.result.contentDigest);
    expect(live.result.next).toBe(41_024);
  });

  it("indexes no more and no less for search than it did before", () => {
    const tool = (record: unknown) => ({
      name: "screenshot",
      args: { selector: "body" },
      result: (record as { message: { content: unknown[]; details?: unknown } }).message,
      isError: false,
    });
    expect(toolSearchContent(tool(served))).toEqual(toolSearchContent(tool(entry)));
    // No base64, no reference metadata, no key-only match.
    const indexed = toolSearchContent(tool(served)).join("\n");
    expect(indexed).toContain("screenshot taken");
    expect(indexed).not.toContain("image/png");
    expect(indexed).not.toContain(sha256(data));
    expect(indexed).not.toContain("mimeType");
  });
});

describe("a page's size no longer depends on what somebody screenshotted", () => {
  /** The shape that broke: two ~2.4 MB toolResult screenshots among ordinary messages. */
  function failingShape(): unknown[] {
    const entries: unknown[] = [];
    let previous: string | null = null;
    for (let index = 0; index < 20; index++) {
      const id = `m${index}`;
      const role = index % 2 ? "assistant" : "user";
      entries.push({ id, parentId: previous, type: "message", message: { role, content: [{ type: "text", text: `Message ${index}` }] } });
      previous = id;
    }
    // The two payload sizes the person's session actually carried.
    for (const at of [2_421_366, 2_405_990] as const) {
      const call = { id: `call-${at}`, parentId: previous, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `c-${at}`, name: "screenshot", arguments: { selector: "body" } }] } };
      const result = {
        id: `shot-${at}`, parentId: call.id, type: "message",
        message: { role: "toolResult", toolCallId: `c-${at}`, content: [{ type: "text", text: "screenshot taken" }, imagePart(png(2560, 1440, at))] },
      };
      entries.push(call, result);
      previous = result.id;
    }
    return entries;
  }

  const scope = (): HistoryWindowScope => ({
    sessionId: "s1", epoch: "live", seq: 1, revision: "r1.tag.1", environmentKey: "e1",
    authority: "live", selection: { kind: "replace" },
  });

  it("fits the failing shape in one page, with room to spare, at any body limit", () => {
    const entries = failingShape();
    const leafId = (entries.at(-1) as { id: string }).id;
    const before = historyContentSerializedBytes(entries, []);
    expect(before).toBeGreaterThan(4 * HISTORY_PAGE_BYTE_LIMIT);
    for (const bodyLimit of [undefined, 16 * 1024, HISTORY_PAGE_BYTE_LIMIT]) {
      const page = boundedHistoryWindow({ entries, leafId }, { tail: 40 }, scope(), { ...(bodyLimit === undefined ? {} : { limit: bodyLimit }), digest: sha256 });
      if (!page) throw new Error(`the failing shape was refused at bodyLimit ${String(bodyLimit)}`);
      const after = historyContentSerializedBytes(page.entries, page.window.context) + historyContentSerializedBytes(page.window.elided ?? [], []);
      // Every row of the conversation is in the page, and nothing was elided.
      expect(page.entries).toHaveLength(entries.length);
      expect(page.window.elided ?? []).toEqual([]);
      expect(page.window.complete).toBe(true);
      expect(after).toBeLessThan(HISTORY_PAGE_BYTE_LIMIT / 8);
      if (bodyLimit === undefined) console.info(`M16-T89 failing-shape page: ${before} B before, ${after} B after`);
      // The screenshots are addressable, in the page, from their own records.
      const refs = page.entries.flatMap(refsOf);
      expect(refs.map(ref => ref.totalBytes)).toEqual([2_421_366, 2_405_990].map(size => utf8ByteLength(png(2560, 1440, size))));
      expect(refs.every(ref => ref.contentDigest.length === 64 && ref.width === 2560 && ref.height === 1440)).toBe(true);
    }
  });

  it("keeps the record ceiling as the net it now is", () => {
    // A record that is large for some other reason is still elided (M16-T88).
    const entries = [
      { id: "u", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
      { id: "a", parentId: "u", type: "message", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(2 * HISTORY_PAGE_BYTE_LIMIT) }, imagePart(png(32, 32, 400))] } },
    ];
    const page = boundedHistoryWindow({ entries, leafId: "a" }, { tail: 40 }, scope(), { digest: sha256 });
    if (!page) throw new Error("expected a page");
    expect(page.window.elided?.map(row => row.id)).toEqual(["a"]);
    expect(page.window.elided?.[0]?.bodies.map(body => body.component.kind)).toEqual(["assistant_text", "image"]);
  });
});

describe("intrinsic size comes from the image's own header, or from nowhere", () => {
  it("reads PNG, JPEG, GIF and WebP, and refuses to guess anything else", () => {
    expect(imageHeaderSize(png(1512, 982, 4_000))).toEqual({ width: 1512, height: 982 });
    expect(imageHeaderSize(jpeg(320, 240))).toEqual({ width: 320, height: 240 });
    expect(imageHeaderSize(gif(64, 48))).toEqual({ width: 64, height: 48 });
    expect(imageHeaderSize(webp(1024, 768))).toEqual({ width: 1024, height: 768 });
    for (const unknown of [
      Buffer.from('<svg width="10" height="10"></svg>').toString("base64"),
      Buffer.alloc(64, 0x41).toString("base64"),
      "",
      "not base64 at all ***",
      png(0, 10, 300),
    ]) expect(imageHeaderSize(unknown)).toBeUndefined();
  });

  it("reads a payload written in wrapped lines exactly as a browser does", () => {
    // `atob` treats ASCII whitespace as absent, so a mail-safe encoder's line
    // breaks are not data. One implementation, one answer: a line-wrapped
    // screenshot measured in the browser and not in the reference an authority
    // published, which is two authorities for one set of bytes.
    const payload = png(1512, 982, 8_000);
    expect(imageHeaderSize(wrapped(payload))).toEqual({ width: 1512, height: 982 });
    expect(imageHeaderSize(wrapped(payload, 4))).toEqual({ width: 1512, height: 982 });
    expect(imageHeaderSize(payload.replace(/^(.{8})/, "$1\n  \t"))).toEqual({ width: 1512, height: 982 });
    // And the reference an authority publishes carries it too.
    const served = entryWithImageReferences(promptWith("u", wrapped(payload)), sha256);
    expect(refsOf(served)[0]).toMatchObject({ width: 1512, height: 982, totalBytes: utf8ByteLength(wrapped(payload)) });
  });

  it("refuses a size the payload could not possibly carry", () => {
    // A three-hundred-byte header declaring 65,536 × 65,536 is a claim, not a
    // measurement; a reader that believed it would reserve a 17 GB surface.
    expect(imageHeaderSize(png(65_536, 65_536, 300))).toBeUndefined();
    expect(imageHeaderSize(png(20_000, 20_000, 1_000))).toBeUndefined();
    expect(imageHeaderSize(gif(60_000, 60_000, 64))).toBeUndefined();
    // A real screenshot is nowhere near the bound, in either format.
    expect(imageHeaderSize(png(2560, 1440, 2_405_990))).toEqual({ width: 2560, height: 1440 });
    expect(imageHeaderSize(png(3840, 2160, 400_000))).toEqual({ width: 3840, height: 2160 });
    expect(imageHeaderSize(jpeg(4032, 3024, 900_000))).toEqual({ width: 4032, height: 3024 });
    // The lie never reaches the wire: the reference simply omits the size.
    const served = entryWithImageReferences(promptWith("u", png(65_536, 65_536, 300)), sha256);
    expect(refsOf(served)[0]!.width).toBeUndefined();
    expect(refsOf(served)[0]!.height).toBeUndefined();
  });

  it("answers nothing, and never throws, on hostile or truncated input", () => {
    const truncate = (base64: string, chars: number): string => base64.slice(0, chars);
    const jpegWithoutFrame = (() => {
      const bytes = Buffer.alloc(600, 0x00);
      Buffer.from([0xff, 0xd8]).copy(bytes, 0);
      // Twenty APP0 segments and no start of frame: the probe gives up.
      for (let at = 2, segment = 0; segment < 20 && at + 20 < bytes.length; segment++, at += 22) {
        bytes[at] = 0xff;
        bytes[at + 1] = 0xe0;
        bytes.writeUInt16BE(20, at + 2);
      }
      return bytes.toString("base64");
    })();
    const zeroLengthSegment = (() => {
      const bytes = Buffer.alloc(64, 0x00);
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]).copy(bytes, 0);
      return bytes.toString("base64");
    })();
    const unknownWebpTag = (() => {
      const bytes = Buffer.alloc(64, 0x00);
      bytes.write("RIFF", 0, "ascii");
      bytes.write("WEBP", 8, "ascii");
      bytes.write("VP9?", 12, "ascii");
      return bytes.toString("base64");
    })();
    for (const [name, payload] of [
      ["truncated PNG signature", truncate(png(100, 100), 8)],
      ["PNG header cut inside IHDR", truncate(png(100, 100), 24)],
      ["JPEG with no frame header", jpegWithoutFrame],
      ["JPEG with a zero-length segment", zeroLengthSegment],
      ["WebP with an unknown tag", unknownWebpTag],
      ["whitespace only", "   \n\t  "],
      ["padding only", "===="],
      ["one character", "A"],
      ["100 KB of one letter", "A".repeat(100_000)],
    ] as const) {
      expect(() => imageHeaderSize(payload), name).not.toThrow();
      expect(imageHeaderSize(payload), name).toBeUndefined();
    }
    // URL-safe base64 is the same bytes and the same answer.
    const safe = png(640, 480, 4_000).replaceAll("+", "-").replaceAll("/", "_");
    expect(imageHeaderSize(safe)).toEqual({ width: 640, height: 480 });
  });

  it("omits the size in the reference of a format it does not know", () => {
    const data = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString("base64");
    const served = entryWithImageReferences(promptWith("u", data), sha256);
    expect(refsOf(served)[0]).toEqual({
      entryId: "u", component: { kind: "image", index: 0 }, mimeType: "image/png",
      totalBytes: utf8ByteLength(data), contentDigest: sha256(data),
    });
  });

  it("looks at the header only, whatever follows it and however large it is", () => {
    const large = png(3840, 2160, 2_000_000);
    expect(imageHeaderSize(large)).toEqual({ width: 3840, height: 2160 });
    // Proof that nothing past the probe window is read: everything after the
    // first four kilobytes is not base64 at all, and the answer is unchanged.
    const probeOnly = `${large.slice(0, 4 * 1024)}${"*".repeat(64)}`;
    expect(imageHeaderSize(probeOnly, utf8ByteLength(large))).toEqual({ width: 3840, height: 2160 });
    // A broken header stays unknown however long the payload is.
    expect(imageHeaderSize(`${"A".repeat(8)}${large.slice(8)}`)).toBeUndefined();
    // And the cost does not follow the payload: measuring a 4 MB picture a
    // hundred times stays inside a fraction of what decoding one would take.
    const huge = png(3840, 2160, 3_000_000);
    const started = performance.now();
    for (let round = 0; round < 100; round++) expect(imageHeaderSize(huge)).toEqual({ width: 3840, height: 2160 });
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("a served record cannot be mistaken for the conversation", () => {
  const data = png(1512, 982, 200_000);
  const stored = toolResultWith("t", data);
  const image = { kind: "image", index: 0 } as const;

  it("refuses to read an image body from a record that does not hold it", () => {
    const served = entryWithImageReferences(stored, sha256);
    // The stored record answers for its own bytes, in full.
    expect(entryBody(stored, image)).toBe(data);
    expect(entryBodies(stored).map(row => row.component.kind)).toContain("image");
    // The served record holds a reference, not bytes: asking it for the body is
    // refused, rather than answered with zero bytes and the digest of nothing,
    // which would fail a client's `total-changed` fence with no diagnosable
    // cause.
    expect(entryBody(served, image)).toBeUndefined();
    expect(entryBodies(served).map(row => row.component.kind)).not.toContain("image");
    const refused = bodyRangeSlice(served, { entryId: "t", component: image, offset: 0 }, "r1", "durable", sha256);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.refusal.reason).toBe("unknown-component");
    expect(!refused.ok && refused.refusal.reason === "unknown-component" && refused.refusal.available).not.toContain("image");
  });

  it("publishes no identity it cannot stand behind, and still says how large the picture is", () => {
    const served = entryWithImageReferences(stored, sha256);
    const hasher = () => { const hash = createHash("sha256"); return { update: (chunk: string) => { hash.update(chunk, "utf8"); }, digest: () => hash.digest("hex") }; };
    const identities = entryBodyIdentities(served, hasher).bodies;
    expect(identities.map(row => row.component.kind)).not.toContain("image");
    expect(identities.some(row => row.totalBytes === 0)).toBe(false);
    // The stored record's identity for that image is the one an authority signs.
    expect(entryBodyIdentities(stored, hasher).bodies.find(row => row.component.kind === "image"))
      .toEqual({ component: image, totalBytes: utf8ByteLength(data), contentDigest: sha256(data) });
    // A client reading the served record still learns the real size: that is
    // what it needs in order to go and read the bytes.
    expect(entryBodyMetadata(served).find(row => row.component.kind === "image"))
      .toEqual({ component: image, totalBytes: utf8ByteLength(data) });
  });
});

describe("a served image part is still an image to every projection that reads one", () => {
  const data = png(1512, 982, 120_000);
  const stored = toolResultWith("t", data);
  const served = entryWithImageReferences(stored, sha256) as { message: { content: unknown[] } };

  it("keeps the picture in an MCP result's blocks, with its reference", () => {
    // Dropping a part for failing to look like base64 is how a screenshot
    // vanished from a tool result without a trace (M16-T89).
    const blocks = mcpContentBlocks(served.message);
    expect(blocks.map(block => block.kind)).toEqual(["text", "image"]);
    const block = blocks[1]!;
    if (block.kind !== "image") throw new Error("expected the image block");
    expect(block.data).toBe("");
    expect(block.mimeType).toBe("image/png");
    expect(block.ref).toMatchObject({ entryId: "t", totalBytes: utf8ByteLength(data), width: 1512, height: 982 });
    // A stored result still carries its bytes in the same position.
    expect(mcpContentBlocks((stored as { message: unknown }).message).map(b => b.kind)).toEqual(["text", "image"]);
    // An image part that is neither bytes nor a reference is still dropped.
    expect(mcpContentBlocks({ content: [{ type: "image", mimeType: "image/png", data: "" }] })).toEqual([]);
    expect(mcpContentBlocks({ content: [{ type: "image", mimeType: "image/png", data: "not base64 ***" }] })).toEqual([]);
  });
});
