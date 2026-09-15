import { createHash } from "node:crypto";
/**
 * RP-5b acceptance A6: the addressing contract itself.
 *
 * One projection names every body of an entry, one slicer cuts it on character
 * boundaries, and the page option that leaves an oversized record out never
 * rewrites a record.
 */
import { describe, expect, it } from "vitest";
import {
  BODY_COMPONENT_KINDS,
  ENTRY_RANGE_MAX_BYTES,
  bodyComponentKey,
  attachmentRegions,
  BODY_REGION_MAX_ITEMS,
  BODY_REGION_METADATA_MAX_BYTES,
  BODY_REGION_SCAN_MAX_BYTES,
  bodyProjectionWork,
  bodyRangeSlice,
  createAttachmentScanner,
  sliceUtf8RangeFrom,
  elideOversizedEntries,
  entryBodies,
  entryBodyIdentities,
  entryRegionsPage,
  type BodyRegion,
  PERSISTED_IDENTITY_MAX_BYTES,
  PERSISTED_IDENTITY_MAX_ITEMS,
  boundedBodyText,
  clientMethods,
  entryBodyMetadata,
  resetBodyProjectionWork,
  clientParamsSchemas,
  elideOversizedEntries,
  entryBodies,
  entryBody,
  largestBodyBytes,
  parseBodyComponentKey,
  sliceUtf8Range,
  utf8ByteLength,
  METHOD_POLICY,
  type BodyComponent,
} from "../src/index.js";

const digest = (text: string): string => `d${utf8ByteLength(text)}`;

const assistant = {
  id: "e1", parentId: "e0", type: "message",
  message: { role: "assistant", content: [
    { type: "text", text: "hello" },
    { type: "thinking", thinking: "because" },
    { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
  ] },
};
const toolResult = { id: "e2", parentId: "e1", type: "message", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }] } };
const prompt = {
  id: "e0", parentId: null, type: "message",
  message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "QUJD" }] },
};

describe("the shared body projection", () => {
  it("names every addressable body of an entry, and nothing else", () => {
    expect(entryBodies(assistant).map(body => bodyComponentKey(body.component)))
      .toEqual(["assistant_text", "reasoning", "tool_args:0"]);
    expect(entryBodies(prompt).map(body => bodyComponentKey(body.component))).toEqual(["user_text", "image:0"]);
    expect(entryBodies(toolResult).map(body => bodyComponentKey(body.component))).toEqual(["tool_result"]);
    expect(entryBody(assistant, { kind: "reasoning" })).toBe("because");
    expect(entryBody(assistant, { kind: "tool_result" })).toBeUndefined();
    expect(largestBodyBytes(prompt)).toBe(utf8ByteLength("QUJD"));
  });

  it("round-trips component keys and refuses unknown ones", () => {
    for (const kind of BODY_COMPONENT_KINDS) {
      const component: BodyComponent = { kind, index: 3 };
      expect(parseBodyComponentKey(bodyComponentKey(component))).toEqual(component);
    }
    expect(parseBodyComponentKey("not_a_component")).toBeUndefined();
    expect(parseBodyComponentKey("image:-1")).toBeUndefined();
  });
});

describe("slicing by exact UTF-8 bytes", () => {
  const text = "aé😀b".repeat(4); // 1, 2, 4 and 1 byte characters

  it("never splits a character, and says where the next slice starts", () => {
    const first = sliceUtf8Range(text, 0, 3)!;
    expect(first.text).toBe("aé");
    expect(first.bytes).toBe(3);
    expect(first.next).toBe(3);
    expect(first.truncated).toBe(true);
    const second = sliceUtf8Range(text, first.next!, 4)!;
    expect(second.text).toBe("😀");
    expect(second.bytes).toBe(4);
  });

  it("reads a whole body in slices that reassemble exactly", () => {
    let offset = 0;
    let out = "";
    for (let step = 0; step < 100; step++) {
      const slice = sliceUtf8Range(text, offset, 4)!;
      out += slice.text;
      if (slice.next === undefined) break;
      offset = slice.next;
    }
    expect(out).toBe(text);
  });

  it("refuses an offset inside a character, past the end, or a limit smaller than one", () => {
    expect(sliceUtf8Range(text, 4, 8)).toBeUndefined();
    expect(sliceUtf8Range(text, utf8ByteLength(text) + 1, 8)).toBeUndefined();
    // A limit smaller than the character standing at that offset addresses
    // nothing; the schema's minimum of four makes this unreachable on the wire.
    expect(sliceUtf8Range(text, 3, 1)).toBeUndefined();
    expect(sliceUtf8Range(text, -1, 8)).toBeUndefined();
    expect(sliceUtf8Range(text, 0, 0)).toBeUndefined();
    // The exact end is an honest empty slice, not a refusal.
    expect(sliceUtf8Range(text, utf8ByteLength(text), 8)).toMatchObject({ bytes: 0, truncated: false });
  });

  it("answers one body with its totals and digests, or says which it has", () => {
    const answer = bodyRangeSlice(assistant, { component: { kind: "assistant_text" }, offset: 0 }, "r1", "durable", digest);
    expect(answer.ok && answer.result).toMatchObject({ authority: "durable", revision: "r1", totalBytes: 5, bytes: 5, truncated: false, text: "hello" });
    const missing = bodyRangeSlice(assistant, { component: { kind: "tool_result" }, offset: 0 }, "r1", "durable", digest);
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.refusal).toEqual({ reason: "unknown-component", available: ["assistant_text", "reasoning", "tool_args"] });
    const bad = bodyRangeSlice(assistant, { component: { kind: "assistant_text" }, offset: 99 }, "r1", "durable", digest);
    expect(!bad.ok && bad.refusal.reason).toBe("bad-range");
  });

  it("caps one answer at the declared payload ceiling", () => {
    const huge = { id: "e9", parentId: null, type: "message", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(200_000) }] } };
    const answer = bodyRangeSlice(huge, { component: { kind: "assistant_text" }, offset: 0, limit: 10 * ENTRY_RANGE_MAX_BYTES }, "r1", "live", digest);
    expect(answer.ok && answer.result.bytes).toBe(ENTRY_RANGE_MAX_BYTES);
    expect(answer.ok && answer.result.next).toBe(ENTRY_RANGE_MAX_BYTES);
  });
});

describe("leaving an oversized record out of a page", () => {
  it("lists it with its identity and body metadata, and rewrites nothing", () => {
    const big = { id: "e3", parentId: "e2", type: "message", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "y".repeat(50_000) }] } };
    const page = elideOversizedEntries([prompt, assistant, big], 1024, digest);
    expect(page.entries).toEqual([prompt, assistant]);
    expect(page.elided).toEqual([{
      id: "e3", parentId: "e2", type: "message", role: "toolResult", toolCallId: "c1",
      bodies: [{ component: { kind: "tool_result" }, totalBytes: 50_000, contentDigest: "d50000" }],
    }]);
  });

  it("keeps a record with no identity rather than pointing at something unreadable", () => {
    const anonymous = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "z".repeat(50_000) }] } };
    const page = elideOversizedEntries([anonymous], 1024, digest);
    expect(page.entries).toEqual([anonymous]);
    expect(page.elided).toEqual([]);
  });
});

describe("an excerpt is a prefix of the canonical body, byte for byte", () => {
  /** Every bound this surface actually uses, and every width of character. */
  const caps = [16 * 1024, 32 * 1024, 64 * 1024];
  const bodies: Array<[string, unknown]> = [
    ["two-byte", { kkk: "ü".repeat(60_000) }],
    ["three-byte", { kkk: "€".repeat(40_000) }],
    ["four-byte", { kkk: "😀".repeat(30_000) }],
    ["escapes", { kkk: `quote " backslash \\ tab \t newline \n ${"€".repeat(30_000)}` }],
    ["control characters", { kkk: `\u0001\u001f${"ü".repeat(40_000)}` }],
    ["unpaired surrogates", { kkk: `\ud800lone \udc00also ${"答".repeat(30_000)}` }],
    ["mixed widths", { a: "x".repeat(9_000), b: "ü".repeat(9_000), c: "€".repeat(9_000), d: "😀".repeat(9_000) }],
  ];

  for (const [name, value] of bodies) {
    it(`cuts ${name} where the canonical text is, and can be continued from there`, () => {
      const whole = JSON.stringify(value, null, 2)!;
      const wholeBytes = Buffer.from(whole, "utf8");
      for (const cap of caps) {
        const bounded = boundedBodyText(value, cap);
        const emitted = utf8ByteLength(bounded.text);
        expect(emitted, `${name} @${cap}`).toBeLessThanOrEqual(cap);
        expect(bounded.totalBytes, `${name} @${cap}`).toBe(wholeBytes.length);
        // Byte for byte, the start of the authoritative body.
        expect(Buffer.from(bounded.text, "utf8").equals(wholeBytes.subarray(0, emitted)), `${name} @${cap}`).toBe(true);
        // A string that was cut never closes itself.
        expect(bounded.truncated && bounded.text.endsWith('"') && !whole.startsWith(`${bounded.text}`), `${name} @${cap}`).toBe(false);
        // And the byte after it is a character boundary, so the authority can
        // serve the continuation this excerpt asks for.
        const next = wholeBytes[emitted];
        if (next !== undefined) expect((next & 0xc0) !== 0x80, `${name} @${cap} continuation`).toBe(true);

        // The authority really does continue from exactly there.
        // The same value as a tool call's request: its canonical body is
        // exactly the text this excerpt is a prefix of.
        const entry = { id: "e1", parentId: null, type: "message", message: { role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "write", arguments: value }] } };
        const answer = bodyRangeSlice(entry, { component: { kind: "tool_args", index: 0 }, offset: emitted, limit: 4096 }, "r1", "durable", digestOfText);
        expect(answer.ok, `${name} @${cap} continuation read`).toBe(true);
        if (answer.ok) {
          expect(answer.result.offset).toBe(emitted);
          expect(whole.startsWith(bounded.text + answer.result.text)).toBe(true);
        }
      }
    });
  }
});

describe("the bounded canonical projection", () => {
  const exact = (value: unknown) => {
    const whole = JSON.stringify(value, null, 2)!;
    const bounded = boundedBodyText(value, 1 << 22);
    expect(bounded.text).toBe(whole);
    expect(bounded.totalBytes).toBe(utf8ByteLength(whole));
    for (const cap of [1, 4, 9, 23, 64, 200]) {
      const short = boundedBodyText(value, cap);
      expect(whole.startsWith(short.text)).toBe(true);
      expect(short.totalBytes).toBe(utf8ByteLength(whole));
    }
  };

  it("matches JSON.stringify exactly for quotes, controls, astral pairs and lone surrogates", () => {
    exact({ q: 'he said "hi"', b: "back\\slash", c: "tab\tnew\nline\r\bform\f", ctl: "\u0001\u001f" });
    exact({ astral: "😀🎉", high: "\ud800alone", low: "\udc00alone", mixed: "a\ud800\udc00b\ud800c\udc00d" });
    exact(["\u007f", "\u0080", "\u07ff", "\u0800", "\uffff", 1, 2.5, true, false, null]);
    exact({ nested: { list: ["ünïcødé", { deep: [] }, {}] } });
  });

  it("writes only the excerpt, however large the body is", () => {
    const body = { lines: Array.from({ length: 500 }, (_, index) => ({ n: index, text: "s".repeat(4000) })) };
    resetBodyProjectionWork();
    const bounded = boundedBodyText(body, 4096);
    const work = bodyProjectionWork();
    expect(bounded.text.length).toBeLessThanOrEqual(4096);
    expect(bounded.totalBytes).toBe(utf8ByteLength(JSON.stringify(body, null, 2)!));
    expect(work.emittedChars).toBeLessThanOrEqual(8192);
    expect(work.emittedChars * 100).toBeLessThan(bounded.totalBytes!);
  });

  it("declares a body it cannot predict unknown, never zero", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [{ at: new Date("2026-01-01T00:00:00Z") }, cyclic, { big: 10n }]) {
      const bounded = boundedBodyText(value, 1024);
      expect(bounded.unknown).toBe(true);
      expect(bounded.totalBytes).toBeUndefined();
      expect(bounded.text).toBe("");
    }
  });

  it("sizes an entry's bodies without building them, and marks unpredictable ones", () => {
    const entry = { id: "e1", parentId: null, type: "message", message: { role: "toolResult", toolCallId: "c1",
      content: [{ type: "text", text: "z".repeat(200_000) }] } };
    resetBodyProjectionWork();
    const rows = entryBodyMetadata(entry);
    expect(rows).toEqual([{ component: { kind: "tool_result" }, totalBytes: 200_000 }]);
    expect(bodyProjectionWork().emittedChars).toBeLessThan(1024);

    const unpredictable = { id: "e2", parentId: null, type: "message", message: { role: "assistant",
      content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { when: new Date("2026-01-01T00:00:00Z") } }] } };
    const args = entryBodyMetadata(unpredictable).find(row => row.component.kind === "tool_args");
    expect(args?.unknown).toBe(true);
    expect(args?.totalBytes).toBe(Number.MAX_SAFE_INTEGER);
  });
});

const digestOfText = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const sha256Of = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

describe("the identity an authority publishes when a message settles", () => {
  const hasher = () => {
    const chunks: string[] = [];
    return { update: (chunk: string) => { chunks.push(chunk); }, digest: () => sha256Of(chunks.join("")) };
  };

  it("names every body exactly as a reader of the same record would", () => {
    const entry = { id: "e1", parentId: "e0", type: "message", message: { role: "assistant", content: [
      { type: "text", text: "答".repeat(50_000) },
      { type: "thinking", thinking: "because" },
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls", deep: { list: [1, "two", null, true] } } },
    ] } };
    const identity = entryBodyIdentities(entry, hasher);
    const expected = entryBodies(entry).map(body => ({
      component: body.component, totalBytes: utf8ByteLength(body.text), contentDigest: sha256Of(body.text),
    }));
    expect(identity.bodies).toEqual(expected);
    expect(identity.omitted).toBe(0);
    expect(identity.truncated).toBeUndefined();
  });

  it("never builds the body it is naming", () => {
    const entry = { id: "e1", parentId: null, type: "message", message: { role: "toolResult", toolCallId: "c1",
      content: [], details: { rows: Array.from({ length: 4000 }, (_, index) => ({ index, text: "s".repeat(2000) })) } } };
    let peak = 0;
    const streaming = () => {
      let bytes = 0;
      return { update: (chunk: string) => { bytes += chunk.length; peak = Math.max(peak, chunk.length); }, digest: () => String(bytes) };
    };
    const identity = entryBodyIdentities(entry, streaming);
    expect(Number(identity.bodies[0]!.contentDigest)).toBeGreaterThan(8_000_000);
    // Nothing ever held more than a fragment of it at once.
    expect(peak).toBeLessThan(4096);
  });

  it("is bounded in items and in bytes, and says what it left out", () => {
    const entry = { id: "e1", parentId: null, type: "message", message: { role: "assistant", content: [
      { type: "text", text: "a" },
      ...Array.from({ length: 40 }, (_, index) => ({ type: "toolCall", id: `c${index}`, name: "t", arguments: { index } })),
    ] } };
    const identity = entryBodyIdentities(entry, hasher);
    expect(identity.bodies.length).toBe(PERSISTED_IDENTITY_MAX_ITEMS);
    expect(identity.omitted).toBe(41 - PERSISTED_IDENTITY_MAX_ITEMS);
    expect(utf8ByteLength(JSON.stringify(identity.bodies))).toBeLessThanOrEqual(PERSISTED_IDENTITY_MAX_BYTES);
    // A tiny byte budget stops earlier still, and says so rather than lying.
    const tight = entryBodyIdentities(entry, hasher, { bytes: 400 });
    expect(tight.truncated).toBe(true);
    expect(tight.bodies.length + tight.omitted).toBe(41);
  });

  it("names nothing it cannot predict, and never zero", () => {
    const entry = { id: "e1", parentId: null, type: "message", message: { role: "toolResult", toolCallId: "c1",
      content: [], details: { at: new Date("2026-01-01T00:00:00Z") } } };
    const identity = entryBodyIdentities(entry, hasher);
    expect(identity.bodies).toEqual([]);
    expect(identity.omitted).toBe(1);
  });

  it("round-trips through JSON on a message_end", () => {
    const entry = { id: "e1", parentId: "e0", type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } };
    const identity = entryBodyIdentities(entry, hasher);
    const update = { kind: "message_end", message: entry.message, role: "assistant",
      entry: { id: "e1", parentId: "e0", revision: "r1.env.2", bodies: identity.bodies } } as const;
    expect(JSON.parse(JSON.stringify(update))).toEqual(update);
  });
});

describe("the attachments an authority finds inside a prompt", () => {
  const hasher = () => {
    const chunks: string[] = [];
    return { update: (chunk: string) => { chunks.push(chunk); }, digest: () => sha256Of(chunks.join("")) };
  };
  const wrap = (name: string, type: string, content: string) =>
    `<attached-file name="${name}" type="${type}" size="${utf8ByteLength(content)}">\n${content}\n</attached-file>`;

  it("finds wrappers anywhere in the component, not only inside an excerpt", () => {
    const first = "ü".repeat(40_000);
    const last = "answer";
    const text = `prose\n\n${wrap("notes.md", "text/markdown", first)}\n\n${"filler ".repeat(20_000)}\n\n${wrap("tail.txt", "text/plain", last)}`;
    const found = attachmentRegions(text, hasher);
    expect(found.items.map(item => item.name)).toEqual(["notes.md", "tail.txt"]);
    expect(found.truncated).toBeUndefined();
    // Offsets are absolute in the component's own byte space, and the bytes at
    // them are exactly the attachment's.
    for (const [index, content] of [first, last].entries()) {
      const item = found.items[index]!;
      expect(item.bytes).toBe(utf8ByteLength(content));
      expect(sliceUtf8RangeFrom(text, item.offset, item.bytes)?.text).toBe(content);
      // The digest is the region's own, not the component's.
      expect(item.contentDigest).toBe(sha256Of(content));
      expect(item.contentDigest).not.toBe(sha256Of(text));
    }
  });

  it("is bounded in items and bytes, counts what it left out exactly, and pages", () => {
    const many = Array.from({ length: 80 }, (_, index) => wrap(`f${index}.txt`, "text/plain", `body ${index}`)).join("\n\n");
    const page = attachmentRegions(many, hasher, { maxItems: 8 });
    expect(page.items).toHaveLength(8);
    expect(page.omitted).toBe(72);
    expect(page.truncated).toBeUndefined();
    expect(page.next).toBeGreaterThan(page.items.at(-1)!.offset);
    // The next page starts where the last one stopped and does not repeat it.
    const second = attachmentRegions(many, hasher, { maxItems: 8, from: page.next });
    expect(second.items[0]!.offset).toBe(page.next);
    expect(second.items.map(item => item.name)).not.toContain(page.items[0]!.name);
    // The byte budget stops earlier still and says so through `omitted`.
    const tight = attachmentRegions(many, hasher, { maxBytes: 600 });
    expect(tight.items.length).toBeLessThan(8);
    expect(tight.items.length + (tight.omitted ?? 0)).toBe(80);
  });

  it("claims no count when it could not see the whole component", () => {
    const text = `${wrap("small.txt", "text/plain", "hello")}\n\n${"x".repeat(5000)}`;
    const partial = attachmentRegions(text, hasher, { scanBytes: 256 });
    expect(partial.truncated).toBe(true);
    expect(partial.omitted).toBeUndefined();
    expect(partial.scannedBytes).toBeLessThanOrEqual(256);
  });

  it("cuts a name and a media type rather than carrying them whole, and says it cut them", () => {
    const text = wrap(`${"n".repeat(1000)}.txt`, `text/${"x".repeat(500)}`, "body");
    const found = attachmentRegions(text, hasher);
    const item = found.items[0]!;
    expect(utf8ByteLength(item.name)).toBeLessThanOrEqual(256);
    expect(utf8ByteLength(item.mediaType)).toBeLessThanOrEqual(128);
    expect(item.nameTruncated).toBe(true);
    expect(item.mediaTypeTruncated).toBe(true);
  });

  it("refuses a wrapper whose declared size is not the size it has", () => {
    const honest = wrap("ok.txt", "text/plain", "real");
    const lying = '<attached-file name="bad.txt" type="text/plain" size="9007199254740993">\nshort\n</attached-file>';
    const found = attachmentRegions(`${honest}\n\n${lying}`, hasher);
    expect(found.items.map(item => item.name)).toEqual(["ok.txt"]);
  });

  it("declares a complete-scan ceiling the stored authority can honour", () => {
    expect(BODY_REGION_SCAN_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(BODY_REGION_MAX_ITEMS).toBe(64);
    expect(BODY_REGION_METADATA_MAX_BYTES).toBe(16 * 1024);
  });
});

describe("what counts as an attachment at all", () => {
  const hasher = () => {
    const chunks: string[] = [];
    return { update: (chunk: string) => { chunks.push(chunk); }, digest: () => sha256Of(chunks.join("")) };
  };
  // The canonical writer, spelled out here so the authority's recogniser is
  // pinned to the same format the composer produces (it cannot import it).
  const escapeText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const escapeAttribute = (text: string) => escapeText(text).replaceAll("\n", "&#10;").replaceAll("\r", "&#13;").replaceAll("\t", "&#9;");
  const wrap = (name: string, type: string, content: string) =>
    `<attached-file name="${escapeAttribute(name)}" type="${escapeAttribute(type)}" size="${utf8ByteLength(content)}">\n${escapeText(content)}\n</attached-file>`;
  const found = (text: string) => attachmentRegions(text, hasher).items;

  it("names a wrapper whose content and attributes need escaping, and addresses the stored bytes", () => {
    const content = '<script>alert("1 & 2")</script>\n\tdone';
    const text = `prose here\n\n${wrap('a & b"c.txt', "text/plain", content)}`;
    const items = found(text);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.name).toBe('a & b"c.txt');
    // The region is the stored, escaped payload — not the decoded file.
    const stored = sliceUtf8RangeFrom(text, item.offset, item.bytes)!.text;
    expect(stored).toBe(escapeText(content));
    expect(stored).not.toBe(content);
    expect(item.bytes).toBe(utf8ByteLength(escapeText(content)));
    expect(item.contentDigest).toBe(sha256Of(escapeText(content)));
    // Decoding happens after reconstruction, and gives the file back exactly.
    expect(stored.replace(/&(amp|lt|gt|quot|#10|#13|#9);/g, (_, entity: string) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', "#10": "\n", "#13": "\r", "#9": "\t" })[entity]!)).toBe(content);
  });

  it("names nothing that is not a complete canonical wrapper", () => {
    const content = "real content";
    const stored = escapeText(content);
    const size = utf8ByteLength(content);
    const cases: Array<[string, string]> = [
      ["an opener with no closer", `<attached-file name="a.txt" type="text/plain" size="${size}">\n${stored}`],
      ["a closer with no opener", `prose\n\n${stored}\n</attached-file>`],
      ["a declared size that is not the decoded size", `<attached-file name="a.txt" type="text/plain" size="${size + 5}">\n${stored}\n</attached-file>`],
      ["a declared size measured on the stored bytes", `<attached-file name="a.txt" type="text/plain" size="${utf8ByteLength(escapeText('a & b'))}">\n${escapeText("a & b")}x\n</attached-file>`],
      ["a payload that is not canonically escaped", `<attached-file name="a.txt" type="text/plain" size="5">\na & b\n</attached-file>`],
      ["an unknown entity", `<attached-file name="a.txt" type="text/plain" size="7">\na&nbsp;b\n</attached-file>`],
      ["a NUL in the payload", `<attached-file name="a.txt" type="text/plain" size="3">\na\0b\n</attached-file>`],
      ["no blank line before it", `prose <attached-file name="a.txt" type="text/plain" size="${size}">\n${stored}\n</attached-file>`],
      ["no blank line after it", `<attached-file name="a.txt" type="text/plain" size="${size}">\n${stored}\n</attached-file>trailing`],
      ["an empty name", `<attached-file name="" type="text/plain" size="${size}">\n${stored}\n</attached-file>`],
      ["a newline inside an attribute", `<attached-file name="a\n.txt" type="text/plain" size="${size}">\n${stored}\n</attached-file>`],
      ["a quote inside an attribute", `<attached-file name="a".txt" type="text/plain" size="${size}">\n${stored}\n</attached-file>`],
      ["attributes out of order", `<attached-file name="a.txt" size="${size}" type="text/plain">\n${stored}\n</attached-file>`],
      ["a size that is not a number", `<attached-file name="a.txt" type="text/plain" size="12x">\n${stored}\n</attached-file>`],
      ["a size past what may be attached", `<attached-file name="a.txt" type="text/plain" size="999999999">\n${stored}\n</attached-file>`],
      ["a lookalike tag", `<attached-files name="a.txt" type="text/plain" size="${size}">\n${stored}\n</attached-files>`],
      ["a wrapper written about, not written", `here is what one looks like: &lt;attached-file name="a.txt"&gt;`],
    ];
    for (const [why, text] of cases) expect(found(text), why).toEqual([]);
  });

  it("names a real wrapper that follows prose and one that follows a rejected lookalike", () => {
    const content = "real";
    const good = wrap("ok.txt", "text/plain", content);
    const broken = `<attached-file name="bad.txt" type="text/plain" size="99">\n${escapeText(content)}\n</attached-file>`;
    expect(found(`some prose\n\n${good}`).map(item => item.name)).toEqual(["ok.txt"]);
    expect(found(`${broken}\n\n${good}`).map(item => item.name)).toEqual(["ok.txt"]);
    // Nested markup inside a valid payload is content, not a second wrapper.
    const nested = wrap("outer.txt", "text/plain", `<attached-file name="inner.txt" type="text/plain" size="4">\ntext\n</attached-file>`);
    expect(found(nested).map(item => item.name)).toEqual(["outer.txt"]);
  });

  it("reassembles a stored region through the range contract and matches its digest", () => {
    const content = "答 & <tag>\n".repeat(3_000);
    const text = `prose\n\n${wrap("big.md", "text/markdown", content)}`;
    const entry = { id: "u3", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text }] } };
    const item = attachmentRegions(text, hasher).items[0]!;
    let offset = item.offset;
    let assembled = "";
    for (let step = 0; step < 200; step++) {
      const answer = bodyRangeSlice(entry, { component: { kind: "user_text" }, offset, limit: 4096, region: { offset: item.offset, bytes: item.bytes } }, "r1", "durable", digestOfText);
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      assembled += answer.result.text;
      expect(answer.result.regionDigest).toBe(item.contentDigest);
      if (answer.result.next === undefined) break;
      offset = answer.result.next;
    }
    expect(utf8ByteLength(assembled)).toBe(item.bytes);
    expect(digestOfText(assembled)).toBe(item.contentDigest);
    expect(assembled).toBe(escapeText(content));
  });
});

describe("finding the same attachments while streaming the parent", () => {
  const hasher = () => {
    const chunks: string[] = [];
    return { update: (chunk: string) => { chunks.push(chunk); }, digest: () => sha256Of(chunks.join("")) };
  };
  const escapeText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const wrap = (name: string, content: string) =>
    `<attached-file name="${name}" type="text/plain" size="${utf8ByteLength(content)}">\n${escapeText(content)}\n</attached-file>`;

  it("agrees with the authority's own scan, whatever the chunks are", () => {
    const text = `prose & more\n\n${wrap("a.txt", "x & y\n".repeat(400))}\n\nbetween\n\n${wrap("b.md", "<tag>\n".repeat(900))}\n\ntail`;
    const expected = attachmentRegions(text, hasher);
    for (const size of [1, 7, 64, 997, 4096, 65_536, text.length]) {
      const scanner = createAttachmentScanner(hasher);
      for (let index = 0; index < text.length; index += size) scanner.push(text.slice(index, index + size));
      const streamed = scanner.end();
      expect(streamed.items, `chunks of ${size}`).toEqual(expected.items);
      expect(streamed.scannedBytes).toBe(utf8ByteLength(text));
    }
  });

  it("rejects what the authority rejects, across a chunk boundary", () => {
    const content = "real";
    const cases = [
      `<attached-file name="a.txt" type="text/plain" size="99">\n${content}\n</attached-file>`,
      `prose <attached-file name="a.txt" type="text/plain" size="4">\n${content}\n</attached-file>`,
      `<attached-file name="a.txt" type="text/plain" size="4">\n${content}`,
    ];
    for (const text of cases) {
      for (const size of [3, 17, 200]) {
        const scanner = createAttachmentScanner(hasher);
        for (let index = 0; index < text.length; index += size) scanner.push(text.slice(index, index + size));
        expect(scanner.end().items, `${text.slice(0, 30)} @${size}`).toEqual([]);
      }
    }
  });

  it("holds only a bounded carry, never the parent", () => {
    const scanner = createAttachmentScanner(hasher);
    const chunk = "plain prose with no markup at all. ".repeat(1_000); // ~34 KB
    for (let index = 0; index < 300; index++) scanner.push(chunk);
    const done = scanner.end();
    expect(done.items).toEqual([]);
    // Ten megabytes went through it.
    expect(done.scannedBytes).toBeGreaterThan(10 * 1024 * 1024);
  });
});

describe("reading one attachment inside a prompt", () => {
  const hasher = () => {
    const chunks: string[] = [];
    return { update: (chunk: string) => { chunks.push(chunk); }, digest: () => sha256Of(chunks.join("")) };
  };
  const content = "答".repeat(30_000); // multi-byte throughout
  const prompt = `have a look\n\n<attached-file name="notes.md" type="text/markdown" size="${utf8ByteLength(content)}">\n${content}\n</attached-file>\n\ntail`;
  const entry = { id: "u1", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: prompt }] } };
  const region = () => entryRegionsPage(entry, { component: { kind: "user_text" } }, "r1", "durable", hasher).ok
    ? (entryRegionsPage(entry, { component: { kind: "user_text" } }, "r1", "durable", hasher) as { result: { items: Array<{ offset: number; bytes: number; contentDigest: string }> } }).result.items[0]!
    : undefined as never;

  it("names the attachment and reads exactly it, in the component's own offsets", () => {
    const item = region();
    expect(item.bytes).toBe(utf8ByteLength(content));
    expect(item.contentDigest).toBe(sha256Of(content));

    let offset = item.offset;
    let assembled = "";
    for (let step = 0; step < 100; step++) {
      const answer = bodyRangeSlice(entry, { component: { kind: "user_text" }, offset, limit: 8192, region: { offset: item.offset, bytes: item.bytes } }, "r1", "durable", digestOfText);
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      // The parent's size, never the region's; and the region echoed exactly.
      expect(answer.result.totalBytes).toBe(utf8ByteLength(prompt));
      expect(answer.result.region).toEqual({ offset: item.offset, bytes: item.bytes });
      expect(answer.result.regionDigest).toBe(digestOfText(content));
      assembled += answer.result.text;
      // Never a partial character.
      expect(answer.result.text.includes("\uFFFD")).toBe(false);
      if (answer.result.next === undefined) {
        // The region's end, even though the component continues past it.
        expect(answer.result.truncated).toBe(false);
        expect(item.offset + item.bytes).toBeLessThan(utf8ByteLength(prompt));
        break;
      }
      expect(answer.result.next).toBeLessThanOrEqual(item.offset + item.bytes);
      offset = answer.result.next;
    }
    expect(assembled).toBe(content);
  });

  it("refuses a region that is not part of this component, and one that is not a safe integer", () => {
    const item = region();
    const cases: BodyRegion[] = [
      { offset: -1, bytes: 10 },
      { offset: 0, bytes: -1 },
      { offset: 0.5, bytes: 10 },
      { offset: 0, bytes: Number.MAX_SAFE_INTEGER },
      { offset: utf8ByteLength(prompt), bytes: 1 },
      { offset: Number.NaN, bytes: 1 },
    ];
    for (const bad of cases) {
      const answer = bodyRangeSlice(entry, { component: { kind: "user_text" }, offset: 0, region: bad }, "r1", "durable", digestOfText);
      expect(answer.ok, JSON.stringify(bad)).toBe(false);
      if (!answer.ok) expect(answer.refusal.reason).toBe("bad-region");
    }
    // An offset outside the region is refused rather than quietly moved in.
    const outside = bodyRangeSlice(entry, { component: { kind: "user_text" }, offset: 0, region: { offset: item.offset, bytes: item.bytes } }, "r1", "durable", digestOfText);
    expect(outside.ok).toBe(false);
  });

  it("pages the attachments of one component and says what it left out", () => {
    const many = Array.from({ length: 20 }, (_, index) => {
      const body = `file ${index}`;
      return `<attached-file name="f${index}.txt" type="text/plain" size="${utf8ByteLength(body)}">\n${body}\n</attached-file>`;
    }).join("\n\n");
    const record = { id: "u2", parentId: null, type: "message", message: { role: "user", content: [{ type: "text", text: many }] } };
    const first = entryRegionsPage(record, { component: { kind: "user_text" }, limit: 5 }, "r1", "live", hasher);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.result.authority).toBe("live");
    expect(first.result.items).toHaveLength(5);
    expect(first.result.omitted).toBe(15);
    expect(first.result.truncated).toBeUndefined();
    expect(first.result.totalBytes).toBe(utf8ByteLength(many));
    // A reply is far inside the transport's own ceiling.
    expect(utf8ByteLength(JSON.stringify(first.result))).toBeLessThanOrEqual(64 * 1024);

    const second = entryRegionsPage(record, { component: { kind: "user_text" }, from: first.result.next, limit: 5 }, "r1", "live", hasher);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result.items[0]!.offset).toBe(first.result.next);
    expect(second.result.items.map(item => item.name)).not.toContain(first.result.items[0]!.name);
  });

  it("refuses a component the entry does not have, and a malformed page cursor", () => {
    const missing = entryRegionsPage(entry, { component: { kind: "tool_result" } }, "r1", "durable", hasher);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.refusal.reason).toBe("unknown-component");
    const bad = entryRegionsPage(entry, { component: { kind: "user_text" }, from: -5 }, "r1", "durable", hasher);
    expect(bad.ok).toBe(false);
  });

  it("publishes the same names on an elided page, bounded", () => {
    const { elided } = elideOversizedEntries([entry], 1024, digestOfText);
    const body = elided[0]!.bodies.find(row => row.component.kind === "user_text")!;
    expect(body.regions?.items).toHaveLength(1);
    expect(body.regions!.items[0]!.name).toBe("notes.md");
    expect(body.regions!.items[0]!.contentDigest).toBe(digestOfText(content));
    expect(utf8ByteLength(JSON.stringify(body.regions))).toBeLessThanOrEqual(16 * 1024);
  });
});

describe("the method itself", () => {
  it("is in the inventory, has a schema and a read-only policy", () => {
    expect(clientMethods).toContain("session/entry_range");
    expect(METHOD_POLICY["session/entry_range"]).toEqual({ scope: "read", reach: "any" });
    const schema = clientParamsSchemas["session/entry_range"];
    expect(schema.safeParse({ path: "/s.jsonl", environmentKey: "k", revision: "r", entryId: "e1", component: { kind: "assistant_text" }, offset: 0 }).success).toBe(true);
    // Hostile shapes are refused by the schema, before anything reads.
    expect(schema.safeParse({ path: "/s.jsonl", environmentKey: "k", revision: "r", entryId: "e1", component: { kind: "nope" }, offset: 0 }).success).toBe(false);
    expect(schema.safeParse({ path: "/s.jsonl", environmentKey: "k", revision: "r", entryId: "e1", component: { kind: "assistant_text" }, offset: -1 }).success).toBe(false);
    expect(schema.safeParse({ path: "/s.jsonl", environmentKey: "k", revision: "r", entryId: "e1", component: { kind: "assistant_text" }, offset: 0, limit: ENTRY_RANGE_MAX_BYTES + 1 }).success).toBe(false);
    expect(schema.safeParse({ path: "/s.jsonl", environmentKey: "k", revision: "r", entryId: "e1", component: { kind: "assistant_text" }, offset: 0, extra: 1 }).success).toBe(false);
  });
});
