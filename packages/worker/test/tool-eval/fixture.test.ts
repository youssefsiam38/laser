/**
 * M26-T3 · the fixture format and the profile matrix.
 *
 * A fixture is data a person writes by hand — every tool that lands after
 * this one writes one — so the loader's job is to refuse a half-understood
 * file with a sentence that names the field, never to guess. These are the
 * refusals.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFixtures, parseFixture } from "../../src/tool-eval/fixture.js";
import { profilesFrom } from "../../src/tool-eval/harness.js";
import { profileMatrix } from "../../src/tool-eval/run.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "tool-eval");

const good = {
  tool: "inspect_agent",
  task: "Check on the agent.",
  expectedTool: "inspect_agent",
  allowedTools: ["inspect_agent"],
  budget: { calls: 1, inputTokens: 100, outputTokens: 10 },
  world: {},
  steps: [{ toolCall: { name: "inspect_agent", args: { runId: "run_1" } } }, { text: "done" }],
};

describe("the fixture format", () => {
  it("fills in the defaults a fixture may leave out", () => {
    const fixture = parseFixture(good, "<test>");
    expect(fixture.wrongToolThreshold).toBe(0);
    expect(fixture.measures).toEqual(["schema", "selection", "budget"]);
    expect(fixture.truncationBytes).toBeUndefined();
    expect(fixture.source).toBe("<test>");
  });

  it("keeps the measures in the contract's own order, however they were declared", () => {
    const fixture = parseFixture({ ...good, measures: ["truncation", "retry"] }, "<test>");
    expect(fixture.measures).toEqual(["schema", "selection", "budget", "retry", "truncation"]);
  });

  it("names the field in every refusal", () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ ...good, tool: "" }, /tool must be a non-empty string/],
      [{ ...good, allowedTools: [] }, /allowedTools must list at least the expected tool/],
      [{ ...good, expectedTool: "stop_agent" }, /allowedTools must contain expectedTool/],
      [{ ...good, budget: undefined }, /budget must declare calls, inputTokens and outputTokens/],
      [{ ...good, budget: { calls: 1, inputTokens: 1 } }, /budget.outputTokens must be a number/],
      [{ ...good, steps: [] }, /steps must hold at least one recorded response/],
      [{ ...good, steps: [{}] }, /steps\[0\] must carry either text or toolCall/],
      [{ ...good, steps: [{ toolCall: { name: "x", args: 4 } }] }, /steps\[0\].toolCall.args must be an object/],
      [{ ...good, steps: [{ toolCall: { name: "x" }, fails: "yes" }] }, /steps\[0\].fails must be true or false/],
      [{ ...good, measures: ["speed"] }, /"speed" is not a measure/],
      [{ ...good, world: 7 }, /world must be an object/],
      ["not an object", /the file must hold a JSON object/],
    ];
    for (const [value, expected] of cases) {
      expect(() => parseFixture(value, "<test>"), JSON.stringify(value).slice(0, 60)).toThrow(expected);
    }
  });

  it("says where it was reading when it refused", () => {
    expect(() => parseFixture({ ...good, tool: 4 }, "/tmp/fixtures/broken.json")).toThrow(/\/tmp\/fixtures\/broken.json is not a usable tool-evaluation fixture/);
  });

  it("loads the package's own fixtures in a stable order", () => {
    const first = loadFixtures(FIXTURES).map((fixture) => fixture.tool);
    const second = loadFixtures(FIXTURES).map((fixture) => fixture.tool);
    expect(first).toEqual(second);
    expect(first).toContain("task_output");
    // The profiles directory beside them is not a fixture.
    expect(first).not.toContain("settings");
  });
});

describe("the profile matrix", () => {
  it("takes the preferred model of each profile, which is what a run answers as", () => {
    const matrix = profileMatrix([
      { id: "mp_a", name: "Fast", models: [{ provider: "recorded", id: "one" }, { provider: "recorded", id: "two" }], origin: "person", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "mp_b", name: "Empty", models: [], origin: "person", updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(matrix).toEqual([{ id: "mp_a", name: "Fast", model: "one", provider: "recorded" }]);
  });

  it("reads the fixture settings file with the product's own reader", () => {
    const profiles = profilesFrom(join(FIXTURES, "profiles"));
    expect(profiles.map((profile) => profile.name)).toEqual(["Fast", "Smart"]);
  });

  it("narrows to one profile by name or by id, and says what there is when there is no such profile", () => {
    expect(profilesFrom(join(FIXTURES, "profiles"), "smart").map((profile) => profile.name)).toEqual(["Smart"]);
    expect(profilesFrom(join(FIXTURES, "profiles"), "mp_evaluationfast0000000000").map((profile) => profile.name)).toEqual(["Fast"]);
    expect(() => profilesFrom(join(FIXTURES, "profiles"), "Balanced")).toThrow(/No profile called "Balanced" is configured. The profiles there are: Fast, Smart./);
  });
});
