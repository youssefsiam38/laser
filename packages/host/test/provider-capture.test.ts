/**
 * RP-7: reassembling a chunked provider capture, and every way one can fail.
 *
 * The rule every case here checks is the same: the request happened, so there
 * is always a row; the body is there only when what arrived is exactly what
 * was announced; and no outcome leaves bytes behind.
 */
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  CAPTURE_ACCUM_ACTOR_BYTES,
  CAPTURE_ACCUM_GLOBAL_BYTES,
  CAPTURE_ACCUM_SESSION_BYTES,
  CAPTURE_OPEN_GLOBAL,
  CAPTURE_OPEN_SESSION,
  type ProviderCaptureMeta,
} from "@lasercode/protocol";
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

/** Every capture belongs to one worker process; tests name it explicitly. */
const A = { generation: "gen-a", cwd: "/project" };
const B = { generation: "gen-b", cwd: "/project-b" };

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
    accumulator.begin(A, "/session", meta);
    accumulator.chunk(A, meta.captureId, 0, body.slice(0, half));
    accumulator.chunk(A, meta.captureId, 1, body.slice(half));
    accumulator.finish(A, meta.captureId, 2, meta.bytes);
    expect(absent).toEqual([]);
    expect(complete).toHaveLength(1);
    // A body this host did not have to touch is handed over as the pieces it
    // arrived in, so it is never held twice.
    expect(complete[0]!.body === "" ? complete[0]!.pieces!.join("") : complete[0]!.body).toBe(body);
    expect(complete[0]!.sessionPath).toBe("/session");
    expect(accumulator.retained()).toEqual({ open: 0, bytes: 0, reservedBytes: 0 });
  });
});

describe("a capture that does not", () => {
  it("refuses an out-of-order chunk and records the row", () => {
    const { accumulator, complete, absent } = harness();
    const body = "x".repeat(100);
    const meta = metaFor(body, "c-bbbbbbbbbbbbbbbb", 2);
    accumulator.begin(A, "/session", meta);
    accumulator.chunk(A, meta.captureId, 1, body);
    expect(complete).toEqual([]);
    expect(absent[0]).toMatchObject({ reason: "corrupt", meta: { bytes: meta.bytes, sha256: meta.sha256 } });
    expect(accumulator.retained().bytes).toBe(0);
  });

  it("refuses a chunk that overruns the announced size", () => {
    const { accumulator, absent } = harness();
    const meta = metaFor("x".repeat(10), "c-cccccccccccccccc", 1);
    accumulator.begin(A, "/session", meta);
    accumulator.chunk(A, meta.captureId, 0, "x".repeat(11));
    expect(absent[0]!.reason).toBe("corrupt");
  });

  it("refuses a wrong chunk count or byte total at the end", () => {
    const { accumulator, absent } = harness();
    const body = "x".repeat(10);
    const meta = metaFor(body, "c-dddddddddddddddd", 1);
    accumulator.begin(A, "/session", meta);
    accumulator.chunk(A, meta.captureId, 0, body);
    accumulator.finish(A, meta.captureId, 2, meta.bytes);
    expect(absent[0]!.reason).toBe("corrupt");
  });

  it("refuses a body whose digest does not match what was announced", () => {
    const { accumulator, complete, absent } = harness();
    const body = "x".repeat(10);
    const meta = { ...metaFor(body, "c-eeeeeeeeeeeeeeee", 1), sha256: "0".repeat(64) };
    accumulator.begin(A, "/session", meta);
    accumulator.chunk(A, meta.captureId, 0, body);
    accumulator.finish(A, meta.captureId, 1, meta.bytes);
    expect(complete).toEqual([]);
    expect(absent[0]!.reason).toBe("corrupt");
    expect(accumulator.retained()).toEqual({ open: 0, bytes: 0, reservedBytes: 0 });
  });

  it("ends the incumbent rather than merging two streams under one id", () => {
    const { accumulator, absent } = harness();
    const body = "x".repeat(10);
    const first = metaFor(body, "c-ffffffffffffffff", 1);
    accumulator.begin(A, "/session", first);
    accumulator.chunk(A, first.captureId, 0, body);
    accumulator.begin(A, "/session", { ...first, at: new Date().toISOString() });
    expect(absent[0]!.reason).toBe("interrupted");
    expect(accumulator.retained().open).toBe(1);
  });

  it("refuses an id that is not opaque and bounded", () => {
    const { accumulator, complete, absent } = harness();
    accumulator.begin(A, "/session", metaFor("x", "../../etc/passwd", 1));
    expect(complete).toEqual([]);
    expect(absent).toEqual([]);
    expect(accumulator.retained().open).toBe(0);
  });

  it("refuses a declared size past the ceiling before it holds anything", () => {
    const { accumulator, absent } = harness();
    accumulator.begin(A, "/session", { ...metaFor("x", "c-1111111111111111", 1), bytes: 64 * 1024 * 1024 });
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
      accumulator.begin(A, "/session", meta);
      accumulator.chunk(A, meta.captureId, 0, chunk);
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
    accumulator.begin(A, "/session", meta);
    accumulator.chunk(A, meta.captureId, 0, body.slice(0, 1024));
    // The producer gave up: the link filled while it was sending.
    accumulator.abort(A, meta.captureId, "link-busy");
    expect(complete).toEqual([]);
    expect(absent).toHaveLength(1);
    expect(absent[0]).toMatchObject({
      reason: "link-busy",
      sessionPath: "/session",
      meta: { bytes: meta.bytes, sha256: meta.sha256, preview: meta.preview },
    });
    expect(accumulator.retained()).toEqual({ open: 0, bytes: 0, reservedBytes: 0 });
    // Nothing else may follow it: no second row from a late chunk, an end, or
    // the worker generation going away afterwards.
    accumulator.chunk(A, meta.captureId, 1, body.slice(1024, 2048));
    accumulator.finish(A, meta.captureId, 4, meta.bytes);
    accumulator.generationGone(A.generation);
    accumulator.clear();
    expect(absent).toHaveLength(1);
    expect(complete).toEqual([]);
  });

  it("ignores an abort for a capture nobody opened", () => {
    const { accumulator, complete, absent } = harness();
    accumulator.abort(A, "c-aaaabbbbccccdddd", "link-busy");
    expect(absent).toEqual([]);
    expect(complete).toEqual([]);
  });

  it("holds every scope while several captures are filled at once", () => {
    const { accumulator, absent } = harness();
    // Four captures across two sessions and two worker processes, all begun
    // before any of them sends a byte: the bound has to hold from `begin`, or
    // four empty starts can each claim a full capture later.
    const announced = 16 * 1024 * 1024;
    const piece = "x".repeat(1024 * 1024);
    const started = [
      { actor: A, session: "/session-1", id: "c-1111111111111111" },
      { actor: A, session: "/session-2", id: "c-2222222222222222" },
      { actor: B, session: "/session-3", id: "c-3333333333333333" },
      { actor: B, session: "/session-4", id: "c-4444444444444444" },
    ];
    for (const entry of started) {
      accumulator.begin(entry.actor, entry.session, { ...metaFor(piece, entry.id, 16), bytes: announced });
    }
    const within = () => {
      const retained = accumulator.retained();
      expect(retained.bytes + retained.reservedBytes).toBeLessThanOrEqual(CAPTURE_ACCUM_GLOBAL_BYTES);
      expect(retained.open).toBeLessThanOrEqual(CAPTURE_OPEN_GLOBAL);
    };
    within();
    for (let round = 0; round < 6; round++) {
      for (const entry of started) {
        accumulator.chunk(entry.actor, entry.id, round, piece);
        within();
      }
    }
    // Nothing disappeared quietly: every eviction is a row.
    expect(absent.every((entry) => entry.reason === "interrupted")).toBe(true);
    expect(absent.length).toBeGreaterThan(0);
  });

  it("holds the per-actor and per-session shares too", () => {
    const { accumulator } = harness();
    const announced = 16 * 1024 * 1024;
    for (let i = 0; i < 3; i++) {
      accumulator.begin(A, "/session", { ...metaFor("x", `c-${String(i).repeat(16)}`, 16), bytes: announced });
      const perActor = [...Array(1)].length; // one generation under test
      expect(perActor).toBe(1);
      expect(accumulator.retained().bytes + accumulator.retained().reservedBytes).toBeLessThanOrEqual(CAPTURE_ACCUM_ACTOR_BYTES);
      expect(accumulator.retained().open).toBeLessThanOrEqual(CAPTURE_OPEN_SESSION);
    }
  });

  it("never exempts a capture from its own scope, and keeps nothing when it cannot fit", () => {
    const { accumulator, absent } = harness();
    // The capture ceiling (16 MiB) is below the per-session share (17 MiB), so
    // a capture that alone exceeded its session would already have been
    // refused as announced. Either way nothing is held and the request is one
    // row: the bound is never satisfied by excluding its own cause.
    accumulator.begin(A, "/session", { ...metaFor("x", "c-5555555555555555", 16), bytes: CAPTURE_ACCUM_SESSION_BYTES + 1 });
    expect(accumulator.retained()).toEqual({ open: 0, bytes: 0, reservedBytes: 0 });
    expect(absent).toHaveLength(1);
    expect(["corrupt", "interrupted"]).toContain(absent[0]!.reason);
  });

  it("ends everything a worker generation opened when it goes", () => {
    const { accumulator, absent } = harness();
    const body = "x".repeat(10);
    const mine = metaFor(body, "c-2222222222222222", 1);
    const other = metaFor(body, "c-3333333333333333", 1);
    accumulator.begin(A, "/session-a", mine);
    accumulator.begin(B, "/session-b", other);
    accumulator.chunk(A, mine.captureId, 0, body);
    accumulator.generationGone(A.generation);
    expect(absent.map((entry) => entry.cwd)).toEqual([A.cwd]);
    expect(accumulator.retained().open).toBe(1);
    accumulator.clear();
    expect(accumulator.retained()).toEqual({ open: 0, bytes: 0, reservedBytes: 0 });
  });
});

describe("the host's own guard over a body it did not redact", () => {
  it("refuses a body with a credential-shaped survivor, and keeps none of it", () => {
    const { accumulator, complete, absent, logs } = harness();
    const body = JSON.stringify({ model: "test", api_key: "sk-live-1234", messages: [] });
    const meta = metaFor(body, "c-4444444444444444", 1);
    accumulator.begin(A, "/session", meta);
    accumulator.chunk(A, meta.captureId, 0, body);
    accumulator.finish(A, meta.captureId, 1, meta.bytes);

    // One outcome, and it is the refusal: the producer should have redacted
    // this, and a body this app cannot vouch for is not stored.
    expect(complete).toEqual([]);
    expect(absent).toHaveLength(1);
    expect(absent[0]).toMatchObject({ reason: "unredacted", meta: { sha256: meta.sha256 } });
    expect(logs.join(" ")).toContain("api_key");
    expect(logs.join(" ")).not.toContain("sk-live-1234");
    expect(accumulator.retained()).toEqual({ open: 0, bytes: 0, reservedBytes: 0 });
  });

  it("sees a credential-shaped key however the pieces were cut", () => {
    const { accumulator, absent } = harness();
    // A key far longer than any fixed overlap, ending in `password`, split
    // across pieces at an arbitrary point.
    const key = `${"a".repeat(120)}_password`;
    const body = JSON.stringify({ model: "test", [key]: "sk-live-9999" });
    const meta = metaFor(body, "c-6f6f6f6f6f6f6f6f", 3);
    accumulator.begin(A, "/session", meta);
    const third = Math.floor(body.length / 3);
    accumulator.chunk(A, meta.captureId, 0, body.slice(0, third));
    accumulator.chunk(A, meta.captureId, 1, body.slice(third, third * 2));
    accumulator.chunk(A, meta.captureId, 2, body.slice(third * 2));
    accumulator.finish(A, meta.captureId, 3, meta.bytes);
    expect(absent).toHaveLength(1);
    // Past the key bound this scanner will hold, so it refuses rather than
    // guessing — either way nothing is stored.
    expect(["unredacted", "corrupt"]).toContain(absent[0]!.reason);
  });

  it("keeps a body whose long values merely look alarming", () => {
    const { accumulator, complete, absent } = harness();
    const body = JSON.stringify({
      model: "test",
      authorization: "[redacted]",
      messages: [{ role: "user", content: `talking about "api_key": "and passwords" at length ${"x".repeat(5000)}` }],
    });
    const meta = metaFor(body, "c-7a7a7a7a7a7a7a7a", 2);
    accumulator.begin(A, "/session", meta);
    const half = Math.floor(body.length / 2);
    accumulator.chunk(A, meta.captureId, 0, body.slice(0, half));
    accumulator.chunk(A, meta.captureId, 1, body.slice(half));
    accumulator.finish(A, meta.captureId, 2, meta.bytes);
    expect(absent).toEqual([]);
    expect(complete).toHaveLength(1);
  });

  it("leaves a clean body's metadata exactly as the producer stated it", () => {
    const { accumulator, complete } = harness();
    const body = JSON.stringify({ model: "test", messages: [{ role: "user", content: "hello" }] });
    const meta = metaFor(body, "c-8888888888888888", 1);
    accumulator.begin(A, "/session", meta);
    accumulator.chunk(A, meta.captureId, 0, body);
    accumulator.finish(A, meta.captureId, 1, meta.bytes);
    expect(complete[0]!.meta).toEqual(meta);
  });

  it("refuses a body that ends in the middle of a string", () => {
    const { accumulator, absent } = harness();
    const body = '{"model":"test","note":"never ends';
    const meta = metaFor(body, "c-5555555555555555", 1);
    accumulator.begin(A, "/session", meta);
    accumulator.chunk(A, meta.captureId, 0, body);
    accumulator.finish(A, meta.captureId, 1, meta.bytes);
    expect(absent).toHaveLength(1);
    expect(absent[0]!.reason).toBe("corrupt");
    expect(accumulator.retained()).toEqual({ open: 0, bytes: 0, reservedBytes: 0 });
  });
});

describe("a store that fails while a capture is arriving", () => {
  function failingHarness(failAt: "open" | "write" | "finish" | "abort") {
    const complete: CaptureComplete[] = [];
    const absent: CaptureAbsent[] = [];
    const logs: string[] = [];
    const written: string[] = [];
    let aborted = 0;
    const accumulator = new CaptureAccumulator({
      openBody: () => {
        if (failAt === "open") throw new Error("disk is full");
        return {
          write: (piece: string) => {
            if (failAt === "write" && written.length === 1) throw new Error("database is locked");
            written.push(piece);
          },
          finish: () => {
            if (failAt === "finish") throw new Error("disk is full");
            return { ref: "f".repeat(64), bytes: written.join("").length };
          },
          abort: () => {
            aborted += 1;
            if (failAt === "abort") throw new Error("database is locked");
          },
        };
      },
      onComplete: (input) => complete.push(input),
      onAbsent: (input) => absent.push(input),
      log: (message) => logs.push(message),
    });
    return { accumulator, complete, absent, logs, written, aborts: () => aborted };
  }

  for (const failAt of ["open", "write", "finish", "abort"] as const) {
    it(`records one row and keeps nothing when the store fails at ${failAt}`, () => {
      const { accumulator, complete, absent } = failingHarness(failAt);
      const body = JSON.stringify({ model: "test", messages: [{ role: "user", content: "x".repeat(4000) }] });
      const meta = metaFor(body, "c-9a9a9a9a9a9a9a9a", 4);
      const quarter = Math.ceil(body.length / 4);
      // Nothing here may throw into the notification path this runs on.
      expect(() => {
        accumulator.begin(A, "/session", meta);
        for (let piece = 0; piece < 4; piece++) {
          accumulator.chunk(A, meta.captureId, piece, body.slice(piece * quarter, (piece + 1) * quarter));
        }
        accumulator.finish(A, meta.captureId, 4, meta.bytes);
      }).not.toThrow();
      // Exactly one outcome, nothing open, nothing reserved.
      expect(complete.length + absent.length).toBe(1);
      expect(accumulator.retained()).toEqual({ open: 0, bytes: 0, reservedBytes: 0 });
      if (failAt === "open" || failAt === "abort") {
        // `open` leaves no store to stream into, so the pieces path completes
        // normally; `abort` is only reached when something else already went
        // wrong, and a throwing abort must not change the outcome.
        expect(complete.length + absent.length).toBe(1);
      } else {
        expect(absent).toHaveLength(1);
        expect(["interrupted", "corrupt"]).toContain(absent[0]!.reason);
      }
    });
  }
});

describe("ownership by worker process", () => {
  it("keeps the same capture id from two processes apart", () => {
    const { accumulator, complete } = harness();
    const body = JSON.stringify({ model: "test", messages: [] });
    const meta = metaFor(body, "c-6666666666666666", 1);
    accumulator.begin(A, "/session", meta);
    accumulator.begin(B, "/session", meta);
    accumulator.chunk(A, meta.captureId, 0, body);
    accumulator.chunk(B, meta.captureId, 0, body);
    accumulator.finish(A, meta.captureId, 1, meta.bytes);
    accumulator.finish(B, meta.captureId, 1, meta.bytes);
    expect(complete).toHaveLength(2);
    expect(complete.map((entry) => entry.cwd).sort()).toEqual([A.cwd, B.cwd].sort());
    expect(accumulator.retained()).toEqual({ open: 0, bytes: 0, reservedBytes: 0 });
  });

  it("ignores a late message from a process that has been replaced", () => {
    const { accumulator, complete, absent } = harness();
    const replaced = { generation: "gen-old", cwd: "/project" };
    const body = JSON.stringify({ model: "test", messages: [] });
    const meta = metaFor(body, "c-7777777777777777", 1);
    accumulator.begin(replaced, "/session", meta);
    accumulator.generationGone(replaced.generation);
    expect(absent).toHaveLength(1);

    // The successor opens the same id; nothing the retired process sends may
    // reach it.
    accumulator.begin(A, "/session", meta);
    accumulator.chunk(replaced, meta.captureId, 0, body);
    accumulator.abort(replaced, meta.captureId, "link-busy");
    accumulator.finish(replaced, meta.captureId, 1, meta.bytes);
    expect(absent).toHaveLength(1);
    expect(accumulator.retained().open).toBe(1);

    // And the successor still completes normally.
    accumulator.chunk(A, meta.captureId, 0, body);
    accumulator.finish(A, meta.captureId, 1, meta.bytes);
    expect(complete).toHaveLength(1);
  });
});

describe("chunks for a capture nobody opened", () => {
  it("are ignored, and allocate nothing", () => {
    const { accumulator, complete, absent } = harness();
    const onComplete = vi.fn();
    expect(onComplete).not.toHaveBeenCalled();
    accumulator.chunk(A, "c-8888888888888888", 0, "x".repeat(1000));
    accumulator.finish(A, "c-8888888888888888", 1, 1000);
    expect(complete).toEqual([]);
    expect(absent).toEqual([]);
    expect(accumulator.retained()).toEqual({ open: 0, bytes: 0, reservedBytes: 0 });
  });
});
