/**
 * L1 · synthesis: the profile walk, the citation rule and the labels.
 *
 * The model is a stub here for the same reason session naming's is: what has
 * to be proven is the *contract* — one bounded completion per model in the
 * profile's order, strict JSON, `inferred` only with two or more cited facts,
 * and an item that cites something the parse never produced dropped rather
 * than shown.
 */
import type { ModelProfile } from "@lasercode/protocol";
import { afterAll, describe, expect, it } from "vitest";
import { applySynthesis, canSynthesise, parseSynthesisJson, synthesise, synthesisBrief, synthesisEntries } from "../../src/design/index/l1-synthesis.js";
import type { CompletionContext, CompletionResult, CompletionRuntime } from "../../src/agents/session-naming.js";
import { buildFixture, cleanupFixtures, entryNamed } from "./helpers.js";

afterAll(cleanupFixtures);

function profile(models: Array<{ provider: string; id: string }>): ModelProfile {
  return { id: "design-index", name: "Smart", models, origin: "person", updatedAt: "2026-01-01T00:00:00.000Z" } as ModelProfile;
}

interface StubCall {
  model: string;
  context: CompletionContext;
}

function runtime(answers: Record<string, string | Error>, calls: StubCall[] = []): { models: () => Promise<CompletionRuntime>; calls: StubCall[] } {
  const models = async (): Promise<CompletionRuntime> => ({
    getModel: (provider, id) => (answers[id] === undefined ? undefined : { provider, id }),
    completeSimple: async (model, context): Promise<CompletionResult> => {
      calls.push({ model: model.id, context });
      const answer = answers[model.id];
      if (answer instanceof Error) throw answer;
      return { content: [{ type: "text", text: answer ?? "" }] };
    },
  });
  return { models, calls };
}

describe("the brief the model is given", () => {
  it("carries the stack, the entries and the fact ids, and is bounded", async () => {
    const { index, l0 } = await buildFixture("react-tailwind");
    const brief = synthesisBrief(index, l0.facts);
    expect(brief).toContain("Stack: frameworks React");
    expect(brief).toContain("Components (entry id");
    expect(brief).toContain(entryNamed(index, "component", "Button")!.id);
    expect(brief).toContain(l0.facts[0]!.id);
    expect(brief.length).toBeLessThanOrEqual(24_200);
  });
});

describe("the profile walk", () => {
  it("passes over a model that is missing, fails or answers unusably", async () => {
    const { index, l0 } = await buildFixture("vue-scss");
    const card = entryNamed(index, "component", "Card")!;
    const cite = l0.facts.find((fact) => fact.kind === "component" && fact.name === "Card")!.id;
    const second = l0.facts.find((fact) => fact.kind === "prop")!.id;
    const good = JSON.stringify({
      components: [{ entryId: card.id, purpose: "A titled panel used for one idea at a time.", whenToUse: "Grouping related fields.", cites: [cite, second] }],
    });
    const calls: StubCall[] = [];
    const { models } = runtime({ "model-b": new Error("upstream is down"), "model-c": "sorry, no JSON here", "model-d": good }, calls);
    const result = await synthesise(index, l0.facts, {
      models,
      profile: profile([{ provider: "p", id: "model-a" }, { provider: "p", id: "model-b" }, { provider: "p", id: "model-c" }, { provider: "p", id: "model-d" }]),
    });
    // model-a is not in the runtime at all, so it is passed over without a call.
    expect(calls.map((call) => call.model)).toEqual(["model-b", "model-c", "model-d"]);
    expect(result.ran).toBe(true);
    expect(result.model).toBe("model-d");
    expect(result.entries[0]?.summary).toContain("titled panel");
    expect(result.entries[0]?.confidence).toBe("inferred");
  });

  it("leaves the index at its parsed truth when there is no profile", async () => {
    const { index, l0 } = await buildFixture("vue-scss");
    expect(canSynthesise(null)).toBe(false);
    const result = await synthesise(index, l0.facts, { models: runtime({}).models, profile: null });
    expect(result.ran).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.gaps[0]?.reason).toContain("no model profile is assigned");
    const applied = applySynthesis(index, result, "design-index");
    expect(applied.builtWith?.layers).toEqual(["l0"]);
    expect(applied.gaps.some((gap) => gap.reason.includes("no model profile"))).toBe(true);
  });

  it("says so when every model of the profile answered unusably", async () => {
    const { index, l0 } = await buildFixture("vue-scss");
    const result = await synthesise(index, l0.facts, {
      models: runtime({ "model-a": "not json at all" }).models,
      profile: profile([{ provider: "p", id: "model-a" }]),
    });
    expect(result.ran).toBe(false);
    expect(result.gaps[0]?.reason).toContain("did not answer with a usable description");
  });
});

describe("what a synthesised answer is allowed to say", () => {
  it("labels two or more cited facts `inferred` and a single one `proposed`", async () => {
    const { index, l0 } = await buildFixture("react-tailwind");
    const button = entryNamed(index, "component", "Button")!;
    const facts = l0.facts.filter((fact) => fact.kind === "component" || fact.kind === "prop").slice(0, 3);
    const answer = {
      components: [{ entryId: button.id, purpose: "The one button.", cites: [facts[0]!.id, facts[1]!.id] }],
      conventions: [{ name: "one primary action", summary: "Each screen has one primary button.", cites: [facts[0]!.id] }],
    };
    const { entries } = synthesisEntries(answer, index, l0.facts);
    expect(entries.find((entry) => entry.id === button.id)?.confidence).toBe("inferred");
    expect(entries.find((entry) => entry.kind === "convention")?.confidence).toBe("proposed");
  });

  it("drops an item that cites a fact the parse never produced", async () => {
    const { index, l0 } = await buildFixture("react-tailwind");
    const button = entryNamed(index, "component", "Button")!;
    const { entries, dropped } = synthesisEntries(
      {
        components: [
          { entryId: button.id, purpose: "Invented from nothing.", cites: ["f_not_a_real_fact"] },
          { entryId: "e_not_in_this_index", purpose: "A component that does not exist.", cites: [l0.facts[0]!.id] },
        ],
        philosophy: { text: "Quiet, dense, typographic.", cites: ["f_also_invented"] },
      },
      index,
      l0.facts,
    );
    expect(entries).toEqual([]);
    expect(dropped).toBe(3);
  });

  it("keeps an era rename and a token name as proposals, not as facts", async () => {
    const { index, l0 } = await buildFixture("monorepo-eras");
    const era = index.eras[0]!;
    const token = index.entries.find((entry) => entry.kind === "token")!;
    const result = synthesisEntries({ eras: [{ id: era.id, name: "current-react" }], tokens: [{ entryId: token.id, name: "color.action" }] }, index, l0.facts);
    const applied = applySynthesis(index, { ...result, gaps: [], ran: true, model: "model-a" }, "design-index");
    const renamed = applied.entries.find((entry) => entry.id === era.id);
    expect(renamed?.name).toBe("current-react");
    expect(renamed?.confidence).toBe("proposed");
    expect(applied.eras.find((candidate) => candidate.id === era.id)?.name).toBe("current-react");
    const retokened = applied.entries.find((entry) => entry.id === token.id);
    expect(retokened?.detail?.["proposedName"]).toBe("color.action");
    expect(retokened?.name).toBe(token.name);
    expect(applied.builtWith).toEqual({ layers: ["l0", "l1"], profileId: "design-index", model: "model-a" });
  });

  it("reads JSON out of a fenced or chatty answer, and refuses the rest", () => {
    expect(parseSynthesisJson('```json\n{"philosophy": {"text": "x"}}\n```')?.["philosophy"]).toBeDefined();
    expect(parseSynthesisJson('Here you go: {"eras": []} — hope that helps')?.["eras"]).toEqual([]);
    expect(parseSynthesisJson("no json at all")).toBeUndefined();
    expect(parseSynthesisJson("{ not: valid }")).toBeUndefined();
  });
});

describe("a build with synthesis", () => {
  it("adds the description to the index and records the profile it ran on", async () => {
    const first = await buildFixture("react-tailwind", { write: false });
    const button = entryNamed(first.index, "component", "Button")!;
    const cites = first.l0.facts.filter((fact) => fact.kind === "prop").slice(0, 2).map((fact) => fact.id);
    const answer = JSON.stringify({
      components: [{ entryId: button.id, purpose: "The project's only button.", whenToUse: "Any action on a form or a card.", doNotUseFor: "Navigation.", cites }],
      philosophy: { text: "Quiet surfaces, one accent, generous spacing.", cites },
    });
    const built = await buildFixture("react-tailwind", {
      projectCwd: first.projectCwd,
      synthesis: { models: runtime({ "model-a": answer }).models, profile: profile([{ provider: "p", id: "model-a" }]), profileId: "design-index" },
    });
    const described = built.index.entries.find((entry) => entry.id === button.id);
    expect(described?.summary).toBe("The project's only button.");
    expect(described?.detail?.["whenToUse"]).toContain("form");
    expect(described?.confidence).toBe("inferred");
    expect(built.index.entries.some((entry) => entry.kind === "philosophy")).toBe(true);
    expect(built.index.builtWith).toEqual({ layers: ["l0", "l1"], profileId: "design-index", model: "model-a" });
  });
});
