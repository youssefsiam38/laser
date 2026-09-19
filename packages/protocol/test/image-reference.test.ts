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
  IMAGE_REFERENCE_MAX_BYTES,
  bodyRangeSlice,
  boundedHistoryWindow,
  elideOversizedEntries,
  entryBody,
  entryBodyMetadata,
  entryImageParts,
  entryWithImageReferences,
  historyContentSerializedBytes,
  imageHeaderSize,
  toolSearchContent,
  utf8ByteLength,
  type HistoryWindowScope,
  type ImagePartReference,
} from "../src/index.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const bytesOf = (value: unknown): number => utf8ByteLength(JSON.stringify(value) ?? "");

/** A PNG of `width × height`, with a valid header and nothing else real in it. */
function png(width: number, height: number, payloadBytes: number): string {
  const bytes = Buffer.alloc(Math.max(32, payloadBytes), 0x7a);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

function jpeg(width: number, height: number): string {
  const bytes = Buffer.alloc(32, 0x00);
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]).copy(bytes, 0);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes.toString("base64");
}

function gif(width: number, height: number): string {
  const bytes = Buffer.alloc(32, 0x00);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes.toString("base64");
}

function webp(width: number, height: number): string {
  const bytes = Buffer.alloc(40, 0x00);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(32, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes.toString("base64");
}

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
    expect(entryImageParts(entry).map(part => part.totalBytes)).toEqual([utf8ByteLength(first), utf8ByteLength(second)]);
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

  it("costs less on the wire than the declared ceiling a planner prices it at", () => {
    const data = png(2560, 1440, 2_400_000);
    const entry = toolResultWith("t", data);
    const served = entryWithImageReferences(entry, sha256);
    // Base64 needs no JSON escaping, so the record without its payload is
    // exactly the stored record less that payload: what the reference adds on
    // top of it is what the host's index prices at IMAGE_REFERENCE_MAX_BYTES.
    const reference = bytesOf(served) - (bytesOf(entry) - utf8ByteLength(data));
    expect(reference).toBeGreaterThan(0);
    expect(reference).toBeLessThan(IMAGE_REFERENCE_MAX_BYTES);
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

  it("omits the size in the reference of a format it does not know", () => {
    const data = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString("base64");
    const served = entryWithImageReferences(promptWith("u", data), sha256);
    expect(refsOf(served)[0]).toEqual({
      entryId: "u", component: { kind: "image", index: 0 }, mimeType: "image/png",
      totalBytes: utf8ByteLength(data), contentDigest: sha256(data),
    });
  });

  it("looks at the header only, however large the picture is", () => {
    // A valid header followed by two megabytes of anything still measures, and
    // a payload whose header is broken is unknown however long it is.
    const large = png(3840, 2160, 2_000_000);
    expect(imageHeaderSize(large)).toEqual({ width: 3840, height: 2160 });
    const broken = `${"A".repeat(8)}${large.slice(8)}`;
    expect(imageHeaderSize(broken)).toBeUndefined();
  });
});
