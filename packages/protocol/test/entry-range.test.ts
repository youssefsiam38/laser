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
  bodyProjectionWork,
  bodyRangeSlice,
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
