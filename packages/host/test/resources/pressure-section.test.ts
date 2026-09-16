/**
 * Where memory pressure appears in the diagnostics, and where it must not (RP-8).
 *
 * A snapshot carries the fixed-size summary, so a bounded history retains N
 * summaries rather than N copies of one growing event list. A diagnostic
 * document carries the summary plus exactly one page of the one journal — and
 * the document's byte bound is still checked on the bytes that actually leave
 * this host, with the page trimmed oldest event first when it has to be.
 */
import { describe, expect, it } from "vitest";
import {
  MEMORY_PRESSURE_EVENTS_MAX,
  MEMORY_PRESSURE_EVENTS_MAX_BYTES,
  MEMORY_PRESSURE_EVENTS_PAGE,
  MEMORY_PRESSURE_EVENT_MAX_AGE_MS,
  RESOURCE_EXPORT_MAX_BYTES,
  parseMemoryPressureJournalPage,
  parseMemoryPressureSummary,
  resourceAvailable,
  resourceUnavailable,
  type MemoryPressureExportSection,
} from "@lasercode/protocol";
import { ResourceService } from "../../src/resources/service.js";
import { PressureJournal } from "../../src/pressure/index.js";
import type { ProcessCollector, ProcessRowMetrics, ProcessTableRow } from "../../src/resources/platform.js";

const NOW = 2_000_000_000_000;

function collector(count: number): ProcessCollector {
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

const summary = parseMemoryPressureSummary({
  level: "warning",
  roles: [
    {
      role: "host",
      level: "warning",
      sampleAgeMs: 10,
      inputs: [{ kind: "physical", value: { status: "available", value: 600 * 1024 * 1024 }, warningBytes: 512 * 1024 * 1024, criticalBytes: 768 * 1024 * 1024 }],
      coverage: { expected: 1, answered: 1, complete: true },
    },
    { role: "project_worker", level: "normal", inputs: [], coverage: { expected: 0, answered: 0, complete: true } },
    { role: "desktop_renderer", level: "normal", inputs: [], coverage: { expected: 0, answered: 0, complete: true } },
    { role: "machine", level: "normal", inputs: [{ kind: "machine_available", value: { status: "available", value: 8_000_000_000 }, warningBytes: 2_048 * 1024 * 1024, criticalBytes: 1_024 * 1024 * 1024 }], coverage: { expected: 1, answered: 1, complete: true } },
  ],
  refusing: [],
  totals: { events: 0, released: { count: 0, bytes: 0 }, refusals: 0 },
});

/** A journal holding `count` real events, as the controller would have filled it. */
function filledJournal(count: number): PressureJournal {
  let at = NOW - 60_000;
  const journal = new PressureJournal({ now: () => (at += 1) });
  for (let index = 0; index < count; index += 1) {
    journal.add({ action: "ephemeral_caches", outcome: "released", released: { count: 1 } }, {
      role: "project_worker",
      level: "warning",
      project: "0123456789abcdef",
    });
  }
  return journal;
}

function sectionOf(journal: PressureJournal): MemoryPressureExportSection {
  return { summary, journal: journal.page() };
}

describe("a snapshot and its history", () => {
  it("carry the summary, and never the journal", async () => {
    const journal = filledJournal(20);
    const resources = new ResourceService({
      collector: collector(2),
      platform: "linux",
      hostPid: 200,
      minIntervalMs: 0,
      now: () => NOW,
      pressure: () => sectionOf(journal),
    });
    const first = await resources.snapshot();
    expect(first.snapshot.pressure).toEqual(summary);
    expect(JSON.stringify(first.snapshot)).not.toContain("mp_1");

    const history = resources.historyPage();
    expect(history.snapshots.length).toBeGreaterThan(0);
    for (const snapshot of history.snapshots) {
      expect(snapshot.pressure).toBeDefined();
      expect(JSON.stringify(snapshot)).not.toContain("retention");
    }
  });

  it("leave the section out when the controller cannot describe itself", async () => {
    const resources = new ResourceService({
      collector: collector(1),
      platform: "linux",
      hostPid: 200,
      minIntervalMs: 0,
      now: () => NOW,
      pressure: () => {
        throw new Error("no controller");
      },
    });
    const taken = await resources.snapshot();
    expect(taken.snapshot.pressure).toBeUndefined();
    const exported = resources.export();
    expect(JSON.parse(exported.document)).not.toHaveProperty("pressure");
  });
});

describe("the diagnostic document", () => {
  it("carries the summary and exactly one bounded page", async () => {
    const journal = filledJournal(120);
    const resources = new ResourceService({
      collector: collector(2),
      platform: "linux",
      hostPid: 200,
      minIntervalMs: 0,
      now: () => NOW,
      pressure: () => sectionOf(journal),
    });
    for (let index = 0; index < 3; index += 1) await resources.snapshot();

    const exported = resources.export();
    const parsed = JSON.parse(exported.document) as {
      pressure: { summary: unknown; journal: { events: Array<{ id: string }>; retention: { events: number; maxEvents: number; maxAgeMs: number; maxBytes: number } } };
      snapshots: Array<{ pressure?: unknown }>;
    };
    expect(parsed.pressure.journal.events).toHaveLength(MEMORY_PRESSURE_EVENTS_PAGE);
    expect(parsed.pressure.journal.retention).toMatchObject({
      events: 120,
      maxEvents: MEMORY_PRESSURE_EVENTS_MAX,
      maxAgeMs: MEMORY_PRESSURE_EVENT_MAX_AGE_MS,
      maxBytes: MEMORY_PRESSURE_EVENTS_MAX_BYTES,
    });
    // One journal, once: the retained snapshots beside it carry summaries only.
    expect(exported.document.split('"retention"').length - 1).toBe(2); // the history's own, and the journal's
    for (const snapshot of parsed.snapshots) expect(snapshot.pressure).toEqual(summary);
    expect(exported.bytes).toBeLessThanOrEqual(RESOURCE_EXPORT_MAX_BYTES);
  });

  it("never carries a path, a pid, a directory or a private generation in its pressure section", async () => {
    const journal = filledJournal(10);
    const resources = new ResourceService({
      collector: collector(2),
      platform: "linux",
      hostPid: 200,
      minIntervalMs: 0,
      now: () => NOW,
      pressure: () => sectionOf(journal),
    });
    await resources.snapshot();
    const section = JSON.stringify((JSON.parse(resources.export().document) as { pressure: unknown }).pressure);
    for (const forbidden of [/\/home\//, /[A-Za-z]:\\\\/, /"pid"/, /"cwd"/, /"path"/, /"generation"/, /"startToken"/]) {
      expect(section).not.toMatch(forbidden);
    }
    // The only identifier a row may carry is the opaque salted project id.
    expect(section).toContain("0123456789abcdef");
  });

  it("trims the page oldest event first, and keeps the summary with a valid empty page", async () => {
    const journal = filledJournal(MEMORY_PRESSURE_EVENTS_MAX);
    const resources = new ResourceService({
      collector: collector(2),
      platform: "linux",
      hostPid: 200,
      minIntervalMs: 0,
      now: () => NOW,
      pressure: () => sectionOf(journal),
    });
    await resources.snapshot();

    const full = sectionOf(journal);
    const newest = full.journal.events[0]!.id;
    const eventBytes = Math.ceil(Buffer.byteLength(JSON.stringify(full.journal.events), "utf8") / full.journal.events.length);

    // A budget a handful of events short of what the whole document needs, so
    // the page is trimmed and the snapshots are not.
    const whole = resources.export().bytes;
    const partial = exportWithBudget(resources, whole - 5 * eventBytes);
    const partialSection = (JSON.parse(partial.document) as { pressure: MemoryPressureExportSection }).pressure;
    expect(partialSection.journal.events.length).toBeGreaterThan(0);
    expect(partialSection.journal.events.length).toBeLessThan(MEMORY_PRESSURE_EVENTS_PAGE);
    // What went is the oldest: the newest event is still the page's first row.
    expect(partialSection.journal.events[0]!.id).toBe(newest);
    // And the retention beside it still describes the whole journal.
    expect(partialSection.journal.retention.events).toBe(MEMORY_PRESSURE_EVENTS_MAX);
    expect(() => parseMemoryPressureJournalPage(partialSection.journal)).not.toThrow();
    expect(partial.truncated).toBe(true);

    // A budget so small that nothing but the summary can survive: the document
    // is still inside it, still valid, and still says what it is.
    const tiny = exportWithBudget(resources, 2 * 1024);
    const tinyParsed = JSON.parse(tiny.document) as { pressure: MemoryPressureExportSection; truncated: boolean };
    expect(tinyParsed.pressure.summary).toEqual(summary);
    expect(tinyParsed.pressure.journal.events).toHaveLength(0);
    expect(tinyParsed.pressure.journal.retention.events).toBe(MEMORY_PRESSURE_EVENTS_MAX);
    expect(() => parseMemoryPressureJournalPage(tinyParsed.pressure.journal)).not.toThrow();
    expect(tiny.truncated).toBe(true);
  });

  it("is never returned over its bound", async () => {
    const journal = filledJournal(MEMORY_PRESSURE_EVENTS_MAX);
    const resources = new ResourceService({
      collector: collector(200),
      platform: "linux",
      hostPid: 200,
      minIntervalMs: 0,
      now: () => NOW,
      pressure: () => sectionOf(journal),
    });
    for (let index = 0; index < 6; index += 1) await resources.snapshot();
    for (const budget of [256 * 1024, 64 * 1024, 16 * 1024, 4 * 1024]) {
      const exported = exportWithBudget(resources, budget);
      expect(exported.bytes).toBeLessThanOrEqual(budget);
      expect(() => JSON.parse(exported.document)).not.toThrow();
    }
  });

  it("gives up the page, then the snapshots, then the section itself, in that order", async () => {
    const journal = filledJournal(MEMORY_PRESSURE_EVENTS_MAX);
    const resources = new ResourceService({
      collector: collector(200),
      platform: "linux",
      hostPid: 200,
      minIntervalMs: 0,
      now: () => NOW,
      pressure: () => sectionOf(journal),
    });
    for (let index = 0; index < 6; index += 1) await resources.snapshot();

    // Small enough that the page has to go, large enough for the summary.
    const kept = exportWithBudget(resources, 4 * 1024);
    const keptParsed = JSON.parse(kept.document) as { snapshots: unknown[]; pressure: MemoryPressureExportSection; truncated: boolean };
    expect(keptParsed.pressure.summary).toEqual(summary);
    expect(keptParsed.pressure.journal.events).toHaveLength(0);
    expect(keptParsed.truncated).toBe(true);
    expect(kept.bytes).toBeLessThanOrEqual(4 * 1024);

    // Smaller than the summary itself: the section goes too, rather than a
    // document over its bound leaving this host.
    const floor = exportWithBudget(resources, 900);
    const floorParsed = JSON.parse(floor.document) as { truncated: boolean; snapshots: unknown[]; pressure?: unknown };
    expect(floorParsed.pressure).toBeUndefined();
    expect(floorParsed.snapshots).toEqual([]);
    expect(floorParsed.truncated).toBe(true);
    expect(floor.bytes).toBeLessThanOrEqual(900);

    // And when even the wrapper does not fit, what comes back is the smallest
    // document this host can describe, still valid and still honest.
    const smallest = exportWithBudget(resources, 64);
    const smallestParsed = JSON.parse(smallest.document) as Record<string, unknown>;
    expect(Object.keys(smallestParsed).sort()).toEqual(["at", "platform", "snapshots", "truncated"]);
    expect(smallestParsed.truncated).toBe(true);
  });

  it("refuses a section the contract would not accept, whatever its size", async () => {
    // The reviewer's case: a callback that hands over something branded but not
    // true — here an oversized summary — produced a 4,195,743-byte document
    // against a 4,194,304-byte maximum. The section is re-validated at the
    // boundary now, so it is left out instead.
    const oversized = {
      ...summary,
      roles: summary.roles.map((row) => ({ ...row, padding: "PADDING".repeat(150_000) })),
    } as unknown as MemoryPressureExportSection["summary"];
    const journal = filledJournal(4);
    const resources = new ResourceService({
      collector: collector(2),
      platform: "linux",
      hostPid: 200,
      minIntervalMs: 0,
      now: () => NOW,
      pressure: () => ({ summary: oversized, journal: journal.page() }),
    });
    await resources.snapshot();
    const exported = resources.export();
    expect(exported.bytes).toBeLessThanOrEqual(RESOURCE_EXPORT_MAX_BYTES);
    expect(exported.document).not.toContain("PADDING");
    expect(JSON.parse(exported.document)).not.toHaveProperty("pressure");
    // A snapshot taken while the callback is lying carries no section either.
    const taken = await resources.snapshot();
    expect(taken.snapshot.pressure).toBeUndefined();
  });

  it("carries only the fields the contract knows, never a caller's extras", async () => {
    const journal = filledJournal(3);
    const resources = new ResourceService({
      collector: collector(2),
      platform: "linux",
      hostPid: 200,
      minIntervalMs: 0,
      now: () => NOW,
      pressure: () => ({ ...sectionOf(journal), smuggled: "/home/someone/project" }) as MemoryPressureExportSection,
    });
    await resources.snapshot();
    const exported = resources.export();
    expect(exported.document).not.toContain("smuggled");
    expect(exported.document).not.toContain("/home/someone/project");
    const parsed = JSON.parse(exported.document) as { pressure: MemoryPressureExportSection };
    expect(parsed.pressure.journal.events).toHaveLength(3);
  });
});

/**
 * Run the real export against a smaller budget, by scaling what the measurement
 * reports rather than the product's constant: the code under test is untouched.
 */
function exportWithBudget(resources: ResourceService, budget: number): { document: string; bytes: number; truncated: boolean } {
  const original = Buffer.byteLength;
  const scale = RESOURCE_EXPORT_MAX_BYTES / budget;
  (Buffer as unknown as { byteLength: typeof Buffer.byteLength }).byteLength = ((value: string, encoding?: BufferEncoding) =>
    Math.ceil(original(value, encoding) * scale)) as typeof Buffer.byteLength;
  try {
    const exported = resources.export();
    return { ...exported, bytes: original(exported.document, "utf8") };
  } finally {
    (Buffer as unknown as { byteLength: typeof Buffer.byteLength }).byteLength = original;
  }
}
