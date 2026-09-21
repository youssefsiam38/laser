/**
 * Foundation mode, worker side (M21-T14).
 *
 * What is pinned here is what the contract actually promises a person:
 *
 * 1. **The order is the product.** A step composed before its inputs exist is
 *    refused, in the sentence the window shows.
 * 2. **A proposal is validated, not trusted.** A model answer that does not
 *    meet a step's rules, or does not fit the protocol schema, falls back —
 *    and the fallback says where it came from.
 * 3. **Unknown licences block.** A source whose licence nobody declared is
 *    never recommended, and the reason is a sentence, not a chip.
 * 4. **The repository is untouched.** A whole foundation is proposed against
 *    a real project directory, and the directory is byte-identical
 *    afterwards — down to file mtimes and the absence of new files.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FOUNDATION_STEP_IDS,
  designBodySchema,
  designFoundationSchema,
  foundationCanonicalJson,
  foundationIsComplete,
  foundationPlanSkeleton,
  foundationPlanWithKeys,
  foundationTokenDiff,
  foundationTokenNames,
  nextFoundationStep,
  toolContract,
  type DesignFoundation,
  type FoundationStepId,
  type ModelProfile,
} from "@lasercode/protocol";
import {
  FOUNDATION_FALLBACK_NOTE,
  PROPOSE_FOUNDATION_SPEC,
  acceptFoundationStep,
  applyFoundationPatch,
  checkSource,
  classifyLicence,
  declaredLicenceFrom,
  foundationBrief,
  neutralFoundation,
  parseFoundationJson,
  proposeFoundationStep,
  proposeFoundationTool,
  storeFoundation,
  type FoundationModelAccess,
} from "../../src/design/foundation/index.js";
import { ScriptedProjectWorkWorld } from "../../src/tool-eval/project-work-world.js";

const EMPTY: DesignFoundation = { principles: [], status: "proposed", steps: [] };

/** Walk every accepted step up to (not including) `stop`, with no models. */
async function upTo(stop: FoundationStepId | undefined): Promise<DesignFoundation> {
  let foundation = EMPTY;
  for (const id of FOUNDATION_STEP_IDS) {
    if (id === stop) break;
    const proposal = await proposeFoundationStep(foundation, id, { inputs: {} });
    foundation = acceptFoundationStep(proposal.foundation, id);
  }
  return foundation;
}

/** A profile whose one model answers with whatever this returns. */
function scriptedAccess(answer: (system: string) => string): FoundationModelAccess {
  const profile = { id: "prof_design", name: "Design", models: [{ provider: "test", id: "test-model" }] } as unknown as ModelProfile;
  return {
    profile,
    models: async () =>
      ({
        getModel: () => ({ id: "test-model", provider: "test" }),
        completeSimple: async (_model: unknown, context: { systemPrompt?: string }) => ({
          content: [{ type: "text", text: answer(context.systemPrompt ?? "") }],
        }),
      }) as never,
  };
}

describe("the proposal steps", () => {
  it("are the ten of the contract, in its order", () => {
    expect([...FOUNDATION_STEP_IDS]).toEqual([
      "principles",
      "primitive_tokens",
      "semantic_tokens",
      "type_scale",
      "space_radius_shadow_z",
      "motion",
      "icon_and_asset_sources",
      "layout_rules",
      "accessibility_floor",
      "component_contracts",
    ]);
  });

  it("refuse a step whose inputs are not settled, naming the one that blocks it", async () => {
    await expect(proposeFoundationStep(EMPTY, "component_contracts", {})).rejects.toThrow(/principles is not settled/i);
    try {
      await proposeFoundationStep(EMPTY, "type_scale", {});
    } catch (error) {
      expect((error as { code: string }).code).toBe("out_of_order");
      expect((error as { next: string }).next).toContain("principles");
    }
  });

  it("may be re-proposed while they are only proposed, and move on once accepted", async () => {
    const first = await proposeFoundationStep(EMPTY, "principles", {});
    expect(first.record.state).toBe("proposed");
    const again = await proposeFoundationStep(first.foundation, "principles", {});
    expect(again.record.state).toBe("proposed");
    const accepted = acceptFoundationStep(again.foundation, "principles");
    expect(nextFoundationStep(accepted)).toBe("primitive_tokens");
    // The next step is now allowed, and the one after it still is not.
    await expect(proposeFoundationStep(accepted, "primitive_tokens", {})).resolves.toBeTruthy();
    await expect(proposeFoundationStep(accepted, "type_scale", {})).rejects.toThrow(/not settled/i);
  });

  it("walk all ten to a complete, schema-valid foundation with no profile connected", async () => {
    let foundation = EMPTY;
    for (const id of FOUNDATION_STEP_IDS) {
      const proposal = await proposeFoundationStep(foundation, id, { inputs: { product: "a reading app" } });
      expect(proposal.fallback).toBe(true);
      expect(proposal.record.note).toBe(FOUNDATION_FALLBACK_NOTE);
      expect(proposal.record.state).toBe("proposed");
      foundation = acceptFoundationStep(proposal.foundation, id);
    }
    expect(foundationIsComplete(foundation)).toBe(true);
    expect(designFoundationSchema.safeParse(foundation).success).toBe(true);
    expect(foundation.components?.map((component) => component.name)).toEqual(
      expect.arrayContaining(["Button", "Input", "Select", "Checkbox", "Card", "Dialog", "Toast", "Nav", "Table", "Empty", "Error", "Loading"]),
    );
    expect(foundation.accessibility?.minFontPx).toBeGreaterThanOrEqual(12);
    expect(foundationTokenNames(foundation).length).toBeGreaterThan(20);
  });

  it("keep the person's brand colours when the neutral foundation stands in", async () => {
    const principles = await proposeFoundationStep(EMPTY, "principles", { inputs: { brandColours: ["#ff0055"] } });
    const accepted = acceptFoundationStep(principles.foundation, "principles");
    const tokens = await proposeFoundationStep(accepted, "primitive_tokens", { inputs: { brandColours: ["#ff0055", "not a colour"] } });
    expect(JSON.stringify(tokens.foundation.tokens)).toContain("#ff0055");
    expect(JSON.stringify(tokens.foundation.tokens)).not.toContain("not a colour");
  });

  it("give the model the accepted steps and the person's own words, bounded", async () => {
    const foundation = await upTo("type_scale");
    const brief = foundationBrief("type_scale", foundation, {
      product: "a scheduling tool",
      feelsLike: "Linear, but calmer",
      references: [{ label: "brand page", text: "x".repeat(9000) }],
    });
    expect(brief).toContain("a scheduling tool");
    expect(brief).toContain("Linear, but calmer");
    expect(brief).toContain("Accepted so far");
    expect(brief).toContain("Principles:");
    expect(brief.length).toBeLessThanOrEqual(12_100);
  });

  it("take a model answer that meets the step's rules", async () => {
    const access = scriptedAccess(() =>
      JSON.stringify({ principles: ["One colour carries meaning.", "Nothing below 12px.", "Every state designed."], summary: "Three rules." }),
    );
    const proposal = await proposeFoundationStep(EMPTY, "principles", { access });
    expect(proposal.fallback).toBe(false);
    expect(proposal.record.source).toBe("model");
    expect(proposal.record.model).toBe("test-model");
    expect(proposal.foundation.principles).toHaveLength(3);
  });

  it("fall back, and say so, when the model breaks the step's own rule", async () => {
    // 10px is under the legibility floor: the step is not repaired quietly.
    const access = scriptedAccess(() => JSON.stringify({ typeScale: [{ name: "tiny", size: "10px" }, { name: "body", size: "16px" }, { name: "h1", size: "24px" }] }));
    const foundation = await upTo("type_scale");
    const proposal = await proposeFoundationStep(foundation, "type_scale", { access });
    expect(proposal.fallback).toBe(true);
    expect(proposal.issues[0]).toContain("did not meet this step's rules");
    expect(proposal.foundation.typeScale?.every((step) => Number.parseFloat(step.size) >= 12)).toBe(true);
  });

  it("fall back when the answer is not JSON at all", async () => {
    const access = scriptedAccess(() => "Here are some lovely principles for you!");
    const proposal = await proposeFoundationStep(EMPTY, "principles", { access });
    expect(proposal.fallback).toBe(true);
    expect(proposal.issues[0]).toContain("did not answer with JSON");
  });

  it("read JSON out of a fenced answer", () => {
    expect(parseFoundationJson('```json\n{"a":1}\n```')?.["a"]).toBe(1);
    expect(parseFoundationJson("no json here")).toBeUndefined();
  });

  it("refuse a patch that would not fit the protocol schema", () => {
    const applied = applyFoundationPatch(EMPTY, { principles: ["x".repeat(900)] });
    expect(applied.ok).toBe(false);
  });

  it("accept a step as the person, recording that they edited it", () => {
    const foundation = acceptFoundationStep({ ...EMPTY, steps: [{ id: "principles", state: "proposed", source: "fallback" }] }, "principles", { edited: true });
    const step = foundation.steps?.[0];
    expect(step?.state).toBe("accepted");
    expect(step?.edited).toBe(true);
    expect(step?.source).toBe("person");
  });
});

describe("licence checks", () => {
  it("classify the permissive set and recommend a pinned one", () => {
    expect(classifyLicence("MIT").classification).toBe("permissive");
    expect(classifyLicence("Apache-2.0").classification).toBe("permissive");
    expect(classifyLicence("OFL-1.1").recommended).toBe(true);
    const checked = checkSource({ id: "lucide", kind: "icons", name: "Lucide", version: "0.544.0", declaredLicence: "ISC" });
    expect(checked.recommended).toBe(true);
    expect(checked.licence.spdx).toBe("ISC");
  });

  it("refuse to recommend copyleft and proprietary, and say which it is", () => {
    const gpl = checkSource({ id: "x", kind: "icons", name: "Some icons", version: "1.0.0", declaredLicence: "GPL-3.0" });
    expect(gpl.licence.classification).toBe("copyleft");
    expect(gpl.recommended).toBe(false);
    expect(gpl.reason).toContain("copyleft");
    const closed = checkSource({ id: "y", kind: "fonts", name: "A foundry font", version: "2.0.0", declaredLicence: "UNLICENSED" });
    expect(closed.licence.classification).toBe("proprietary");
    expect(closed.recommended).toBe(false);
  });

  it("block an unknown licence outright, and say what would unblock it", () => {
    const nothing = checkSource({ id: "z", kind: "illustrations", name: "Some art", version: "1.0.0" });
    expect(nothing.licence.classification).toBe("unknown");
    expect(nothing.recommended).toBe(false);
    expect(nothing.reason).toContain("declares no licence");
    const unrecognised = classifyLicence("Weird Community Licence v9");
    expect(unrecognised.classification).toBe("unknown");
    expect(unrecognised.recommended).toBe(false);
    expect(unrecognised.reason).toContain("does not recognise");
  });

  it("take the most permissive branch of a dual licence", () => {
    expect(classifyLicence("MIT OR GPL-3.0").classification).toBe("permissive");
    expect(classifyLicence("(GPL-2.0 AND MPL-2.0)").classification).toBe("copyleft");
  });

  it("read the licence out of a manifest, or a licence file's heading", () => {
    expect(declaredLicenceFrom('{"name":"pkg","license":"MIT"}')).toEqual({ declared: "MIT", declaredIn: "manifest: license" });
    expect(declaredLicenceFrom('{"license":{"type":"ISC"}}').declared).toBe("ISC");
    expect(declaredLicenceFrom("MIT License\n\nCopyright (c) 2026").declared).toContain("MIT License");
    expect(declaredLicenceFrom("{not json at all")).toEqual({});
    expect(classifyLicence(declaredLicenceFrom("{broken").declared).classification).toBe("unknown");
  });

  it("refuse to recommend a source with no exact version, however permissive", () => {
    const ranged = checkSource({ id: "r", kind: "icons", name: "Ranged icons", version: "^1.2.0", declaredLicence: "MIT" });
    expect(ranged.licence.classification).toBe("permissive");
    expect(ranged.recommended).toBe(false);
    expect(ranged.reason).toContain("exact version");
  });

  it("classify what a model claims rather than believing it", async () => {
    const access = scriptedAccess(() =>
      JSON.stringify({
        sources: [
          { id: "mystery", kind: "icons", name: "Mystery Icons", version: "1.0.0", licence: "Mystery Public Licence" },
          { id: "lucide", kind: "icons", name: "Lucide", version: "0.544.0", licence: "ISC" },
        ],
      }),
    );
    const foundation = await upTo("icon_and_asset_sources");
    const proposal = await proposeFoundationStep(foundation, "icon_and_asset_sources", { access });
    const sources = proposal.foundation.sources ?? [];
    expect(sources.find((source) => source.id === "mystery")?.recommended).toBe(false);
    expect(sources.find((source) => source.id === "mystery")?.licence.classification).toBe("unknown");
    expect(sources.find((source) => source.id === "lucide")?.recommended).toBe(true);
  });

  it("every source the neutral foundation proposes is permissive, pinned and recommended", () => {
    for (const source of neutralFoundation().sources ?? []) {
      expect(source.licence.classification, source.name).toBe("permissive");
      expect(source.recommended, source.name).toBe(true);
      expect(source.version, source.name).toMatch(/^\d+\.\d+\.\d+/);
    }
  });
});

describe("storage", () => {
  it("never touches the repository: the project directory is byte-identical after a whole foundation", async () => {
    const base = mkdtempSync(join(tmpdir(), "foundation-storage-"));
    const project = join(base, "project");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "package.json"), '{"name":"greenfield","private":true}\n');
    writeFileSync(join(project, "src", "main.ts"), "export const start = () => undefined;\n");
    const before = snapshot(project);

    const world = new ScriptedProjectWorkWorld({});
    let foundation = EMPTY;
    let key: string | undefined;
    let entityId: string | undefined;
    for (const [index, id] of FOUNDATION_STEP_IDS.entries()) {
      const proposal = await proposeFoundationStep(foundation, id, {});
      const stored = await storeFoundation(world, {
        ...(entityId ? { design: (await load(world, entityId)) } : {}),
        foundation: proposal.foundation,
        note: "step",
        idempotencyKey: `step-${String(index)}`,
      });
      key = stored.key;
      entityId = stored.entityId;
      foundation = acceptFoundationStep(proposal.foundation, id);
    }
    expect(key).toMatch(/^DES-\d+$/);
    expect(snapshot(project)).toEqual(before);
    rmSync(base, { recursive: true, force: true });
  });

  it("imports no filesystem or process API, so it could not write to a project", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "..", "src", "design", "foundation", "storage.ts"), "utf8");
    expect(source).not.toMatch(/from "node:(fs|fs\/promises|child_process|http|https|net)"/);
    expect(source).not.toMatch(/writeFileSync|mkdirSync|spawn|exec\(/);
  });

  it("keeps the screens and sketches a design already has", async () => {
    const world = new ScriptedProjectWorkWorld({});
    const first = await storeFoundation(world, { foundation: neutralFoundation(), note: "created", idempotencyKey: "one" });
    const loaded = await load(world, first.entityId);
    const withScreen = {
      ...loaded,
      body: {
        ...loaded.body,
        brief: "kept",
        fixtures: [{ id: "fx_1", name: "rows", rows: 3 }],
      },
    };
    const second = await storeFoundation(world, { design: withScreen, foundation: { ...neutralFoundation(), notes: "edited" }, note: "revised", idempotencyKey: "two" });
    expect(second.created).toBe(false);
    const after = await load(world, second.entityId);
    expect(after.body.brief).toBe("kept");
    expect(after.body.fixtures).toHaveLength(1);
    expect(after.body.foundation?.notes).toBe("edited");
  });
});

describe("propose_foundation", () => {
  it("obeys the tool contract and declares what it is", () => {
    expect(toolContract(PROPOSE_FOUNDATION_SPEC)).toEqual([]);
    expect(PROPOSE_FOUNDATION_SPEC.annotations).toEqual({ readOnly: false, idempotent: false, destructive: false, external: false });
    expect(PROPOSE_FOUNDATION_SPEC.label).toBe("injected");
  });

  it("proposes the next step, stores it and answers with the refs", async () => {
    const world = new ScriptedProjectWorkWorld({});
    const first = await proposeFoundationTool({ work: world }, { idempotency_key: "k1", product: "a reading app" });
    expect(first["step"]).toBe("principles");
    expect(first["state"]).toBe("proposed");
    expect(String(first["key"])).toMatch(/^DES-\d+$/);
    expect(String(first["revision_id"]).length).toBeGreaterThan(0);
    expect(String(first["note"])).toContain("Nothing has been written into the project");
    expect(first["next_step"]).toBe("primitive_tokens");
    expect(first["accepted_steps"]).toBe(0);
    expect(first["total_steps"]).toBe(10);
    // The step is stored where the window reads it.
    const stored = await load(world, String(first["entity_id"]));
    expect(stored.body.foundation?.steps?.[0]?.id).toBe("principles");
    expect(designBodySchema.safeParse(stored.body).success).toBe(true);
  });

  it("refuses a step whose inputs are not settled, with the call to make", async () => {
    const world = new ScriptedProjectWorkWorld({});
    const first = await proposeFoundationTool({ work: world }, { idempotency_key: "k1" });
    await expect(
      proposeFoundationTool({ work: world }, { idempotency_key: "k2", entity_id: String(first["entity_id"]), step: "motion" }),
    ).rejects.toThrow(/not settled/i);
  });

  it("refuses to propose onto something that is not a design", async () => {
    const world = new ScriptedProjectWorkWorld({
      items: [{ kind: "spec", title: "A spec", body: { kind: "spec", spec: { form: "brief", summary: "x", problem: "y", requirements: [], openQuestions: [], outOfScope: [] } } }],
    });
    const spec = world.entity("SPEC-1");
    await expect(proposeFoundationTool({ work: world }, { idempotency_key: "k", entity_id: spec!.entity.entityId })).rejects.toThrow(/is a spec/);
  });

  it("refuses in a projectless chat, and says what would fix it", async () => {
    const world = new ScriptedProjectWorkWorld({ hasProject: false });
    await expect(proposeFoundationTool({ work: world }, { idempotency_key: "k" })).rejects.toThrow(/not working in a project/);
  });

  it("names sources it cannot recommend on the answer", async () => {
    const world = new ScriptedProjectWorkWorld({});
    let answer = await proposeFoundationTool({ work: world }, { idempotency_key: "k0" });
    const entityId = String(answer["entity_id"]);
    // Accept each step as the person would, then ask for the next one.
    for (const id of FOUNDATION_STEP_IDS) {
      const design = await load(world, entityId);
      const accepted = acceptFoundationStep(design.body.foundation!, id);
      await storeFoundation(world, { design, foundation: accepted, note: "accepted", idempotencyKey: `accept-${id}` });
      const next = nextFoundationStep(accepted);
      if (next === undefined) break;
      answer = await proposeFoundationTool({ work: world }, { idempotency_key: `k-${next}`, entity_id: entityId, step: next });
    }
    const design = await load(world, entityId);
    expect(foundationIsComplete(design.body.foundation)).toBe(true);
    await expect(proposeFoundationTool({ work: world }, { idempotency_key: "k-done", entity_id: entityId })).rejects.toThrow(/every step/i);
  });
});

describe("the Design Profile digest and the ordering helper", () => {
  it("takes the digest over content only, so approving does not move it", () => {
    const foundation = neutralFoundation();
    const digest = createHash("sha256").update(foundationCanonicalJson(foundation)).digest("hex");
    const approved: DesignFoundation = { ...foundation, status: "approved", profile: { version: 1, digest } };
    expect(createHash("sha256").update(foundationCanonicalJson(approved)).digest("hex")).toBe(digest);
    // Key order does not move it; content does.
    const reordered: DesignFoundation = { components: foundation.components, ...foundation };
    expect(foundationCanonicalJson(reordered)).toBe(foundationCanonicalJson(foundation));
    expect(foundationCanonicalJson({ ...foundation, principles: ["different"] })).not.toBe(foundationCanonicalJson(foundation));
  });

  it("puts the foundation task first, with everything else depending on it", () => {
    const skeleton = foundationPlanSkeleton(neutralFoundation(), {
      designKey: "DESIGN-1",
      product: "a reading app",
      followOn: [{ title: "The library screen", outcome: "A person can see every book they have." }],
    });
    expect(skeleton.tasks[0]?.title).toContain("foundation");
    expect(skeleton.plan.phases[0]?.id).toBe("foundation");
    const plan = foundationPlanWithKeys(skeleton, ["TASK-1", "TASK-2"]);
    expect(plan.phases[0]?.taskKeys).toEqual(["TASK-1"]);
    expect(plan.phases[1]?.taskKeys).toEqual(["TASK-2"]);
    expect(plan.dependencies).toEqual([{ from: "TASK-2", to: "TASK-1", reason: expect.stringContaining("foundation") }]);
  });

  it("names a blocked source in the task's notes and in the plan's risks", () => {
    const foundation = neutralFoundation();
    foundation.sources = [...(foundation.sources ?? []), checkSource({ id: "q", kind: "icons", name: "Mystery Icons", version: "1.0.0" })];
    const skeleton = foundationPlanSkeleton(foundation, {});
    expect(skeleton.tasks[0]?.body.notes).toContain("Mystery Icons");
    expect(skeleton.plan.risks.some((risk) => risk.summary.includes("licence"))).toBe(true);
  });

  it("diffs token names when the built source is indexed", () => {
    const diff = foundationTokenDiff(["color.bg", "color.ink"], ["color.bg", "color.surface"]);
    expect(diff.added).toEqual(["color.surface"]);
    expect(diff.removed).toEqual(["color.ink"]);
    expect(diff.kept).toEqual(["color.bg"]);
  });
});

// ---------------------------------------------------------------------- utils

async function load(world: ScriptedProjectWorkWorld, entityId: string) {
  const { loadDesign } = await import("../../src/design/foundation/storage.js");
  const design = await loadDesign(world, { entityId });
  if (!design) throw new Error("the scripted world lost the design");
  return design;
}

/** Every file under a directory, with its bytes and its modification time. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const stats = statSync(path);
      out[relative(root, path)] = `${createHash("sha256").update(readFileSync(path)).digest("hex")}:${String(stats.mtimeMs)}`;
    }
  };
  walk(root);
  return out;
}
