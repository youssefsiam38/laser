/**
 * The foundation's rules, where both sides read them from (M21-T14).
 *
 * The worker proposes and the window edits, so anything they must agree on
 * lives in the protocol: the fixed order of the ten steps, what "complete"
 * means, the bytes the Design Profile digest is taken over, the token-name
 * diff a superseded foundation shows, and the implementation ordering a Plan
 * inherits from it. Each is pinned here rather than in either consumer.
 */
import { describe, expect, it } from "vitest";
import {
  FOUNDATION_STEP_IDS,
  FOUNDATION_STEPS,
  checkFoundationStepOrder,
  designBodySchema,
  designFoundationSchema,
  foundationBlockedSources,
  foundationCanonicalJson,
  foundationIsComplete,
  foundationPlanSkeleton,
  foundationPlanWithKeys,
  foundationProgress,
  foundationStep,
  foundationStepIndex,
  foundationSteps,
  foundationTokenDiff,
  foundationTokenNames,
  nextFoundationStep,
  withFoundationStep,
  type DesignBody,
  type DesignFoundation,
  type FoundationStepRecord,
} from "../src/index.js";

function accepted(...ids: readonly string[]): DesignFoundation {
  return {
    principles: ["One colour carries meaning."],
    steps: ids.map((id) => ({ id, state: "accepted", source: "model" }) as FoundationStepRecord),
  };
}

const FULL: DesignFoundation = {
  principles: ["One colour carries meaning."],
  status: "proposed",
  steps: FOUNDATION_STEP_IDS.map((id) => ({ id, state: "accepted", source: "model" }) as FoundationStepRecord),
  tokens: { color: { bg: { $value: "#ffffff", $type: "color" }, ink: { $value: "#111111", $type: "color" } } },
  modes: [{ name: "dark", tokens: { color: { bg: { $value: "#101010", $type: "color" } } } }],
  typeScale: [{ name: "body", size: "16px", lineHeight: "24px" }],
  scales: { spacing: [{ name: "1", value: "4px" }] },
  motion: { durations: [{ name: "fast", value: "140ms" }], easings: [{ name: "standard", value: "linear" }], reducedMotion: "Opacity only." },
  sources: [
    { id: "lucide", kind: "icons", name: "Lucide", version: "0.544.0", licence: { classification: "permissive", spdx: "ISC" }, recommended: true, reason: "ISC: permissive." },
    { id: "mystery", kind: "illustrations", name: "Mystery art", licence: { classification: "unknown" }, recommended: false, reason: "Nobody declared a licence." },
  ],
  layoutRules: ["One page frame."],
  accessibility: { contrastMin: 4.5, minFontPx: 12, focusVisible: "A two-pixel ring.", rules: ["Keyboard first."] },
  components: [{ name: "Button", purpose: "The one thing this screen wants.", variants: ["primary"] }],
};

describe("the ordered steps", () => {
  it("are the contract's ten, each with a label and a purpose", () => {
    expect(FOUNDATION_STEPS.map((step) => step.id)).toEqual([...FOUNDATION_STEP_IDS]);
    for (const step of FOUNDATION_STEPS) {
      expect(step.label.length, step.id).toBeGreaterThan(2);
      expect(step.purpose.length, step.id).toBeGreaterThan(20);
      expect(step.writes.length, step.id).toBeGreaterThan(0);
    }
    expect(foundationStep("motion")?.label).toBe("Motion");
    expect(foundationStepIndex("nope")).toBe(-1);
  });

  it("refuse a step before its inputs, naming what blocks it", () => {
    const refusal = checkFoundationStepOrder(accepted("principles"), "motion");
    expect(refusal?.code).toBe("out_of_order");
    expect(refusal?.blockedBy).toBe("primitive_tokens");
    expect(refusal?.message).toContain("primitive tokens");
    expect(checkFoundationStepOrder(accepted("principles"), "primitive_tokens")).toBeUndefined();
    expect(checkFoundationStepOrder(undefined, "principles")).toBeUndefined();
  });

  it("refuse an unknown step and a re-proposal of an accepted one, unless replacing", () => {
    expect(checkFoundationStepOrder(accepted(), "colours")?.code).toBe("unknown_step");
    expect(checkFoundationStepOrder(accepted("principles"), "principles")?.code).toBe("already_accepted");
    expect(checkFoundationStepOrder(accepted("principles"), "principles", { replace: true })).toBeUndefined();
  });

  /**
   * Both sides write a step record through this, so neither can drift on
   * where the row lands. What goes *in* the record stays each side's own: the
   * worker composes a fresh one for a proposal, the window patches the one it
   * is showing.
   */
  it("replace one step's record in place, in the contract's order", () => {
    const foundation = accepted("primitive_tokens", "principles");
    const replaced = withFoundationStep(foundation, { id: "principles", state: "proposed", source: "person", edited: true });
    expect(replaced.steps?.map((step) => step.id)).toEqual(["principles", "primitive_tokens"]);
    expect(replaced.steps?.[0]).toEqual({ id: "principles", state: "proposed", source: "person", edited: true });
    // One row per step, and the foundation itself is not mutated.
    expect(replaced.steps?.filter((step) => step.id === "principles")).toHaveLength(1);
    expect(foundation.steps?.[0]?.state).toBe("accepted");
    expect(foundation.steps).toHaveLength(2);

    // A step nobody recorded yet is added, in its place in the order.
    const added = withFoundationStep(accepted("principles"), { id: "motion", state: "proposed", source: "model" });
    expect(added.steps?.map((step) => step.id)).toEqual(["principles", "motion"]);

    // A record the order does not know is carried, not dropped: losing a
    // stored decision silently is worse than sorting it last.
    const unknown = withFoundationStep(accepted("principles"), { id: "colours", state: "proposed", source: "model" } as FoundationStepRecord);
    expect(unknown.steps?.map((step) => step.id)).toEqual(["principles", "colours"]);
  });

  it("report the next step, the progress and the order however the steps were stored", () => {
    expect(nextFoundationStep(accepted("principles", "primitive_tokens"))).toBe("semantic_tokens");
    expect(nextFoundationStep(FULL)).toBeUndefined();
    expect(foundationIsComplete(FULL)).toBe(true);
    expect(foundationProgress(accepted("principles"))).toEqual({ accepted: 1, total: 10 });
    const scrambled: DesignFoundation = { principles: [], steps: [...(FULL.steps ?? [])].reverse() };
    expect(foundationSteps(scrambled).map((step) => step.id)).toEqual([...FOUNDATION_STEP_IDS]);
  });
});

describe("the body", () => {
  it("validates a whole foundation, and still validates the shape that came before it", () => {
    expect(designFoundationSchema.safeParse(FULL).success).toBe(true);
    // Additive: a body written before M21-T14 carried principles, a blob id
    // and a note, and must read back unchanged.
    const old: DesignBody = {
      brief: "before",
      foundation: { principles: ["a"], tokensBlobId: "blb_1", notes: "n" },
      screens: [],
      flows: [],
      sketches: [],
      fidelity: "proposed",
      fixtures: [],
    };
    expect(designBodySchema.safeParse(old).success).toBe(true);
  });

  it("refuses a field it does not know, and an accessibility floor that is not a number", () => {
    expect(designFoundationSchema.safeParse({ principles: [], invented: true }).success).toBe(false);
    expect(designFoundationSchema.safeParse({ principles: [], accessibility: { contrastMin: "lots", minFontPx: 12, focusVisible: "x", rules: [] } }).success).toBe(false);
  });

  it("lists the sources it may not recommend, with the reason", () => {
    expect(foundationBlockedSources(FULL)).toEqual([{ id: "mystery", name: "Mystery art", reason: "Nobody declared a licence." }]);
  });
});

describe("the Design Profile digest", () => {
  it("is taken over content, in a fixed order, and ignores the approval's own record", () => {
    const first = foundationCanonicalJson(FULL);
    const approved: DesignFoundation = { ...FULL, status: "approved", profile: { version: 1, digest: "a".repeat(64), approvedAt: "2026-01-01T00:00:00.000Z" } };
    expect(foundationCanonicalJson(approved)).toBe(first);
    const superseded: DesignFoundation = { ...FULL, supersededBy: { indexId: "idx", added: [], removed: [] } };
    expect(foundationCanonicalJson(superseded)).toBe(first);
    // Step bookkeeping is not content either: accepting a step does not move
    // the digest of what was accepted.
    expect(foundationCanonicalJson({ ...FULL, steps: [] })).toBe(first);
  });

  it("moves when anything a person approved moves", () => {
    expect(foundationCanonicalJson({ ...FULL, principles: ["something else"] })).not.toBe(foundationCanonicalJson(FULL));
    expect(foundationCanonicalJson({ ...FULL, components: [] })).not.toBe(foundationCanonicalJson(FULL));
  });
});

describe("tokens and the index that supersedes them", () => {
  it("names every token, in the base document and in every mode", () => {
    expect(foundationTokenNames(FULL)).toEqual(["color.bg", "color.ink"]);
  });

  it("diffs the names a rebuilt index holds against the ones that were approved", () => {
    const diff = foundationTokenDiff(foundationTokenNames(FULL), ["color.bg", "color.accent"]);
    expect(diff).toEqual({ added: ["color.accent"], removed: ["color.ink"], kept: ["color.bg"] });
  });
});

describe("implementation ordering", () => {
  it("puts the foundation first and makes everything else depend on it", () => {
    const skeleton = foundationPlanSkeleton(FULL, {
      designKey: "DES-3",
      product: "a reading app",
      followOn: [
        { title: "Library", outcome: "Every book a person has." },
        { title: "Reader", outcome: "One book, read." },
      ],
    });
    expect(skeleton.tasks).toHaveLength(3);
    expect(skeleton.tasks[0]?.phaseId).toBe("foundation");
    expect(skeleton.tasks[0]?.body.acceptance.map((entry) => entry.id)).toContain("indexed");
    expect(skeleton.tasks[0]?.body.notes).toContain("Mystery art");
    expect(skeleton.plan.document).toContain("DES-3");

    const plan = foundationPlanWithKeys(skeleton, ["TASK-1", "TASK-2", "TASK-3"]);
    expect(plan.phases[0]?.taskKeys).toEqual(["TASK-1"]);
    expect(plan.phases[1]?.taskKeys).toEqual(["TASK-2", "TASK-3"]);
    expect(plan.dependencies).toEqual([
      { from: "TASK-2", to: "TASK-1", reason: expect.any(String) },
      { from: "TASK-3", to: "TASK-1", reason: expect.any(String) },
    ]);
  });

  it("produces one phase and one task when nothing follows yet", () => {
    const skeleton = foundationPlanSkeleton(FULL, {});
    expect(skeleton.plan.phases).toHaveLength(1);
    const plan = foundationPlanWithKeys(skeleton, ["TASK-9"]);
    expect(plan.phases[0]?.taskKeys).toEqual(["TASK-9"]);
    expect(plan.dependencies).toEqual([]);
  });
});
