// @vitest-environment happy-dom
/**
 * RP-5b §2 in the view: a prompt this window does not hold still shows what it
 * carries, and opening one of those files reads exactly its stored bytes,
 * proves they are that file's, and only then turns them back into text.
 */
import { describe, expect, it, vi } from "vitest";
import { attachmentRegions, utf8ByteLength } from "@lasercode/protocol";
import { createHash } from "node:crypto";
import { checkRegionsPage, readAttachment, readAttachmentRegions, BodyReplyRefused } from "../../src/runtime/body-reader.js";
import { stubOfElided } from "../../src/runtime/retained-entries.js";
import { blocksFromEntries } from "../../src/store.js";
import type { Block } from "../../src/store.js";

const SESSION = "/project/session.jsonl";
const hasher = () => { const hash = createHash("sha256"); return { update: (chunk: string) => { hash.update(chunk, "utf8"); }, digest: () => hash.digest("hex") }; };
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const escapeText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const wrap = (name: string, type: string, content: string) =>
  `<attached-file name="${name}" type="${type}" size="${utf8ByteLength(content)}">\n${escapeText(content)}\n</attached-file>`;

const fileText = `const x = "1 & 2";\n<div>\n`.repeat(4000);
const prompt = `have a look\n\n${wrap("app.ts", "text/plain", fileText)}`;
const regions = attachmentRegions(prompt, hasher);

/** The elided record an authority publishes for that prompt. */
const elided = {
  id: "u1", parentId: null, type: "message", role: "user",
  bodies: [{ component: { kind: "user_text" as const }, totalBytes: utf8ByteLength(prompt), contentDigest: sha(prompt), regions }],
};

/** An authority that answers region reads honestly. */
function authority(over: Partial<Record<string, unknown>> = {}) {
  return vi.fn(async (params: Record<string, unknown>) => {
    const region = params.region as { offset: number; bytes: number } | undefined;
    const offset = params.offset as number;
    const limit = (params.limit as number | undefined) ?? 65536;
    const end = region ? region.offset + region.bytes : utf8ByteLength(prompt);
    const take = Math.min(limit, end - offset);
    const text = Buffer.from(prompt, "utf8").subarray(offset, offset + take).toString("utf8");
    const bytes = utf8ByteLength(text);
    const next = offset + bytes < end ? offset + bytes : undefined;
    return {
      authority: "durable", revision: "r1.env.2", component: params.component, totalBytes: utf8ByteLength(prompt),
      offset, bytes, ...(next !== undefined ? { next } : {}), truncated: next !== undefined,
      sliceDigest: sha(text), contentDigest: sha(prompt), text,
      ...(region ? { region, regionDigest: sha(Buffer.from(prompt, "utf8").subarray(region.offset, region.offset + region.bytes).toString("utf8")) } : {}),
      ...over,
    };
  });
}

describe("one page of attachments at a time", () => {
  const ref = {
    entryId: "u1", component: { kind: "user_text" as const }, totalBytes: utf8ByteLength(prompt),
    revision: "r1.env.2", contentDigest: sha(prompt), excerpt: { offset: 0, bytes: 0 },
  };
  const item = (offset: number, name: string) => ({ offset, bytes: 10, name, mediaType: "text/plain", contentDigest: sha(name) });
  const pageOf = (over: Record<string, unknown> = {}) => ({
    authority: "durable" as const, revision: "r1.env.2", component: { kind: "user_text" as const },
    totalBytes: utf8ByteLength(prompt), items: [item(10, "a.txt"), item(30, "b.txt")], scannedBytes: 100, ...over,
  });

  it("checks a page before anything is shown", () => {
    const good = checkRegionsPage(pageOf({ next: 60 }) as never, { revision: "r1.env.2", component: { kind: "user_text" }, totalBytes: utf8ByteLength(prompt), from: 0 });
    expect(good.items).toHaveLength(2);
    expect(good.next).toBe(60);

    const bad: Array<[string, Record<string, unknown>]> = [
      ["another revision", { revision: "r2.env.2" }],
      ["another component", { component: { kind: "assistant_text" } }],
      ["no authority", { authority: "guess" }],
      ["another body size", { totalBytes: 12 }],
      ["a region past the end", { items: [item(utf8ByteLength(prompt), "x")] }],
      ["an unsafe offset", { items: [{ ...item(10, "x"), offset: Number.MAX_SAFE_INTEGER }] }],
      ["a fractional size", { items: [{ ...item(10, "x"), bytes: 1.5 }] }],
      ["a digest that is not one", { items: [{ ...item(10, "x"), contentDigest: "nope" }] }],
      ["regions out of order", { items: [item(60, "b"), item(10, "a")] }],
      ["a cursor that does not move", { next: 0 }],
      ["a count claimed for a partial scan", { truncated: true, omitted: 3 }],
      ["more items than a page may carry", { items: Array.from({ length: 200 }, (_, index) => item(index * 20, `f${index}.txt`)) }],
    ];
    for (const [why, over] of bad) {
      expect(() => checkRegionsPage(pageOf(over) as never, { revision: "r1.env.2", component: { kind: "user_text" }, totalBytes: utf8ByteLength(prompt), from: 0, limit: 64 }), why)
        .toThrow(BodyReplyRefused);
    }
  });

  it("asks for the page it was told to, and keeps only that page", async () => {
    const pages = vi.fn(async (params: Record<string, unknown>) => {
      const from = (params.from as number | undefined) ?? 0;
      return from === 0
        ? pageOf({ next: 60, omitted: 5 })
        : pageOf({ items: [item(60, "c.txt")], omitted: 4 });
    });
    const first = await readAttachmentRegions(pages as never, authority() as never, SESSION, ref as never, { limit: 2 });
    expect(first.items.map(row => row.name)).toEqual(["a.txt", "b.txt"]);
    expect(first.omitted).toBe(5);
    const second = await readAttachmentRegions(pages as never, authority() as never, SESSION, ref as never, { from: first.next, limit: 2 });
    // The next page does not repeat the one before it and does not add to it.
    expect(second.items.map(row => row.name)).toEqual(["c.txt"]);
    expect(pages.mock.calls.map(call => (call[0] as { from?: number }).from)).toEqual([undefined, 60]);
  });

  it("pages an old authority the same way, without ever returning everything it found", async () => {
    const many = Array.from({ length: 8 }, (_, index) => {
      const content = `file ${index}\n`.repeat(50);
      return `<attached-file name="f${index}.txt" type="text/plain" size="${utf8ByteLength(content)}">\n${content}\n</attached-file>`;
    }).join("\n\n");
    const body = `prose\n\n${many}`;
    const bodyRef = { entryId: "u2", component: { kind: "user_text" as const }, totalBytes: utf8ByteLength(body), revision: "r1.env.2", contentDigest: sha(body), excerpt: { offset: 0, bytes: 0 } };
    const stream = vi.fn(async (params: Record<string, unknown>) => {
      const offset = params.offset as number;
      const buffer = Buffer.from(body, "utf8");
      const take = Math.min((params.limit as number) ?? 65536, buffer.length - offset);
      const text = buffer.subarray(offset, offset + take).toString("utf8");
      const next = offset + take < buffer.length ? offset + take : undefined;
      return { authority: "durable", revision: "r1.env.2", component: params.component, totalBytes: buffer.length, offset,
        bytes: utf8ByteLength(text), ...(next !== undefined ? { next } : {}), truncated: next !== undefined,
        sliceDigest: sha(text), contentDigest: sha(body), text };
    });
    const refuse = vi.fn(async () => { throw Object.assign(new Error("unknown method"), { code: -32601 }); });
    const first = await readAttachmentRegions(refuse as never, stream as never, SESSION, bodyRef as never, { limit: 3 });
    expect(first.items.map(row => row.name)).toEqual(["f0.txt", "f1.txt", "f2.txt"]);
    expect(first.omitted).toBe(5);
    expect(first.next).toBeGreaterThan(first.items[2]!.offset);
    const second = await readAttachmentRegions(refuse as never, stream as never, SESSION, bodyRef as never, { from: first.next, limit: 3 });
    expect(second.items.map(row => row.name)).toEqual(["f3.txt", "f4.txt", "f5.txt"]);
    // A page, never everything it walked past.
    expect(second.items).toHaveLength(3);
  });
});

describe("an authority that has never heard of attachment regions", () => {
  const ref = {
    entryId: "u1", component: { kind: "user_text" as const }, totalBytes: utf8ByteLength(prompt),
    revision: "r1.env.2", contentDigest: sha(prompt), excerpt: { offset: 0, bytes: 0 },
  };
  const refuse = (code: number, message: string) => vi.fn(async () => { throw Object.assign(new Error(message), { code }); });

  it("finds the same files by reading the body, holding only a bounded carry", async () => {
    const request = authority();
    const found = await readAttachmentRegions(refuse(-32601, "unknown method session/entry_regions") as never, request as never, SESSION, ref as never, {});
    expect(found.items.map(item => ({ offset: item.offset, bytes: item.bytes, name: item.name })))
      .toEqual(regions.items.map(item => ({ offset: item.offset, bytes: item.bytes, name: item.name })));
    expect(found.items[0]!.contentDigest).toBe(regions.items[0]!.contentDigest);
    // It read the parent in ordinary slices, each inside the range bound.
    expect(request.mock.calls.length).toBeGreaterThan(1);
    for (const [params] of request.mock.calls) {
      expect((params as { limit: number }).limit).toBeLessThanOrEqual(64 * 1024);
      expect((params as { region?: unknown }).region).toBeUndefined();
    }
  });

  it("falls back for that refusal and for nothing else", async () => {
    const request = authority();
    for (const [code, message] of [[-32601, "unknown method"], [-32602, "unrecognized key: region"]] as const) {
      await expect(readAttachmentRegions(refuse(code, message) as never, request as never, SESSION, ref as never, {})).resolves.toBeDefined();
    }
    for (const [code, message] of [[-32007, "revision moved on"], [-32001, "not authorized"], [-32602, "offset is not a boundary"], [0, "network down"]] as const) {
      const failing = refuse(code, message);
      await expect(readAttachmentRegions(failing as never, request as never, SESSION, ref as never, {})).rejects.toThrow(message);
    }
  });

  it("refuses what it found when the body it read was not this body", async () => {
    const wrong = authority({ contentDigest: "e".repeat(64) });
    await expect(readAttachmentRegions(refuse(-32601, "unknown method") as never, wrong as never, SESSION, ref as never, {}))
      .rejects.toThrow(BodyReplyRefused);
  });
});

describe("a prompt the view only points at", () => {
  it("shows the files the authority named, with their stored-region identity", () => {
    const stub = stubOfElided(elided as never);
    const blocks = blocksFromEntries([], "u1", undefined, { stubs: [stub], revision: "r1.env.2" } as never);
    const user = blocks.find(block => block.kind === "user") as Extract<Block, { kind: "user" }>;
    expect(user.files.map(file => file.name)).toEqual(["app.ts"]);
    const ref = user.bodies?.files?.[0];
    expect(ref?.entryId).toBe("u1");
    expect(ref?.component.kind).toBe("user_text");
    expect(ref?.revision).toBe("r1.env.2");
    expect(ref?.region).toEqual({ offset: regions.items[0]!.offset, bytes: regions.items[0]!.bytes });
    expect(ref?.contentDigest).toBe(regions.items[0]!.contentDigest);
    // The chip's size is the stored payload; nothing of it is held.
    expect(user.files[0]!.content).toBe("");
  });

  it("reads one file back, verifies the whole stored region, and unescapes only then", async () => {
    const item = regions.items[0]!;
    const request = authority();
    const outcome = await readAttachment(request as never, SESSION,
      { entryId: "u1", component: { kind: "user_text" }, totalBytes: utf8ByteLength(prompt), revision: "r1.env.2",
        contentDigest: item.contentDigest, region: { offset: item.offset, bytes: item.bytes }, excerpt: { offset: 0, bytes: 0 } } as never, {});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The file's own text, not the stored escaping.
    expect(outcome.text).toBe(fileText);
    expect(outcome.text).not.toContain("&amp;");
    // Read in slices, each one inside the range bound, every one region-fenced.
    expect(request.mock.calls.length).toBeGreaterThan(1);
    for (const [params] of request.mock.calls) {
      expect((params as { limit: number }).limit).toBeLessThanOrEqual(64 * 1024);
      expect((params as { region: unknown }).region).toEqual({ offset: item.offset, bytes: item.bytes });
      expect((params as { revision: string }).revision).toBe("r1.env.2");
    }
  });

  it("refuses bytes that are not this file's, an echo that does not match, and a region it cannot address", async () => {
    const item = regions.items[0]!;
    const ref = { entryId: "u1", component: { kind: "user_text" as const }, totalBytes: utf8ByteLength(prompt), revision: "r1.env.2",
      contentDigest: item.contentDigest, region: { offset: item.offset, bytes: item.bytes }, excerpt: { offset: 0, bytes: 0 } };

    // A different region digest for the same bytes: not this file.
    const wrongDigest = await readAttachment(authority({ regionDigest: "f".repeat(64) }) as never, SESSION, ref as never, {}).catch(() => ({ ok: false as const, reason: "corrupt" as const }));
    expect(wrongDigest.ok).toBe(false);

    // An echo that is not what was asked for.
    await expect(readAttachment(authority({ region: { offset: 0, bytes: 4 } }) as never, SESSION, ref as never, {})).rejects.toThrow(BodyReplyRefused);

    // An unsafe region is refused before a request is made.
    const unsafe = vi.fn();
    const answer = await readAttachment(unsafe as never, SESSION, { ...ref, region: { offset: 0, bytes: Number.MAX_SAFE_INTEGER } } as never, {});
    expect(answer).toEqual({ ok: false, reason: "too-large" });
    expect(unsafe).not.toHaveBeenCalled();
  });
});
