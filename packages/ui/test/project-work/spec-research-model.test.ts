/**
 * The rules behind the Spec and Research surfaces (M21-T7).
 *
 * These are the parts a screenshot cannot prove: what a full spec is missing
 * and what a brief is never asked for, which span of an excerpt a claim
 * actually quotes, where a source can be opened, what a question may be
 * resolved to, and that an exact key outranks every text match.
 */
import { describe, expect, it } from "vitest";
import type { ProjectWorkListItem, ProjectWorkSearchResult, SpecBody } from "@lasercode/protocol";

import {
  addQuestion,
  citedSpan,
  deriveResearchStatus,
  findingsFor,
  provenanceOf,
  questionRows,
  quoteMarkdown,
  resolutionRefusal,
  resolveQuestion,
  retrievalSpend,
  sourceTarget,
  uncitedFindings,
} from "../../src/project-work/research.js";
import { mergeSearchResults } from "../../src/project-work/search.js";
import { fullSpecGaps, sameSpecBody, specBodyFrom, specBodyText, specDraft, specIsWritable } from "../../src/project-work/spec.js";
import { EMPTY_FILTER } from "../../src/project-work/views.js";

import { item } from "./fixture.js";
import { researchFixture, specFixture } from "./bodies-fixture.js";

describe("the spec body a person edits", () => {
  it("keeps a brief small and never asks it for anything else", () => {
    const brief: SpecBody = { ...specFixture(), form: "brief", outcomes: [], requirements: [], acceptance: [] };
    expect(fullSpecGaps(brief)).toEqual([]);
    expect(specIsWritable(brief)).toBe(true);
    // The same body as a full spec names what a full spec records.
    expect(fullSpecGaps({ ...brief, form: "full", problem: undefined })).toEqual([
      "the problem",
      "outcomes",
      "requirements",
      "acceptance criteria",
    ]);
  });

  it("drops what is blank rather than storing an empty field", () => {
    const draft = specDraft({ ...specFixture(), problem: "   ", document: "", outcomes: ["kept", "  "] });
    const body = specBodyFrom(draft);
    expect(body.problem).toBeUndefined();
    expect(body.document).toBeUndefined();
    expect(body.outcomes).toEqual(["kept"]);
  });

  it("renders one body as stable text, so a difference is between revisions", () => {
    const body = specFixture();
    expect(specBodyText(body)).toBe(specBodyText(specDraft(body)));
    expect(sameSpecBody(body, { ...body, brief: "something else" })).toBe(false);
    expect(specBodyText(body)).toContain("## Acceptance");
    expect(specBodyText(body)).toContain("[must]");
  });
});

describe("the question tree", () => {
  it("reads parents before children, and keeps a node whose parent is gone", () => {
    const body = researchFixture();
    const rows = questionRows(body);
    expect(rows.map((row) => row.node.id)).toEqual(["q1", "q2", "q3"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 0]);
    const orphaned = questionRows({ ...body, questions: [{ id: "qx", text: "stranded", parent: "gone", state: "open", findings: [] }] });
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]?.depth).toBe(0);
  });

  it("gives a question only the findings the revision still carries", () => {
    const body = researchFixture();
    expect(findingsFor(body, "q1").map((finding) => finding.id)).toEqual(["f1"]);
    expect(findingsFor(body, "q2")).toEqual([]);
    expect(uncitedFindings(body).map((finding) => finding.id)).toEqual(["f2"]);
    expect(retrievalSpend(body)).toEqual({ sources: 2, findings: 2, questions: 3, resolved: 1 });
  });

  it("derives the status from the question states rather than being told", () => {
    const body = researchFixture();
    expect(deriveResearchStatus(body)).toBe("partial");
    const answered = body.questions.map((question) => ({ ...question, state: "answered" as const, findings: ["f1"] }));
    expect(deriveResearchStatus({ ...body, questions: answered })).toBe("answered");
    const stuck = body.questions.map((question) => ({ ...question, state: "unanswerable" as const }));
    expect(deriveResearchStatus({ ...body, questions: stuck })).toBe("unanswerable");
    expect(deriveResearchStatus({ ...body, status: "superseded" })).toBe("superseded");
  });

  it("refuses an answer that cites nothing unless it says so outright", () => {
    expect(resolutionRefusal({ state: "answered", answer: "yes", findings: [] })).toContain("cites at least one finding");
    expect(resolutionRefusal({ state: "answered", answer: "yes", findings: [], inferredOnly: true })).toBeUndefined();
    expect(resolutionRefusal({ state: "answered", answer: "", findings: ["f1"] })).toContain("written down");
    expect(resolutionRefusal({ state: "unanswerable", answer: "" })).toContain("what no source could settle");
    const body = resolveQuestion(researchFixture(), "q2", { state: "answered", answer: "It does.", findings: ["f1"] });
    expect(body.questions.find((question) => question.id === "q2")?.state).toBe("answered");
    expect(body.status).toBe("partial");
  });

  it("adds a question under another one without touching the rest", () => {
    const body = addQuestion(researchFixture(), { text: "  and what about licences?  ", parent: "q1" });
    const added = body.questions.at(-1);
    expect(added?.text).toBe("and what about licences?");
    expect(added?.parent).toBe("q1");
    expect(added?.state).toBe("open");
    expect(body.questions).toHaveLength(4);
  });
});

describe("a finding's excerpt", () => {
  it("highlights the span the claim quotes, and nothing on a resemblance", () => {
    const span = citedSpan(
      "The loader waits for the frame to settle before it paints, and only then reports readiness.",
      'The docs say it "waits for the frame to settle" before painting.',
    );
    expect(span?.match).toBe("waits for the frame to settle");
    expect(span?.before).toBe("The loader ");

    // A claim that shares only short words with the excerpt highlights nothing.
    expect(citedSpan("A totally different sentence.", "The docs mention a thing.")).toBeUndefined();
  });

  it("falls back to the longest run the two literally share", () => {
    const span = citedSpan("Rendering is deferred until the next animation frame.", "Rendering is deferred until the next animation frame, they claim.");
    expect(span?.match).toContain("deferred until the next animation frame");
  });

  it("carries where it came from into the quote it writes", () => {
    const body = researchFixture();
    const finding = body.findings[0]!;
    const quote = quoteMarkdown(finding, "RES-7");
    expect(quote).toContain("RES-7");
    expect(quote).toContain("> The loader waits");
    expect(quote).toContain(provenanceOf(finding.source));
    expect(quote).toContain("[from https://example.org/docs/loader]");
  });
});

describe("opening a source", () => {
  it("opens a URL, a forge at an exact commit, a registry page and a DOI", () => {
    expect(sourceTarget({ kind: "web", id: "https://example.org/a", title: "", fetchedVia: "web", trust: "primary" })).toMatchObject({
      open: "external",
      url: "https://example.org/a",
    });
    expect(
      sourceTarget({ kind: "repository", id: "github.com/acme/widget@0123456789abcdef", title: "", fetchedVia: "repository", trust: "primary" }),
    ).toMatchObject({ open: "external", url: "https://github.com/acme/widget/tree/0123456789abcdef" });
    expect(sourceTarget({ kind: "package", id: "npm:react@19.1.1", title: "", fetchedVia: "package", trust: "official" })).toMatchObject({
      open: "external",
      url: "https://www.npmjs.com/package/react/v/19.1.1",
    });
    expect(sourceTarget({ kind: "scholarly", id: "doi:10.1000/xyz123", title: "", fetchedVia: "scholarly", trust: "primary" })).toMatchObject({
      open: "external",
      url: "https://doi.org/10.1000/xyz123",
    });
  });

  it("opens a local file, another artifact by key, and refuses to invent the rest", () => {
    expect(sourceTarget({ kind: "document", id: "/work/app/notes.md", title: "", fetchedVia: "document", trust: "unknown" })).toMatchObject({
      open: "file",
      path: "/work/app/notes.md",
    });
    expect(sourceTarget({ kind: "project", id: "SPEC-4", title: "", fetchedVia: "project", trust: "secondary" })).toMatchObject({
      open: "work",
      key: "SPEC-4",
    });
    expect(sourceTarget({ kind: "person", id: "you", title: "", fetchedVia: "person", trust: "secondary" })).toMatchObject({ open: "none" });
    // An unknown forge is not turned into a URL that may not exist.
    expect(
      sourceTarget({ kind: "repository", id: "git.internal/acme/widget@abcdef1", title: "", fetchedVia: "repository", trust: "unknown" }),
    ).toMatchObject({ open: "none" });
  });
});

describe("searching the backlog", () => {
  const rows: ProjectWorkListItem[] = [
    item({ entityId: "e1", kind: "spec", number: 4, title: "The relay" }),
    item({ entityId: "e2", kind: "research", number: 7, title: "Which PDF library" }),
    item({ entityId: "e3", kind: "task", number: 44, title: "Wire the board" }),
  ];
  const result = (entityId: string, over: Partial<ProjectWorkSearchResult> = {}): ProjectWorkSearchResult => {
    const row = rows.find((candidate) => candidate.ref.entityId === entityId)!;
    return {
      ref: row.ref,
      kind: row.kind,
      key: row.key,
      title: row.title,
      state: row.state,
      score: over.score ?? 1,
      exactKey: over.exactKey ?? false,
      matches: over.matches ?? [{ field: "body", snippet: "…" }],
    };
  };

  it("brings in a row that only matched inside its body", () => {
    const filter = { ...EMPTY_FILTER, text: "pdfium" };
    const merged = mergeSearchResults(rows, filter, "updated", [result("e2")]);
    expect(merged.rows.map((row) => row.key)).toEqual(["RES-7"]);
    expect(merged.fromBody).toBe(1);
  });

  it("puts an exact key first, above anything whose text matched", () => {
    const filter = { ...EMPTY_FILTER, text: "RES-7" };
    const merged = mergeSearchResults(rows, filter, "updated", [
      result("e1", { score: 9, matches: [{ field: "body", snippet: "…RES-7…" }] }),
      result("e2", { exactKey: true, score: 1, matches: [{ field: "key", snippet: "RES-7" }] }),
    ]);
    expect(merged.rows[0]?.key).toBe("RES-7");
  });

  it("does not let a search step around the other filters", () => {
    const archived: ProjectWorkListItem[] = [...rows, item({ entityId: "e4", kind: "spec", number: 9, title: "Old one", archived: true })];
    const filter = { ...EMPTY_FILTER, text: "old" };
    const merged = mergeSearchResults(archived, filter, "updated", [result("e1"), { ...result("e1"), ref: archived[3]!.ref, key: "SPEC-9" }]);
    expect(merged.rows.some((row) => row.key === "SPEC-9")).toBe(false);
  });
});
