import { describe, expect, it } from "vitest";
import { FRAME_MAX_BYTES, LineDecoder, isNotification, isRequest, isResponse } from "../src/index.js";

describe("LineDecoder", () => {
  it("splits on LF only and strips CR", () => {
    const d = new LineDecoder();
    expect(d.push('{"a":1}\r\n{"b":"x y"}\n{"c"')).toEqual(['{"a":1}', '{"b":"x y"}']);
    expect(d.push(":3}\n")).toEqual(['{"c":3}']);
    expect(d.end()).toEqual([]);
  });

  it("does not split on the characters Node's readline also breaks on", () => {
    const d = new LineDecoder();
    // U+2028 and U+2029 are legal inside a JSON string; `readline` ends a line
    // on them, which is exactly why this decoder exists.
    expect(d.push(`{"a":"x\u2028y\u2029z"}\n`)).toEqual([`{"a":"x\u2028y\u2029z"}`]);
  });

  it("flushes a trailing partial line from end()", () => {
    const d = new LineDecoder();
    expect(d.push('{"a":1}')).toEqual([]);
    expect(d.end()).toEqual(['{"a":1}']);
    expect(d.end()).toEqual([]);
  });

  /**
   * The decoder works in UTF-8 bytes, so the interesting boundaries are inside
   * characters, not between them: a 3-byte CJK character, a 4-byte emoji (a
   * surrogate pair in JavaScript) and a CRLF, cut at every internal byte.
   */
  it("decodes identically however the bytes are cut up", () => {
    const line = `{"cjk":"日本語テキスト","emoji":"👩‍🚀🇯🇵","latin":"x"}`;
    const whole = Buffer.from(`${line}\r\n`, "utf8");
    for (let cut = 1; cut < whole.length; cut++) {
      const d = new LineDecoder();
      const lines = [...d.push(whole.subarray(0, cut)), ...d.push(whole.subarray(cut))];
      expect(lines, `cut at byte ${cut}`).toEqual([line]);
      expect(d.stats.retained).toBe(0);
    }
  });

  it("decodes a byte stream arriving one byte at a time", () => {
    const line = `{"emoji":"🚀","cjk":"漢字"}`;
    const bytes = Buffer.from(`${line}\n`, "utf8");
    const d = new LineDecoder();
    const out: string[] = [];
    for (const byte of bytes) out.push(...d.push(Buffer.from([byte])));
    expect(out).toEqual([line]);
  });

  /**
   * Linearity, proven by what the decoder did rather than by how long it took.
   *
   * The old implementation re-scanned its whole accumulated buffer on every
   * chunk, so scanning was quadratic in the frame size. These invariants fail
   * on that implementation and cannot flake on a loaded machine:
   *
   *  - every byte is scanned exactly once;
   *  - a frame is copied at most once, and only when it spanned chunks;
   *  - retained bytes never exceed the frame being assembled.
   */
  it("scans every byte once and copies a frame at most once", () => {
    for (const megabytes of [1, 4, 8, 16]) {
      const d = new LineDecoder();
      const chunk = Buffer.alloc(64 * 1024, 0x78);
      const total = megabytes * 1024 * 1024;
      for (let sent = 0; sent < total; sent += chunk.length) d.push(chunk);
      const lines = d.push(Buffer.from("\n"));
      const stats = d.stats;
      expect(lines[0]!.length).toBe(total);
      expect(stats.bytesScanned).toBe(total + 1);
      expect(stats.joins).toBe(1);
      expect(stats.bytesCopied).toBe(total);
      expect(stats.largestFrame).toBe(total);
      expect(stats.retainedHighWater).toBeLessThanOrEqual(total);
      expect(stats.retained).toBe(0);
    }
  });

  it("copies nothing for a frame that arrived inside one chunk", () => {
    const d = new LineDecoder();
    d.push(Buffer.from(`${"y".repeat(1000)}\n`, "utf8"));
    expect(d.stats.joins).toBe(0);
    expect(d.stats.bytesCopied).toBe(0);
  });

  it("faults on a frame past the ceiling instead of skipping it", () => {
    const overflows: Array<{ bytes: number }> = [];
    const d = new LineDecoder({ maxFrameBytes: 1024, onOverflow: (info) => overflows.push(info) });
    expect(d.push(Buffer.alloc(900, 0x61))).toEqual([]);
    expect(d.push(Buffer.alloc(900, 0x61))).toEqual([]);
    expect(overflows).toEqual([{ bytes: 1800 }]);
    expect(d.faulted).toBe(true);
    expect(d.stats.retained).toBe(0);
    expect(d.stats.overflows).toBe(1);
    // Nothing after the fault is decoded: a response we could not read would
    // otherwise leave its request waiting for ever, silently.
    expect(d.push(Buffer.from('{"a":1}\n'))).toEqual([]);
    expect(d.end()).toEqual([]);
  });

  it("measures the ceiling in UTF-8 bytes, not characters", () => {
    const d = new LineDecoder({ maxFrameBytes: 8 });
    // Three 3-byte characters are 9 bytes, past a ceiling of 8, even though
    // they are only three characters (and six UTF-16 code units would be five).
    expect(d.push(Buffer.from("日本語", "utf8"))).toEqual([]);
    expect(d.faulted).toBe(true);
  });

  it("defaults to the product's frame ceiling", () => {
    expect(FRAME_MAX_BYTES).toBe(64 * 1024 * 1024);
    const d = new LineDecoder();
    d.push(Buffer.from("{}\n"));
    expect(d.faulted).toBe(false);
  });

  it("skips empty lines and keeps ordering across chunks", () => {
    const d = new LineDecoder();
    expect(d.push(Buffer.from("\n\na\n"))).toEqual(["a"]);
    expect(d.push(Buffer.from("b\r\nc"))).toEqual(["b"]);
    expect(d.end()).toEqual(["c"]);
  });
});

describe("message guards", () => {
  it("classifies request, notification, response", () => {
    expect(isRequest({ jsonrpc: "2.0", id: 1, method: "x", params: {} })).toBe(true);
    expect(isNotification({ jsonrpc: "2.0", method: "x", params: {} })).toBe(true);
    expect(isResponse({ jsonrpc: "2.0", id: 1, result: {} })).toBe(true);
  });
});
