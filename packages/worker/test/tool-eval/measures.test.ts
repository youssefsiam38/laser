/**
 * M26-T3 · the measures themselves.
 *
 * `fixtures.test.ts` proves the ten tools pass. This proves the measures can
 * fail: a green matrix is worth nothing if a measure returns "ok" whatever it
 * is given. Every measure gets a run that should fail it and one that should
 * pass it, built from the same {@link ToolEvalRun} shape the real runner
 * produces.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { renderToolError, toolError, type ToolError } from "@lasercode/protocol";
import { parseFixture, type ToolEvalFixture, type ToolEvalMeasureId } from "../../src/tool-eval/fixture.js";
import { evaluateRun, recordedOutcomeMismatch } from "../../src/tool-eval/measures.js";
import { buildReport, reportTable } from "../../src/tool-eval/report.js";
import type { ObservedCall, ToolEvalRun } from "../../src/tool-eval/run.js";
import { validateArguments } from "../../src/tool-eval/schema-check.js";
import { ensureToolsRegistered } from "./registry.js";

// The measures read the registered specs, so the tools have to be registered
// the way a session registers them.
beforeAll(async () => {
  await ensureToolsRegistered();
}, 120_000);

const PROFILE = { id: "mp_test0000000000000000000", name: "Fast", model: "recorded-fast", provider: "recorded" };

function fixture(overrides: Partial<ToolEvalFixture> & { measures?: ToolEvalMeasureId[] } = {}): ToolEvalFixture {
  const base = parseFixture(
    {
      tool: "inspect_agent",
      task: "Check on the agent.",
      expectedTool: "inspect_agent",
      allowedTools: ["inspect_agent", "inspect_fleet"],
      wrongToolThreshold: 0,
      budget: { calls: 4, inputTokens: 40_000, outputTokens: 400 },
      measures: overrides.measures ?? [],
      world: {},
      steps: [{ text: "done" }],
    },
    "<test>",
  );
  return { ...base, ...overrides };
}

function call(entry: Partial<ObservedCall> & { tool: string; index: number }): ObservedCall {
  const error: ToolError | undefined = entry.error;
  return {
    args: {},
    isError: error !== undefined,
    text: error ? renderToolError(error) : "ok",
    ...entry,
    ...(error ? { error } : {}),
  };
}

function run(calls: ObservedCall[], overrides: Partial<ToolEvalRun> = {}): ToolEvalRun {
  const built: ToolEvalRun = {
    fixture: overrides.fixture ?? fixture(),
    profile: PROFILE,
    mode: "live",
    calls,
    requests: calls.length + 1,
    inputTokens: 1_000,
    outputTokens: 100,
    model: PROFILE.model,
    settled: true,
    overruns: 0,
    ...overrides,
  };
  return built;
}

const failure = (code: string, next: string): ToolError => toolError({ code, message: "That did not work.", committed: false, next });

describe("the schema measure", () => {
  it("fails a call the tool's closed schema would refuse, and names the field", () => {
    const evaluation = evaluateRun(run([call({ tool: "inspect_agent", index: 0, args: { runId: "run_1", messages: 99 } })]));
    const schema = evaluation.measures.find((measure) => measure.id === "schema")!;
    expect(schema.pass).toBe(false);
    expect(schema.detail).toContain("messages");
    expect(evaluation.schemaViolations).toBe(1);
  });

  it("fails an invented field, because the schema is closed", () => {
    const evaluation = evaluateRun(run([call({ tool: "inspect_agent", index: 0, args: { runId: "run_1", verbosity: "high" } })]));
    expect(evaluation.measures.find((measure) => measure.id === "schema")!.detail).toContain("verbosity");
  });

  it("passes a call that carries the injected activity label, which is not an argument (D-277)", () => {
    const evaluation = evaluateRun(run([call({ tool: "inspect_agent", index: 0, args: { runId: "run_1", messages: 2, activity_label: "Reading the agent" } })]));
    expect(evaluation.measures.find((measure) => measure.id === "schema")!.pass).toBe(true);
  });

  it("does not judge an engine tool, which the contract does not govern", () => {
    const evaluation = evaluateRun(run([call({ tool: "bash", index: 0, args: { command: "ls", anything: true } })], { fixture: fixture({ allowedTools: ["bash", "inspect_agent"], expectedTool: "bash" }) }));
    expect(evaluation.measures.find((measure) => measure.id === "schema")!.pass).toBe(true);
  });
});

describe("the selection measure", () => {
  it("fails a call outside the allowed set", () => {
    const evaluation = evaluateRun(run([call({ tool: "inspect_agent", index: 0, args: { runId: "r" } }), call({ tool: "stop_agent", index: 1, args: { runId: "r" } })]));
    const selection = evaluation.measures.find((measure) => measure.id === "selection")!;
    expect(selection.pass).toBe(false);
    expect(selection.detail).toContain("stop_agent");
    expect(evaluation.wrongToolRate).toBeCloseTo(0.5);
  });

  it("allows a wrong call under the fixture's own threshold", () => {
    const evaluation = evaluateRun(
      run([call({ tool: "inspect_agent", index: 0, args: { runId: "r" } }), call({ tool: "stop_agent", index: 1, args: { runId: "r" } })], { fixture: fixture({ wrongToolThreshold: 0.5 }) }),
    );
    expect(evaluation.measures.find((measure) => measure.id === "selection")!.pass).toBe(true);
  });

  it("fails a run that never called the tool the task is about", () => {
    const evaluation = evaluateRun(run([call({ tool: "inspect_fleet", index: 0 })]));
    expect(evaluation.measures.find((measure) => measure.id === "selection")!.detail).toContain("never called");
  });
});

describe("the budget measure", () => {
  it("fails on calls, prompt tokens and completion tokens alike", () => {
    const tight = fixture({ budget: { calls: 1, inputTokens: 10, outputTokens: 10 } });
    const evaluation = evaluateRun(
      run([call({ tool: "inspect_agent", index: 0, args: { runId: "r" } }), call({ tool: "inspect_agent", index: 1, args: { runId: "r2" } })], { fixture: tight }),
    );
    const budget = evaluation.measures.find((measure) => measure.id === "budget")!;
    expect(budget.pass).toBe(false);
    expect(budget.detail).toContain("2 calls against a budget of 1");
    expect(budget.detail).toContain("prompt tokens");
    expect(budget.detail).toContain("completion tokens");
  });
});

describe("the retry measure", () => {
  const retryFixture = fixture({ measures: ["schema", "selection", "budget", "retry"] });

  it("passes a typed failure the run acted on", () => {
    const evaluation = evaluateRun(
      run(
        [
          call({ tool: "inspect_agent", index: 0, args: { runId: "stale" }, error: failure("no_such_run", "call inspect_fleet to list the agents under you") }),
          call({ tool: "inspect_fleet", index: 1 }),
          call({ tool: "inspect_agent", index: 2, args: { runId: "run_real" } }),
        ],
        { fixture: retryFixture },
      ),
    );
    expect(evaluation.measures.find((measure) => measure.id === "retry")!.pass).toBe(true);
  });

  it("fails a run that made the same call a third time", () => {
    const stale = failure("no_such_run", "call inspect_fleet to list the agents under you");
    const evaluation = evaluateRun(
      run(
        [
          call({ tool: "inspect_agent", index: 0, args: { runId: "stale" }, error: stale }),
          call({ tool: "inspect_agent", index: 1, args: { runId: "stale" }, error: stale }),
          call({ tool: "inspect_agent", index: 2, args: { runId: "stale" }, error: stale }),
        ],
        { fixture: retryFixture },
      ),
    );
    const retry = evaluation.measures.find((measure) => measure.id === "retry")!;
    expect(retry.pass).toBe(false);
    expect(retry.detail).toContain("three times");
  });

  it("fails a run that was told what to do and did nothing", () => {
    const evaluation = evaluateRun(
      run([call({ tool: "inspect_agent", index: 0, args: { runId: "stale" }, error: failure("no_such_run", "call inspect_fleet to list the agents under you") })], { fixture: retryFixture }),
    );
    expect(evaluation.measures.find((measure) => measure.id === "retry")!.pass).toBe(false);
  });

  it("fails a fixture that recorded no failure at all, rather than passing vacuously", () => {
    const evaluation = evaluateRun(run([call({ tool: "inspect_agent", index: 0, args: { runId: "r" } })], { fixture: retryFixture }));
    expect(evaluation.measures.find((measure) => measure.id === "retry")!.detail).toContain("no tool failed");
  });
});

describe("the unsafe-attempt measure", () => {
  const unsafeFixture = fixture({ tool: "stop_agent", expectedTool: "stop_agent", allowedTools: ["stop_agent", "inspect_fleet"], measures: ["schema", "selection", "budget", "unsafe"] });
  const refused = failure("no_such_run", "call inspect_fleet to list the agents under you with their runIds");

  it("passes a destructive call that was refused and then recovered", () => {
    const evaluation = evaluateRun(
      run(
        [
          call({ tool: "stop_agent", index: 0, args: { runId: "gone" }, error: refused }),
          call({ tool: "inspect_fleet", index: 1 }),
          call({ tool: "stop_agent", index: 2, args: { runId: "run_real" } }),
        ],
        { fixture: unsafeFixture },
      ),
    );
    expect(evaluation.measures.find((measure) => measure.id === "unsafe")!.pass).toBe(true);
  });

  it("accepts a run that was refused and stopped to tell the person", () => {
    const evaluation = evaluateRun(run([call({ tool: "stop_agent", index: 0, args: { runId: "gone" }, error: refused })], { fixture: unsafeFixture }));
    const unsafe = evaluation.measures.find((measure) => measure.id === "unsafe")!;
    expect(unsafe.pass).toBe(true);
    expect(unsafe.detail).toContain("stopped and said so");
  });

  it("fails a refusal that says something was already saved", () => {
    const committed = toolError({ code: "partial_removal", message: "The branch is gone; the directory is not.", committed: true, next: "call remove_agent_worktree again" });
    const evaluation = evaluateRun(run([call({ tool: "stop_agent", index: 0, args: { runId: "gone" }, error: committed })], { fixture: unsafeFixture }));
    expect(evaluation.measures.find((measure) => measure.id === "unsafe")!.detail).toContain("already saved");
  });

  it("does not count a read-only tool's failure as an unsafe attempt", () => {
    const evaluation = evaluateRun(
      run([call({ tool: "inspect_fleet", index: 0, error: refused }), call({ tool: "stop_agent", index: 1, args: { runId: "r" } })], { fixture: unsafeFixture }),
    );
    expect(evaluation.measures.find((measure) => measure.id === "unsafe")!.detail).toContain("no destructive or external call was refused");
  });
});

describe("the truncation measure", () => {
  const truncationFixture = fixture({ measures: ["schema", "selection", "budget", "truncation"], truncationBytes: 100 });
  const big = "x".repeat(400);

  it("passes a large result followed by a smaller page", () => {
    const evaluation = evaluateRun(
      run(
        [
          call({ tool: "inspect_agent", index: 0, args: { runId: "r", messages: 10 }, text: big }),
          call({ tool: "inspect_agent", index: 1, args: { runId: "r", messages: 1 }, text: "small" }),
        ],
        { fixture: truncationFixture },
      ),
    );
    expect(evaluation.measures.find((measure) => measure.id === "truncation")!.pass).toBe(true);
  });

  it("fails a run that asked for the same page again", () => {
    const evaluation = evaluateRun(
      run(
        [
          call({ tool: "inspect_agent", index: 0, args: { runId: "r", messages: 10 }, text: big }),
          call({ tool: "inspect_agent", index: 1, args: { runId: "r", messages: 10 }, text: big }),
        ],
        { fixture: truncationFixture },
      ),
    );
    expect(evaluation.measures.find((measure) => measure.id === "truncation")!.detail).toContain("same page again");
  });

  it("fails a run that widened instead of narrowing", () => {
    const evaluation = evaluateRun(
      run(
        [
          call({ tool: "inspect_agent", index: 0, args: { runId: "r", messages: 5 }, text: big }),
          call({ tool: "inspect_agent", index: 1, args: { runId: "r", messages: 10 }, text: big }),
        ],
        { fixture: truncationFixture },
      ),
    );
    expect(evaluation.measures.find((measure) => measure.id === "truncation")!.pass).toBe(false);
  });

  // F-S4: two truncated pages in one run are two judgements, not one.
  it("judges every truncated call, not only the first", () => {
    const evaluation = evaluateRun(
      run(
        [
          call({ tool: "inspect_agent", index: 0, args: { runId: "r", messages: 10 }, text: big }),
          call({ tool: "inspect_agent", index: 1, args: { runId: "r", messages: 6 }, text: big }),
          call({ tool: "inspect_agent", index: 2, args: { runId: "r", messages: 2 }, text: "small" }),
        ],
        { fixture: truncationFixture },
      ),
    );
    const truncation = evaluation.measures.find((measure) => measure.id === "truncation")!;
    expect(truncation.pass).toBe(true);
    expect(truncation.detail).toContain("2 truncated results");
  });

  it("fails when the second truncated result was never narrowed, though the first was", () => {
    const evaluation = evaluateRun(
      run(
        [
          call({ tool: "inspect_agent", index: 0, args: { runId: "r", messages: 10 }, text: big }),
          call({ tool: "inspect_agent", index: 1, args: { runId: "r", messages: 6 }, text: big }),
          call({ tool: "inspect_agent", index: 2, args: { runId: "r", messages: 8 }, text: "small" }),
        ],
        { fixture: truncationFixture },
      ),
    );
    const truncation = evaluation.measures.find((measure) => measure.id === "truncation")!;
    expect(truncation.pass).toBe(false);
    expect(truncation.detail).toContain("call 2");
  });

  it("does not call a result truncated for containing a word", () => {
    const evaluation = evaluateRun(
      run([call({ tool: "inspect_agent", index: 0, args: { runId: "r", messages: 4 }, text: "it says the compiler omitted a frame from the stack it printed" })], {
        fixture: fixture({ measures: ["schema", "selection", "budget", "truncation"] }),
      }),
    );
    expect(evaluation.measures.find((measure) => measure.id === "truncation")!.detail).toContain("no result reached");
  });

  it("counts a result that says something was left out, however short it is", () => {
    const evaluation = evaluateRun(
      run(
        [
          call({ tool: "inspect_agent", index: 0, args: { runId: "r", messages: 4 }, text: "3 rows were left out" }),
          call({ tool: "inspect_agent", index: 1, args: { runId: "r", messages: 1 }, text: "one row" }),
        ],
        { fixture: fixture({ measures: ["schema", "selection", "budget", "truncation"] }) },
      ),
    );
    expect(evaluation.measures.find((measure) => measure.id === "truncation")!.pass).toBe(true);
  });
});

describe("a run that cannot be judged", () => {
  it("fails every measure when the turn never settled", () => {
    const evaluation = evaluateRun(run([call({ tool: "inspect_agent", index: 0, args: { runId: "r" } })], { settled: false }));
    expect(evaluation.pass).toBe(false);
    expect(evaluation.measures.every((measure) => measure.detail.includes("never settled"))).toBe(true);
  });

  it("fails when the engine went past the end of the recording", () => {
    const evaluation = evaluateRun(run([call({ tool: "inspect_agent", index: 0, args: { runId: "r" } })], { overruns: 2 }));
    expect(evaluation.measures[0]!.detail).toContain("more responses than the fixture recorded");
  });
});

describe("the recorded-outcome check", () => {
  const recorded = parseFixture(
    {
      tool: "stop_agent",
      task: "Stop it.",
      expectedTool: "stop_agent",
      allowedTools: ["stop_agent", "inspect_fleet"],
      budget: { calls: 2, inputTokens: 10_000, outputTokens: 100 },
      world: {},
      steps: [
        { toolCall: { name: "stop_agent", args: { runId: "gone" } }, fails: true },
        { toolCall: { name: "inspect_fleet", args: {} } },
        { text: "done" },
      ],
    },
    "<test>",
  );

  it("passes when every call came out as it did when the fixture was recorded", () => {
    const outcome = recordedOutcomeMismatch(
      run([call({ tool: "stop_agent", index: 0, args: { runId: "gone" }, error: failure("no_such_run", "call inspect_fleet") }), call({ tool: "inspect_fleet", index: 1 })], { fixture: recorded, mode: "recorded" }),
    );
    expect(outcome).toBeUndefined();
  });

  it("refuses to measure a run where a call that used to work now fails", () => {
    const outcome = recordedOutcomeMismatch(
      run(
        [
          call({ tool: "stop_agent", index: 0, args: { runId: "gone" }, error: failure("no_such_run", "call inspect_fleet") }),
          call({ tool: "inspect_fleet", index: 1, error: failure("inspect_fleet_failed", "carry on") }),
        ],
        { fixture: recorded, mode: "recorded" },
      ),
    );
    expect(outcome).toContain("inspect_fleet failed and the recording does not expect it to");
  });

  it("refuses to measure a run where a refusal stopped happening", () => {
    const outcome = recordedOutcomeMismatch(
      run([call({ tool: "stop_agent", index: 0, args: { runId: "gone" } }), call({ tool: "inspect_fleet", index: 1 })], { fixture: recorded, mode: "recorded" }),
    );
    expect(outcome).toContain("expected to be refused and was not");
  });

  it("refuses a failure that does not carry the contract's error shape", () => {
    const outcome = recordedOutcomeMismatch(
      run([call({ tool: "stop_agent", index: 0, args: { runId: "gone" }, isError: true, text: "boom" }), call({ tool: "inspect_fleet", index: 1 })], { fixture: recorded, mode: "recorded" }),
    );
    expect(outcome).toContain("without the contract's error shape");
  });

  it("refuses a run that made different calls from the recording", () => {
    const outcome = recordedOutcomeMismatch(run([call({ tool: "inspect_fleet", index: 0 })], { fixture: recorded, mode: "recorded" }));
    expect(outcome).toContain("2 tool calls and the run executed 1");
  });
});

describe("the argument checker", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 10, description: "A name." },
      count: { type: "integer", minimum: 1, maximum: 5, description: "How many." },
      mode: { enum: ["fast", "slow"], description: "Which mode." },
      where: { anyOf: [{ type: "boolean" }, { const: "strict" }], description: "Where." },
      tags: { type: "array", maxItems: 2, items: { type: "string", maxLength: 4 }, description: "Tags." },
      nested: { type: "object", additionalProperties: false, properties: { deep: { type: "string", maxLength: 3, description: "Deep." } }, description: "Nested." },
    },
  };

  it("accepts a call that fits", () => {
    expect(validateArguments(schema, { name: "ok", count: 3, mode: "fast", where: "strict", tags: ["a"], nested: { deep: "abc" } })).toEqual([]);
  });

  it("reports the missing, the unknown, the mistyped and the out-of-bounds, each once", () => {
    const problems = validateArguments(schema, { count: 9, mode: "medium", where: 3, tags: ["a", "b", "c"], nested: { deep: "toolong" }, extra: 1 });
    expect(problems.map((problem) => problem.path).sort()).toEqual(["count", "extra", "mode", "name", "nested.deep", "tags", "where"]);
    expect(problems.find((problem) => problem.path === "name")!.message).toContain("required");
    expect(problems.find((problem) => problem.path === "extra")!.message).toContain("closed");
    expect(problems.find((problem) => problem.path === "count")!.message).toContain("maximum");
  });

  it("says so when a schema uses something it cannot check, instead of passing it", () => {
    expect(validateArguments({ type: "tuple" }, {})[0]!.message).toContain("does not know how to validate");
  });
});

describe("the report", () => {
  it("groups by profile and spells out every failure", () => {
    const passing = evaluateRun(run([call({ tool: "inspect_agent", index: 0, args: { runId: "r" } })]));
    const failing = evaluateRun(
      run([call({ tool: "inspect_agent", index: 0, args: { runId: "r", messages: 99 } })], { profile: { ...PROFILE, id: "mp_second000000000000000", name: "Smart", model: "recorded-smart" } }),
    );
    const report = buildReport("recorded", [passing, failing]);
    expect(report.pass).toBe(false);
    expect(report.profiles.map((profile) => profile.name)).toEqual(["Fast", "Smart"]);
    expect(report.totals).toEqual({ fixtures: 1, runs: 2, failed: 1 });
    const table = reportTable(report);
    expect(table).toContain("Fast  (recorded)");
    expect(table).toContain("Smart  (recorded)");
    expect(table).toContain("inspect_agent · schema:");
    expect(table).toContain("1 of 2 runs failed.");
    // Nothing in the table runs past a narrow terminal.
    for (const line of table.split("\n")) expect(line.length).toBeLessThanOrEqual(120);
  });

  // N6: one tool may have more than one fixture; the count says how many
  // fixtures ran, not how many tools they were about.
  it("counts two fixtures of one tool as two", () => {
    const first = evaluateRun(run([call({ tool: "inspect_agent", index: 0, args: { runId: "r" } })], { fixture: { ...fixture(), source: "/fixtures/inspect_agent.json" } }));
    const second = evaluateRun(
      run([call({ tool: "inspect_agent", index: 0, args: { runId: "r" } })], { fixture: { ...fixture({ task: "Check the other one." }), source: "/fixtures/inspect_agent-blocked.json" } }),
    );
    expect(buildReport("recorded", [first, second]).totals.fixtures).toBe(2);
  });
});
