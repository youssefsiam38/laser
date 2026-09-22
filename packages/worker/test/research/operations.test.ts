/**
 * The write rules of `docs/research-phase.md`, as the host applies them.
 *
 * `applyResearchOperation()` is the one gate both the worker and the host run
 * (D-351.a), so every rule in the contract's "Rules" section and its Tests row
 * is asserted here against the real function: confidence by rule,
 * excerpt-in-digest, citations on an answer, what would settle an
 * unanswerable, attention for a handed-over question, stale propagation from
 * a changed finding, and the derived status.
 */
import { describe, expect, it } from "vitest";
import {
  RESEARCH_ADAPTERS,
  RESEARCH_BUDGET_DEFAULTS,
  ResearchOperationRefused,
  applyResearchOperation,
  checkFindingConfidence,
  defaultResearchSources,
  enabledResearchAdapters,
  readResearchSources,
  researchAdapterEnabled,
  researchHostAllowed,
  researchStatusFrom,
  researchBodySchema,
  type RecordFindingOperation,
  type ResearchBody,
  type ResearchSessionRead,
  type SourceRef,
} from "@lasercode/protocol";

const officialSource: SourceRef = {
  kind: "web",
  id: "https://docs.example.org/guides/pdf-text",
  title: "Reading PDF text in Node",
  fetchedVia: "web",
  trust: "primary",
  digest: "a".repeat(64),
};

const communitySource: SourceRef = { kind: "web", id: "https://medium.com/@someone/x", title: "A take", fetchedVia: "web", trust: "community" };
const projectSource: SourceRef = { kind: "project", id: "path:src/import.ts", title: "src/import.ts", fetchedVia: "project", trust: "primary" };

function body(): ResearchBody {
  return {
    question: "Which library should this project use to read PDF files?",
    scope: { in: [], out: [], constraints: [] },
    status: "open",
    questions: [
      { id: "q1", text: "Which libraries extract text?", state: "open", findings: [] },
      { id: "q2", text: "Which licence does each carry?", state: "open", findings: [] },
    ],
    findings: [],
    unresolved: [],
    sources: [],
  };
}

const record = (over: Partial<RecordFindingOperation> = {}): RecordFindingOperation => ({
  op: "record_finding",
  questionId: "q1",
  claim: "pdf-text extracts a text layer from a tagged PDF.",
  confidence: "declared",
  source: officialSource,
  excerpt: "The pdf-text module extracts a text layer from a tagged PDF.",
  licence: "permissive",
  ...over,
});

const reads = (text: string, id = officialSource.id, digest = officialSource.digest!): Map<string, ResearchSessionRead> =>
  new Map([[id, { digest, text }]]);

function refusalOf(run: () => unknown): ResearchOperationRefused {
  try {
    run();
  } catch (failure) {
    if (failure instanceof ResearchOperationRefused) return failure;
    throw failure;
  }
  throw new Error("the operation should have been refused");
}

describe("the confidence rule", () => {
  it("declares only a quoted official or primary source", () => {
    expect(checkFindingConfidence(record(), new Map())).toEqual({ ok: true });
    expect(checkFindingConfidence(record({ source: communitySource }), new Map()).ok).toBe(false);
    expect(refusalOf(() => applyResearchOperation(body(), record({ source: communitySource }))).code).toBe("confidence_not_declared");
    expect(refusalOf(() => applyResearchOperation(body(), record({ excerpt: undefined }))).code).toBe("excerpt_required");
    // What a person said is secondary at most, so it can never be declared.
    const said: SourceRef = { kind: "person", id: "the person", title: "In conversation", fetchedVia: "session", trust: "secondary" };
    expect(refusalOf(() => applyResearchOperation(body(), record({ source: said }))).message).toContain("secondary evidence");
  });

  it("observes only what was read in this project", () => {
    const observed = record({ confidence: "observed", source: projectSource, excerpt: "PDF import is not supported", licence: "not_applicable" });
    expect(applyResearchOperation(body(), observed).findingId).toBeTruthy();
    expect(refusalOf(() => applyResearchOperation(body(), record({ confidence: "observed" }))).code).toBe("confidence_not_observed");
    expect(refusalOf(() => applyResearchOperation(body(), { ...observed, excerpt: undefined, location: undefined })).code).toBe("excerpt_required");
  });

  it("infers only from two findings it cites, and they must exist", () => {
    const one = applyResearchOperation(body(), record());
    const two = applyResearchOperation(one.body, record({ questionId: "q2", claim: "It is MIT licensed.", excerpt: "It is released under the MIT licence" }));
    const inferred = record({
      confidence: "inferred",
      claim: "pdf-text is a permissively licensed text extractor.",
      source: communitySource,
      excerpt: undefined,
      derivedFrom: [one.findingId!, two.findingId!],
    });
    const applied = applyResearchOperation(two.body, inferred);
    expect(applied.body.findings.at(-1)?.confidence).toBe("inferred");
    expect(applied.body.findings.at(-1)?.derivedFrom).toEqual([one.findingId, two.findingId]);
    expect(refusalOf(() => applyResearchOperation(two.body, { ...inferred, derivedFrom: [one.findingId!] })).code).toBe("inference_uncited");
    expect(refusalOf(() => applyResearchOperation(two.body, { ...inferred, derivedFrom: ["f9", "f8"] })).code).toBe("no_such_finding");
    // The body schema enforces the same rule on anything already stored.
    const loose = { ...applied.body, findings: applied.body.findings.map((finding) => ({ ...finding, derivedFrom: undefined })) };
    expect(researchBodySchema.safeParse(loose).success).toBe(false);
  });

  it("proposes what no primary source states, and refuses a primary source not quoted", () => {
    const proposed = record({ confidence: "proposed", source: communitySource, excerpt: undefined, licence: "unknown" });
    expect(applyResearchOperation(body(), proposed).body.findings[0]?.confidence).toBe("proposed");
    expect(refusalOf(() => applyResearchOperation(body(), record({ confidence: "proposed" }))).code).toBe("confidence_not_proposed");
  });
});

describe("the excerpt-in-digest check", () => {
  const text = "The pdf-text module extracts a text layer from a tagged PDF.\nIt is released under the MIT licence.";

  it("accepts a quote that is in what this session read, whatever the wrapping", () => {
    const applied = applyResearchOperation(body(), record({ excerpt: "extracts a text\nlayer from a tagged PDF" }), { reads: reads(text) });
    expect(applied.body.findings[0]?.excerpt).toContain("extracts a text");
  });

  it("refuses a quote that is not in it", () => {
    const refusal = refusalOf(() => applyResearchOperation(body(), record({ excerpt: "it is the fastest library available" }), { reads: reads(text) }));
    expect(refusal.code).toBe("excerpt_not_in_source");
    expect(refusal.next).toContain("read_source");
  });

  it("refuses a digest that is not the digest of what was read", () => {
    const refusal = refusalOf(() =>
      applyResearchOperation(body(), record({ source: { ...officialSource, digest: "b".repeat(64) } }), { reads: reads(text) }),
    );
    expect(refusal.code).toBe("digest_mismatch");
  });

  it("skips the check for a source this session did not read", () => {
    expect(() => applyResearchOperation(body(), record({ excerpt: "anything at all" }), { reads: new Map() })).not.toThrow();
  });
});

describe("resolving a question", () => {
  const withFinding = () => applyResearchOperation(body(), record());

  it("requires a citation for an answer, or an explicit inferred-only", () => {
    const first = withFinding();
    const refusal = refusalOf(() =>
      applyResearchOperation(first.body, { op: "resolve_question", questionId: "q2", state: "answered", answer: "Probably MIT." }),
    );
    expect(refusal.code).toBe("citation_required");
    expect(refusal.next).toContain("inferredOnly");
    const inferred = applyResearchOperation(first.body, {
      op: "resolve_question",
      questionId: "q2",
      state: "answered",
      answer: "Probably MIT, by inference from the two findings above.",
      inferredOnly: true,
      findings: [],
    });
    expect(inferred.body.questions.find((question) => question.id === "q2")?.inferredOnly).toBe(true);
  });

  it("answers when it cites a declared finding, and derives the status", () => {
    const first = withFinding();
    const answered = applyResearchOperation(first.body, {
      op: "resolve_question",
      questionId: "q1",
      state: "answered",
      answer: "pdf-text does.",
      findings: [first.findingId!],
    });
    expect(answered.body.questions[0]?.state).toBe("answered");
    expect(answered.body.status).toBe("open");
    const both = applyResearchOperation(answered.body, {
      op: "resolve_question",
      questionId: "q2",
      state: "unanswerable",
      wouldSettleIt: "The maintainer publishing a licence file.",
    });
    expect(both.body.status).toBe("partial");
    expect(both.body.unresolved).toEqual([{ fact: "Which licence does each carry?", wouldSettleIt: "The maintainer publishing a licence file." }]);
    expect(researchStatusFrom([{ id: "q", text: "t", state: "answered", findings: [] }])).toBe("answered");
    expect(researchStatusFrom([], "superseded")).toBe("superseded");
  });

  it("refuses unanswerable without what would settle it", () => {
    expect(refusalOf(() => applyResearchOperation(body(), { op: "resolve_question", questionId: "q1", state: "unanswerable" })).code).toBe("would_settle_required");
  });

  it("raises attention when a question is handed to the person", () => {
    const applied = applyResearchOperation(body(), {
      op: "resolve_question",
      questionId: "q1",
      state: "handed_to_person",
      answer: "This is a preference, not a fact.",
    });
    expect(applied.attention).toEqual({ kind: "handed_to_person", questionId: "q1", text: "Which libraries extract text?", note: "This is a preference, not a fact." });
  });

  it("opens sub-questions under the question it resolved, inside the bounds", () => {
    const first = withFinding();
    const applied = applyResearchOperation(first.body, {
      op: "resolve_question",
      questionId: "q1",
      state: "answered",
      answer: "pdf-text and two others.",
      findings: [first.findingId!],
      addQuestions: [{ text: "Does pdf-text handle scanned PDFs?" }],
    });
    const added = applied.body.questions.at(-1)!;
    expect(added.parent).toBe("q1");
    expect(added.state).toBe("open");
    expect(applied.body.status).toBe("open");
  });

  it("refuses a question or a finding it does not have", () => {
    expect(refusalOf(() => applyResearchOperation(body(), record({ questionId: "q9" }))).code).toBe("no_such_question");
    expect(refusalOf(() => applyResearchOperation(body(), { op: "resolve_question", questionId: "q1", state: "answered", answer: "x", findings: ["f9"] })).code).toBe("no_such_finding");
  });
});

describe("corrections and stale propagation", () => {
  it("appends a correction and hands the host the decisions it stales", () => {
    const first = applyResearchOperation(body(), record({ supports: ["SPEC-12#d3", "DESIGN-4#d1"] }));
    const corrected = applyResearchOperation(first.body, {
      ...record({ claim: "pdf-text no longer ships a text layer extractor.", contradicts: [first.findingId!] }),
    });
    expect(corrected.body.findings).toHaveLength(2);
    // The old finding is untouched: findings are never edited.
    expect(corrected.body.findings[0]).toEqual(first.body.findings[0]);
    expect(corrected.staleRefs).toEqual(["SPEC-12#d3", "DESIGN-4#d1"]);
    const resolved = applyResearchOperation(corrected.body, {
      op: "resolve_question",
      questionId: "q1",
      state: "answered",
      answer: "It does not.",
      findings: [corrected.findingId!],
    });
    expect(resolved.staleRefs).toEqual(["SPEC-12#d3", "DESIGN-4#d1"]);
  });

  it("says when a licence blocks recommending a reuse it recorded", () => {
    const applied = applyResearchOperation(body(), record({ licence: "unknown", reuse: { what: "code", from: "https://docs.example.org/guides/pdf-text" } }));
    expect(applied.reuseBlocked).toContain("blocks recommending it");
    expect(applied.body.findings[0]?.reuse?.what).toBe("code");
  });

  it("dedupes the source index and keeps the body valid", () => {
    const first = applyResearchOperation(body(), record());
    const second = applyResearchOperation(first.body, record({ questionId: "q2", claim: "It is MIT licensed.", excerpt: "MIT licence" }));
    expect(second.body.sources).toHaveLength(1);
    expect(researchBodySchema.safeParse(second.body).success).toBe(true);
  });

  it("refuses an operation that is not one a research write may say", () => {
    expect(refusalOf(() => applyResearchOperation(body(), { op: "record_finding", questionId: "q1" } as never)).code).toBe("invalid_operation");
  });
});

describe("Research sources settings", () => {
  it("defaults to every shipped adapter and the contract's budgets", () => {
    const sources = defaultResearchSources();
    expect(enabledResearchAdapters(sources)).toEqual(["web", "project", "repository", "package", "document"]);
    expect(sources.budget).toEqual(RESEARCH_BUDGET_DEFAULTS);
    expect(RESEARCH_ADAPTERS.filter((adapter) => !adapter.shipped).map((adapter) => adapter.id)).toEqual(["scholarly", "tracker"]);
    expect(researchAdapterEnabled(sources, "scholarly")).toBe(false);
  });

  it("reads a document, ignores what it cannot use, and keeps the rest", () => {
    const sources = readResearchSources({
      adapters: { web: false, nonsense: true, project: "yes" },
      denyDomains: ["Internal.Example.com", 42],
      budget: { maxSearches: 4, maxReads: -1 },
      cacheMaxBytes: 2 * 1024 * 1024,
    });
    expect(sources.adapters.web).toBe(false);
    expect(sources.adapters.project).toBe(true);
    expect(sources.denyDomains).toEqual(["internal.example.com"]);
    expect(sources.budget.maxSearches).toBe(4);
    expect(sources.budget.maxReads).toBe(RESEARCH_BUDGET_DEFAULTS.maxReads);
    expect(sources.cacheMaxBytes).toBe(2 * 1024 * 1024);
    expect(readResearchSources("not a document")).toEqual(defaultResearchSources());
  });

  it("denies a host outright and limits an allow list to what it names", () => {
    const denied = readResearchSources({ denyDomains: ["internal.example.com"] });
    expect(researchHostAllowed(denied, "wiki.internal.example.com").allowed).toBe(false);
    expect(researchHostAllowed(denied, "wiki.internal.example.com").reason).toContain("must not reach");
    expect(researchHostAllowed(denied, "docs.example.org").allowed).toBe(true);
    const allowed = readResearchSources({ allowDomains: ["docs.example.org"], denyDomains: ["beta.docs.example.org"] });
    expect(researchHostAllowed(allowed, "docs.example.org").allowed).toBe(true);
    expect(researchHostAllowed(allowed, "medium.com").allowed).toBe(false);
    expect(researchHostAllowed(allowed, "beta.docs.example.org").allowed).toBe(false);
  });
});
