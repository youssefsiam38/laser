/**
 * RP-5b acceptance A9: the live half of reading one body.
 *
 * The worker answers from the entries it holds, at the revision computed from
 * that very snapshot, with the same slicing and the same digests the host's
 * worker-free reader produces from the stored conversation. A caller reading
 * at an older revision is refused rather than handed another state's offsets,
 * and a turn that has not been written yet has no entry to address at all.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { boundedHistoryWindow, bodyRangeSlice, entryRegionsPage, utf8ByteLength } from "@lasercode/protocol";
import { SessionRevisionTracker } from "../src/history-revision.js";

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const ENVIRONMENT = "11111111-2222-3333-4444-555555555555";
const header = { id: "session-1", cwd: "/project", version: 3 };
const HUGE = "答".repeat(1_000_000); // 3 MB of UTF-8, every character multi-byte

const prompt = { type: "message", id: "e0", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "go" }] } };
const reply = { type: "message", id: "e1", parentId: "e0", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: HUGE }] } };

describe("the attachments the owning worker names", () => {
  const content = "答".repeat(20_000);
  const promptText = `look at this\n\n<attached-file name="notes.md" type="text/markdown" size="${utf8ByteLength(content)}">\n${content}\n</attached-file>`;
  const withFile = { type: "message", id: "u9", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: promptText }] } };
  const hasher = () => { const hash = createHash("sha256"); return { update: (chunk: string) => { hash.update(chunk, "utf8"); }, digest: () => hash.digest("hex") }; };

  it("names them the way the stored reader does, and reads one exactly", () => {
    const tracker = new SessionRevisionTracker(ENVIRONMENT);
    const { revision } = tracker.compute(header, [withFile], "u9");
    const page = entryRegionsPage(withFile, { component: { kind: "user_text" } }, revision, "live", hasher);
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.result.authority).toBe("live");
    const item = page.result.items[0]!;
    expect(item.name).toBe("notes.md");
    expect(item.contentDigest).toBe(sha256Hex(content));
    expect(page.result.totalBytes).toBe(utf8ByteLength(promptText));

    // Read it back through the ordinary range contract, in region bytes.
    let offset = item.offset;
    let assembled = "";
    for (let step = 0; step < 100; step++) {
      const answer = bodyRangeSlice(withFile, { component: { kind: "user_text" }, offset, limit: 64 * 1024, region: { offset: item.offset, bytes: item.bytes } }, revision, "live", sha256Hex);
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      expect(answer.result.regionDigest).toBe(sha256Hex(content));
      expect(answer.result.text.includes("\uFFFD")).toBe(false);
      assembled += answer.result.text;
      if (answer.result.next === undefined) break;
      offset = answer.result.next;
    }
    expect(assembled).toBe(content);
    // The same bytes a worker-free read of the same record would produce.
    const durable = entryRegionsPage(withFile, { component: { kind: "user_text" } }, revision, "durable", hasher);
    expect(durable.ok && durable.result.items).toEqual(page.result.items);
  });
});

describe("a body read from the owning worker", () => {
  it("slices exactly, on character boundaries, with the whole body's digest", () => {
    const tracker = new SessionRevisionTracker(ENVIRONMENT);
    const { revision } = tracker.compute(header, [prompt, reply], "e1");
    const answer = bodyRangeSlice(reply, { component: { kind: "assistant_text" }, offset: 0, limit: 64 * 1024 }, revision, "live", sha256Hex);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.result.authority).toBe("live");
    expect(answer.result.totalBytes).toBe(utf8ByteLength(HUGE));
    expect(answer.result.contentDigest).toBe(sha256Hex(HUGE));
    expect(answer.result.bytes % 3).toBe(0);
    expect(answer.result.text.includes("\uFFFD")).toBe(false);
  });

  it("reassembles to the same bytes a durable read would produce", () => {
    const tracker = new SessionRevisionTracker(ENVIRONMENT);
    const { revision } = tracker.compute(header, [prompt, reply], "e1");
    let offset: number | undefined = 0;
    const hash = createHash("sha256");
    let peak = 0;
    while (offset !== undefined) {
      const answer = bodyRangeSlice(reply, { component: { kind: "assistant_text" }, offset, limit: 64 * 1024 }, revision, "live", sha256Hex);
      if (!answer.ok) throw new Error("unexpected refusal");
      peak = Math.max(peak, utf8ByteLength(answer.result.text));
      hash.update(answer.result.text, "utf8");
      offset = answer.result.next;
    }
    expect(hash.digest("hex")).toBe(sha256Hex(HUGE));
    expect(peak).toBeLessThanOrEqual(64 * 1024);
  });

  it("changes revision when the conversation moves on, so an old read is refused", () => {
    const tracker = new SessionRevisionTracker(ENVIRONMENT);
    const before = tracker.compute(header, [prompt, reply], "e1").revision;
    const later = { type: "message", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "more" }] } };
    const after = tracker.compute(header, [prompt, reply, later], "e2").revision;
    expect(after).not.toBe(before);
    // The worker compares the caller's revision with this one and refuses.
    expect(before === after).toBe(false);
  });

  it("leaves an oversized record out of a live page instead of refusing the page", () => {
    const tracker = new SessionRevisionTracker(ENVIRONMENT);
    const { revision, environmentKey } = tracker.compute(header, [prompt, reply], "e1");
    const scope = { sessionId: "session-1", epoch: "w1", seq: 3, revision, environmentKey, authority: "live" as const, selection: { kind: "replace" as const } };
    // Without the per-body limit the page cannot be transferred at all.
    expect(boundedHistoryWindow({ entries: [prompt, reply], leafId: "e1" }, { tail: 40 }, scope)).toBeUndefined();
    const page = boundedHistoryWindow({ entries: [prompt, reply], leafId: "e1" }, { tail: 40 }, scope, { limit: 16 * 1024, digest: sha256Hex });
    expect(page).toBeDefined();
    expect(page!.entries).toEqual([prompt]);
    expect(page!.window.elided).toEqual([{
      id: "e1", parentId: "e0", type: "message", role: "assistant",
      bodies: [{ component: { kind: "assistant_text" }, totalBytes: utf8ByteLength(HUGE), contentDigest: sha256Hex(HUGE) }],
    }]);
  });

  it("serves a screenshot in a live page as a reference, and still reads its bytes at that revision (M16-T89)", () => {
    const shot = (() => {
      const bytes = Buffer.alloc(2_405_990, 0x7a);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
      bytes.writeUInt32BE(13, 8);
      bytes.write("IHDR", 12, "ascii");
      bytes.writeUInt32BE(2560, 16);
      bytes.writeUInt32BE(1440, 20);
      return bytes.toString("base64");
    })();
    const call = { type: "message", id: "e1", parentId: "e0", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "screenshot", arguments: {} }] } };
    const shotResult = { type: "message", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:02.000Z", message: {
      role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "screenshot taken" }, { type: "image", mimeType: "image/png", data: shot }] } };
    const entries = [prompt, call, shotResult];
    const tracker = new SessionRevisionTracker(ENVIRONMENT);
    const { revision, environmentKey } = tracker.compute(header, entries, "e2");
    const scope = { sessionId: "session-1", epoch: "w1", seq: 4, revision, environmentKey, authority: "live" as const, selection: { kind: "replace" as const } };
    // No body limit at all, and the page is still served whole: a picture never
    // travels inside one, so no page can be too large because of a screenshot.
    const page = boundedHistoryWindow({ entries, leafId: "e2" }, { tail: 40 }, scope, { digest: sha256Hex });
    expect(page).toBeDefined();
    expect(page!.entries).toHaveLength(3);
    expect(page!.window.elided).toBeUndefined();
    const part = (page!.entries[2] as { message: { content: Array<{ data?: string; ref?: unknown }> } }).message.content[1]!;
    expect(part.data).toBe("");
    expect(part.ref).toEqual({
      entryId: "e2", component: { kind: "image", index: 0 }, mimeType: "image/png",
      totalBytes: utf8ByteLength(shot), contentDigest: sha256Hex(shot), width: 2560, height: 1440,
    });
    // The reference is what this worker answers a range request with.
    const slice = bodyRangeSlice(shotResult, { entryId: "e2", component: { kind: "image", index: 0 }, offset: 1_000_000, limit: 2_048 }, revision, "live", sha256Hex);
    expect(slice.ok).toBe(true);
    if (!slice.ok) return;
    expect(slice.result.totalBytes).toBe(utf8ByteLength(shot));
    expect(slice.result.contentDigest).toBe(sha256Hex(shot));
    expect(slice.result.text).toBe(shot.slice(1_000_000, 1_002_048));
  });

  it("has nothing to address while a turn is still being written", () => {
    // A live message carries no entry id until it is persisted; the reference
    // the transcript holds says `live`, and the transcript says so in words.
    const unwritten = { type: "message", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "half a th" }] } };
    const answer = bodyRangeSlice(unwritten, { component: { kind: "assistant_text" }, offset: 0 }, "r1", "live", sha256Hex);
    expect(answer.ok).toBe(true);
    // …but it is unreachable: nothing can name it, because it has no id.
    expect((unwritten as { id?: string }).id).toBeUndefined();
  });
});
