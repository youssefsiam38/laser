/**
 * The `DesignIndex` body (M21-T10, `docs/design-phase.md` "The Design Index").
 *
 * What is pinned here is the contract the worker's parsers write and the
 * workspace reads: provenance on every entry, a DTCG token document with
 * bounded nesting, the review verbs including `split`, and the fields that
 * make a review survive a re-index — `factsDigest` and
 * `review.reviewedFactsDigest`.
 */
import { describe, expect, it } from "vitest";
import {
  DESIGN_INDEX_ENTRY_KINDS,
  DESIGN_INDEX_REVIEW_STATES,
  designIndexEntrySchema,
  designIndexSchema,
  designTokenDocumentSchema,
  designTokenSchema,
  type DesignIndex,
  type DesignTokenGroup,
} from "../src/project-work-bodies.js";

const DIGEST = "a".repeat(64);

function index(): DesignIndex {
  return {
    indexId: "idx_1",
    stack: { frameworks: ["React"], styling: ["Tailwind"], buildTool: "Vite", packageManager: "pnpm" },
    eras: [{ id: "era_1", name: "React + Tailwind", roots: ["packages/web"], useForNewWork: true }],
    entries: [
      {
        id: "e_1",
        kind: "component",
        name: "Button",
        eraId: "era_1",
        summary: "The one button.",
        detail: { props: "label: string", variants: "variant=primary" },
        sources: [{ path: "src/components/Button.tsx", digest: DIGEST, excerpt: "export function Button" }],
        confidence: "declared",
        status: "active",
        review: { state: "accepted", reviewer: "Rae", reviewedAt: "2026-02-01T10:00:00.000Z", reviewedFactsDigest: DIGEST },
        factsDigest: DIGEST,
        citations: ["f_1", "f_2"],
        changedSinceReview: true,
      },
    ],
    gaps: [{ path: "tailwind.config.js", reason: "a computed value; config is read as text and never run." }],
    builtAt: "2026-02-01T09:00:00.000Z",
    tokensDocument: {
      color: {
        brand: {
          "500": {
            $type: "color",
            $value: "#3b82f6",
            $description: "The brand colour.",
            $extensions: { "com.example.provenance": { sources: [{ path: "tailwind.config.js", digest: DIGEST }], confidence: "declared", usages: 4, entryId: "e_2" } },
          },
        },
      },
    },
    appRoot: "packages/web",
    builtWith: { layers: ["l0", "l1"], profileId: "design-index", model: "a-model" },
    stoppedEarly: false,
  };
}

describe("the index body", () => {
  it("accepts a full index, provenance and all", () => {
    const parsed = designIndexSchema.safeParse(index());
    expect(parsed.success).toBe(true);
  });

  it("keeps the kinds and the review verbs the design contract names", () => {
    expect([...DESIGN_INDEX_ENTRY_KINDS]).toEqual(["token", "component", "convention", "asset", "era", "philosophy"]);
    expect([...DESIGN_INDEX_REVIEW_STATES]).toEqual(["unreviewed", "accepted", "renamed", "merged", "split", "rejected"]);
  });

  it("carries what a review needs to survive a re-index", () => {
    const entry = index().entries[0]!;
    expect(designIndexEntrySchema.safeParse(entry).success).toBe(true);
    expect(designIndexEntrySchema.safeParse({ ...entry, factsDigest: "not-a-digest" }).success).toBe(false);
    expect(designIndexEntrySchema.safeParse({ ...entry, review: { ...entry.review, reviewedFactsDigest: "short" } }).success).toBe(false);
    const split = { ...entry, review: { state: "split" as const, reviewer: "Rae", note: "split into Button and IconButton" } };
    expect(designIndexEntrySchema.safeParse(split).success).toBe(true);
  });

  it("refuses a field nobody declared, on the index and on an entry", () => {
    expect(designIndexSchema.safeParse({ ...index(), screenshots: ["one.png"] }).success).toBe(false);
    expect(designIndexEntrySchema.safeParse({ ...index().entries[0], html: "<button>" }).success).toBe(false);
  });

  it("requires a confidence from the four labels, and nothing else", () => {
    for (const confidence of ["declared", "observed", "inferred", "proposed"]) {
      expect(designIndexEntrySchema.safeParse({ ...index().entries[0], confidence }).success, confidence).toBe(true);
    }
    expect(designIndexEntrySchema.safeParse({ ...index().entries[0], confidence: "certain" }).success).toBe(false);
  });
});

describe("the DTCG document", () => {
  it("accepts a token with a value, a type and its provenance", () => {
    expect(designTokenSchema.safeParse({ $type: "dimension", $value: "16px" }).success).toBe(true);
    expect(designTokenSchema.safeParse({ $value: { width: "1px", style: "solid" } }).success).toBe(true);
    expect(designTokenSchema.safeParse({ $type: "color" }).success).toBe(false);
    expect(designTokenSchema.safeParse({ $value: "#fff", colour: "#fff" }).success).toBe(false);
  });

  it("nests groups, and stops at six levels rather than without limit", () => {
    const leaf = { $type: "color", $value: "#000000" };
    const deep = (levels: number): DesignTokenGroup => {
      let node: DesignTokenGroup = { leaf };
      for (let level = 1; level < levels; level += 1) node = { group: node };
      return node;
    };
    expect(designTokenDocumentSchema.safeParse(deep(6)).success).toBe(true);
    expect(designTokenDocumentSchema.safeParse(deep(8)).success).toBe(false);
  });

  it("keeps an alias as the alias it is", () => {
    const document = { semantic: { action: { $type: "color", $value: "{color.brand.500}" } } };
    expect(designTokenDocumentSchema.safeParse(document).success).toBe(true);
  });
});
