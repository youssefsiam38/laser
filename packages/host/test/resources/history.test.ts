import { describe, expect, it } from "vitest";
import { resourceAvailable, resourceUnavailable, type ResourceProcess, type ResourceSnapshot } from "@lasercode/protocol";
import { ResourceHistory } from "../../src/resources/history.js";

function row(pid: number, padding = 0): ResourceProcess {
  return {
    key: `${pid}@linux:boot:${pid}`,
    pid,
    startToken: `linux:boot:${pid}`,
    role: "unknown_descendant",
    label: padding > 0 ? "x".repeat(padding) : "node",
    memory: {
      pss: resourceAvailable(1024),
      resident: resourceAvailable(2048),
      peakResident: resourceAvailable(4096),
      privateResident: resourceAvailable(512),
      commit: resourceUnavailable("unsupported_platform"),
    },
    cpu: { seconds: resourceAvailable(1) },
    elapsedMs: resourceAvailable(1000),
    io: { readBytes: resourceAvailable(0), writeBytes: resourceAvailable(0) },
    source: "proc",
  };
}

function snapshot(id: string, rows: number, padding = 0): ResourceSnapshot {
  return {
    id,
    at: "2026-01-01T00:00:00.000Z",
    platform: "linux",
    durationMs: 1,
    processes: Array.from({ length: rows }, (_, index) => row(index + 1, padding)),
    totals: {
      coverage: { processes: rows, measured: rows, complete: true },
      knownPhysicalBytes: rows * 1024,
      physical: resourceAvailable(rows * 1024),
      residentCoverage: { processes: rows, measured: rows, complete: true },
      knownResidentBytes: rows * 2048,
      residentSum: resourceAvailable(rows * 2048),
    },
    byRole: [],
    health: { ok: true, collectors: [], truncated: false, crossCheck: { status: "unavailable" } },
  };
}

describe("retained history", () => {
  it("drops snapshots older than the age bound, on its own", () => {
    let now = 1_000_000;
    const history = new ResourceHistory({ now: () => now, maxAgeMs: 10_000, maxSnapshots: 100, maxProcessRows: 10_000, maxBytes: 10 ** 9 });
    history.add(snapshot("rs_1", 1));
    now += 5_000;
    history.add(snapshot("rs_2", 1));
    now += 6_000; // rs_1 is now 11s old, rs_2 is 6s old
    expect(history.page().map((entry) => entry.id)).toEqual(["rs_2"]);
    expect(history.retention().lastEvictedBy).toBe("age");
  });

  it("drops the oldest when the snapshot count bound is hit, with room in every other bound", () => {
    const history = new ResourceHistory({ maxSnapshots: 2, maxAgeMs: 10 ** 9, maxProcessRows: 10 ** 6, maxBytes: 10 ** 9 });
    history.add(snapshot("rs_1", 1));
    history.add(snapshot("rs_2", 1));
    history.add(snapshot("rs_3", 1));
    expect(history.page().map((entry) => entry.id)).toEqual(["rs_2", "rs_3"]);
    const retention = history.retention();
    expect(retention.lastEvictedBy).toBe("snapshots");
    expect(retention.snapshots).toBe(2);
  });

  it("drops on the process-row bound even when few snapshots are retained", () => {
    const history = new ResourceHistory({ maxProcessRows: 10, maxSnapshots: 1000, maxAgeMs: 10 ** 9, maxBytes: 10 ** 9 });
    history.add(snapshot("rs_1", 6));
    history.add(snapshot("rs_2", 6));
    expect(history.page().map((entry) => entry.id)).toEqual(["rs_2"]);
    expect(history.retention().lastEvictedBy).toBe("rows");
    expect(history.retention().processRows).toBe(6);
  });

  it("drops on the byte bound even when rows and snapshots are well inside theirs", () => {
    // Size the bound from a real snapshot, so this asserts the byte rule and
    // not a guess about how many bytes a row happens to serialize to.
    const measure = new ResourceHistory();
    measure.add(snapshot("rs_0", 2, 60));
    const oneSnapshot = measure.retention().bytes;
    const maxBytes = Math.floor(oneSnapshot * 2.5);
    const history = new ResourceHistory({ maxBytes, maxProcessRows: 10 ** 6, maxSnapshots: 1000, maxAgeMs: 10 ** 9 });
    history.add(snapshot("rs_1", 2, 60));
    history.add(snapshot("rs_2", 2, 60));
    history.add(snapshot("rs_3", 2, 60));
    const retention = history.retention();
    expect(retention.bytes).toBeLessThanOrEqual(maxBytes);
    expect(retention.lastEvictedBy).toBe("bytes");
    expect(history.page().at(-1)!.id).toBe("rs_3");
  });

  it("reports every limit, so retention can be explained rather than felt", () => {
    const history = new ResourceHistory();
    history.add(snapshot("rs_1", 3));
    const retention = history.retention();
    expect(retention).toMatchObject({ maxAgeMs: 3_600_000, maxSnapshots: 3600, maxProcessRows: 20_000, maxBytes: 67_108_864, snapshots: 1, processRows: 3 });
    expect(retention.bytes).toBeGreaterThan(0);
    expect(retention.lastEvictedBy).toBeUndefined();
  });

  it("pages forward without skipping the middle of the history", () => {
    const history = new ResourceHistory();
    for (let index = 1; index <= 5; index += 1) history.add(snapshot(`rs_${index}`, 1));
    expect(history.page({ sinceId: "rs_3" }).map((entry) => entry.id)).toEqual(["rs_4", "rs_5"]);
    // A bounded page starts where the caller is, not at the end: walking the
    // history two at a time must visit every sample exactly once.
    const walked: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = history.page({ limit: 2, ...(cursor ? { sinceId: cursor } : {}) });
      if (page.length === 0) break;
      walked.push(...page.map((entry) => entry.id));
      cursor = page.at(-1)!.id;
    }
    expect(walked).toEqual(["rs_1", "rs_2", "rs_3", "rs_4", "rs_5"]);
    expect(history.page({ sinceId: "nope" })).toHaveLength(5);
  });
});
