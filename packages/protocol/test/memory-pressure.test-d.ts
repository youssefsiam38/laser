/**
 * The contract's *compile-time* half (RP-8).
 *
 * The schemas refuse a contradictory message at the boundary; these assertions
 * refuse one before it is ever built, so an internal producer cannot construct
 * a shape the parser would reject and hand it on through the public type. What
 * TypeScript cannot express — coverage arithmetic, a role's evidence, a
 * summary's aggregate, a page's order, a pass's set and order — is behind the
 * validated forms instead, and this file proves those cannot be forged either.
 */
import { describe, expectTypeOf, it } from "vitest";
import type {
  HostNotifications,
  MemoryPressureActionResult,
  MemoryPressureDirectiveResult,
  MemoryPressureDirectiveResultInput,
  MemoryPressureJournalPage,
  MemoryPressureJournalPageInput,
  MemoryPressurePublish,
  MemoryPressureReport,
  MemoryPressureReportInput,
  MemoryPressureSummary,
  MemoryPressureSummaryInput,
  MemoryPressureWorkerActionResult,
  ResourceSnapshot,
  ValidatedMemoryPressureJournalPage,
  ValidatedMemoryPressurePublish,
  ValidatedMemoryPressureSummary,
} from "../src/index.js";
import {
  parseMemoryPressureDirectiveResult,
  parseMemoryPressureJournalPage,
  parseMemoryPressurePublish,
  parseMemoryPressureReport,
  parseMemoryPressureSummary,
} from "../src/index.js";

describe("a step's row", () => {
  it("cannot say it released nothing, or release without saying so", () => {
    const released: MemoryPressureActionResult = { action: "task_records", outcome: "released", released: { bytes: 1 } };
    expectTypeOf(released).toMatchTypeOf<MemoryPressureActionResult>();

    // @ts-expect-error a release with neither a count nor bytes is not evidence
    const empty: MemoryPressureActionResult = { action: "task_records", outcome: "released", released: {} };
    // @ts-expect-error a released outcome must say what it released
    const silent: MemoryPressureActionResult = { action: "task_records", outcome: "released" };
    // @ts-expect-error only a released step may report what it released
    const impostor: MemoryPressureActionResult = { action: "task_records", outcome: "held", released: { bytes: 1 } };
    void empty;
    void silent;
    void impostor;
  });

  it("lets the admission step refuse and do nothing else, and makes a hold say what holds it", () => {
    const refused: MemoryPressureActionResult = { action: "admission_refused", outcome: "refused", refusal: "older_history" };
    const held: MemoryPressureActionResult = { action: "task_records", outcome: "held", reason: "pins_held" };
    expectTypeOf(refused).toMatchTypeOf<MemoryPressureActionResult>();
    expectTypeOf(held).toMatchTypeOf<MemoryPressureActionResult>();

    // @ts-expect-error the admission step refuses; it does nothing else (D-263)
    const busy: MemoryPressureActionResult = { action: "admission_refused", outcome: "held", refusal: "older_history", reason: "pins_held" };
    // @ts-expect-error a hold says what is holding it (D-263)
    const mute: MemoryPressureActionResult = { action: "task_records", outcome: "held" };
    // @ts-expect-error … and it says one of the three that can hold something
    const wrong: MemoryPressureActionResult = { action: "task_records", outcome: "held", reason: "work_budget" };
    // @ts-expect-error … while those three explain nothing else
    const stray: MemoryPressureActionResult = { action: "task_records", outcome: "budget_reached", reason: "pins_held" };
    void busy;
    void mute;
    void wrong;
    void stray;

    // What D-263 leaves alone stays expressible.
    const budgeted: MemoryPressureActionResult = {
      action: "replay_suffixes",
      outcome: "released",
      released: { count: 1 },
      reason: "work_budget",
    };
    const quiet: MemoryPressureActionResult = { action: "task_records", outcome: "unavailable" };
    void budgeted;
    void quiet;
  });

  it("refuses anything but the admission step to name a refusal", () => {
    const refused: MemoryPressureActionResult = { action: "admission_refused", outcome: "refused", refusal: "new_project_worker" };
    expectTypeOf(refused).toMatchTypeOf<MemoryPressureActionResult>();

    // @ts-expect-error an admission refusal must name what was refused
    const nameless: MemoryPressureActionResult = { action: "admission_refused", outcome: "refused" };
    // @ts-expect-error and a worker's rows never carry a refusal at all
    const worker: MemoryPressureWorkerActionResult = { action: "task_records", outcome: "refused", refusal: "older_history" };
    void worker;
    // @ts-expect-error no other step refuses anything
    const foreign: MemoryPressureActionResult = { action: "replay_suffixes", outcome: "held", refusal: "older_history" };
    void nameless;
    void foreign;
  });

  it("keeps a worker's rows to a worker's steps", () => {
    const own: MemoryPressureWorkerActionResult = { action: "replay_suffixes", outcome: "nothing_to_give" };
    expectTypeOf(own).toMatchTypeOf<MemoryPressureActionResult>();

    // @ts-expect-error unloading a session is the host's step, not a worker's
    const host: MemoryPressureWorkerActionResult = { action: "idle_session_unload", outcome: "nothing_to_give" };
    // @ts-expect-error releasing views is the window's step
    const window: MemoryPressureWorkerActionResult = { action: "renderer_views", outcome: "nothing_to_give" };
    void host;
    void window;
  });
});

describe("a journal page", () => {
  it("cannot invent the journal's bounds", () => {
    // @ts-expect-error the bounds are this module's constants, not a sender's
    const invented: MemoryPressureJournalPage["retention"] = { maxEvents: 1_000, maxAgeMs: 1, maxBytes: 1, events: 0, bytes: 0 };
    void invented;
  });
});

describe("the validated forms", () => {
  it("are the only thing a snapshot or a wire message will take", () => {
    const readable: MemoryPressureSummary = {
      level: "unknown",
      roles: [],
      refusing: [],
      totals: { events: 0, released: { count: 0, bytes: 0 }, refusals: 0 },
    };
    // A readable summary is what a producer builds and hands to the parser …
    expectTypeOf(readable).toMatchTypeOf<MemoryPressureSummaryInput>();
    const validated: ValidatedMemoryPressureSummary = parseMemoryPressureSummary(readable);
    const snapshot: Pick<ResourceSnapshot, "pressure"> = { pressure: validated };
    void snapshot;

    // … and an unparsed one cannot be attached, whatever it says.
    // @ts-expect-error only a parsed summary reaches a snapshot
    const unchecked: Pick<ResourceSnapshot, "pressure"> = { pressure: readable };
    void unchecked;
  });

  it("are what the wire types are, so a shape cannot drift from its parser", () => {
    expectTypeOf<MemoryPressureDirectiveResult>().toMatchTypeOf<{ applied: boolean }>();
    expectTypeOf<MemoryPressureReport>().toMatchTypeOf<{
      generation: number;
      ceiling?: { configuredBytes?: number; measuredLimit?: { status: "available"; value: number } | { status: "unavailable"; reason: string } };
    }>();
    expectTypeOf<ValidatedMemoryPressureSummary>().toMatchTypeOf<MemoryPressureSummary>();
    expectTypeOf<MemoryPressurePublish>().toEqualTypeOf<ValidatedMemoryPressurePublish>();
  });

  it("refuse every raw value, in every shape that has a parser", () => {
    const rawSummary: MemoryPressureSummaryInput = {
      level: "unknown",
      roles: [],
      refusing: [],
      totals: { events: 0, released: { count: 0, bytes: 0 }, refusals: 0 },
    };
    const rawPage: MemoryPressureJournalPageInput = {
      events: [],
      retention: { maxEvents: 200, maxAgeMs: 3_600_000, maxBytes: 262_144, events: 0, bytes: 0 },
    };
    const rawAnswer: MemoryPressureDirectiveResultInput = { applied: false, ran: [], results: [], stores: {} };
    const rawReport: MemoryPressureReportInput = {
      generation: 1,
      level: "unknown",
      inputs: [],
      ceiling: { configuredBytes: 2_147_483_648, measuredLimit: { status: "available", value: 2_197_815_296 } },
      ran: [],
      results: [],
      stores: {},
    };

    // @ts-expect-error a summary is validated or it is not one of ours
    const summary: ValidatedMemoryPressureSummary = rawSummary;
    // @ts-expect-error … and so is a page,
    const journal: ValidatedMemoryPressureJournalPage = rawPage;
    // @ts-expect-error … a directive answer,
    const answer: MemoryPressureDirectiveResult = rawAnswer;
    // @ts-expect-error … and a worker's report.
    const report: MemoryPressureReport = rawReport;
    void summary;
    void journal;
    void answer;
    void report;

    // A sound epoch beside a validated summary is still a raw payload: the
    // whole message is validated, or none of it is.
    const validSummary = parseMemoryPressureSummary(rawSummary);
    // @ts-expect-error the published payload is validated as a whole
    const publish: MemoryPressurePublish = { epoch: 1, summary: validSummary };
    // @ts-expect-error and the notification carries exactly that validated form
    const notification: HostNotifications["resource/pressure"] = { epoch: 1, summary: validSummary };
    void publish;
    void notification;

    // Parsed values are accepted everywhere their raw counterparts were not.
    const parsed: HostNotifications["resource/pressure"] = parseMemoryPressurePublish({ epoch: 1, summary: rawSummary });
    expectTypeOf(parsed).toEqualTypeOf<ValidatedMemoryPressurePublish>();
    expectTypeOf(parseMemoryPressureJournalPage(rawPage)).toEqualTypeOf<ValidatedMemoryPressureJournalPage>();
    expectTypeOf(parseMemoryPressureDirectiveResult(rawAnswer)).toEqualTypeOf<MemoryPressureDirectiveResult>();
    expectTypeOf(parseMemoryPressureReport(rawReport)).toEqualTypeOf<MemoryPressureReport>();
  });
});
