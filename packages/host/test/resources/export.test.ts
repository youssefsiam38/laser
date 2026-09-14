/**
 * The diagnostic export is bounded absolutely.
 *
 * A person hands this file to somebody, or attaches it to a report. "Usually
 * small enough" is not a bound: one snapshot of a very wide machine has to fit
 * too, and what comes out has to still be the document it says it is — valid
 * JSON that admits what was left out.
 */
import { describe, expect, it } from "vitest";
import { RESOURCE_EXPORT_MAX_BYTES, resourceAvailable, resourceUnavailable } from "@lasercode/protocol";
import { ResourceService } from "../../src/resources/service.js";
import type { ProcessCollector, ProcessRowMetrics, ProcessTableRow } from "../../src/resources/platform.js";

const NOW = 2_000_000_000_000;

/** One host plus `count` children, each with a long (but bounded) label. */
function wideCollector(count: number): ProcessCollector {
  const rows: ProcessTableRow[] = [{ pid: 200, ppid: 1, startToken: "linux:boot:200", startedAtMs: NOW - 1000, label: "node" }];
  for (let index = 0; index < count; index += 1) {
    rows.push({ pid: 1000 + index, ppid: 200, startToken: `linux:boot:${1000 + index}`, startedAtMs: NOW - 1000, label: "x".repeat(64) });
  }
  return {
    name: "fake",
    source: "proc",
    table: async () => rows,
    measure: async (): Promise<ProcessRowMetrics> => ({
      memory: {
        pss: resourceAvailable(1024),
        resident: resourceAvailable(2048),
        peakResident: resourceAvailable(4096),
        privateResident: resourceUnavailable("unsupported_platform"),
        commit: resourceUnavailable("unsupported_platform"),
      },
      cpu: { seconds: resourceAvailable(1) },
      elapsedMs: resourceAvailable(1000),
      io: { readBytes: resourceAvailable(0), writeBytes: resourceAvailable(0) },
    }),
  };
}

describe("the diagnostic export", () => {
  it("stays inside its byte bound even when a single snapshot is larger than the budget", async () => {
    const resources = new ResourceService({ collector: wideCollector(511), platform: "linux", hostPid: 200, minIntervalMs: 0, now: () => NOW });
    await resources.snapshot();
    const rows = (await resources.snapshot()).snapshot.processes.length;
    expect(rows).toBeGreaterThan(500);

    // A budget smaller than one snapshot, to exercise the last resort without
    // building a 64 MiB fixture.
    const exported = exportWithBudget(resources, 8 * 1024);
    expect(exported.truncated).toBe(true);
    const parsed = JSON.parse(exported.document) as { snapshots: Array<{ processes: unknown[]; totals: unknown }> };
    expect(parsed.snapshots).toHaveLength(1);
    expect(parsed.snapshots[0]!.processes.length).toBeLessThan(rows);
    // The totals are the snapshot's own, so the document still adds up to
    // something true about the machine even when rows were left out.
    expect(parsed.snapshots[0]!.totals).toBeDefined();
  });

  it("keeps the newest snapshots when the whole history does not fit", async () => {
    const resources = new ResourceService({ collector: wideCollector(60), platform: "linux", hostPid: 200, minIntervalMs: 0, now: () => NOW });
    for (let index = 0; index < 5; index += 1) await resources.snapshot();
    const exported = exportWithBudget(resources, 64 * 1024);
    const parsed = JSON.parse(exported.document) as { snapshots: Array<{ id: string }> };
    expect(exported.truncated).toBe(true);
    expect(parsed.snapshots.at(-1)!.id).toBe("rs_5");
    expect(exported.bytes).toBeLessThanOrEqual(64 * 1024);
  });

  it("is within the real bound for an ordinary machine", async () => {
    const resources = new ResourceService({ collector: wideCollector(20), platform: "linux", hostPid: 200, minIntervalMs: 0, now: () => NOW });
    await resources.snapshot();
    const exported = resources.export();
    expect(exported.truncated).toBe(false);
    expect(exported.bytes).toBeLessThan(RESOURCE_EXPORT_MAX_BYTES);
    expect(() => JSON.parse(exported.document)).not.toThrow();
  });
});

/**
 * Run the real export against a smaller budget. The constant is the product's;
 * the behaviour under it is what this file is about, and a 64 MiB fixture
 * would prove the same thing far more slowly.
 */
function exportWithBudget(resources: ResourceService, budget: number): { document: string; bytes: number; truncated: boolean } {
  const globals = globalThis as { __resourceExportBudget?: number };
  const original = Buffer.byteLength;
  const scale = RESOURCE_EXPORT_MAX_BYTES / budget;
  globals.__resourceExportBudget = budget;
  // Scale the measured size instead of the constant: the code under test is
  // untouched, and the arithmetic it does is exercised exactly as shipped.
  (Buffer as unknown as { byteLength: typeof Buffer.byteLength }).byteLength = ((value: string, encoding?: BufferEncoding) =>
    Math.ceil(original(value, encoding) * scale)) as typeof Buffer.byteLength;
  try {
    const exported = resources.export();
    return { ...exported, bytes: original(exported.document, "utf8") };
  } finally {
    (Buffer as unknown as { byteLength: typeof Buffer.byteLength }).byteLength = original;
    delete globals.__resourceExportBudget;
  }
}
