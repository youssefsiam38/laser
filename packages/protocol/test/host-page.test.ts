/**
 * Finding an insertion region again, and the host fields a Design body
 * carries (M21-T12, D-353).
 *
 * The rule under test is one sentence of `docs/design-phase.md`: "if the
 * template changes so the structural path no longer resolves, the anchor is
 * shown as orphaned, never silently moved". So: a path that resolves is
 * resolved, a path that resolves onto different words is `changed` and still
 * anchored, and a path that is gone is `orphaned` — with the place the same
 * words now live offered as something to accept, never applied.
 */
import { describe, expect, it } from "vitest";
import {
  applyInsertionRegionResolution,
  designBodySchema,
  insertionRegionIsAnchored,
  resolveInsertionRegion,
  type DesignBody,
  type HostOutlineAnchor,
  type InsertionRegion,
} from "../src/index.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const region: InsertionRegion = {
  id: "ir_1",
  templatePath: "app/views/invoices/index.html.erb",
  structuralPath: "/section[0]/table[0]",
  textHash: HASH_A,
};

function anchors(...rows: Array<[string, string, string?]>): HostOutlineAnchor[] {
  return rows.map(([structuralPath, textHash, id]) => ({ structuralPath, textHash, ...(id !== undefined ? { id } : {}) }));
}

describe("resolveInsertionRegion", () => {
  it("resolves when the path and the text are both still there", () => {
    const resolution = resolveInsertionRegion(region, anchors(["/section[0]", HASH_B], ["/section[0]/table[0]", HASH_A, "hn_7"]));
    expect(resolution).toEqual({ state: "resolved", structuralPath: "/section[0]/table[0]", nodeId: "hn_7" });
    expect(insertionRegionIsAnchored(resolution)).toBe(true);
  });

  it("reports a changed anchor rather than pretending nothing happened", () => {
    const resolution = resolveInsertionRegion(region, anchors(["/section[0]/table[0]", HASH_C, "hn_7"]));
    expect(resolution.state).toBe("changed");
    expect(resolution.nodeId).toBe("hn_7");
    expect(resolution.reason).toContain("app/views/invoices/index.html.erb");
    expect(insertionRegionIsAnchored(resolution)).toBe(true);
  });

  it("orphans an anchor whose path is gone, and says the section went", () => {
    const resolution = resolveInsertionRegion(region, anchors(["/section[0]", HASH_B]));
    expect(resolution.state).toBe("orphaned");
    expect(resolution.candidate).toBeUndefined();
    expect(resolution.reason).toContain("removed or rewritten");
    expect(insertionRegionIsAnchored(resolution)).toBe(false);
  });

  it("offers where the same text went, and moves nothing", () => {
    const resolution = resolveInsertionRegion(region, anchors(["/main[0]/table[0]", HASH_A, "hn_9"]));
    expect(resolution.state).toBe("orphaned");
    expect(resolution.candidate).toEqual({ structuralPath: "/main[0]/table[0]", nodeId: "hn_9" });
    expect(resolution.reason).toContain("nothing was moved for you");
    // The region itself still carries the path the person picked.
    const after = applyInsertionRegionResolution(region, resolution);
    expect(after.structuralPath).toBe("/section[0]/table[0]");
    expect(after.orphaned).toBe(true);
  });

  it("does not guess when two nodes carry the same text", () => {
    const resolution = resolveInsertionRegion(region, anchors(["/main[0]/table[0]", HASH_A], ["/aside[0]/table[0]", HASH_A]));
    expect(resolution.state).toBe("orphaned");
    expect(resolution.candidate).toBeUndefined();
  });

  it("clears the orphaned flag once the anchor resolves again", () => {
    const orphaned: InsertionRegion = { ...region, orphaned: true };
    const resolution = resolveInsertionRegion(orphaned, anchors(["/section[0]/table[0]", HASH_A]));
    expect(applyInsertionRegionResolution(orphaned, resolution)).toEqual(region);
  });

  it("says which template it could not find the path in", () => {
    const { templatePath: _dropped, ...withoutTemplate } = region;
    expect(resolveInsertionRegion(withoutTemplate, []).reason).toContain("the template");
  });
});

describe("the host fields of a Design body", () => {
  const body: DesignBody = {
    brief: "A saved-filters panel on the invoices page.",
    screens: [],
    flows: [],
    sketches: [],
    fixtures: [],
    fidelity: "mapped",
    hostPage: {
      routeOrPath: "/invoices",
      templatePath: "app/views/invoices/index.html.erb",
      outline: [
        { id: "hn_1", role: "template", label: "index.html.erb", depth: 0, structuralPath: "/", textHash: HASH_A },
        { id: "hn_2", role: "section", depth: 1, structuralPath: "/section[0]", textHash: HASH_B, sourcePath: "app/views/shared/_filters.html.erb" },
      ],
      files: ["app/views/invoices/index.html.erb"],
      references: [
        { kind: "repository", label: "The invoices page", path: "docs/screens/invoices.png", mediaType: "image/png", fidelity: "mapped" },
        { kind: "supplied", blobId: "blob_1", mediaType: "image/png", bytes: 2048, fidelity: "proposed" },
      ],
      stack: "rails",
      gaps: [{ path: "app/views/invoices/index.html.erb", reason: "one region was not outlined." }],
      fidelity: "mapped",
    },
    insertionRegion: region,
    strategy: {
      kind: "island",
      reason: "The host page is Bootstrap and new work belongs in React.",
      targetFiles: ["app/views/invoices/index.html.erb"],
      integrationContract: "Custom properties at the boundary, props in and events out.",
      reasons: ["The host page is Bootstrap and new work belongs in React."],
      tradeoffs: ["Two idioms on one page until the rest follows."],
      alternative: { kind: "conform", reasons: ["The team works in ERB every day."], tradeoffs: ["It ages with the host era."] },
      eraId: "era_modern",
      proposalOnly: true,
    },
  };

  it("validates", () => {
    const parsed = designBodySchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("still validates without any of the fields M21-T12 added", () => {
    const older: DesignBody = {
      ...body,
      hostPage: { routeOrPath: "/invoices", outline: [{ id: "hn_1", role: "section", depth: 0 }], files: [], fidelity: "mapped" },
      strategy: { kind: "conform", reason: "Small feature.", targetFiles: [] },
    };
    expect(designBodySchema.safeParse(older).success).toBe(true);
  });

  it("refuses a text hash that is not a digest", () => {
    const broken = { ...body, hostPage: { ...body.hostPage!, outline: [{ id: "hn_1", role: "section", depth: 0, textHash: "nope" }] } };
    expect(designBodySchema.safeParse(broken).success).toBe(false);
  });
});
