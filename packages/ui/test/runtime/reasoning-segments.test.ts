/**
 * One reasoning body, five layers, the same bytes.
 *
 * A provider writes a reasoning summary as separate titled segments. They read
 * as separate paragraphs, so a blank line stands between them — and that blank
 * line is part of the body, which means the durable block this view builds, the
 * live one it grows from deltas, the tail it keeps of a message already in
 * flight, and the range the authority serves must all agree about it to the
 * byte. A reference minted two bytes short of the body it points at is not a
 * wrong number on screen: it is a read refused with "That part of the message
 * did not arrive as expected."
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  REASONING_SEGMENT_SEPARATOR,
  bodyRangeSlice,
  entryBody,
  entryBodyMetadata,
  utf8ByteLength,
  type SessionState,
} from "@lasercode/protocol";

import { blocksFromEntries, initialState, reduce, type AppState, type Block } from "../../src/store.js";
import { BODY_EXCERPT_MAX_BYTES, LIVE_TAIL_MAX_BYTES, tailOfParts } from "../../src/runtime/body-excerpt.js";
import { validateRangeReply, type RangeResult } from "../../src/runtime/body-reader.js";

const CWD = "/p";
const path = `${CWD}/reasoning.jsonl`;
const REVISION = "r1.env.2";
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const sessionState = (over: Partial<SessionState> = {}): SessionState => ({
  path, id: "id-reasoning", cwd: CWD, messageCount: 2, pendingMessageCount: 0, isStreaming: false, isCompacting: false, ...over,
} as SessionState);

const update = (state: AppState, seq: number, value: unknown): AppState =>
  reduce(state, { type: "notification", method: "session/update", params: { sessionPath: path, seq, at: "2026-09-15T00:00:00.000Z", update: value } } as never);

const streaming = (state: AppState): Extract<Block, { kind: "assistant" }> =>
  state.open[path]!.blocks.at(-1) as Extract<Block, { kind: "assistant" }>;

/** Two segments as a provider writes them; the second is not ASCII. */
const FIRST = "**Handling loading state** — the skeleton has to stay honest.";
const SECOND = "**Implementing safe fallback** — 答えは「はい」です。";
const JOINED = `${FIRST}${REASONING_SEGMENT_SEPARATOR}${SECOND}`;

const assistantEntry = (segments: readonly string[], id = "e1") => ({
  id, parentId: "e0", type: "message",
  message: { role: "assistant", content: [
    { type: "text", text: "Done." },
    ...segments.map(thinking => ({ type: "thinking", thinking })),
  ] },
});

const blockOf = (entry: unknown): Extract<Block, { kind: "assistant" }> =>
  blocksFromEntries([entry], (entry as { id: string }).id, undefined, { stubs: [], revision: REVISION })
    .find(block => block.kind === "assistant") as Extract<Block, { kind: "assistant" }>;

describe("a reasoning summary with more than one segment", () => {
  it("reads as separate paragraphs in a settled transcript row", () => {
    const block = blockOf(assistantEntry([FIRST, SECOND]));
    expect(block.thinking).toBe(JOINED);
    expect(block.thinking).toBe(entryBody(assistantEntry([FIRST, SECOND]), { kind: "reasoning" }));
    // The reply's own text is one stream of tokens and keeps its empty join.
    expect(block.text).toBe("Done.");
  });

  it("mints a reference the size of the body the authority serves", () => {
    const segments = ["A".repeat(12_000), "答".repeat(6_000)];
    const entry = assistantEntry(segments);
    const block = blockOf(entry);
    const served = entryBody(entry, { kind: "reasoning" })!;
    const published = entryBodyMetadata(entry).find(row => row.component.kind === "reasoning")!.totalBytes;

    expect(served).toBe(segments.join(REASONING_SEGMENT_SEPARATOR));
    expect(block.bodies?.thinking?.totalBytes).toBe(utf8ByteLength(served));
    expect(block.bodies?.thinking?.totalBytes).toBe(published);
    expect(utf8ByteLength(block.thinking)).toBeLessThanOrEqual(BODY_EXCERPT_MAX_BYTES);
    // The excerpt is the head of that body, not the head of its first segment.
    expect(served.startsWith(block.thinking)).toBe(true);
  });

  it("reads back, slice by slice, against the reference this view minted", () => {
    // The first segment is longer than the excerpt, so the boundary itself is
    // in the part that has to be read back from the authority.
    const segments = ["A".repeat(20_000), "答".repeat(6_000)];
    const entry = assistantEntry(segments);
    const ref = blockOf(entry).bodies!.thinking!;
    const body = entryBody(entry, { kind: "reasoning" })!;

    let offset = ref.excerpt.offset + ref.excerpt.bytes;
    let read = "";
    for (let step = 0; step < 100; step++) {
      const answer = bodyRangeSlice(entry, { entryId: "e1", component: { kind: "reasoning" }, offset, limit: 4096 }, REVISION, "durable", sha);
      expect(answer.ok).toBe(true);
      if (!answer.ok) break;
      // Exactly the check every reader makes before a byte reaches a surface:
      // a total that disagrees with the reference refuses the whole read.
      const reply = validateRangeReply(answer.result as RangeResult, {
        revision: REVISION, entryId: "e1", component: ref.component, offset, limit: 4096, totalBytes: ref.totalBytes,
      });
      read += reply.text;
      if (reply.next === undefined) break;
      offset = reply.next;
    }
    expect(read).toBe(body.slice(body.length - read.length));
    // Head excerpt plus the rest is the body, blank line and all.
    expect(blockOf(entry).thinking + read).toBe(body);
    expect(read).toContain(REASONING_SEGMENT_SEPARATOR);
  });

  it("keeps the blank line in the tail of a message already in flight", () => {
    const small = tailOfParts([FIRST, SECOND], { component: { kind: "reasoning" } });
    expect(small.text).toBe(JOINED);
    expect(small.ref).toBeUndefined();

    const segments = ["A".repeat(40_000), "B".repeat(20_000)];
    const body = segments.join(REASONING_SEGMENT_SEPARATOR);
    const tail = tailOfParts(segments, { component: { kind: "reasoning" } });
    expect(tail.ref!.totalBytes).toBe(utf8ByteLength(body));
    expect(utf8ByteLength(tail.text)).toBeLessThanOrEqual(LIVE_TAIL_MAX_BYTES);
    // The tail is a suffix of the body, and its reference says exactly where
    // that suffix starts inside it.
    expect(body.endsWith(tail.text)).toBe(true);
    expect(tail.ref!.excerpt.bytes).toBe(utf8ByteLength(tail.text));
    expect(tail.ref!.excerpt.offset).toBe(utf8ByteLength(body) - utf8ByteLength(tail.text));
    expect(body.slice(tail.ref!.excerpt.offset)).toBe(tail.text);

    // A body counted across a boundary counts the separator too.
    const across = tailOfParts(["x".repeat(20_000), "y".repeat(15_000)], { component: { kind: "reasoning" } });
    expect(across.ref!.totalBytes).toBe(35_002);
    // Prose is not segmented: its parts are one stream, as they were.
    const prose = tailOfParts(["x".repeat(20_000), "y".repeat(20_000)], { component: { kind: "assistant_text" } });
    expect(prose.ref!.totalBytes).toBe(40_000);
    expect(prose.text).not.toContain(REASONING_SEGMENT_SEPARATOR);
  });

  it("separates the segments of a live turn as its deltas cross contentIndex", () => {
    let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ isStreaming: true }) });
    state = { ...state, current: path };
    state = update(state, 1, { kind: "message_start", role: "assistant" });
    state = update(state, 2, { kind: "thinking_delta", delta: FIRST.slice(0, 20), contentIndex: 0 });
    state = update(state, 3, { kind: "thinking_delta", delta: FIRST.slice(20), contentIndex: 0 });
    // An empty segment is not a paragraph and spends no blank line.
    state = update(state, 4, { kind: "thinking_delta", delta: "", contentIndex: 1 });
    state = update(state, 5, { kind: "thinking_delta", delta: SECOND, contentIndex: 2 });
    expect(streaming(state).thinking).toBe(JOINED);

    // And the live body is the body the entry is served as when it settles.
    const settledEntry = assistantEntry([FIRST, SECOND]);
    expect(streaming(state).thinking).toBe(entryBody(settledEntry, { kind: "reasoning" }));
    state = update(state, 6, { kind: "message_end", role: "assistant", message: settledEntry.message });
    const settled = state.open[path]!.blocks.find(block => block.kind === "assistant") as Extract<Block, { kind: "assistant" }>;
    expect(settled.streaming).toBe(false);
    expect(settled.thinking).toBe(JOINED);
    // The segment cursor is a live detail; a settled row is what a reload builds.
    expect("thinkingIndex" in settled).toBe(false);
  });

  it("counts the blank line in a live reference, so a bounded turn stays readable", () => {
    let state = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ isStreaming: true }) });
    state = { ...state, current: path };
    state = update(state, 1, { kind: "message_start", role: "assistant" });
    const first = "A".repeat(40_000);
    const second = "B".repeat(20_000);
    state = update(state, 2, { kind: "thinking_delta", delta: first, contentIndex: 0 });
    state = update(state, 3, { kind: "thinking_delta", delta: second, contentIndex: 1 });

    const block = streaming(state);
    const body = `${first}${REASONING_SEGMENT_SEPARATOR}${second}`;
    expect(block.bodies?.thinking?.totalBytes).toBe(utf8ByteLength(body));
    // The same number the authority publishes for that turn once it is written.
    expect(block.bodies?.thinking?.totalBytes)
      .toBe(entryBodyMetadata(assistantEntry([first, second])).find(row => row.component.kind === "reasoning")!.totalBytes);
    expect(utf8ByteLength(block.thinking)).toBeLessThanOrEqual(LIVE_TAIL_MAX_BYTES);
    expect(body.endsWith(block.thinking)).toBe(true);

    // An older worker sends no index: the turn is one segment, exactly as before.
    let plain = reduce({ ...initialState, connection: "open" }, { type: "opened", state: sessionState({ isStreaming: true }) });
    plain = { ...plain, current: path };
    plain = update(plain, 1, { kind: "message_start", role: "assistant" });
    plain = update(plain, 2, { kind: "thinking_delta", delta: "one " });
    plain = update(plain, 3, { kind: "thinking_delta", delta: "stream" });
    expect(streaming(plain).thinking).toBe("one stream");
  });
});
