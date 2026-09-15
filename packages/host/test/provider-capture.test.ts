/**
 * RP-7: reassembling a chunked provider capture, and every way one can fail.
 *
 * The rule every case here checks is the same: the request happened, so there
 * is always a row; the body is there only when what arrived is exactly what
 * was announced; and no outcome leaves bytes behind.
 */
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { CAPTURE_ACCUM_SESSION_BYTES, CAPTURE_OPEN_SESSION, type ProviderCaptureMeta } from "@lasercode/protocol";
import { CaptureAccumulator, type CaptureAbsent, type CaptureComplete } from "../src/provider-capture.js";

function metaFor(body: string, captureId = "c-0123456789abcdef", chunks = 1): ProviderCaptureMeta {
  return {
    captureId,
    at: new Date().toISOString(),
    bytes: Buffer.byteLength(body, "utf8"),
    sha256: createHash("sha256").update(body).digest("hex"),
    preview: body.slice(0, 40),
    redactedFields: 0,
    chunks,
    summary: { model: "test", messages: 1 },
  };
}

function harness() {
  const complete: CaptureComplete[] = [];
  const absent: CaptureAbsent[] = [];
  const logs: string[] = [];
  const accumulator = new CaptureAccumulator({
    onComplete: (input) => complete.push(input),
    onAbsent: (input) => absent.push(input),
    log: (message) => logs.push(message),
  });
  return { accumulator, complete, absent, logs };
}

describe("a capture that arrives whole", () => {
  it("is stored once, with the body it announced", () => {
    const { accumulator, complete, absent } = harness();
    const body = JSON.stringify({ model: "test", messages: [{ role: "user", content: "hello" }] });
    const meta = metaFor(body, "c-aaaaaaaaaaaaaaaa", 2);
    const half = Math.floor(body.length / 2);
    accumulator.begin("/project", "/session", meta);
    accumulator.chunk(meta.captureId, 0, body.slice(0, half));
    accumulator.chunk(meta.captureId, 1, body.slice(half));
    accumulator.finish(meta.captureId, 2, meta.bytes);
    expect(absent).toEqual([]);
    expect(complete).toHaveLength(1);
    expect(complete[0]!.body).toBe(body);
    expect(complete[0]!.sessionPath).toBe("/session");
    expect(accumulator.retained()).toEqual({ open: 0, bytes: 0 });
  });
});

describe("a capture that does not", () => {
  it("refuses an out-of-order chunk and records the row", () => {
    const { accumulator, complete, absent } = harness();
    const body = "x".repeat(100);
    const meta = metaFor(body, "c-bbbbbbbbbbbbbbbb", 2);
    accumulator.begin("/project", "/session", meta);
    accumulator.chunk(meta.captureId, 1, body);
    expect(complete).toEqual([]);
    expect(absent[0]).toMatchObject({ reason: "corrupt", meta: { bytes: meta.bytes, sha256: meta.sha256 } });
    expect(accumulator.retained().bytes).toBe(0);
  });

  it("refuses a chunk that overruns the announced size", () => {
    const { accumulator, absent } = harness();
    const meta = metaFor("x".repeat(10), "c-cccccccccccccccc", 1);
    accumulator.begin("/project", "/session", meta);
    accumulator.chunk(meta.captureId, 0, "x".repeat(11));
    expect(absent[0]!.reason).toBe("corrupt");
  });

  it("refuses a wrong chunk count or byte total at the end", () => {
    const { accumulator, absent } = harness();
    const body = "x".repeat(10);
    const meta = metaFor(body, "c-dddddddddddddddd", 1);
    accumulator.begin("/project", "/session", meta);
    accumulator.chunk(meta.captureId, 0, body);
    accumulator.finish(meta.captureId, 2, meta.bytes);
    expect(absent[0]!.reason).toBe("corrupt");
  });

  it("refuses a body whose digest does not match what was announced", () => {
    const { accumulator, complete, absent } = harness();
    const body = "x".repeat(10);
    const meta = { ...metaFor(body, "c-eeeeeeeeeeeeeeee", 1), sha256: "0".repeat(64) };
    accumulator.begin("/project", "/session", meta);
    accumulator.chunk(meta.captureId, 0, body);
    accumulator.finish(meta.captureId, 1, meta.bytes);
    expect(complete).toEqual([]);
    expect(absent[0]!.reason).toBe("corrupt");
    expect(accumulator.retained()).toEqual({ open: 0, bytes: 0 });
  });

  it("ends the incumbent rather than merging two streams under one id", () => {
    const { accumulator, absent } = harness();
    const body = "x".repeat(10);
    const first = metaFor(body, "c-ffffffffffffffff", 1);
    accumulator.begin("/project", "/session", first);
    accumulator.chunk(first.captureId, 0, body);
    accumulator.begin("/project", "/session", { ...first, at: new Date().toISOString() });
    expect(absent[0]!.reason).toBe("interrupted");
    expect(accumulator.retained().open).toBe(1);
  });

  it("refuses an id that is not opaque and bounded", () => {
    const { accumulator, complete, absent } = harness();
    accumulator.begin("/project", "/session", metaFor("x", "../../etc/passwd", 1));
    expect(complete).toEqual([]);
    expect(absent).toEqual([]);
    expect(accumulator.retained().open).toBe(0);
  });

  it("refuses a declared size past the ceiling before it holds anything", () => {
    const { accumulator, absent } = harness();
    accumulator.begin("/project", "/session", { ...metaFor("x", "c-1111111111111111", 1), bytes: 64 * 1024 * 1024 });
    expect(absent[0]!.reason).toBe("corrupt");
    expect(accumulator.retained().open).toBe(0);
  });
});

describe("bounds", () => {
  it("holds no more than the session's share, oldest first", () => {
    const { accumulator, absent } = harness();
    const chunk = "x".repeat(2 * 1024 * 1024);
    for (let index = 0; index < 4; index++) {
      const meta = { ...metaFor(chunk, `c-${String(index).repeat(16)}`, 8), bytes: 8 * 1024 * 1024 };
      accumulator.begin("/project", "/session", meta);
      accumulator.chunk(meta.captureId, 0, chunk);
    }
    expect(accumulator.retained().open).toBeLessThanOrEqual(CAPTURE_OPEN_SESSION);
    expect(accumulator.retained().bytes).toBeLessThanOrEqual(CAPTURE_ACCUM_SESSION_BYTES);
    // Everything evicted is a row that says so, never silence.
    expect(absent.every((entry) => entry.reason === "interrupted")).toBe(true);
  });

  it("records an aborted capture once, with its own metadata, and keeps nothing", () => {
    const { accumulator, complete, absent } = harness();
    const body = "x".repeat(4096);
    const meta = metaFor(body, "c-9999999999999999", 4);
    accumulator.begin("/project", "/session", meta);
    accumulator.chunk(meta.captureId, 0, body.slice(0, 1024));
    // The producer gave up: the link filled while it was sending.
    accumulator.abort(meta.captureId, "link-busy");
    expect(complete).toEqual([]);
    expect(absent).toHaveLength(1);
    expect(absent[0]).toMatchObject({
      reason: "link-busy",
      sessionPath: "/session",
      meta: { bytes: meta.bytes, sha256: meta.sha256, preview: meta.preview },
    });
    expect(accumulator.retained()).toEqual({ open: 0, bytes: 0 });
    // Nothing else may follow it: no second row from a late chunk, an end, or
    // the worker generation going away afterwards.
    accumulator.chunk(meta.captureId, 1, body.slice(1024, 2048));
    accumulator.finish(meta.captureId, 4, meta.bytes);
    accumulator.actorGone("/project");
    accumulator.clear();
    expect(absent).toHaveLength(1);
    expect(complete).toEqual([]);
  });

  it("ignores an abort for a capture nobody opened", () => {
    const { accumulator, complete, absent } = harness();
    accumulator.abort("c-aaaabbbbccccdddd", "link-busy");
    expect(absent).toEqual([]);
    expect(complete).toEqual([]);
  });

  it("ends everything a worker generation opened when it goes", () => {
    const { accumulator, absent } = harness();
    const body = "x".repeat(10);
    const mine = metaFor(body, "c-2222222222222222", 1);
    const other = metaFor(body, "c-3333333333333333", 1);
    accumulator.begin("/project-a", "/session-a", mine);
    accumulator.begin("/project-b", "/session-b", other);
    accumulator.chunk(mine.captureId, 0, body);
    accumulator.actorGone("/project-a");
    expect(absent.map((entry) => entry.cwd)).toEqual(["/project-a"]);
    expect(accumulator.retained().open).toBe(1);
    accumulator.clear();
    expect(accumulator.retained()).toEqual({ open: 0, bytes: 0 });
  });
});

describe("the host's own guard over a body it did not redact", () => {
  it("redacts a survivor, restates the metadata to the bytes it stores, and names only the key", () => {
    const { accumulator, complete, absent, logs } = harness();
    const body = JSON.stringify({ model: "test", api_key: "sk-live-1234", messages: [] });
    const meta = metaFor(body, "c-4444444444444444", 1);
    accumulator.begin("/project", "/session", meta);
    accumulator.chunk(meta.captureId, 0, body);
    accumulator.finish(meta.captureId, 1, meta.bytes);

    // Exactly one outcome for one capture.
    expect(complete).toHaveLength(1);
    expect(absent).toEqual([]);

    const stored = complete[0]!;
    expect(stored.body).not.toContain("sk-live-1234");
    expect(JSON.parse(stored.body).api_key).toBe("[redacted]");
    // The row must describe the bytes that are actually stored, not the ones
    // the producer announced: a digest over something nobody can read back is
    // worse than no digest at all.
    expect(stored.meta.bytes).toBe(Buffer.byteLength(stored.body, "utf8"));
    expect(stored.meta.sha256).toBe(createHash("sha256").update(stored.body).digest("hex"));
    expect(stored.meta.sha256).not.toBe(meta.sha256);
    expect(stored.meta.preview).toBe(stored.body.slice(0, meta.preview.length));
    expect(stored.meta.preview).not.toContain("sk-live-1234");
    expect(stored.meta.redactedFields).toBe(1);
    // Nothing about the original leaked into the log line.
    expect(logs.join(" ")).toContain("api_key");
    expect(logs.join(" ")).not.toContain("sk-live-1234");
  });

  it("keeps the producer's own redaction count as a floor", () => {
    const { accumulator, complete } = harness();
    const body = JSON.stringify({ model: "test", cookie: "a=b", messages: [] });
    const meta = { ...metaFor(body, "c-7777777777777777", 1), redactedFields: 4 };
    accumulator.begin("/project", "/session", meta);
    accumulator.chunk(meta.captureId, 0, body);
    accumulator.finish(meta.captureId, 1, meta.bytes);
    expect(complete[0]!.meta.redactedFields).toBe(4);
  });

  it("leaves a clean body's metadata exactly as the producer stated it", () => {
    const { accumulator, complete } = harness();
    const body = JSON.stringify({ model: "test", messages: [{ role: "user", content: "hello" }] });
    const meta = metaFor(body, "c-8888888888888888", 1);
    accumulator.begin("/project", "/session", meta);
    accumulator.chunk(meta.captureId, 0, body);
    accumulator.finish(meta.captureId, 1, meta.bytes);
    expect(complete[0]!.meta).toEqual(meta);
  });

  it("stores nothing, once, when a survivor cannot even be parsed", () => {
    const { accumulator, complete, absent } = harness();
    const body = `not json, "authorization": "Bearer sk-live"`;
    const meta = metaFor(body, "c-5555555555555555", 1);
    accumulator.begin("/project", "/session", meta);
    accumulator.chunk(meta.captureId, 0, body);
    accumulator.finish(meta.captureId, 1, meta.bytes);
    // One row, and it is the absent one: no empty body was also completed.
    expect(complete).toEqual([]);
    expect(absent).toHaveLength(1);
    expect(absent[0]).toMatchObject({ reason: "corrupt", meta: { sha256: meta.sha256, bytes: meta.bytes } });
    expect(JSON.stringify(absent[0])).not.toContain("sk-live");
    expect(accumulator.retained()).toEqual({ open: 0, bytes: 0 });
  });
});

describe("chunks for a capture nobody opened", () => {
  it("are ignored, and allocate nothing", () => {
    const { accumulator, complete, absent } = harness();
    const onComplete = vi.fn();
    expect(onComplete).not.toHaveBeenCalled();
    accumulator.chunk("c-6666666666666666", 0, "x".repeat(1000));
    accumulator.finish("c-6666666666666666", 1, 1000);
    expect(complete).toEqual([]);
    expect(absent).toEqual([]);
    expect(accumulator.retained()).toEqual({ open: 0, bytes: 0 });
  });
});
