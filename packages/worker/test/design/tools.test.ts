/**
 * The three Design Index tools: the contract lint, the handlers against a
 * real project, and the conformance fixtures replayed.
 *
 * **What this proves and what it does not.** The specs are linted by the
 * contract's own `toolContract()`, the handlers are the real ones, the world
 * is a real project indexed by the real builder, and every refusal is the
 * contract's `{ code, message, committed, next }`. What is *not* exercised
 * here is the engine's own tool loop: this file replays the three fixtures
 * against the handlers directly, which is the cheaper of the two proofs. The
 * matrix in `test/tool-eval/fixtures.test.ts` runs the same files through the
 * real engine and the real registrations, since M21-T17 registered the tools
 * (`docs/leap/m21-design-index-plan.md` decision 6, `m21-tools-plan.md`).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { toolContract, type LaserToolSpec } from "@lasercode/protocol";
import { afterAll, describe, expect, it } from "vitest";
import { parseFixture, type ToolEvalFixture } from "../../src/tool-eval/fixture.js";
import { ScriptedDesignWorld } from "../../src/tool-eval/design-world.js";
import {
  BUILD_DESIGN_INDEX_SPEC,
  DESIGN_INDEX_TOOL_RECOVERY,
  DESIGN_INDEX_TOOL_SPECS,
  DesignToolFailure,
  INSPECT_DESIGN_INDEX_SPEC,
  REVIEW_DESIGN_INDEX_SPEC,
  buildDesignIndexTool,
  inspectDesignIndex,
  reviewDesignIndexTool,
  type DesignIndexBridge,
} from "../../src/design/index/tools.js";
import { FIXTURE_ROOT } from "./helpers.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "tool-eval");
const DESIGN_FIXTURES = ["build_design_index.json", "inspect_design_index.json", "review_design_index.json"];
const AGENT = { kind: "agent" as const, label: "Design worker" };
const worlds: ScriptedDesignWorld[] = [];

function world(project: string, built: boolean): ScriptedDesignWorld {
  const instance = new ScriptedDesignWorld({ projectSource: join(FIXTURE_ROOT, project), built });
  worlds.push(instance);
  return instance;
}

afterAll(() => {
  for (const instance of worlds) instance.dispose();
});

describe("the three specs", () => {
  it("obey the tool contract", () => {
    for (const spec of DESIGN_INDEX_TOOL_SPECS) {
      expect(toolContract(spec), spec.name).toEqual([]);
    }
  });

  it("are the three the design contract names, with honest annotations", () => {
    expect(DESIGN_INDEX_TOOL_SPECS.map((spec) => spec.name)).toEqual(["inspect_design_index", "build_design_index", "review_design_index"]);
    expect(INSPECT_DESIGN_INDEX_SPEC.annotations).toEqual({ readOnly: true, idempotent: true, destructive: false, external: false });
    // Building twice builds twice; nothing leaves the machine; nothing is destroyed.
    expect(BUILD_DESIGN_INDEX_SPEC.annotations).toEqual({ readOnly: false, idempotent: false, destructive: false, external: false });
    expect(REVIEW_DESIGN_INDEX_SPEC.annotations).toEqual({ readOnly: false, idempotent: true, destructive: false, external: false });
    for (const spec of DESIGN_INDEX_TOOL_SPECS) {
      expect(spec.label).toBe("injected");
      expect(DESIGN_INDEX_TOOL_RECOVERY[spec.name]?.next.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("declares an output for each, with no free-form blob", () => {
    for (const spec of DESIGN_INDEX_TOOL_SPECS) {
      const output = spec.output as { type?: string; properties?: Record<string, unknown> };
      expect(output.type, spec.name).toBe("object");
      expect(Object.keys(output.properties ?? {}).length, spec.name).toBeGreaterThan(2);
    }
  });
});

describe("inspect_design_index", () => {
  it("refuses with the call to make when the project has no index", async () => {
    const scripted = world("vue-scss", false);
    await scripted.prepare();
    await expect(inspectDesignIndex(scripted, {})).rejects.toThrow(DesignToolFailure);
    try {
      await inspectDesignIndex(scripted, {});
    } catch (error) {
      const failure = (error as DesignToolFailure).toolError;
      expect(failure.code).toBe("no_index");
      expect(failure.committed).toBe(false);
      expect(failure.next).toContain("build_design_index");
    }
  });

  it("answers with the eras, the entries and the review counts", async () => {
    const scripted = world("react-tailwind", true);
    await scripted.prepare();
    const answer = await inspectDesignIndex(scripted, { query: "button", kind: "component", limit: 5 });
    expect(String(answer["stack"])).toContain("React");
    expect((answer["eras"] as Array<{ useForNewWork: boolean }>)[0]?.useForNewWork).toBe(true);
    const entries = answer["entries"] as Array<Record<string, unknown>>;
    expect(entries.map((entry) => entry["name"])).toContain("Button");
    expect(entries[0]?.["factsDigest"]).toMatch(/^[0-9a-f]{64}$/);
    expect((answer["counts"] as { total: number }).total).toBeGreaterThan(5);
  });

  it("pages, and says when it cut the list", async () => {
    const scripted = world("react-tailwind", true);
    await scripted.prepare();
    const answer = await inspectDesignIndex(scripted, { limit: 3 });
    expect((answer["entries"] as unknown[]).length).toBe(3);
    expect(answer["truncated"]).toBe(true);
  });

  it("returns one entry in full, and refuses an id it does not have", async () => {
    const scripted = world("react-tailwind", true);
    await scripted.prepare();
    const button = await scripted.entry("component", "Button");
    const answer = await inspectDesignIndex(scripted, { entry_id: button!.id });
    const entries = answer["entries"] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(String(entries[0]?.["detail"])).toContain("variant=primary");
    await expect(inspectDesignIndex(scripted, { entry_id: "e_nope" })).rejects.toThrow(/has no entry/);
  });
});

describe("build_design_index", () => {
  it("starts the command and answers with its id, without waiting", async () => {
    const scripted = world("vue-scss", false);
    await scripted.prepare();
    const answer = await buildDesignIndexTool(scripted, {});
    expect(String(answer["commandId"])).toMatch(/^cmd_/);
    expect(String(answer["note"])).toContain("fleet");
    const index = await inspectDesignIndex(scripted, { kind: "token", limit: 5 });
    expect((index["entries"] as unknown[]).length).toBeGreaterThan(0);
  });

  it("refuses an app root outside the project", async () => {
    const scripted = world("vue-scss", true);
    await scripted.prepare();
    await expect(buildDesignIndexTool(scripted, { app_root: "../../etc" })).rejects.toThrow(/inside this project/);
    await expect(buildDesignIndexTool(scripted, { app_root: "/var/tmp" })).rejects.toThrow(/inside this project/);
  });
});

describe("review_design_index", () => {
  it("records a decision, attributes it to the agent, and counts the progress", async () => {
    const scripted = world("react-tailwind", true);
    await scripted.prepare();
    const card = await scripted.entry("component", "Card");
    const answer = await reviewDesignIndexTool(scripted, { entry_id: card!.id, action: "rename", name: "Panel", facts_digest: card!.factsDigest }, AGENT);
    expect(answer["name"]).toBe("Panel");
    expect(answer["reviewState"]).toBe("renamed");
    expect(String(answer["reviewedBy"])).toContain("(agent)");
    expect(answer["reviewed"]).toBe(1);
    // It stuck: a second read shows the person-facing name.
    const after = await inspectDesignIndex(scripted, { entry_id: card!.id });
    expect((after["entries"] as Array<Record<string, unknown>>)[0]?.["name"]).toBe("Panel");
  });

  it("refuses a stale digest with the call that fixes it, and the retry works", async () => {
    const scripted = world("react-tailwind", true);
    await scripted.prepare();
    const button = await scripted.entry("component", "Button");
    try {
      await reviewDesignIndexTool(scripted, { entry_id: button!.id, action: "accept", facts_digest: "0".repeat(64) }, AGENT);
      throw new Error("the stale digest should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("re-indexed after you read it");
    }
    const answer = await reviewDesignIndexTool(scripted, { entry_id: button!.id, action: "accept", facts_digest: button!.factsDigest }, AGENT);
    expect(answer["reviewState"]).toBe("accepted");
  });

  it("refuses an action it does not have", async () => {
    const scripted = world("react-tailwind", true);
    await scripted.prepare();
    const button = await scripted.entry("component", "Button");
    await expect(reviewDesignIndexTool(scripted, { entry_id: button!.id, action: "delete" as never }, AGENT)).rejects.toThrow(/not something this tool can record/);
  });
});

// --------------------------------------------------------------- the fixtures

type Handler = (bridge: DesignIndexBridge, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

const HANDLERS: Record<string, Handler> = {
  inspect_design_index: (bridge, args) => inspectDesignIndex(bridge, args as never),
  build_design_index: (bridge, args) => buildDesignIndexTool(bridge, args as never),
  review_design_index: (bridge, args) => reviewDesignIndexTool(bridge, args as never, AGENT),
};

/** `{{entry:component:Card:id}}`, `{{entry:component:Card:digest}}`, `{{stale}}`. */
async function resolve(value: unknown, scripted: ScriptedDesignWorld): Promise<unknown> {
  if (typeof value !== "string") return value;
  if (value === "{{stale}}") return "0".repeat(64);
  const match = /^\{\{entry:([a-z]+):([^:]+):(id|digest)\}\}$/.exec(value);
  if (!match) return value;
  const entry = await scripted.entry(match[1] as never, match[2] ?? "");
  if (!entry) throw new Error(`the fixture names an entry the world does not have: ${value}`);
  return match[3] === "id" ? entry.id : entry.factsDigest;
}

function loadDesignFixtures(): ToolEvalFixture[] {
  return readdirSync(FIXTURES)
    .filter((name) => DESIGN_FIXTURES.includes(name))
    .sort()
    .map((name) => parseFixture(JSON.parse(readFileSync(join(FIXTURES, name), "utf8")), join(FIXTURES, name)));
}

describe("the conformance fixtures", () => {
  const fixtures = loadDesignFixtures();

  it("has one for each tool, in the harness's own format", () => {
    expect(fixtures.map((fixture) => fixture.tool).sort()).toEqual(["build_design_index", "inspect_design_index", "review_design_index"]);
    for (const fixture of fixtures) {
      expect(fixture.world.designIndex?.project, fixture.tool).toBeDefined();
      expect(fixture.measures).toEqual(expect.arrayContaining(["schema", "selection", "budget"]));
    }
  });

  for (const fixture of loadDesignFixtures()) {
    it(`replays ${fixture.tool} exactly as it was recorded`, async () => {
      const declared = fixture.world.designIndex!;
      const scripted = world(declared.project, declared.built === true);
      await scripted.prepare();

      let calls = 0;
      let lastFailureNext: string | undefined;
      for (const step of fixture.steps) {
        if (!("toolCall" in step)) continue;
        calls += 1;
        const name = step.toolCall.name;
        // Selection: a recorded call is one the task was allowed to make.
        expect(fixture.allowedTools, `${fixture.tool}: ${name}`).toContain(name);
        const handler = HANDLERS[name];
        expect(handler, `${fixture.tool} names an unknown tool: ${name}`).toBeDefined();

        const args: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(step.toolCall.args)) {
          if (key === "activity_label") continue;
          args[key] = await resolve(value, scripted);
        }
        // Schema: every recorded argument is one the tool declares.
        const spec = DESIGN_INDEX_TOOL_SPECS.find((candidate) => candidate.name === name) as LaserToolSpec;
        const properties = Object.keys((spec.input as { properties: Record<string, unknown> }).properties);
        for (const key of Object.keys(args)) expect(properties, `${name}.${key}`).toContain(key);

        if (step.fails === true) {
          let failure: unknown;
          try {
            await handler!(scripted, args);
          } catch (error) {
            failure = error;
          }
          expect(failure, `${fixture.tool}: ${name} was recorded as failing and did not`).toBeInstanceOf(DesignToolFailure);
          const toolError = (failure as DesignToolFailure).toolError;
          expect(toolError.code.length).toBeGreaterThan(0);
          expect(toolError.committed).toBe(false);
          expect(toolError.next.length).toBeGreaterThan(0);
          lastFailureNext = toolError.next;
          continue;
        }
        const result = await handler!(scripted, args);
        expect(result, `${fixture.tool}: ${name} answered nothing`).toBeTruthy();
        // Retry: the call after a refusal is the one the refusal named.
        if (lastFailureNext !== undefined) {
          expect(lastFailureNext, `${fixture.tool}: the recovery named a different call than ${name}`).toContain(name);
          lastFailureNext = undefined;
        }
      }
      expect(calls, `${fixture.tool} went over its call budget`).toBeLessThanOrEqual(fixture.budget.calls);
      expect(fixture.steps.at(-1)).toHaveProperty("text");
    });
  }
});
