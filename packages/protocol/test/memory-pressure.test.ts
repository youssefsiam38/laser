import { describe, expect, it } from "vitest";
import {
  MEMORY_PRESSURE_ACTIONS,
  MEMORY_PRESSURE_DIRECTIVE_LEVELS,
  MEMORY_PRESSURE_EVENTS_MAX,
  MEMORY_PRESSURE_EVENTS_MAX_BYTES,
  MEMORY_PRESSURE_EVENTS_PAGE,
  MEMORY_PRESSURE_EVENT_ID,
  MEMORY_PRESSURE_EVENT_MAX_AGE_MS,
  MEMORY_PRESSURE_HELD_REASONS,
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
  MEMORY_PRESSURE_WORKER_ACTIONS,
  NOTIFICATION_PRESSURE,
  NOTIFICATION_SCOPE,
  METHOD_POLICY,
  RESOURCE_STORE_KEYS,
  aggregateMemoryPressureLevel,
  clientMethods,
  clientParamsSchemas,
  inPolicyOrder,
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
  memoryPressureWorkerActionResultSchema,
  notificationScope,
  parseMemoryPressurePublish,
  parseMemoryPressureSummary,
  type MemoryPressureJournalPageInput,
  type MemoryPressureReportInput,
  type MemoryPressureSummaryInput,
} from "../src/index.js";

/** The one directive shape, as the host sends it. */
const directive = { level: "warning", epoch: 3, generation: 7 } as const;

const measure = { status: "available", value: 273_297_408 } as const;
const missing = { status: "unavailable", reason: "collector_failed" } as const;

const workerRole: MemoryPressureSummaryInput["roles"][number] = {
  role: "project_worker",
  level: "warning",
  sampleAgeMs: 4_000,
  inputs: [
    { kind: "physical", value: measure, warningBytes: 1_342_177_280, criticalBytes: 2_013_265_920 },
    { kind: "heap", value: missing },
  ],
  ceiling: { configuredBytes: 2_147_483_648, measuredLimit: { status: "available", value: 2_197_815_296 } },
  coverage: { expected: 2, answered: 1, complete: false, reason: "incomplete_coverage" },
};

const calmRole = (role: (typeof MEMORY_PRESSURE_ROLES)[number]): MemoryPressureSummaryInput["roles"][number] => ({
  role,
  level: "normal",
  inputs: [{ kind: "physical", value: measure }],
  coverage: { expected: 1, answered: 1, complete: true },
});

const unknownRole = (role: (typeof MEMORY_PRESSURE_ROLES)[number]): MemoryPressureSummaryInput["roles"][number] => ({
  role,
  level: "unknown",
  inputs: [{ kind: "physical", value: missing }],
  coverage: { expected: 1, answered: 0, complete: false, reason: "incomplete_coverage" },
});

/** Every role, exactly once: the shape a summary must always have. */
const summary: MemoryPressureSummaryInput = {
  level: "warning",
  roles: [calmRole("host"), workerRole, calmRole("desktop_renderer"), calmRole("machine")],
  refusing: ["whole_transcript"],
  totals: { events: 4, released: { count: 2, bytes: 1_048_576 }, refusals: 1 },
  latestEventId: "mp_41",
};

const event = {
  id: "mp_41",
  atMs: 1_767_225_600_000,
  role: "project_worker",
  level: "critical",
  action: "replay_suffixes",
  outcome: "released",
  released: { count: 12, bytes: 524_288 },
  project: "0123456789abcdef",
} as const;

const report: MemoryPressureReportInput = {
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

const page: MemoryPressureJournalPageInput = {
  events: [event],
  retention: {
    maxEvents: MEMORY_PRESSURE_EVENTS_MAX,
    maxAgeMs: MEMORY_PRESSURE_EVENT_MAX_AGE_MS,
    maxBytes: MEMORY_PRESSURE_EVENTS_MAX_BYTES,
    events: 1,
    bytes: 512,
    lastEvictedBy: "age",
  },
};

describe("the pressure vocabulary", () => {
  it("has no duplicates, and separates a level from the absence of one", () => {
    for (const table of [
      MEMORY_PRESSURE_LEVELS,
      MEMORY_PRESSURE_LEVEL_STATES,
      MEMORY_PRESSURE_ROLES,
      MEMORY_PRESSURE_ACTIONS,
      MEMORY_PRESSURE_WORKER_ACTIONS,
      MEMORY_PRESSURE_OUTCOMES,
      MEMORY_PRESSURE_REASONS,
      MEMORY_PRESSURE_REFUSALS,
      MEMORY_PRESSURE_INPUT_KINDS,
      MEMORY_PRESSURE_DIRECTIVE_LEVELS,
    ]) {
      expect(new Set(table).size).toBe(table.length);
    }
    expect(MEMORY_PRESSURE_LEVELS).not.toContain("unknown");
    expect(MEMORY_PRESSURE_LEVEL_STATES).toEqual([...MEMORY_PRESSURE_LEVELS, "unknown"]);
    expect(MEMORY_PRESSURE_DIRECTIVE_LEVELS).toEqual(["warning", "critical"]);
  });

  it("keeps the seven ordered steps in their declared order, and names the three a worker owns", () => {
    expect(MEMORY_PRESSURE_ACTIONS).toEqual([
      "ephemeral_caches",
      "renderer_views",
      "replay_suffixes",
      "task_records",
      "idle_session_unload",
      "worker_retirement",
      "admission_refused",
    ]);
    expect(MEMORY_PRESSURE_WORKER_ACTIONS).toEqual(["ephemeral_caches", "replay_suffixes", "task_records"]);
    // The worker's steps are a subsequence of the policy, in the policy's order.
    expect(MEMORY_PRESSURE_WORKER_ACTIONS.every((action) => MEMORY_PRESSURE_ACTIONS.includes(action))).toBe(true);
    expect(inPolicyOrder([...MEMORY_PRESSURE_WORKER_ACTIONS])).toBe(true);
    expect(inPolicyOrder(["replay_suffixes", "ephemeral_caches"])).toBe(false);
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
    expect(MEMORY_PRESSURE_EVENT_ID.test("mp_1")).toBe(true);
    for (const bad of ["mp_0", "mp_01", "mp_007"]) {
      expect(MEMORY_PRESSURE_EVENT_ID.test(bad), bad).toBe(false);
    }
    for (const bad of ["mp_", "mp_x", "41", "mp_41 ", "mp_1234567890123456", "MP_41", "mp_-1"]) {
      expect(MEMORY_PRESSURE_EVENT_ID.test(bad), bad).toBe(false);
    }
    expect(MEMORY_PRESSURE_PROJECT_ID.test("0123456789abcdef")).toBe(true);
    for (const bad of ["/home/me/project", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "project"]) {
      expect(MEMORY_PRESSURE_PROJECT_ID.test(bad), bad).toBe(false);
    }
  });

  it("aggregates a set of levels as the worst thing any of them knows", () => {
    expect(aggregateMemoryPressureLevel(["normal", "normal"])).toBe("normal");
    expect(aggregateMemoryPressureLevel(["normal", "unknown"])).toBe("unknown");
    expect(aggregateMemoryPressureLevel(["unknown", "warning"])).toBe("warning");
    expect(aggregateMemoryPressureLevel(["warning", "critical", "unknown"])).toBe("critical");
    expect(aggregateMemoryPressureLevel([])).toBe("normal");
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
    expect(memoryPressureMeasureSchema.safeParse({ status: "unavailable", reason: "process_gone", detail: "gone" }).success).toBe(false);
    expect(memoryPressureMeasureSchema.safeParse({ status: "unavailable", reason: "because" }).success).toBe(false);
    for (const value of [
      Number.POSITIVE_INFINITY,
      Number.NaN,
      -1,
      -0.5,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      "273297408",
      null,
    ]) {
      expect(memoryPressureMeasureSchema.safeParse({ status: "available", value }).success, String(value)).toBe(false);
    }
    expect(memoryPressureMeasureSchema.safeParse({ status: "available", value: Number.MAX_SAFE_INTEGER }).success).toBe(true);
    expect(memoryPressureMeasureSchema.safeParse({ status: "available", value: 0 }).success).toBe(true);
    expect(memoryPressureMeasureSchema.safeParse({ status: "available" }).success).toBe(false);
  });

  it("takes thresholds as a pair, in the direction its kind moves", () => {
    const physical = { kind: "physical", value: measure, warningBytes: 100, criticalBytes: 200 };
    expect(memoryPressureInputSchema.parse(physical)).toEqual(physical);
    // Memory in use grows into trouble; memory still available falls into it.
    const machine = { kind: "machine_available", value: measure, warningBytes: 200, criticalBytes: 100 };
    expect(memoryPressureInputSchema.parse(machine)).toEqual(machine);
    expect(memoryPressureInputSchema.safeParse({ ...physical, criticalBytes: 100 }).success).toBe(false);
    expect(memoryPressureInputSchema.safeParse({ ...physical, warningBytes: 200, criticalBytes: 200 }).success).toBe(false);
    expect(memoryPressureInputSchema.safeParse({ ...machine, warningBytes: 100, criticalBytes: 200 }).success).toBe(false);
    // One threshold says nothing: a number is only above a line when there is one.
    expect(memoryPressureInputSchema.safeParse({ kind: "heap", value: measure, warningBytes: 100 }).success).toBe(false);
    expect(memoryPressureInputSchema.safeParse({ kind: "heap", value: measure, criticalBytes: 100 }).success).toBe(false);
    expect(memoryPressureInputSchema.safeParse({ kind: "heap", value: measure }).success).toBe(true);
  });

  it("bounds the inputs one role row may carry", () => {
    expect(memoryPressureInputSchema.parse(workerRole.inputs[0])).toEqual(workerRole.inputs[0]);
    expect(memoryPressureInputSchema.safeParse({ kind: "swap", value: measure }).success).toBe(false);
    expect(memoryPressureInputSchema.safeParse({ kind: "physical", value: measure, warningBytes: -1, criticalBytes: 1 }).success).toBe(false);
    const many = Array.from({ length: MEMORY_PRESSURE_INPUTS_MAX + 1 }, () => ({ kind: "heap", value: measure }));
    expect(memoryPressureRoleStateSchema.safeParse({ ...workerRole, inputs: many }).success).toBe(false);
  });

  it("takes one input of each kind, never two answers to one question", () => {
    const twice = [
      { kind: "physical", value: measure },
      { kind: "physical", value: missing },
    ];
    expect(memoryPressureRoleStateSchema.safeParse({ ...workerRole, inputs: twice }).success).toBe(false);
    expect(memoryPressureReportSchema.safeParse({ ...report, inputs: twice }).success).toBe(false);
    const each = MEMORY_PRESSURE_INPUT_KINDS.map((kind) => ({ kind, value: measure }));
    expect(memoryPressureRoleStateSchema.safeParse({ ...workerRole, inputs: each }).success).toBe(true);
  });

  it("keeps coverage arithmetic rather than an opinion", () => {
    expect(memoryPressureRoleStateSchema.safeParse({ ...workerRole, level: "warning", coverage: { expected: 2, answered: 2, complete: true } }).success).toBe(true);
    for (const coverage of [
      { expected: 1, answered: 2, complete: false, reason: "incomplete_coverage" },
      { expected: 2, answered: 2, complete: false, reason: "incomplete_coverage" },
      { expected: 2, answered: 1, complete: true },
      { expected: 2, answered: 2, complete: true, reason: "incomplete_coverage" },
      { expected: 2, answered: 1, complete: false },
      { expected: 2, answered: 1, complete: false, reason: "collector_failed" },
    ]) {
      expect(memoryPressureRoleStateSchema.safeParse({ ...workerRole, coverage }).success, JSON.stringify(coverage)).toBe(false);
    }
  });

  it("will not call a role calm without the evidence to say so", () => {
    expect(memoryPressureRoleStateSchema.parse(calmRole("host"))).toEqual(calmRole("host"));
    // Normal needs complete coverage …
    expect(
      memoryPressureRoleStateSchema.safeParse({
        ...calmRole("host"),
        coverage: { expected: 2, answered: 1, complete: false, reason: "incomplete_coverage" },
      }).success,
    ).toBe(false);
    // … and a reading it could actually take.
    expect(memoryPressureRoleStateSchema.safeParse({ ...calmRole("host"), inputs: [{ kind: "physical", value: missing }] }).success).toBe(false);
    expect(memoryPressureRoleStateSchema.safeParse({ ...calmRole("host"), inputs: [] }).success).toBe(false);
    // A warning or a critical is a claim about a number, so it needs one.
    for (const level of ["warning", "critical"] as const) {
      expect(
        memoryPressureRoleStateSchema.safeParse({ ...calmRole("host"), level, inputs: [{ kind: "physical", value: missing }] }).success,
        level,
      ).toBe(false);
    }
    // Unknown is what missing or stale evidence looks like, and it is allowed
    // to look like that.
    expect(memoryPressureRoleStateSchema.parse(unknownRole("machine"))).toEqual(unknownRole("machine"));
    expect(memoryPressureRoleStateSchema.safeParse({ ...unknownRole("machine"), inputs: [] }).success).toBe(true);
    // An aggregate with nothing in it is genuinely calm: no live worker is not
    // a missing reading.
    const empty = { role: "project_worker", level: "normal", inputs: [], coverage: { expected: 0, answered: 0, complete: true } };
    expect(memoryPressureRoleStateSchema.parse(empty)).toEqual(empty);
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

  it("cannot contradict itself about releasing or refusing", () => {
    const released = { action: "task_records", outcome: "released", released: { bytes: 1_024 } } as const;
    expect(memoryPressureActionResultSchema.parse(released)).toEqual(released);
    expect(memoryPressureActionResultSchema.safeParse({ action: "task_records", outcome: "released" }).success).toBe(false);
    expect(memoryPressureActionResultSchema.safeParse({ ...released, released: {} }).success).toBe(false);
    expect(
      memoryPressureActionResultSchema.safeParse({ action: "task_records", outcome: "held", released: { bytes: 1 } }).success,
    ).toBe(false);
    const refused = { action: "admission_refused", outcome: "refused", refusal: "new_project_worker" } as const;
    expect(memoryPressureActionResultSchema.parse(refused)).toEqual(refused);
    expect(memoryPressureActionResultSchema.safeParse({ action: "admission_refused", outcome: "refused" }).success).toBe(false);
    expect(
      memoryPressureActionResultSchema.safeParse({ action: "replay_suffixes", outcome: "held", refusal: "older_history" }).success,
    ).toBe(false);
  });

  it("lets the admission step refuse, and do nothing else (D-263)", () => {
    const refused = { action: "admission_refused", outcome: "refused", refusal: "new_project_worker" } as const;
    expect(memoryPressureActionResultSchema.parse(refused)).toEqual(refused);
    for (const outcome of ["released", "nothing_to_give", "held", "unavailable", "budget_reached"] as const) {
      const row = outcome === "released"
        ? { ...refused, outcome, released: { count: 1 } }
        : outcome === "held"
          ? { ...refused, outcome, reason: "pins_held" }
          : { ...refused, outcome };
      expect(memoryPressureActionResultSchema.safeParse(row).success, outcome).toBe(false);
    }
  });

  it("makes a hold say what holds it, and nothing else say that (D-263)", () => {
    for (const reason of MEMORY_PRESSURE_HELD_REASONS) {
      expect(memoryPressureActionResultSchema.safeParse({ action: "task_records", outcome: "held", reason }).success, reason).toBe(true);
    }
    // A hold with no reason, or with a reason that explains something else.
    expect(memoryPressureActionResultSchema.safeParse({ action: "task_records", outcome: "held" }).success).toBe(false);
    for (const reason of MEMORY_PRESSURE_REASONS.filter((row) => !MEMORY_PRESSURE_HELD_REASONS.includes(row as never))) {
      expect(memoryPressureActionResultSchema.safeParse({ action: "task_records", outcome: "held", reason }).success, reason).toBe(false);
      // … and those reasons are free to explain other outcomes.
      expect(
        memoryPressureActionResultSchema.safeParse({ action: "task_records", outcome: "budget_reached", reason }).success,
        reason,
      ).toBe(true);
    }
    // The three holding reasons never explain anything but a hold.
    for (const reason of MEMORY_PRESSURE_HELD_REASONS) {
      for (const outcome of ["nothing_to_give", "unavailable", "budget_reached", "refused"] as const) {
        expect(memoryPressureActionResultSchema.safeParse({ action: "task_records", outcome, reason }).success, `${outcome}/${reason}`).toBe(false);
      }
      expect(
        memoryPressureActionResultSchema.safeParse({ action: "task_records", outcome: "released", released: { count: 1 }, reason }).success,
        reason,
      ).toBe(false);
    }
    // What D-263 leaves alone: a release with work left over, and an
    // unavailable row that has no more to say.
    expect(
      memoryPressureActionResultSchema.safeParse({ action: "replay_suffixes", outcome: "released", released: { count: 1 }, reason: "work_budget" }).success,
    ).toBe(true);
    expect(memoryPressureActionResultSchema.safeParse({ action: "task_records", outcome: "unavailable" }).success).toBe(true);
  });

  it("accepts only a worker's own steps in a worker's rows", () => {
    for (const action of MEMORY_PRESSURE_WORKER_ACTIONS) {
      expect(memoryPressureWorkerActionResultSchema.safeParse({ action, outcome: "nothing_to_give" }).success, action).toBe(true);
    }
    const foreign = MEMORY_PRESSURE_ACTIONS.filter((action) => !MEMORY_PRESSURE_WORKER_ACTIONS.includes(action as never));
    expect(foreign).toEqual(["renderer_views", "idle_session_unload", "worker_retirement", "admission_refused"]);
    for (const action of foreign) {
      expect(memoryPressureWorkerActionResultSchema.safeParse({ action, outcome: "nothing_to_give" }).success, action).toBe(false);
    }
  });

  it("gives a recorded event an identity its sender could not have chosen", () => {
    expect(memoryPressureEventSchema.parse(event)).toEqual(event);
    expect(memoryPressureEventSchema.safeParse({ ...event, outcome: "held" }).success).toBe(false);
    expect(memoryPressureEventSchema.safeParse({ ...event, refusal: "older_history" }).success).toBe(false);
    for (const id of ["mp_0", "mp_01"]) {
      expect(memoryPressureEventSchema.safeParse({ ...event, id }).success, id).toBe(false);
    }
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
    for (const key of RESOURCE_STORE_KEYS) {
      expect(memoryPressureStoresSchema.safeParse({ [key]: { count: 1, bytes: 2 } }).success, key).toBe(true);
    }
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

describe("a worker's pass", () => {
  it("round-trips a directive answer and bounds it to one row per step", () => {
    const answer = { applied: true, ran: report.ran, results: report.results, stores: report.stores };
    expect(memoryPressureDirectiveResultSchema.parse(answer)).toEqual(answer);
    expect(memoryPressureDirectiveResultSchema.safeParse({ ...answer, applied: "yes" }).success).toBe(false);
    const tooMany = Array.from({ length: MEMORY_PRESSURE_WORKER_ACTIONS.length + 1 }, () => ({
      action: "task_records",
      outcome: "released",
      released: { bytes: 1 },
    }));
    expect(memoryPressureDirectiveResultSchema.safeParse({ ...answer, results: tooMany }).success).toBe(false);
  });

  it("refuses a step that belongs to another actor, in either worker shape", () => {
    const answer = { applied: true, ran: report.ran, results: report.results, stores: report.stores };
    for (const action of ["renderer_views", "idle_session_unload", "worker_retirement", "admission_refused"] as const) {
      const row =
        action === "admission_refused"
          ? { action, outcome: "refused", refusal: "new_project_worker" }
          : { action, outcome: "nothing_to_give" };
      expect(memoryPressureDirectiveResultSchema.safeParse({ ...answer, ran: [action], results: [row] }).success, action).toBe(false);
      expect(
        memoryPressureReportSchema.safeParse({ ...report, ran: [action], results: [row] }).success,
        `report ${action}`,
      ).toBe(false);
    }
  });

  it("refuses a pass that contradicts itself about which steps it ran", () => {
    const answer = { applied: true, ran: report.ran, results: report.results, stores: report.stores };
    expect(
      memoryPressureDirectiveResultSchema.safeParse({
        ...answer,
        ran: ["ephemeral_caches", "ephemeral_caches"],
        results: [
          { action: "ephemeral_caches", outcome: "held", reason: "pins_held" },
          { action: "ephemeral_caches", outcome: "held", reason: "pins_held" },
        ],
      }).success,
    ).toBe(false);
    expect(memoryPressureDirectiveResultSchema.safeParse({ ...answer, ran: ["ephemeral_caches"] }).success).toBe(false);
    expect(memoryPressureDirectiveResultSchema.safeParse({ ...answer, results: [report.results[0]!] }).success).toBe(false);
    expect(
      memoryPressureDirectiveResultSchema.safeParse({ ...answer, ran: ["ephemeral_caches", "task_records"], results: report.results })
        .success,
    ).toBe(false);
    const reversed = {
      ...answer,
      ran: ["replay_suffixes", "ephemeral_caches"],
      results: [report.results[1]!, report.results[0]!],
    };
    expect(memoryPressureDirectiveResultSchema.safeParse(reversed).success).toBe(false);
    // Gaps are ordinary; order is not optional.
    expect(
      memoryPressureDirectiveResultSchema.safeParse({
        ...answer,
        ran: ["ephemeral_caches", "task_records"],
        results: [report.results[0]!, { action: "task_records", outcome: "held", reason: "pins_held" }],
      }).success,
    ).toBe(true);
  });

  it("holds a worker's report to the same order and correspondence", () => {
    expect(memoryPressureReportSchema.parse(report)).toEqual(report);
    expect(
      memoryPressureReportSchema.safeParse({
        ...report,
        ran: ["replay_suffixes", "ephemeral_caches"],
        results: [report.results[1]!, report.results[0]!],
      }).success,
    ).toBe(false);
    expect(memoryPressureReportSchema.safeParse({ ...report, results: [report.results[0]!] }).success).toBe(false);
    for (const extra of [{ cwd: "/home/me/project" }, { pid: 412 }, { project: "0123456789abcdef" }, { at: "2026-01-01T00:00:00.000Z" }]) {
      expect(memoryPressureReportSchema.safeParse({ ...report, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(memoryPressureReportSchema.safeParse({ ...report, generation: -1 }).success).toBe(false);
    expect(memoryPressureReportSchema.safeParse({ ...report, sampleAgeMs: Number.POSITIVE_INFINITY }).success).toBe(false);
  });

  it("acts on nothing at normal, and on nothing at all under unproven evidence", () => {
    // A level that is not pressure has run nothing.
    for (const level of ["normal", "unknown"] as const) {
      expect(memoryPressureReportSchema.safeParse({ ...report, level }).success, level).toBe(false);
    }
    const quiet = { ...report, level: "normal", ran: [], results: [] };
    expect(memoryPressureReportSchema.parse(quiet)).toEqual(quiet);
    const blind = { ...report, level: "unknown", inputs: [{ kind: "physical", value: missing }], ran: [], results: [] };
    expect(memoryPressureReportSchema.parse(blind)).toEqual(blind);
    // A claimed level needs a reading it could take.
    expect(memoryPressureReportSchema.safeParse({ ...quiet, inputs: [] }).success).toBe(false);
    expect(memoryPressureReportSchema.safeParse({ ...quiet, inputs: [{ kind: "physical", value: missing }] }).success).toBe(false);
    expect(memoryPressureReportSchema.safeParse({ ...report, inputs: [{ kind: "physical", value: missing }] }).success).toBe(false);
    // Unknown may have nothing at all to show for itself.
    expect(memoryPressureReportSchema.safeParse({ ...blind, inputs: [] }).success).toBe(true);
  });
});

describe("the summary", () => {
  it("publishes a fixed-size summary and refuses one that grew", () => {
    const publish = { epoch: 4, summary };
    expect(memoryPressurePublishSchema.parse(publish)).toEqual(publish);
    expect(parseMemoryPressurePublish(publish)).toEqual(publish);
    expect(memoryPressureSummarySchema.parse(summary)).toEqual(summary);
    expect(parseMemoryPressureSummary(summary)).toEqual(summary);
    expect(memoryPressureSummarySchema.safeParse({ ...summary, latestEventId: "latest" }).success).toBe(false);
    expect(memoryPressureSummarySchema.safeParse({ ...summary, events: [event] }).success).toBe(false);
    expect(
      memoryPressureSummarySchema.safeParse({ ...summary, totals: { events: 1, released: { count: 1, bytes: 1.2 }, refusals: 0 } })
        .success,
    ).toBe(false);
    // The validation mark is a type, never a field: a message carrying one as
    // a property is refused like any other stranger.
    expect(memoryPressureSummarySchema.safeParse({ ...summary, __memoryPressureValidated: true }).success).toBe(false);
  });

  it("validates the whole published payload, not only the summary inside it", () => {
    const publish = { epoch: 4, summary };
    // An epoch is a generation, so it is a real, exact, non-negative integer.
    for (const epoch of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "4", null, undefined]) {
      expect(memoryPressurePublishSchema.safeParse({ ...publish, epoch }).success, String(epoch)).toBe(false);
    }
    expect(memoryPressurePublishSchema.safeParse({ ...publish, epoch: 0 }).success).toBe(true);
    expect(memoryPressurePublishSchema.safeParse({ ...publish, epoch: Number.MAX_SAFE_INTEGER }).success).toBe(true);
    // And a summary that is not one of ours does not become one by being
    // published beside a sound epoch.
    expect(memoryPressurePublishSchema.safeParse({ ...publish, summary: { ...summary, level: "critical" } }).success).toBe(false);
    expect(memoryPressurePublishSchema.safeParse({ ...publish, journal: [] }).success).toBe(false);
  });

  it("reports every role exactly once, so an omission cannot become calm", () => {
    for (const role of MEMORY_PRESSURE_ROLES) {
      const without = summary.roles.filter((row) => row.role !== role);
      expect(
        memoryPressureSummarySchema.safeParse({ ...summary, level: aggregateMemoryPressureLevel(without.map((row) => row.level)), roles: without })
          .success,
        role,
      ).toBe(false);
    }
    expect(memoryPressureSummarySchema.safeParse({ ...summary, roles: [...summary.roles, workerRole] }).success).toBe(false);
    const tooManyRoles = Array.from({ length: MEMORY_PRESSURE_ROLES_MAX + 1 }, () => workerRole);
    expect(memoryPressureSummarySchema.safeParse({ ...summary, roles: tooManyRoles }).success).toBe(false);
  });

  it("is the worst thing its roles know, not a second opinion beside them", () => {
    const calm = { ...summary, level: "normal", roles: MEMORY_PRESSURE_ROLES.map((role) => calmRole(role)) };
    expect(memoryPressureSummarySchema.parse(calm)).toEqual(calm);
    // A role in trouble cannot leave the aggregate calm …
    expect(memoryPressureSummarySchema.safeParse({ ...calm, roles: [calmRole("host"), workerRole, calmRole("desktop_renderer"), calmRole("machine")] }).success).toBe(false);
    // … and a role nobody could read makes the aggregate unknown, never normal.
    const blind = [calmRole("host"), unknownRole("project_worker"), calmRole("desktop_renderer"), calmRole("machine")];
    expect(memoryPressureSummarySchema.safeParse({ ...calm, roles: blind }).success).toBe(false);
    expect(memoryPressureSummarySchema.safeParse({ ...calm, level: "unknown", roles: blind }).success).toBe(true);
    const worst = [calmRole("host"), { ...workerRole, level: "critical" }, unknownRole("desktop_renderer"), calmRole("machine")];
    expect(memoryPressureSummarySchema.safeParse({ ...calm, level: "critical", roles: worst }).success).toBe(true);
    expect(memoryPressureSummarySchema.safeParse({ ...calm, level: "warning", roles: worst }).success).toBe(false);
  });

  it("lists each kind of refusal once", () => {
    expect(memoryPressureSummarySchema.safeParse({ ...summary, refusing: ["older_history", "older_history"] }).success).toBe(false);
    expect(memoryPressureSummarySchema.safeParse({ ...summary, refusing: [...MEMORY_PRESSURE_REFUSALS] }).success).toBe(true);
    const tooManyRefusals = Array.from({ length: MEMORY_PRESSURE_REFUSALS_MAX + 1 }, () => "older_history");
    expect(memoryPressureSummarySchema.safeParse({ ...summary, refusing: tooManyRefusals }).success).toBe(false);
  });
});

describe("one journal page", () => {
  it("round-trips a page and keeps its retention explainable", () => {
    expect(memoryPressureJournalPageSchema.parse(page)).toEqual(page);
    expect(
      memoryPressureJournalPageSchema.safeParse({ ...page, retention: { ...page.retention, lastEvictedBy: "pressure" } }).success,
    ).toBe(false);
    for (const retention of [
      { ...page.retention, maxEvents: MEMORY_PRESSURE_EVENTS_MAX + 1 },
      { ...page.retention, maxAgeMs: MEMORY_PRESSURE_EVENT_MAX_AGE_MS * 2 },
      { ...page.retention, maxBytes: MEMORY_PRESSURE_EVENTS_MAX_BYTES * 2 },
      { ...page.retention, events: MEMORY_PRESSURE_EVENTS_MAX + 1 },
      { ...page.retention, bytes: MEMORY_PRESSURE_EVENTS_MAX_BYTES + 1 },
    ]) {
      expect(memoryPressureJournalPageSchema.safeParse({ ...page, retention }).success, JSON.stringify(retention)).toBe(false);
    }
  });

  it("is newest first, by id and by time", () => {
    const older = { ...event, id: "mp_40", atMs: event.atMs - 1_000 };
    const newestFirst = { ...page, events: [event, older], retention: { ...page.retention, events: 2, bytes: 1_024 } };
    expect(memoryPressureJournalPageSchema.parse(newestFirst)).toEqual(newestFirst);
    expect(memoryPressureJournalPageSchema.safeParse({ ...newestFirst, events: [older, event] }).success).toBe(false);
    // Two rows cannot be the same event …
    expect(memoryPressureJournalPageSchema.safeParse({ ...newestFirst, events: [event, event] }).success).toBe(false);
    // … and time cannot run forward while ids run backwards.
    expect(
      memoryPressureJournalPageSchema.safeParse({ ...newestFirst, events: [event, { ...older, atMs: event.atMs + 1 }] }).success,
    ).toBe(false);
    // Equal timestamps are ordinary: two steps of one pass are recorded together.
    expect(memoryPressureJournalPageSchema.safeParse({ ...newestFirst, events: [event, { ...older, atMs: event.atMs }] }).success).toBe(true);
  });

  it("cannot carry rows the journal says it does not retain", () => {
    expect(memoryPressureJournalPageSchema.safeParse({ ...page, retention: { ...page.retention, events: 0, bytes: 0 } }).success).toBe(false);
    const emptyPage = { events: [], retention: { ...page.retention, events: 0, bytes: 0 } };
    expect(memoryPressureJournalPageSchema.parse(emptyPage)).toEqual(emptyPage);
    expect(memoryPressureJournalPageSchema.safeParse({ ...emptyPage, retention: { ...page.retention, events: 0, bytes: 8 } }).success).toBe(false);
    expect(memoryPressureJournalPageSchema.safeParse({ ...page, retention: { ...page.retention, events: 1, bytes: 0 } }).success).toBe(false);
    const tooMany = Array.from({ length: MEMORY_PRESSURE_EVENTS_PAGE + 1 }, (_, index) => ({
      ...event,
      id: `mp_${MEMORY_PRESSURE_EVENTS_PAGE + 1 - index}`,
      atMs: event.atMs - index,
    }));
    expect(
      memoryPressureJournalPageSchema.safeParse({ events: tooMany, retention: { ...page.retention, events: 60, bytes: 4_096 } }).success,
    ).toBe(false);
  });
});

describe("the inventories that must stay complete", () => {
  it("gives every new message a scope and a pressure class", () => {
    expect(NOTIFICATION_SCOPE["resource/pressure"]).toBe("diagnostics");
    expect(NOTIFICATION_SCOPE["pi/resource/pressure"]).toBe("diagnostics");
    expect(notificationScope("resource/pressure")).toBe("diagnostics");
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
