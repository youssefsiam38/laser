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
  MemoryPressureActionResult,
  MemoryPressureDirectiveResult,
  MemoryPressureJournalPage,
  MemoryPressureReport,
  MemoryPressureSummary,
  MemoryPressureSummaryInput,
  MemoryPressureWorkerActionResult,
  ResourceSnapshot,
  ValidatedMemoryPressureSummary,
} from "../src/index.js";
import { parseMemoryPressureSummary } from "../src/index.js";

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

  it("refuses anything but the admission step to name a refusal", () => {
    const refused: MemoryPressureActionResult = { action: "admission_refused", outcome: "refused", refusal: "new_project_worker" };
    expectTypeOf(refused).toMatchTypeOf<MemoryPressureActionResult>();

    // @ts-expect-error an admission refusal must name what was refused
    const nameless: MemoryPressureActionResult = { action: "admission_refused", outcome: "refused" };
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
    expectTypeOf<MemoryPressureReport>().toMatchTypeOf<{ generation: number }>();
    expectTypeOf<ValidatedMemoryPressureSummary>().toMatchTypeOf<MemoryPressureSummary>();
  });
});
