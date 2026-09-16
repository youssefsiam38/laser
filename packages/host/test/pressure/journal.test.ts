/**
 * The one journal: what it records, what it drops, and what it never carries.
 *
 * Three independent bounds — age, count, bytes — and one canonical order. The
 * page that leaves this file is the protocol's own validated shape, so an
 * ordering or accounting mistake here is a parse failure rather than a subtly
 * wrong document somewhere downstream.
 */
import { describe, expect, it } from "vitest";
import {
  MEMORY_PRESSURE_EVENTS_MAX,
  MEMORY_PRESSURE_EVENTS_MAX_BYTES,
  MEMORY_PRESSURE_EVENTS_PAGE,
  MEMORY_PRESSURE_EVENT_MAX_AGE_MS,
  parseMemoryPressureJournalPage,
  type MemoryPressureActionResult,
} from "@lasercode/protocol";
import { PressureJournal } from "../../src/pressure/index.js";

const released = (count: number): MemoryPressureActionResult => ({
  action: "ephemeral_caches",
  outcome: "released",
  released: { count },
});
const quiet: MemoryPressureActionResult = { action: "replay_suffixes", outcome: "nothing_to_give" };
const held: MemoryPressureActionResult = { action: "task_records", outcome: "held", reason: "pins_held" };
const refusal: MemoryPressureActionResult = {
  action: "admission_refused",
  outcome: "refused",
  refusal: "whole_transcript",
};

function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return { now: () => at, advance: (ms) => (at += ms) };
}

describe("recording an event", () => {
  it("gives it the identity only the host can give it", () => {
    const time = clock();
    const journal = new PressureJournal({ now: time.now });
    const event = journal.add(released(2), { role: "project_worker", level: "warning", project: "0123456789abcdef" });
    expect(event).toMatchObject({
      id: "mp_1",
      atMs: 1_000,
      role: "project_worker",
      level: "warning",
      project: "0123456789abcdef",
      action: "ephemeral_caches",
      outcome: "released",
      released: { count: 2 },
    });
    // Nothing else: no path, no pid, no generation, no worker-chosen field.
    expect(Object.keys(event!).sort()).toEqual(["action", "atMs", "id", "level", "outcome", "project", "released", "role"]);
  });

  it("records evidence that nothing was there to give, too", () => {
    const journal = new PressureJournal();
    journal.add(quiet, { role: "project_worker", level: "warning" });
    journal.add(held, { role: "project_worker", level: "critical" });
    const page = journal.page();
    expect(page.events.map((row) => row.outcome)).toEqual(["held", "nothing_to_give"]);
    expect(page.retention.events).toBe(2);
  });

  it("numbers events from one, upwards, for the life of this process", () => {
    const journal = new PressureJournal();
    for (let index = 0; index < 5; index += 1) journal.add(quiet, { role: "host", level: "warning" });
    expect(journal.page().events.map((row) => row.id)).toEqual(["mp_5", "mp_4", "mp_3", "mp_2", "mp_1"]);
  });
});

describe("the three bounds", () => {
  it("drops by count at two hundred", () => {
    const journal = new PressureJournal();
    for (let index = 0; index < MEMORY_PRESSURE_EVENTS_MAX + 12; index += 1) {
      journal.add(released(1), { role: "host", level: "warning" });
    }
    const counts = journal.counts();
    expect(counts.events).toBe(MEMORY_PRESSURE_EVENTS_MAX);
    expect(counts.lastEvictedBy).toBe("events");
    const page = journal.page();
    expect(page.events[0]!.id).toBe(`mp_${MEMORY_PRESSURE_EVENTS_MAX + 12}`);
    expect(page.retention.events).toBe(MEMORY_PRESSURE_EVENTS_MAX);
  });

  it("drops by age at an hour, even with nothing new arriving", () => {
    const time = clock();
    const journal = new PressureJournal({ now: time.now });
    journal.add(released(1), { role: "host", level: "warning" });
    time.advance(MEMORY_PRESSURE_EVENT_MAX_AGE_MS + 1);
    const page = journal.page();
    expect(page.events).toHaveLength(0);
    expect(page.retention.events).toBe(0);
    // An empty journal retains no bytes, which the contract checks for us.
    expect(page.retention.bytes).toBe(0);
    expect(page.retention.lastEvictedBy).toBe("age");
  });

  it("drops by bytes, and the bytes are the exact serialized size", () => {
    const journal = new PressureJournal({ maxBytes: 400 });
    const first = journal.add(released(1), { role: "host", level: "warning" })!;
    const exact = Buffer.byteLength(JSON.stringify(first), "utf8");
    expect(journal.counts().bytes).toBe(exact);
    while (journal.counts().bytes + exact <= 400) journal.add(released(1), { role: "host", level: "warning" });
    const before = journal.counts().events;
    journal.add(released(1), { role: "host", level: "warning" });
    const after = journal.counts();
    expect(after.bytes).toBeLessThanOrEqual(400);
    expect(after.events).toBeLessThanOrEqual(before);
    expect(after.lastEvictedBy).toBe("bytes");
    // Never above the contract's own ceiling either.
    expect(journal.counts().bytes).toBeLessThanOrEqual(MEMORY_PRESSURE_EVENTS_MAX_BYTES);
  });
});

describe("a page", () => {
  it("is newest first, at most fifty, and validates", () => {
    const time = clock();
    const journal = new PressureJournal({ now: time.now });
    for (let index = 0; index < 60; index += 1) {
      journal.add(released(1), { role: "host", level: "warning" });
      time.advance(10);
    }
    const page = journal.page();
    expect(page.events).toHaveLength(MEMORY_PRESSURE_EVENTS_PAGE);
    expect(page.events[0]!.id).toBe("mp_60");
    expect(page.events.at(-1)!.id).toBe("mp_11");
    for (let index = 1; index < page.events.length; index += 1) {
      expect(page.events[index]!.atMs).toBeLessThanOrEqual(page.events[index - 1]!.atMs);
    }
    expect(page.retention.events).toBe(60);
    // The validated form is the only one that leaves the journal.
    expect(() => parseMemoryPressureJournalPage(page)).not.toThrow();
  });

  it("may carry fewer than the journal retains, and says what the journal holds", () => {
    const journal = new PressureJournal();
    for (let index = 0; index < 20; index += 1) journal.add(released(1), { role: "host", level: "warning" });
    const page = journal.page(5);
    expect(page.events).toHaveLength(5);
    expect(page.events[0]!.id).toBe("mp_20");
    expect(page.events.at(-1)!.id).toBe("mp_16");
    expect(page.retention.events).toBe(20);
  });

  it("keeps its order when the machine's clock steps backwards", () => {
    let at = 5_000;
    const journal = new PressureJournal({ now: () => at });
    journal.add(released(1), { role: "host", level: "warning" });
    at = 1_000; // NTP, a suspend, a virtual machine
    journal.add(released(1), { role: "host", level: "warning" });
    expect(() => parseMemoryPressureJournalPage(journal.page())).not.toThrow();
  });
});

describe("totals", () => {
  it("are exactly what the journal is holding, and nothing it once held", () => {
    const journal = new PressureJournal({ maxEvents: 3 });
    journal.add(released(5), { role: "host", level: "warning" });
    journal.add({ action: "renderer_views", outcome: "released", released: { bytes: 2_048 } }, { role: "desktop_renderer", level: "warning" });
    journal.add(refusal, { role: "host", level: "critical" });
    expect(journal.totals()).toEqual({ events: 3, released: { count: 5, bytes: 2_048 }, refusals: 1 });
    // The fourth pushes the first out, and the totals move with it.
    journal.add(quiet, { role: "host", level: "warning" });
    expect(journal.totals()).toEqual({ events: 3, released: { count: 0, bytes: 2_048 }, refusals: 1 });
    expect(journal.latestEventId()).toBe("mp_4");
  });

  it("are zero on an empty journal, with no latest event to join to", () => {
    const journal = new PressureJournal();
    expect(journal.totals()).toEqual({ events: 0, released: { count: 0, bytes: 0 }, refusals: 0 });
    expect(journal.latestEventId()).toBeUndefined();
  });
});
