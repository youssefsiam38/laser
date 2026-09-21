/**
 * Review: the decisions, and the two properties that make them survive a
 * rebuild — stable entry ids and a digest per entry
 * (`docs/design-phase.md`, "Review", "Re-index").
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applyReview, applyReviewAction, changedSinceReview, emptyReview, reviewProgress, ReviewRefused } from "../../src/design/index/review.js";
import { buildDesignIndex } from "../../src/design/index/command.js";
import { buildFixture, cleanupFixtures, copyFixture, entryNamed } from "./helpers.js";

afterAll(cleanupFixtures);

const PERSON = { kind: "person" as const, label: "Rae" };
const AGENT = { kind: "agent" as const, label: "Design worker" };
const AT = "2026-02-01T10:00:00.000Z";

describe("the decisions a person can record", () => {
  it("accepts, renames, merges, splits, rejects, deprecates and pins", async () => {
    const { index } = await buildFixture("react-tailwind");
    const button = entryNamed(index, "component", "Button");
    const card = entryNamed(index, "component", "Card");
    const legacy = entryNamed(index, "component", "LegacyButton");
    const spacing = entryNamed(index, "convention", "spacing rhythm");
    expect(button && card && legacy && spacing).toBeTruthy();

    let document = emptyReview();
    document = applyReviewAction(document, index, { entryId: button!.id, action: "accept", actor: PERSON, at: AT });
    document = applyReviewAction(document, index, { entryId: card!.id, action: "rename", name: "Panel", actor: PERSON, at: AT });
    document = applyReviewAction(document, index, { entryId: legacy!.id, action: "merge", intoEntryId: button!.id, actor: PERSON, at: AT });
    document = applyReviewAction(document, index, { entryId: spacing!.id, action: "pin", actor: PERSON, at: AT });

    const reviewed = applyReview(index, document);
    expect(reviewed.entries.find((entry) => entry.id === button!.id)?.review.state).toBe("accepted");
    const renamed = reviewed.entries.find((entry) => entry.id === card!.id);
    expect(renamed?.name).toBe("Panel");
    expect(renamed?.review.state).toBe("renamed");
    expect(renamed?.review.renamedFrom).toBe("Card");
    expect(renamed?.detail?.["parsedName"]).toBe("Card");
    expect(reviewed.entries.find((entry) => entry.id === legacy!.id)?.review.mergedIntoId).toBe(button!.id);
    expect(reviewed.entries.find((entry) => entry.id === spacing!.id)?.review.pinned).toBe(true);
    expect(reviewProgress(reviewed).reviewed).toBe(4);
  });

  it("records who decided, and never hides that a model did", async () => {
    const { index } = await buildFixture("vue-scss");
    const card = entryNamed(index, "component", "Card")!;
    const document = applyReviewAction(emptyReview(), index, { entryId: card.id, action: "accept", actor: AGENT, at: AT });
    expect(document.entries[card.id]?.reviewerKind).toBe("agent");
    expect(applyReview(index, document).entries.find((entry) => entry.id === card.id)?.review.reviewer).toBe("Design worker");
  });

  it("marks one era for new work, and unmarks the others", async () => {
    const { index } = await buildFixture("monorepo-eras");
    const legacy = index.eras.find((era) => era.roots.includes("packages/legacy"))!;
    const modern = index.eras.find((era) => era.roots.includes("packages/web"))!;
    const document = applyReviewAction(emptyReview(), index, { entryId: legacy.id, action: "use-for-new-work", useForNewWork: true, actor: PERSON, at: AT });
    const reviewed = applyReview(index, document);
    expect(reviewed.eras.find((era) => era.id === legacy.id)?.useForNewWork).toBe(true);
    expect(reviewed.eras.find((era) => era.id === modern.id)?.useForNewWork).toBe(false);
  });

  it("refuses what it cannot do, in words with a next call", async () => {
    const { index } = await buildFixture("vue-scss");
    const card = entryNamed(index, "component", "Card")!;
    expect(() => applyReviewAction(emptyReview(), index, { entryId: "e_nope", action: "accept", actor: PERSON, at: AT })).toThrow(ReviewRefused);
    expect(() => applyReviewAction(emptyReview(), index, { entryId: card.id, action: "rename", actor: PERSON, at: AT })).toThrow(/needs the new name/);
    expect(() => applyReviewAction(emptyReview(), index, { entryId: card.id, action: "merge", actor: PERSON, at: AT })).toThrow(/needs the id/);
    expect(() => applyReviewAction(emptyReview(), index, { entryId: card.id, action: "split", into: ["one"], actor: PERSON, at: AT })).toThrow(/at least two names/);
    expect(() => applyReviewAction(emptyReview(), index, { entryId: card.id, action: "use-for-new-work", actor: PERSON, at: AT })).toThrow(/not an era/);
    try {
      applyReviewAction(emptyReview(), index, { entryId: "e_nope", action: "accept", actor: PERSON, at: AT });
    } catch (error) {
      expect((error as ReviewRefused).code).toBe("no_such_entry");
      expect((error as ReviewRefused).next).toContain("inspect_design_index");
    }
  });

  it("refuses a decision made against facts the index has moved past", async () => {
    const { index } = await buildFixture("react-tailwind");
    const button = entryNamed(index, "component", "Button")!;
    expect(() =>
      applyReviewAction(emptyReview(), index, { entryId: button.id, action: "accept", actor: PERSON, at: AT, expectedFactsDigest: "0".repeat(64) }),
    ).toThrow(/re-indexed after you read it/);
    expect(() =>
      applyReviewAction(emptyReview(), index, { entryId: button.id, action: "accept", actor: PERSON, at: AT, expectedFactsDigest: button.factsDigest }),
    ).not.toThrow();
  });
});

describe("across a re-index", () => {
  it("keeps every decision by stable id, even when the source file moved", async () => {
    const project = copyFixture("react-tailwind");
    const first = await buildDesignIndex({ projectCwd: project });
    const button = entryNamed(first.index, "component", "Button")!;
    const card = entryNamed(first.index, "component", "Card")!;
    const document = applyReviewAction(
      applyReviewAction(emptyReview(), first.index, { entryId: button.id, action: "accept", actor: PERSON, at: AT }),
      first.index,
      { entryId: card.id, action: "rename", name: "Panel", actor: PERSON, at: AT },
    );

    // The component moves to another folder; nothing about it changes.
    const source = join(project, "src", "components", "Button.tsx");
    mkdirSync(join(project, "src", "ui"), { recursive: true });
    writeFileSync(join(project, "src", "ui", "Button.tsx"), readFileSync(source, "utf8"));
    rmSync(source);

    const second = await buildDesignIndex({ projectCwd: project, review: document });
    const rebuilt = second.index.entries.find((entry) => entry.id === button.id);
    expect(rebuilt?.name).toBe("Button");
    expect(rebuilt?.sources[0]?.path).toBe("src/ui/Button.tsx");
    expect(rebuilt?.review.state).toBe("accepted");
    expect(second.index.entries.find((entry) => entry.id === card.id)?.name).toBe("Panel");
  });

  it("says 'changed since review' when the entry's own facts moved", async () => {
    const project = copyFixture("react-tailwind");
    const first = await buildDesignIndex({ projectCwd: project });
    const button = entryNamed(first.index, "component", "Button")!;
    const card = entryNamed(first.index, "component", "Card")!;
    let document = applyReviewAction(emptyReview(), first.index, { entryId: button.id, action: "accept", actor: PERSON, at: AT });
    document = applyReviewAction(document, first.index, { entryId: card.id, action: "accept", actor: PERSON, at: AT });

    const source = join(project, "src", "components", "Button.tsx");
    writeFileSync(source, readFileSync(source, "utf8").replace('variant?: "primary" | "secondary" | "ghost";', 'variant?: "primary" | "secondary" | "ghost" | "danger";'));

    const second = await buildDesignIndex({ projectCwd: project, review: document });
    const changed = changedSinceReview(second.index);
    expect(changed.map((entry) => entry.id)).toEqual([button.id]);
    const rebuilt = second.index.entries.find((entry) => entry.id === button.id);
    expect(rebuilt?.review.state).toBe("accepted");
    expect(rebuilt?.detail?.["variants"]).toContain("variant=danger");
    expect(second.index.entries.find((entry) => entry.id === card.id)?.changedSinceReview).toBeUndefined();
  });
});
