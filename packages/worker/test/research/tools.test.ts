/**
 * The four Research tools: the contract lint, the handlers against a real
 * run, and the conformance fixtures replayed.
 *
 * **What this proves and what it does not.** The specs are linted by the
 * contract's own `toolContract()`, the handlers are the real ones, the
 * adapters, cache, ledger and operation applier are real, and every refusal
 * is `{ code, message, committed, next }`. What is *not* exercised is the
 * engine's own tool loop: the four tools are not registered with the engine
 * yet (M21-T17's wiring), so the fixtures live in
 * `test/fixtures/tool-eval/research/` and are replayed by this file rather
 * than by the matrix in `test/tool-eval/fixtures.test.ts` — exactly as
 * M21-T10 did for the Design Index. The day they are registered, the files
 * move one directory up and the matrix runs them unchanged.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { toolContract, type LaserToolSpec } from "@lasercode/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { parseFixture, type ToolEvalFixture } from "../../src/tool-eval/fixture.js";
import { ScriptedResearchWorld } from "../../src/tool-eval/research-world.js";
import {
  RECORD_FINDING_SPEC,
  RESOLVE_QUESTION_SPEC,
  ResearchToolFailure,
  readSourceTool,
  recordFindingTool,
  researchToolSpecs,
  resolveQuestionTool,
  searchSourcesTool,
  type ResearchBridge,
} from "../../src/research/tools.js";

const FIXTURE_ROOT = join(import.meta.dirname, "..", "fixtures", "research");
const FIXTURES = join(import.meta.dirname, "..", "fixtures", "tool-eval", "research");
const worlds: ScriptedResearchWorld[] = [];

function world(options: Partial<ConstructorParameters<typeof ScriptedResearchWorld>[0]> = {}): ScriptedResearchWorld {
  const instance = new ScriptedResearchWorld({ fixtureRoot: FIXTURE_ROOT, ...options });
  worlds.push(instance);
  return instance;
}

afterEach(() => {
  for (const instance of worlds.splice(0)) instance.dispose();
});

async function failure(run: () => Promise<unknown>): Promise<ResearchToolFailure["toolError"]> {
  try {
    await run();
  } catch (error) {
    expect(error, "every tool failure is the contract's shape").toBeInstanceOf(ResearchToolFailure);
    return (error as ResearchToolFailure).toolError;
  }
  throw new Error("that call should have been refused");
}

const ALL_ADAPTERS = ["web", "project", "repository", "package", "document"] as const;

describe("the four specs", () => {
  const specs = researchToolSpecs(ALL_ADAPTERS);

  it("obey the tool contract", () => {
    for (const spec of specs) expect(toolContract(spec), spec.name).toEqual([]);
  });

  it("are the four the research contract names, with honest annotations", () => {
    expect(specs.map((spec) => spec.name)).toEqual(["search_sources", "read_source", "record_finding", "resolve_question"]);
    expect(specs[0]?.annotations).toEqual({ readOnly: true, idempotent: true, destructive: false, external: true });
    expect(specs[1]?.annotations).toEqual({ readOnly: true, idempotent: true, destructive: false, external: true });
    // A writer repeated with the same idempotency key returns the first result.
    expect(RECORD_FINDING_SPEC.annotations).toEqual({ readOnly: false, idempotent: true, destructive: false, external: false });
    expect(RESOLVE_QUESTION_SPEC.annotations).toEqual({ readOnly: false, idempotent: true, destructive: false, external: false });
    for (const spec of specs) expect(spec.label).toBe("injected");
  });

  it("carries expectedRevisionId and an idempotency key on both writers", () => {
    for (const spec of [RECORD_FINDING_SPEC, RESOLVE_QUESTION_SPEC]) {
      const required = (spec.input as { required: string[] }).required;
      expect(required, spec.name).toContain("expected_revision_id");
      expect(required, spec.name).toContain("idempotency_key");
    }
  });

  it("offers only the adapters this session has, and drops the read tools when there are none", () => {
    const narrow = researchToolSpecs(["project", "document"]);
    const adapter = (narrow[0]!.input as { properties: { adapter: { enum: string[] } } }).properties.adapter;
    expect(adapter.enum).toEqual(["project", "document"]);
    // A disabled adapter is absent, not an option that fails.
    expect(adapter.enum).not.toContain("web");
    expect(researchToolSpecs([]).map((spec) => spec.name)).toEqual(["record_finding", "resolve_question"]);
  });
});

describe("search_sources", () => {
  it("answers with hits, their sources and what the run has spent", async () => {
    const scripted = world();
    const answer = await searchSourcesTool(scripted, { adapter: "web", query: "extract text from pdf node library", limit: 5 });
    const hits = answer["hits"] as Array<Record<string, unknown>>;
    expect((hits[0]?.["source"] as { id: string }).id).toBe("https://docs.example.org/guides/pdf-text");
    expect(String(answer["budget"])).toContain("1/24 searches");
  });

  it("refuses the same query twice, with the call to make instead", async () => {
    const scripted = world();
    await searchSourcesTool(scripted, { adapter: "web", query: "extract text from pdf node library" });
    const refused = await failure(() => searchSourcesTool(scripted, { adapter: "web", query: "  Extract text from PDF node library " }));
    expect(refused.code).toBe("identical_query");
    expect(refused.committed).toBe(false);
    expect(refused.next).toContain("read_source");
  });

  it("stops when the budget is spent and says what to do with what was found", async () => {
    const scripted = world({ sources: { budget: { maxSearches: 1, maxReads: 32, maxBytes: 4 * 1024 * 1024, maxWallClockMs: 900_000 } } });
    await searchSourcesTool(scripted, { adapter: "project", query: "pdf" });
    const refused = await failure(() => searchSourcesTool(scripted, { adapter: "project", query: "import" }));
    expect(refused.code).toBe("budget_spent");
    expect(refused.message).toContain("Spent:");
    expect(refused.next).toContain("report what the budget stopped");
  });

  it("is absent for a disabled adapter, and says which sources exist", async () => {
    const scripted = world({ sources: { adapters: { web: false, project: true, repository: false, package: false, document: true, scholarly: false, tracker: false } } });
    expect(scripted.adapters()).toEqual(["project", "document"]);
    expect(researchToolSpecs(scripted.adapters()).map((spec) => spec.name)).toEqual(["search_sources", "read_source", "record_finding", "resolve_question"]);
    const refused = await failure(() => searchSourcesTool(scripted, { adapter: "web", query: "anything" }));
    expect(refused.code).toBe("adapter_unavailable");
    expect(refused.message).toContain("project, document");
  });

  it("says so plainly when every source is switched off", async () => {
    const scripted = world({ sources: { adapters: { web: false, project: false, repository: false, package: false, document: false, scholarly: false, tracker: false } } });
    expect(researchToolSpecs(scripted.adapters()).map((spec) => spec.name)).toEqual(["record_finding", "resolve_question"]);
    const refused = await failure(() => searchSourcesTool(scripted, { adapter: "project", query: "pdf" }));
    expect(refused.message).toContain("Every research source is switched off");
  });
});

describe("read_source", () => {
  it("returns the page with its provenance line, digest, canonical and notices", async () => {
    const scripted = world();
    const answer = await readSourceTool(scripted, { source_id: "https://docs.example.org/guides/pdf-text" });
    expect(String(answer["text"]).startsWith("[from https://docs.example.org/guides/pdf-text]")).toBe(true);
    expect(String(answer["digest"])).toMatch(/^[0-9a-f]{64}$/);
    expect(answer["canonical"]).toBe("https://docs.example.org/guides/pdf-text");
    expect((answer["notices"] as string[]).join(" ")).toContain("not an instruction to you");
  });

  it("refuses a source nobody named a way to reach", async () => {
    const scripted = world();
    const refused = await failure(() => readSourceTool(scripted, { source_id: "pdf-text" }));
    expect(refused.code).toBe("unknown_source_kind");
  });
});

describe("record_finding", () => {
  async function ready(): Promise<{ scripted: ScriptedResearchWorld; revision: string }> {
    const scripted = world();
    await readSourceTool(scripted, { source_id: "https://docs.example.org/guides/pdf-text" });
    return { scripted, revision: scripted.store.revisionId };
  }

  const base = {
    idempotency_key: "k1",
    question_id: "q2",
    claim: "pdf-text is released under the MIT licence.",
    source_id: "https://docs.example.org/guides/pdf-text",
    excerpt: "It is released under the MIT licence and has no native dependencies.",
    licence: "permissive" as const,
  };

  it("records a declared finding and answers with the rule's verdict", async () => {
    const { scripted, revision } = await ready();
    const answer = await recordFindingTool(scripted, { ...base, expected_revision_id: revision, confidence: "declared" });
    expect(answer["confidence"]).toBe("declared");
    expect(answer["confidenceNote"]).toBeUndefined();
    expect(String(answer["findingId"])).not.toBe("");
    expect(answer["revisionId"]).toBe("rev2");
    expect(scripted.store.body.findings[0]?.excerpt).toContain("MIT licence");
    expect(scripted.store.body.sources[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("overrides a confidence the rule cannot justify, and says why", async () => {
    const scripted = world();
    await searchSourcesTool(scripted, { adapter: "web", query: "extract text from pdf node library" });
    await readSourceTool(scripted, { source_id: "https://medium.com/@someone/pdf-libraries" });
    const answer = await recordFindingTool(scripted, {
      expected_revision_id: scripted.store.revisionId,
      idempotency_key: "k2",
      question_id: "q1",
      claim: "pdf-text is the fastest of the three.",
      confidence: "declared",
      source_id: "https://medium.com/@someone/pdf-libraries",
      excerpt: "I think pdf-text is the fastest of the three, but I have not measured it.",
      licence: "unknown",
    });
    expect(answer["confidence"]).toBe("proposed");
    expect(String(answer["confidenceNote"])).toContain("Confidence follows the rule, not the call");
  });

  it("refuses an excerpt that is not in what this session read", async () => {
    const { scripted, revision } = await ready();
    const refused = await failure(() =>
      recordFindingTool(scripted, { ...base, expected_revision_id: revision, excerpt: "It is twice as fast as everything else." }),
    );
    expect(refused.code).toBe("excerpt_not_in_source");
    expect(refused.committed).toBe(false);
    expect(refused.next).toContain("read_source");
  });

  it("refuses a source this session never saw", async () => {
    const { scripted, revision } = await ready();
    const refused = await failure(() => recordFindingTool(scripted, { ...base, expected_revision_id: revision, source_id: "https://example.invalid/made-up" }));
    expect(refused.code).toBe("unknown_source");
    expect(refused.next).toContain("search_sources");
  });

  it("refuses a stale revision and names the one to use", async () => {
    const { scripted } = await ready();
    const refused = await failure(() => recordFindingTool(scripted, { ...base, expected_revision_id: "rev0" }));
    expect(refused.code).toBe("stale_revision");
    expect(refused.next).toContain("rev1");
    expect(refused.committed).toBe(false);
  });

  it("accepts a quote from any body of a source read in pieces", async () => {
    const scripted = world();
    const id = "git:https://github.com/example-org/pdf-text.git@9f2b1c4e5a6d7f8091a2b3c4d5e6f708192a3b4c";
    await readSourceTool(scripted, { source_id: id, adapter: "repository" });
    await readSourceTool(scripted, { source_id: id, adapter: "repository", paths: ["src/reader.ts"] });
    const answer = await recordFindingTool(scripted, {
      expected_revision_id: scripted.store.revisionId,
      idempotency_key: "k-repo",
      question_id: "q1",
      claim: "pdf-text reads the text layer page by page and renders nothing.",
      source_id: id,
      excerpt: "The text layer is read page by page; nothing is rendered.",
      licence: "permissive",
    });
    expect(answer["confidence"]).toBe("declared");
    const refused = await failure(() =>
      recordFindingTool(scripted, {
        expected_revision_id: String(answer["revisionId"]),
        idempotency_key: "k-repo-2",
        question_id: "q1",
        claim: "It renders pages to images.",
        source_id: id,
        excerpt: "It renders each page to a PNG.",
        licence: "permissive",
      }),
    );
    expect(refused.code).toBe("excerpt_not_in_source");
  });

  it("propagates stale decisions from a correction", async () => {
    const { scripted, revision } = await ready();
    const first = await recordFindingTool(scripted, { ...base, expected_revision_id: revision, supports: ["SPEC-3#d1"] });
    const second = await recordFindingTool(scripted, {
      ...base,
      idempotency_key: "k2",
      expected_revision_id: String(first["revisionId"]),
      claim: "pdf-text dropped its MIT licence in 3.2.",
      contradicts: [String(first["findingId"])],
    });
    expect(second["staleRefs"]).toEqual(["SPEC-3#d1"]);
    expect(scripted.store.stale).toContain("SPEC-3#d1");
  });
});

describe("resolve_question", () => {
  it("answers with citations, hands a question over, and reports what is open", async () => {
    const scripted = world();
    await readSourceTool(scripted, { source_id: "https://docs.example.org/guides/pdf-text" });
    const finding = await recordFindingTool(scripted, {
      expected_revision_id: scripted.store.revisionId,
      idempotency_key: "k1",
      question_id: "q2",
      claim: "pdf-text is released under the MIT licence.",
      source_id: "https://docs.example.org/guides/pdf-text",
      excerpt: "It is released under the MIT licence",
      licence: "permissive",
    });

    const uncited = await failure(() =>
      resolveQuestionTool(scripted, { expected_revision_id: scripted.store.revisionId, idempotency_key: "r0", question_id: "q1", state: "answered", answer: "Three of them." }),
    );
    expect(uncited.code).toBe("citation_required");

    const answered = await resolveQuestionTool(scripted, {
      expected_revision_id: scripted.store.revisionId,
      idempotency_key: "r1",
      question_id: "q2",
      state: "answered",
      answer: "pdf-text is MIT licensed.",
      findings: [String(finding["findingId"])],
    });
    expect(answered["state"]).toBe("answered");
    expect(answered["openQuestions"]).toBe(2);
    expect(answered["status"]).toBe("open");

    const handed = await resolveQuestionTool(scripted, {
      expected_revision_id: scripted.store.revisionId,
      idempotency_key: "r2",
      question_id: "q3",
      state: "handed_to_person",
      answer: "This is a preference about maintenance, not a fact.",
    });
    expect(handed["raisedForPerson"]).toBe(true);
    expect(scripted.store.attentions).toEqual([{ questionId: "q3", text: "Which one should this project adopt?" }]);
  });

  it("requires what would settle an unanswerable question", async () => {
    const scripted = world();
    const refused = await failure(() =>
      resolveQuestionTool(scripted, { expected_revision_id: scripted.store.revisionId, idempotency_key: "r3", question_id: "q1", state: "unanswerable" }),
    );
    expect(refused.code).toBe("would_settle_required");
    expect(refused.next).toContain("wouldSettleIt");
  });
});

// --------------------------------------------------------------- the fixtures

type Handler = (bridge: ResearchBridge, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

const HANDLERS: Record<string, Handler> = {
  search_sources: (bridge, args) => searchSourcesTool(bridge, args as never),
  read_source: (bridge, args) => readSourceTool(bridge, args as never),
  record_finding: (bridge, args) => recordFindingTool(bridge, args as never),
  resolve_question: (bridge, args) => resolveQuestionTool(bridge, args as never),
};

function loadResearchFixtures(): ToolEvalFixture[] {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => parseFixture(JSON.parse(readFileSync(join(FIXTURES, name), "utf8")), join(FIXTURES, name)));
}

describe("the conformance fixtures", () => {
  const fixtures = loadResearchFixtures();

  it("has one for each tool, in the harness's own format", () => {
    expect(fixtures.map((fixture) => fixture.tool).sort()).toEqual(["read_source", "record_finding", "resolve_question", "search_sources"]);
    for (const fixture of fixtures) {
      expect(fixture.world.research, fixture.tool).toBeDefined();
      expect(fixture.measures, fixture.tool).toEqual(expect.arrayContaining(["schema", "selection", "budget"]));
    }
    // The two optional measures a research run can really show are both used.
    const declared = new Set(fixtures.flatMap((fixture) => fixture.measures));
    expect(declared.has("retry")).toBe(true);
    expect(declared.has("truncation")).toBe(true);
  });

  it("keeps a credential out of every fixture", () => {
    for (const fixture of fixtures) {
      expect(JSON.stringify(fixture), fixture.tool).not.toMatch(/api[_-]?key|secret|bearer |password|\bsk-[a-z0-9]{8}/i);
    }
  });

  for (const fixture of loadResearchFixtures()) {
    it(`replays ${fixture.tool} exactly as it was recorded`, async () => {
      const declared = fixture.world.research!;
      const scripted = world({
        ...(declared.project !== undefined ? { project: declared.project } : {}),
        ...(declared.searchConnected === false ? { searchConnected: false } : {}),
        ...(declared.disabledAdapters !== undefined
          ? { sources: { adapters: Object.fromEntries(declared.disabledAdapters.map((id) => [id, false])) as never } }
          : {}),
      });
      const specs = researchToolSpecs(scripted.adapters());

      let calls = 0;
      let lastFailure: { tool: string; next: string; args: Record<string, unknown> } | undefined;
      let lastTruncated: { tool: string; limit: number } | undefined;
      let lastFinding: string | undefined;

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
          args[key] = resolve(value, scripted, lastFinding);
        }
        // Schema: every recorded argument is one the tool declares.
        const spec = specs.find((candidate) => candidate.name === name) as LaserToolSpec;
        expect(spec, `${name} is not offered in this world`).toBeDefined();
        const properties = Object.keys((spec.input as { properties: Record<string, unknown> }).properties);
        for (const key of Object.keys(args)) expect(properties, `${name}.${key}`).toContain(key);

        if (step.fails === true) {
          let thrown: unknown;
          try {
            await handler!(scripted, args);
          } catch (error) {
            thrown = error;
          }
          expect(thrown, `${fixture.tool}: ${name} was recorded as failing and did not`).toBeInstanceOf(ResearchToolFailure);
          const toolError = (thrown as ResearchToolFailure).toolError;
          expect(toolError.code.length).toBeGreaterThan(0);
          expect(toolError.committed).toBe(false);
          expect(toolError.next.length).toBeGreaterThan(0);
          lastFailure = { tool: name, next: toolError.next, args };
          continue;
        }

        const result = await handler!(scripted, args);
        expect(result, `${fixture.tool}: ${name} answered nothing`).toBeTruthy();
        if (typeof result["findingId"] === "string" && result["findingId"] !== "") lastFinding = result["findingId"];

        // Retry: the call after a refusal is an informed one — the tool the
        // refusal named, or the same tool with different arguments
        // (`docs/agent-tool-contract.md` §4).
        if (lastFailure !== undefined) {
          const informed = lastFailure.next.includes(name) || (lastFailure.tool === name && JSON.stringify(lastFailure.args) !== JSON.stringify(args));
          expect(informed, `${fixture.tool}: ${name} after a refusal was neither the call it named nor a different call`).toBe(true);
          lastFailure = undefined;
        }

        // Truncation: a page over the fixture's ceiling is followed by a
        // strictly smaller page, never the same one again.
        if (lastTruncated?.tool === name) {
          const limit = typeof args["limit"] === "number" ? args["limit"] : Number.POSITIVE_INFINITY;
          expect(limit, `${fixture.tool}: ${name} did not narrow after a truncated page`).toBeLessThan(lastTruncated.limit);
          lastTruncated = undefined;
        }
        const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
        if (fixture.truncationBytes !== undefined && bytes >= fixture.truncationBytes) {
          lastTruncated = { tool: name, limit: typeof args["limit"] === "number" ? args["limit"] : Number.POSITIVE_INFINITY };
        }
      }
      expect(calls, `${fixture.tool} went over its call budget`).toBeLessThanOrEqual(fixture.budget.calls);
      expect(fixture.steps.at(-1)).toHaveProperty("text");
    });
  }
});

/** `{{revision}}`, `{{stale}}`, `{{finding}}` — the three a recorded call may need. */
function resolve(value: unknown, scripted: ScriptedResearchWorld, finding: string | undefined): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolve(entry, scripted, finding));
  if (typeof value !== "string") return value;
  if (value === "{{revision}}") return scripted.store.revisionId;
  if (value === "{{stale}}") return "rev0";
  if (value === "{{finding}}") {
    if (finding === undefined) throw new Error("the fixture cites a finding before one was recorded");
    return finding;
  }
  return value;
}
