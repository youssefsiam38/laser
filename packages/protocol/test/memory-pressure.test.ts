import { describe, expect, it } from "vitest";
import {
  MEMORY_PRESSURE_ACTIONS,
  MEMORY_PRESSURE_DIRECTIVE_LEVELS,
  MEMORY_PRESSURE_EVENTS_MAX,
  MEMORY_PRESSURE_EVENTS_MAX_BYTES,
  MEMORY_PRESSURE_EVENTS_PAGE,
  MEMORY_PRESSURE_EVENT_ID,
  MEMORY_PRESSURE_EVENT_MAX_AGE_MS,
  MEMORY_PRESSURE_INPUTS_MAX,
  MEMORY_PRESSURE_INPUT_KINDS,
  MEMORY_PRESSURE_LEVELS,
  MEMORY_PRESSURE_LEVEL_STATES,
  MEMORY_PRESSURE_OUTCOMES,
  MEMORY_PRESSURE_PROJECT_ID,
  MEMORY_PRESSURE_REASONS,
  MEMORY_PRESSURE_REFUSALS,
  MEMORY_PRESSURE_REFUSALS_MAX,
  MEMORY_PRESSURE_RESULTS_MAX,
  MEMORY_PRESSURE_ROLES,
  MEMORY_PRESSURE_ROLES_MAX,
  NOTIFICATION_PRESSURE,
  NOTIFICATION_SCOPE,
  METHOD_POLICY,
  RESOURCE_STORE_KEYS,
  clientMethods,
  clientParamsSchemas,
  isSheddable,
  memoryPressureActionResultSchema,
  memoryPressureDirectiveResultSchema,
  memoryPressureDirectiveSchema,
  memoryPressureEventSchema,
  memoryPressureInputSchema,
  memoryPressureJournalPageSchema,
  memoryPressureMeasureSchema,
  memoryPressurePublishSchema,
  memoryPressureReportSchema,
  memoryPressureRoleStateSchema,
  memoryPressureStoresSchema,
  memoryPressureSummarySchema,
  notificationScope,
  type MemoryPressureEvent,
  type MemoryPressureReport,
  type MemoryPressureSummary,
} from "../src/index.js";

/** The one directive shape, as the host sends it. */
const directive = { level: "warning", epoch: 3, generation: 7 } as const;

const measure = { status: "available", value: 273_297_408 } as const;

const roleState = {
  role: "project_worker",
  level: "warning",
  sampleAgeMs: 4_000,
  inputs: [
    { kind: "physical", value: measure, warningBytes: 1_342_177_280, criticalBytes: 2_013_265_920 },
    { kind: "heap", value: { status: "unavailable", reason: "not_collected" } },
  ],
  ceiling: { configuredBytes: 2_147_483_648, measuredLimit: { status: "available", value: 2_197_815_296 } },
  coverage: { expected: 2, answered: 1, complete: false, reason: "incomplete_coverage" },
} as const;

const summary: MemoryPressureSummary = {
  level: "warning",
  roles: [roleState as unknown as MemoryPressureSummary["roles"][number]],
  refusing: ["whole_transcript"],
  totals: { events: 4, released: { count: 2, bytes: 1_048_576 }, refusals: 1 },
  latestEventId: "mp_41",
};

const event: MemoryPressureEvent = {
  id: "mp_41",
  atMs: 1_767_225_600_000,
  role: "project_worker",
  level: "critical",
  action: "replay_suffixes",
  outcome: "released",
  released: { count: 12, bytes: 524_288 },
  project: "0123456789abcdef",
};

const report: MemoryPressureReport = {
  generation: 7,
  level: "warning",
  sampleAgeMs: 1_000,
  inputs: [{ kind: "physical", value: measure }],
  ran: ["ephemeral_caches", "replay_suffixes"],
  results: [
    { action: "ephemeral_caches", outcome: "released", released: { bytes: 4_194_304 } },
    { action: "replay_suffixes", outcome: "held", reason: "pins_held" },
  ],
  stores: { workerReplay: { count: 316, bytes: 1_275_319 } },
};

describe("the pressure vocabulary", () => {
  it("has no duplicates, and separates a level from the absence of one", () => {
    for (const table of [
      MEMORY_PRESSURE_LEVELS,
      MEMORY_PRESSURE_LEVEL_STATES,
      MEMORY_PRESSURE_ROLES,
      MEMORY_PRESSURE_ACTIONS,
      MEMORY_PRESSURE_OUTCOMES,
      MEMORY_PRESSURE_REASONS,
      MEMORY_PRESSURE_REFUSALS,
      MEMORY_PRESSURE_INPUT_KINDS,
      MEMORY_PRESSURE_DIRECTIVE_LEVELS,
    ]) {
      expect(new Set(table).size).toBe(table.length);
    }
    // "unknown" is a state, never a level: nothing may present it as normal.
    expect(MEMORY_PRESSURE_LEVELS).not.toContain("unknown");
    expect(MEMORY_PRESSURE_LEVEL_STATES).toEqual([...MEMORY_PRESSURE_LEVELS, "unknown"]);
    // A directive exists to make something happen, so it cannot ask for calm.
    expect(MEMORY_PRESSURE_DIRECTIVE_LEVELS).toEqual(["warning", "critical"]);
  });

  it("keeps the seven ordered steps in their declared order", () => {
    expect(MEMORY_PRESSURE_ACTIONS).toEqual([
      "ephemeral_caches",
      "renderer_views",
      "replay_suffixes",
      "task_records",
      "idle_session_unload",
      "worker_retirement",
      "admission_refused",
    ]);
  });

  it("declares the journal bounds the plan fixed, and derives the rest from its own tables", () => {
    expect(MEMORY_PRESSURE_EVENTS_MAX).toBe(200);
    expect(MEMORY_PRESSURE_EVENT_MAX_AGE_MS).toBe(60 * 60_000);
    expect(MEMORY_PRESSURE_EVENTS_MAX_BYTES).toBe(256 * 1024);
    expect(MEMORY_PRESSURE_EVENTS_PAGE).toBe(50);
    expect(MEMORY_PRESSURE_INPUTS_MAX).toBe(8);
    expect(MEMORY_PRESSURE_RESULTS_MAX).toBe(MEMORY_PRESSURE_ACTIONS.length);
    expect(MEMORY_PRESSURE_ROLES_MAX).toBe(MEMORY_PRESSURE_ROLES.length);
    expect(MEMORY_PRESSURE_REFUSALS_MAX).toBe(MEMORY_PRESSURE_REFUSALS.length);
  });

  it("bounds an event id and a project id to shapes nothing can hide in", () => {
    expect(MEMORY_PRESSURE_EVENT_ID.test("mp_41")).toBe(true);
    for (const bad of ["mp_", "mp_x", "41", "mp_41 ", "mp_0123456789012345", "MP_41", "mp_-1"]) {
      expect(MEMORY_PRESSURE_EVENT_ID.test(bad), bad).toBe(false);
    }
    expect(MEMORY_PRESSURE_PROJECT_ID.test("0123456789abcdef")).toBe(true);
    for (const bad of ["/home/me/project", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "project"]) {
      expect(MEMORY_PRESSURE_PROJECT_ID.test(bad), bad).toBe(false);
    }
  });
});

describe("the directive", () => {
  it("round-trips the exact shape the host sends, and nothing else", () => {
    expect(memoryPressureDirectiveSchema.parse(directive)).toEqual(directive);
    expect(clientParamsSchemas["pi/worker/pressure"].parse(directive)).toEqual(directive);
    expect(clientMethods).toContain("pi/worker/pressure");
  });

  it("refuses a level that is not an instruction, and any other unknown value", () => {
    for (const level of ["normal", "unknown", "Warning", "", null, 1, undefined]) {
      expect(memoryPressureDirectiveSchema.safeParse({ ...directive, level }).success, String(level)).toBe(false);
    }
  });

  it("refuses an epoch or generation that is not a real, exact, non-negative integer", () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "3", null]) {
      expect(memoryPressureDirectiveSchema.safeParse({ ...directive, epoch: value }).success, String(value)).toBe(false);
      expect(memoryPressureDirectiveSchema.safeParse({ ...directive, generation: value }).success, String(value)).toBe(false);
    }
    expect(memoryPressureDirectiveSchema.safeParse({ ...directive, epoch: Number.MAX_SAFE_INTEGER }).success).toBe(true);
  });

  it("refuses anything added to it, including a path, a pid or a note", () => {
    for (const extra of [{ path: "/home/me/s.jsonl" }, { pid: 412 }, { detail: "running low" }, { cwd: "/home/me" }]) {
      expect(memoryPressureDirectiveSchema.safeParse({ ...directive, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });
});

describe("a measured number", () => {
  it("is either a real value or a known reason, and never carries words", () => {
    expect(memoryPressureMeasureSchema.parse(measure)).toEqual(measure);
    expect(memoryPressureMeasureSchema.parse({ status: "unavailable", reason: "process_gone" })).toEqual({
      status: "unavailable",
      reason: "process_gone",
    });
    // RP-1 may keep a human note beside an unavailable measure; this wire may not.
    expect(memoryPressureMeasureSchema.safeParse({ status: "unavailable", reason: "process_gone", detail: "gone" }).success).toBe(false);
    expect(memoryPressureMeasureSchema.safeParse({ status: "unavailable", reason: "because" }).success).toBe(false);
    expect(memoryPressureMeasureSchema.safeParse({ status: "available", value: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(memoryPressureMeasureSchema.safeParse({ status: "available", value: Number.NaN }).success).toBe(false);
    expect(memoryPressureMeasureSchema.safeParse({ status: "available", value: "273297408" }).success).toBe(false);
    // Absent is absent: a missing measure is never a zero somebody may add up.
    expect(memoryPressureMeasureSchema.safeParse({ status: "available" }).success).toBe(false);
  });

  it("bounds the inputs one role row may carry", () => {
    expect(memoryPressureInputSchema.parse(roleState.inputs[0])).toEqual(roleState.inputs[0]);
    expect(memoryPressureInputSchema.safeParse({ kind: "swap", value: measure }).success).toBe(false);
    expect(memoryPressureInputSchema.safeParse({ kind: "physical", value: measure, warningBytes: -1 }).success).toBe(false);
    const many = Array.from({ length: MEMORY_PRESSURE_INPUTS_MAX + 1 }, () => ({ kind: "heap", value: measure }));
    expect(memoryPressureRoleStateSchema.safeParse({ ...roleState, inputs: many }).success).toBe(false);
  });

  it("keeps a role honest about what it could not read", () => {
    expect(memoryPressureRoleStateSchema.parse(roleState)).toEqual(roleState);
    expect(memoryPressureRoleStateSchema.parse({ ...roleState, level: "unknown" }).level).toBe("unknown");
    expect(memoryPressureRoleStateSchema.safeParse({ ...roleState, level: "fine" }).success).toBe(false);
    // The configured ceiling and the one the process reports are two facts.
    expect(memoryPressureRoleStateSchema.parse(roleState).ceiling).toEqual(roleState.ceiling);
    expect(
      memoryPressureRoleStateSchema.safeParse({ ...roleState, coverage: { expected: 2, answered: 1, complete: false, reason: "why" } }).success,
    ).toBe(false);
  });
});

describe("what a step reports", () => {
  it("names the step and the result, and never what it touched", () => {
    const result = { action: "idle_session_unload", outcome: "held", reason: "pins_held" } as const;
    expect(memoryPressureActionResultSchema.parse(result)).toEqual(result);
    for (const extra of [{ path: "/home/me/s.jsonl" }, { session: "abc" }, { message: "held" }, { cwd: "/p" }]) {
      expect(memoryPressureActionResultSchema.safeParse({ ...result, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(memoryPressureActionResultSchema.safeParse({ action: "free_memory", outcome: "released" }).success).toBe(false);
    expect(memoryPressureActionResultSchema.safeParse({ action: "task_records", outcome: "done" }).success).toBe(false);
    expect(memoryPressureActionResultSchema.safeParse({ ...result, refusal: "everything" }).success).toBe(false);
    expect(
      memoryPressureActionResultSchema.safeParse({ action: "task_records", outcome: "released", released: { bytes: 1.5 } }).success,
    ).toBe(false);
  });

  it("gives a recorded event an identity its sender could not have chosen", () => {
    expect(memoryPressureEventSchema.parse(event)).toEqual(event);
    expect(memoryPressureEventSchema.safeParse({ ...event, id: "/home/me" }).success).toBe(false);
    expect(memoryPressureEventSchema.safeParse({ ...event, project: "/home/me/project" }).success).toBe(false);
    expect(memoryPressureEventSchema.safeParse({ ...event, level: "unknown" }).success).toBe(false);
    expect(memoryPressureEventSchema.safeParse({ ...event, role: "relay" }).success).toBe(false);
    expect(memoryPressureEventSchema.safeParse({ ...event, atMs: -1 }).success).toBe(false);
    expect(memoryPressureEventSchema.safeParse({ ...event, atMs: Number.MAX_SAFE_INTEGER + 2 }).success).toBe(false);
    for (const extra of [{ pid: 412 }, { startToken: "linux:abc:1" }, { detail: "released" }, { sessionId: "s1" }]) {
      expect(memoryPressureEventSchema.safeParse({ ...event, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });
});

describe("the retained-store counters beside a pass", () => {
  it("accepts only the keys the inventory declares, and only counts and bytes", () => {
    expect(memoryPressureStoresSchema.parse({})).toEqual({});
    expect(memoryPressureStoresSchema.parse(report.stores)).toEqual(report.stores);
    expect(memoryPressureStoresSchema.safeParse({ somethingElse: { count: 1 } }).success).toBe(false);
    expect(memoryPressureStoresSchema.safeParse({ workerReplay: { count: 1, label: "replay" } }).success).toBe(false);
    expect(memoryPressureStoresSchema.safeParse({ workerReplay: { bytes: -1 } }).success).toBe(false);
    // Every declared key is accepted, so a store cannot be silently unreportable.
    for (const key of RESOURCE_STORE_KEYS) {
      expect(memoryPressureStoresSchema.safeParse({ [key]: { count: 1, bytes: 2 } }).success, key).toBe(true);
    }
    // RP-8 adds no key of its own: pressure has a summary, not a store.
    expect(RESOURCE_STORE_KEYS).toEqual([
      "workerSessions",
      "workerReplay",
      "workerCaches",
      "taskRegistry",
      "deliveryRegistry",
      "providerQueues",
      "rendererViews",
      "deviceCache",
    ]);
  });
});

describe("the three messages", () => {
  it("round-trips a directive answer and bounds it to one row per step", () => {
    const answer = { applied: true, ran: report.ran, events: report.results, stores: report.stores };
    expect(memoryPressureDirectiveResultSchema.parse(answer)).toEqual(answer);
    const tooMany = Array.from({ length: MEMORY_PRESSURE_RESULTS_MAX + 1 }, () => ({ action: "task_records", outcome: "released" }));
    expect(memoryPressureDirectiveResultSchema.safeParse({ ...answer, events: tooMany }).success).toBe(false);
    expect(memoryPressureDirectiveResultSchema.safeParse({ ...answer, ran: [...tooMany.map(() => "task_records")] }).success).toBe(false);
    expect(memoryPressureDirectiveResultSchema.safeParse({ ...answer, applied: "yes" }).success).toBe(false);
  });

  it("round-trips a worker's report and keeps every identity out of it", () => {
    expect(memoryPressureReportSchema.parse(report)).toEqual(report);
    expect(memoryPressureReportSchema.parse({ ...report, level: "unknown" }).level).toBe("unknown");
    for (const extra of [{ cwd: "/home/me/project" }, { pid: 412 }, { project: "0123456789abcdef" }, { at: "2026-01-01T00:00:00.000Z" }]) {
      expect(memoryPressureReportSchema.safeParse({ ...report, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(memoryPressureReportSchema.safeParse({ ...report, generation: -1 }).success).toBe(false);
    expect(memoryPressureReportSchema.safeParse({ ...report, sampleAgeMs: Number.POSITIVE_INFINITY }).success).toBe(false);
  });

  it("publishes a fixed-size summary and refuses one that grew", () => {
    const publish = { epoch: 4, summary };
    expect(memoryPressurePublishSchema.parse(publish)).toEqual(publish);
    expect(memoryPressureSummarySchema.parse(summary)).toEqual(summary);
    const tooManyRoles = Array.from({ length: MEMORY_PRESSURE_ROLES_MAX + 1 }, () => roleState);
    expect(memoryPressureSummarySchema.safeParse({ ...summary, roles: tooManyRoles }).success).toBe(false);
    const tooManyRefusals = Array.from({ length: MEMORY_PRESSURE_REFUSALS_MAX + 1 }, () => "older_history");
    expect(memoryPressureSummarySchema.safeParse({ ...summary, refusing: tooManyRefusals }).success).toBe(false);
    expect(memoryPressureSummarySchema.safeParse({ ...summary, latestEventId: "latest" }).success).toBe(false);
    expect(memoryPressureSummarySchema.safeParse({ ...summary, events: [event] }).success).toBe(false);
    expect(
      memoryPressureSummarySchema.safeParse({ ...summary, totals: { events: 1, released: { count: 1, bytes: 1.2 }, refusals: 0 } }).success,
    ).toBe(false);
  });

  it("bounds one journal page and keeps its retention explainable", () => {
    const page = {
      events: [event],
      retention: {
        maxEvents: MEMORY_PRESSURE_EVENTS_MAX,
        maxAgeMs: MEMORY_PRESSURE_EVENT_MAX_AGE_MS,
        maxBytes: MEMORY_PRESSURE_EVENTS_MAX_BYTES,
        events: 1,
        bytes: 512,
        lastEvictedBy: "age" as const,
      },
    };
    expect(memoryPressureJournalPageSchema.parse(page)).toEqual(page);
    const tooMany = Array.from({ length: MEMORY_PRESSURE_EVENTS_PAGE + 1 }, (_, index) => ({ ...event, id: `mp_${index}` }));
    expect(memoryPressureJournalPageSchema.safeParse({ ...page, events: tooMany }).success).toBe(false);
    expect(
      memoryPressureJournalPageSchema.safeParse({ ...page, retention: { ...page.retention, lastEvictedBy: "pressure" } }).success,
    ).toBe(false);
  });
});

describe("the inventories that must stay complete", () => {
  it("gives every new message a scope and a pressure class", () => {
    expect(NOTIFICATION_SCOPE["resource/pressure"]).toBe("diagnostics");
    expect(NOTIFICATION_SCOPE["pi/resource/pressure"]).toBe("diagnostics");
    expect(notificationScope("resource/pressure")).toBe("diagnostics");
    // The summary is re-readable from `resource/snapshot`, so a socket that is
    // behind may lose it; a worker's report is the only record of what it did.
    expect(NOTIFICATION_PRESSURE["resource/pressure"]).toBe("diagnostic");
    expect(NOTIFICATION_PRESSURE["pi/resource/pressure"]).toBe("state");
    expect(isSheddable("resource/pressure")).toBe(true);
    expect(isSheddable("pi/resource/pressure")).toBe(false);
  });

  it("keeps the directive the app's own call", () => {
    expect(METHOD_POLICY["pi/worker/pressure"]).toMatchObject({ scope: "work_control", reach: "native" });
    expect(METHOD_POLICY["pi/worker/pressure"].refusal).toBeTruthy();
  });
});
