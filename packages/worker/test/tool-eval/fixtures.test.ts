/**
 * M26-T3 · the conformance fixtures, on every configured profile.
 *
 * This is the harness doing its job: every Laser tool's fixture replayed
 * through the real engine, the real driver and the real tool registrations,
 * on each profile of the fixture settings file, with every measure of
 * `docs/agent-tool-contract.md` §4 asserted. A tool whose schema, refusal
 * wording, error shape, page bounds or description size changes in a way that
 * breaks a model's use of it fails here.
 *
 * Nothing in it reaches the network: the provider is a replay server on
 * 127.0.0.1, the harness bridge is scripted, and the one external tool is
 * evaluated through the refusal a machine with no connected search provider
 * really gives. The live run a person starts (`pnpm tool-eval --live`) is
 * never run from here.
 */
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { LASER_TOOL_NAMES } from "@lasercode/protocol";
import { laserToolRegistry } from "@lasercode/pi-extension";
import { loadFixtures, TOOL_EVAL_MEASURES, type ToolEvalFixture } from "../../src/tool-eval/fixture.js";
import { profilesFrom } from "../../src/tool-eval/harness.js";
import { evaluateRun } from "../../src/tool-eval/measures.js";
import { buildReport, reportTable } from "../../src/tool-eval/report.js";
import { runFixture, type ToolEvalProfile } from "../../src/tool-eval/run.js";
import type { FixtureEvaluation } from "../../src/tool-eval/measures.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "tool-eval");

/**
 * Every tool under the contract today: the ten M26 brought under it (D-350.d),
 * the eleven project-work tools M21-T17 registered — the four lifecycle tools,
 * the three Design Index tools and the four Research tools — and the verifier
 * M21-T19 added beside them.
 */
const TOOLS = [
  "start_agent",
  "send_agent_message",
  "inspect_fleet",
  "inspect_agent",
  "stop_agent",
  "remove_agent_worktree",
  "complete_agent_run",
  "task_output",
  "task_stop",
  "web_search",
  "inspect_project_work",
  "write_project_artifact",
  "request_project_review",
  "report_project_task",
  "verify_project_task",
  "inspect_design_index",
  "build_design_index",
  "review_design_index",
  "ground_host_page",
  "search_sources",
  "read_source",
  "record_finding",
  "resolve_question",
];

let fixtures: ToolEvalFixture[];
let profiles: ToolEvalProfile[];

beforeAll(() => {
  fixtures = loadFixtures(FIXTURES);
  profiles = profilesFrom(join(FIXTURES, "profiles"));
});

describe("the tool evaluation matrix", () => {
  it("has a fixture for every registered tool and at least two profiles", () => {
    expect(fixtures.map((fixture) => fixture.tool).sort()).toEqual([...TOOLS].sort());
    expect(profiles.length).toBeGreaterThanOrEqual(2);
    // The profiles differ in the one thing a recorded run can vary: the model.
    expect(new Set(profiles.map((profile) => profile.model)).size).toBe(profiles.length);
  });

  it("passes every measure of every fixture on every profile", async () => {
    const results: FixtureEvaluation[] = [];
    for (const profile of profiles) {
      for (const fixture of fixtures) {
        const run = await runFixture({ fixture, profile, timeoutMs: 60_000 });
        const evaluation = evaluateRun(run);
        results.push(evaluation);
        // Named per run, so a failure says which tool on which profile and why
        // rather than "20 runs, one of them failed".
        const failures = evaluation.measures.filter((measure) => !measure.pass);
        expect(failures.map((measure) => `${profile.name} · ${fixture.tool} · ${measure.id}: ${measure.detail}`), `${profile.name} · ${fixture.tool}`).toEqual([]);
        expect(run.overruns, `${profile.name} · ${fixture.tool} asked for responses past the end of its recording`).toBe(0);
        expect(run.model, `${profile.name} ran on the wrong model`).toBe(profile.model);
      }
    }
    // F-S1: the pin that makes the list above honest. Every run registered the
    // real tools, so the registry now holds the whole tool surface of a root
    // session and a child one; a tool registered without a fixture, or a
    // fixture for a tool nobody registers, fails here rather than passing
    // silently. The protocol's own list — what the transcript reads, which may
    // not import the engine — is pinned to the same set.
    const registered = [...laserToolRegistry().keys()].sort();
    expect(registered, "every registered tool has an evaluation fixture, and every fixture a registered tool").toEqual([...TOOLS].sort());
    expect([...LASER_TOOL_NAMES].sort(), "LASER_TOOL_NAMES names exactly the registered tools").toEqual(registered);
    const report = buildReport("recorded", results);
    expect(report.pass).toBe(true);
    expect(report.totals).toEqual({ fixtures: fixtures.length, runs: TOOLS.length * profiles.length, failed: 0 });
    // The report a person reads holds every profile and every tool, and says so.
    const table = reportTable(report);
    for (const profile of profiles) expect(table).toContain(profile.name);
    for (const tool of TOOLS) expect(table).toContain(tool);
    expect(table).toContain(`All ${String(report.totals.runs)} runs passed`);
  }, 300_000);

  it("measures every fixture on the three measures that always apply, and the declared ones as well", () => {
    for (const fixture of fixtures) {
      expect(fixture.measures, fixture.tool).toEqual(expect.arrayContaining(["schema", "selection", "budget"]));
      expect(fixture.measures.every((measure) => TOOL_EVAL_MEASURES.includes(measure)), fixture.tool).toBe(true);
    }
    // The optional three are each exercised by at least one tool, or the
    // contract's own measures would have no proof behind them.
    const declared = new Set(fixtures.flatMap((fixture) => fixture.measures));
    expect(declared.has("retry")).toBe(true);
    expect(declared.has("unsafe")).toBe(true);
    expect(declared.has("truncation")).toBe(true);
  });

  it("keeps a credential out of every fixture", () => {
    for (const fixture of fixtures) {
      const text = JSON.stringify(fixture);
      expect(text, fixture.tool).not.toMatch(/api[_-]?key|secret|bearer |password|\bsk-[a-z0-9]{8}/i);
    }
  });
});
