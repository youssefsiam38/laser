/**
 * RP-5b acceptance A7, A8 and the durable half of A9: reading one body of one
 * stored entry, worker-free.
 *
 * Every refusal here is a refusal *before* anything is read: a foreign
 * environment, a revision this host is not serving, an entry that is not in
 * this conversation, a range that addresses nothing. What a caller does get is
 * exact: totals, digests, character-aligned slices, and no word about how the
 * conversation is stored.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BODY_REGION_SCAN_MAX_BYTES, ErrorCodes, PRODUCT_NAME, utf8ByteLength, type ClientRequests } from "@lasercode/protocol";
import { DEFAULT_SESSION_INDEX_LIMITS, SessionIndexCache } from "../src/session-index.js";
import { BODY_MEMO_IDLE_MS, SessionBodyRange, sha256Hex } from "../src/session-body-range.js";
import { SessionRevisions } from "../src/session-revision.js";

const ENVIRONMENT = "11111111-2222-4333-8444-555555555555";
const CWD = "/projects/a";
const HUGE = "µ".repeat(16 * 1024 * 1024); // multi-byte throughout: 32 MiB of UTF-8

const header = JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: CWD, timestamp: "2026-01-01T00:00:00.000Z" });
const prompt = { type: "message", id: "e0", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "start" }] } };
const reply = { type: "message", id: "e1", parentId: "e0", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: HUGE }, { type: "thinking", thinking: "short" }] } };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-range-`));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, [header, JSON.stringify(prompt), JSON.stringify(reply)].join("\n") + "\n");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function services() {
  const reads: string[] = [];
  // Shipped defaults, deliberately: the acceptance body is 32 MiB in one
  // record, and a conversation holding one must be readable without a worker.
  const index = new SessionIndexCache();
  const revisions = new SessionRevisions({ index, environmentId: ENVIRONMENT });
  const range = new SessionBodyRange({ index, revisions, onRead: (entry) => reads.push(entry.id ?? "") });
  return { index, revisions, range, reads };
}

const params = (over: Partial<ClientRequests["session/entry_range"]["params"]> = {}): ClientRequests["session/entry_range"]["params"] => ({
  path: "/unused", environmentKey: "", revision: "", entryId: "e1", component: { kind: "assistant_text" }, offset: 0, ...over,
});

describe("what the reader keeps between slices", () => {
  it("walks the record once for a sliced read, and lets it go on request", async () => {
    const file = fixture();
    try {
      const { range, revisions, index, reads } = services();
      const indexed = await index.read(file.path);
      const revision = revisions.revisionOf(indexed.ok ? indexed.index : (undefined as never));
      const read = (offset: number) => range.read(file.path, params({ path: file.path, environmentKey: revisions.environmentKey, revision, offset, limit: 4096 }));
      await read(0);
      const first = reads.length;
      await read(4096);
      // The second slice came from the body the first one walked.
      expect(reads.length).toBe(first);
      // Letting go is explicit, and the next read starts from the file again.
      range.forget();
      await read(8192);
      expect(reads.length).toBeGreaterThan(first);
    } finally {
      file.cleanup();
    }
  });

  it("lets go while nothing is reading, without a later read to trigger it", async () => {
    const file = fixture();
    vi.useFakeTimers();
    try {
      const { range, revisions, index, reads } = services();
      const indexed = await index.read(file.path);
      const revision = revisions.revisionOf(indexed.ok ? indexed.index : (undefined as never));
      const read = (offset: number) => range.read(file.path, params({ path: file.path, environmentKey: revisions.environmentKey, revision, offset, limit: 4096 }));
      await read(0);
      const first = reads.length;
      // Nothing reads for a minute: the body goes on its own, so an idle host
      // is not holding a conversation nobody is looking at (RP-5b, RP-8).
      await vi.advanceTimersByTimeAsync(BODY_MEMO_IDLE_MS + 1);
      await read(4096);
      expect(reads.length).toBeGreaterThan(first);
    } finally {
      vi.useRealTimers();
      file.cleanup();
    }
  });
});

describe("reading one body from the stored conversation", () => {
  it("can honour the protocol's complete-scan ceiling for attachments", () => {
    // The scan that makes an attachment count exact assumes the stored
    // authority cannot hold a record larger than this; the shipped line bound
    // is what makes that true (RP-5b §2).
    expect(DEFAULT_SESSION_INDEX_LIMITS.lineBytes).toBeGreaterThanOrEqual(BODY_REGION_SCAN_MAX_BYTES);
  });

  it("admits a thirty-two mebibyte body under shipped defaults", () => {
    // The ceiling is declared, finite and above the acceptance body plus its
    // JSON framing; nothing here relies on a test-only configuration.
    expect(DEFAULT_SESSION_INDEX_LIMITS.lineBytes).toBeGreaterThan(utf8ByteLength(HUGE) + 4096);
    expect(DEFAULT_SESSION_INDEX_LIMITS.lineBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it("answers exact totals, digests and character-aligned slices without a worker", async () => {
    const file = fixture();
    try {
      const { range, revisions, index, reads } = services();
      const indexed = await index.read(file.path);
      expect(indexed.ok).toBe(true);
      const revision = revisions.revisionOf(indexed.ok ? indexed.index : (undefined as never));
      const answer = await range.read(file.path, params({ path: file.path, environmentKey: revisions.environmentKey, revision, limit: 4096 }));
      expect(answer.kind).toBe("answer");
      if (answer.kind !== "answer") return;
      expect(answer.result.authority).toBe("durable");
      expect(answer.result.totalBytes).toBe(utf8ByteLength(HUGE));
      expect(answer.result.contentDigest).toBe(sha256Hex(HUGE));
      expect(answer.result.sliceDigest).toBe(sha256Hex(answer.result.text));
      // Never half a character, whatever the byte limit lands on.
      expect(answer.result.bytes % 2).toBe(0);
      expect(answer.result.text.includes("\uFFFD")).toBe(false);
      expect(answer.result.next).toBe(answer.result.bytes);
      expect(reads).toEqual(["e1"]);
      // Nothing in the answer says anything about storage.
      expect(JSON.stringify(answer.result)).not.toContain(file.path);
    } finally { file.cleanup(); }
  });

  it("reconstructs a whole body from ranges, holding one slice at a time", { timeout: 60_000 }, async () => {
    const file = fixture();
    try {
      const { range, revisions, index } = services();
      const indexed = await index.read(file.path);
      const revision = revisions.revisionOf(indexed.ok ? indexed.index : (undefined as never));
      // A test client that never holds more than one slice plus a digest.
      const hash = await import("node:crypto").then(crypto => crypto.createHash("sha256"));
      let offset: number | undefined = 0;
      let held = 0;
      let peak = 0;
      let slices = 0;
      let total = 0;
      while (offset !== undefined) {
        const answer = await range.read(file.path, params({ path: file.path, environmentKey: revisions.environmentKey, revision, offset, limit: 64 * 1024 }));
        if (answer.kind !== "answer") throw new Error("unexpected refusal");
        held = utf8ByteLength(answer.result.text);
        peak = Math.max(peak, held);
        hash.update(answer.result.text, "utf8");
        total += held;
        slices += 1;
        offset = answer.result.next;
      }
      expect(total).toBe(utf8ByteLength(HUGE));
      expect(hash.digest("hex")).toBe(sha256Hex(HUGE));
      expect(slices).toBeGreaterThan(500);
      // Never more than one payload in hand at any point.
      expect(peak).toBeLessThanOrEqual(64 * 1024);
    } finally { file.cleanup(); }
  });

  it("refuses a foreign environment before reading anything", async () => {
    const file = fixture();
    try {
      const { range, reads } = services();
      const answer = await range.read(file.path, params({ path: file.path, environmentKey: "someone-else", revision: "whatever" }));
      expect(answer.kind).toBe("refuse");
      if (answer.kind === "refuse") expect(answer.error.code).toBe(ErrorCodes.InvalidParams);
      expect(reads).toEqual([]);
    } finally { file.cleanup(); }
  });

  it("refuses a revision it is not serving rather than answering another state's bytes", async () => {
    const file = fixture();
    try {
      const { range, revisions, reads } = services();
      const answer = await range.read(file.path, params({ path: file.path, environmentKey: revisions.environmentKey, revision: "r1.aaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbb" }));
      expect(answer.kind).toBe("refuse");
      if (answer.kind === "refuse") {
        expect(answer.error.code).toBe(ErrorCodes.RevisionUnavailable);
        expect(answer.error.message).toMatch(/Open it again/);
      }
      expect(reads).toEqual([]);
    } finally { file.cleanup(); }
  });

  it("refuses an unknown entry, an absent component and a hostile range", async () => {
    const file = fixture();
    try {
      const { range, revisions, index } = services();
      const indexed = await index.read(file.path);
      const revision = revisions.revisionOf(indexed.ok ? indexed.index : (undefined as never));
      const base = { path: file.path, environmentKey: revisions.environmentKey, revision };
      for (const over of [
        { entryId: "nope" },
        { component: { kind: "tool_result" as const } },
        { offset: 10 ** 9 },
        { offset: 1 }, // inside a two-byte character
      ]) {
        const answer = await range.read(file.path, params({ ...base, ...over }));
        expect(answer.kind).toBe("refuse");
        if (answer.kind === "refuse") expect(answer.error.code).toBe(ErrorCodes.InvalidParams);
      }
    } finally { file.cleanup(); }
  });

  it("says the conversation is gone rather than inventing an answer", async () => {
    const { range, revisions } = services();
    const answer = await range.read("/nowhere/session.jsonl", params({ path: "/nowhere/session.jsonl", environmentKey: revisions.environmentKey, revision: "r" }));
    expect(answer.kind).toBe("refuse");
    if (answer.kind === "refuse") expect(answer.error.code).toBe(ErrorCodes.SessionNotFound);
  });

  it("leaves an oversized record out of a durable page and lists it exactly", async () => {
    const file = fixture();
    try {
      const { index, revisions } = services();
      const { SessionProjection } = await import("../src/session-projection.js");
      const projection = new SessionProjection({ index, revisions });
      const answer = await projection.read(file.path, { tail: 40 }, undefined, 16 * 1024);
      expect(answer.kind).toBe("answer");
      if (answer.kind !== "answer") return;
      expect(answer.result.entries).toHaveLength(1);
      expect((answer.result.entries[0] as { id: string }).id).toBe("e0");
      expect(answer.result.window!.elided).toEqual([{
        id: "e1", parentId: "e0", type: "message", role: "assistant",
        bodies: [
          { component: { kind: "assistant_text" }, totalBytes: utf8ByteLength(HUGE), contentDigest: sha256Hex(HUGE) },
          { component: { kind: "reasoning" }, totalBytes: 5, contentDigest: sha256Hex("short") },
        ],
      }]);
      // The delivered record is still exactly what the file holds.
      expect(answer.result.entries[0]).toEqual(prompt);
    } finally { file.cleanup(); }
  });

  it("serves the same bytes and digest a live authority would", async () => {
    const file = fixture();
    try {
      const { range, revisions, index } = services();
      const indexed = await index.read(file.path);
      const revision = revisions.revisionOf(indexed.ok ? indexed.index : (undefined as never));
      const durable = await range.read(file.path, params({ path: file.path, environmentKey: revisions.environmentKey, revision, component: { kind: "reasoning" } }));
      const { bodyRangeSlice } = await import("@lasercode/protocol");
      const live = bodyRangeSlice(reply, { component: { kind: "reasoning" }, offset: 0 }, revision, "live", sha256Hex);
      expect(durable.kind === "answer" && durable.result.text).toBe("short");
      expect(live.ok && live.result.contentDigest).toBe(durable.kind === "answer" ? durable.result.contentDigest : "");
      expect(live.ok && live.result.authority).toBe("live");
    } finally { file.cleanup(); }
  });
});

describe("a tool's output, read from the stored conversation (D-275)", () => {
  // Two text parts around an image, carrying details: the structured record is
  // JSON, and the output a person reads is the text alone.
  const partA = "first ✓ line\n".repeat(6000);
  const partB = "😀 tail é\n".repeat(7000);
  const output = partA + partB;
  const result = { type: "message", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:03.000Z", message: {
    role: "toolResult", toolCallId: "c1", toolName: "bash",
    content: [{ type: "text", text: partA }, { type: "image", mimeType: "image/png", data: "QUJD" }, { type: "text", text: partB }],
    details: { exitCode: 0, truncation: { truncated: false } }, isError: false } };

  function toolFixture() {
    const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-output-`));
    const path = join(dir, "session.jsonl");
    const call = { type: "message", id: "e1", parentId: "e0", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "cat" } }], stopReason: "toolUse" } };
    writeFileSync(path, [header, JSON.stringify(prompt), JSON.stringify(call), JSON.stringify(result)].join("\n") + "\n");
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("serves plain text with details present, reassembling across parts and multi-byte boundaries", async () => {
    const file = toolFixture();
    try {
      const { range, revisions, index } = services();
      const indexed = await index.read(file.path);
      const revision = revisions.revisionOf(indexed.ok ? indexed.index : (undefined as never));
      let offset = 0;
      let out = "";
      for (let step = 0; step < 200; step++) {
        const answer = await range.read(file.path, params({ path: file.path, environmentKey: revisions.environmentKey, revision,
          entryId: "e2", component: { kind: "tool_output" }, offset, limit: 4093 }));
        expect(answer.kind).toBe("answer");
        if (answer.kind !== "answer") return;
        expect(answer.result.totalBytes).toBe(utf8ByteLength(output));
        expect(answer.result.contentDigest).toBe(sha256Hex(output));
        expect(answer.result.text.includes("�")).toBe(false);
        out += answer.result.text;
        if (answer.result.next === undefined) break;
        offset = answer.result.next;
      }
      expect(out).toBe(output);
      // The structured record is still there for the callers that read it.
      const record = await range.read(file.path, params({ path: file.path, environmentKey: revisions.environmentKey, revision,
        entryId: "e2", component: { kind: "tool_result" }, offset: 0, limit: 64 }));
      expect(record.kind === "answer" && record.result.text.startsWith("{\n  \"content\"")).toBe(true);
    } finally { file.cleanup(); }
  });

  it("names it on a durable page exactly as it serves it", async () => {
    const file = toolFixture();
    try {
      const { index, revisions } = services();
      const { SessionProjection } = await import("../src/session-projection.js");
      const projection = new SessionProjection({ index, revisions });
      const answer = await projection.read(file.path, { tail: 40 }, undefined, 16 * 1024);
      expect(answer.kind).toBe("answer");
      if (answer.kind !== "answer") return;
      const elided = answer.result.window!.elided!.find(row => row.id === "e2")!;
      expect(elided.bodies.find(row => row.component.kind === "tool_output"))
        .toEqual({ component: { kind: "tool_output" }, totalBytes: utf8ByteLength(output), contentDigest: sha256Hex(output) });
    } finally { file.cleanup(); }
  });
});

describe("a screenshot a page served as a reference (M16-T89)", () => {
  // The bytes are never in a page, so the reference the page published is the
  // only way back to them: what it says has to be what this reader answers.
  const shot = (() => {
    const bytes = Buffer.alloc(240_000, 0x7a);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(1512, 16);
    bytes.writeUInt32BE(982, 20);
    return bytes.toString("base64");
  })();
  const result = { type: "message", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:03.000Z", message: {
    role: "toolResult", toolCallId: "c1", toolName: "screenshot",
    content: [{ type: "text", text: "screenshot taken" }, { type: "image", mimeType: "image/png", data: shot }] } };

  function shotFixture() {
    const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-image-`));
    const path = join(dir, "session.jsonl");
    const call = { type: "message", id: "e1", parentId: "e0", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "screenshot", arguments: { selector: "body" } }], stopReason: "toolUse" } };
    writeFileSync(path, [header, JSON.stringify(prompt), JSON.stringify(call), JSON.stringify(result)].join("\n") + "\n");
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("answers the exact bytes and digest the reference named, mid-payload included", async () => {
    const file = shotFixture();
    try {
      const { range, revisions, index } = services();
      const { bodyRangeSlice, entryWithImageReferences } = await import("@lasercode/protocol");
      const indexed = await index.read(file.path);
      const revision = revisions.revisionOf(indexed.ok ? indexed.index : (undefined as never));
      const component = { kind: "image", index: 0 } as const;
      const read = (offset: number, limit: number) => range.read(file.path, params({ path: file.path,
        environmentKey: revisions.environmentKey, revision, entryId: "e2", component, offset, limit }));

      // What the page published for this picture.
      const served = entryWithImageReferences(result, sha256Hex) as { message: { content: Array<{ ref?: { totalBytes: number; contentDigest: string; width?: number; height?: number } }> } };
      const reference = served.message.content[1]!.ref!;
      expect(reference).toEqual({ entryId: "e2", component, mimeType: "image/png",
        totalBytes: utf8ByteLength(shot), contentDigest: sha256Hex(shot), width: 1512, height: 982 });

      let offset = 0;
      let out = "";
      for (let step = 0; step < 200; step++) {
        const answer = await read(offset, 4093);
        expect(answer.kind).toBe("answer");
        if (answer.kind !== "answer") return;
        expect(answer.result.totalBytes).toBe(reference.totalBytes);
        expect(answer.result.contentDigest).toBe(reference.contentDigest);
        out += answer.result.text;
        if (answer.result.next === undefined) break;
        offset = answer.result.next;
      }
      expect(out).toBe(shot);

      // A range that starts and ends mid-payload, from both authorities.
      const middle = await read(100_000, 1_024);
      const live = bodyRangeSlice(result, { entryId: "e2", component, offset: 100_000, limit: 1_024 }, revision, "live", sha256Hex);
      if (middle.kind !== "answer" || !live.ok) throw new Error("expected a mid-payload range");
      expect(middle.result.text).toBe(shot.slice(100_000, 101_024));
      expect(middle.result.text).toBe(live.result.text);
      expect(middle.result.sliceDigest).toBe(live.result.sliceDigest);
      expect(middle.result.contentDigest).toBe(live.result.contentDigest);
      expect(middle.result.next).toBe(101_024);
      expect(middle.result.authority).toBe("durable");
    } finally { file.cleanup(); }
  });
});
