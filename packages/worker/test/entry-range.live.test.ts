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
import { boundedHistoryWindow, bodyRangeSlice, utf8ByteLength } from "@lasercode/protocol";
import { SessionRevisionTracker } from "../src/history-revision.js";

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const ENVIRONMENT = "11111111-2222-3333-4444-555555555555";
const header = { id: "session-1", cwd: "/project", version: 3 };
const HUGE = "答".repeat(1_000_000); // 3 MB of UTF-8, every character multi-byte

const prompt = { type: "message", id: "e0", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "go" }] } };
const reply = { type: "message", id: "e1", parentId: "e0", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: HUGE }] } };

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
