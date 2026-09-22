/**
 * Review — the index is a proposal until a person accepts it
 * (`docs/design-phase.md`, "Review").
 *
 * Automated component discovery is roughly two-thirds right in the industry's
 * own measurements, so nothing here pretends otherwise: an entry carries its
 * confidence and its sources, a person accepts, renames, merges, splits,
 * rejects, deprecates, marks an era `useForNewWork` or pins a convention, and
 * those decisions live in their own document.
 *
 * Two properties make review survive a rebuild:
 *
 * 1. **Stable ids.** An entry's id is derived from its kind, its era and its
 *    parsed name — not from a file path or a position — so the same component
 *    parsed out of a moved file is the same entry.
 * 2. **A digest per entry.** The review records the `factsDigest` it was made
 *    against; when the parse produces a different digest, the decision is kept
 *    and the entry is shown as **changed since review**, never silently
 *    re-accepted and never quietly dropped.
 */
import type { DesignIndex, DesignIndexEntry, DesignIndexReviewState } from "@lasercode/protocol";

export const DESIGN_REVIEW_ACTIONS = [
  "accept",
  "rename",
  "merge",
  "split",
  "reject",
  "deprecate",
  "undeprecate",
  "use-for-new-work",
  "pin",
  "unpin",
  "reset",
] as const;
export type DesignReviewAction = (typeof DESIGN_REVIEW_ACTIONS)[number];

/** Who made a decision. A model's review is recorded and shown as a model's. */
export interface ReviewActor {
  kind: "person" | "agent";
  label: string;
}

export interface ReviewDecision {
  state: DesignIndexReviewState;
  reviewer: string;
  reviewerKind: "person" | "agent";
  reviewedAt: string;
  /** The entry's `factsDigest` when the decision was made. */
  reviewedFactsDigest?: string;
  name?: string;
  renamedFrom?: string;
  mergedIntoId?: string;
  splitFromId?: string;
  status?: "active" | "deprecated" | "internal";
  pinned?: boolean;
  note?: string;
}

/** `<project>/.laser/design/review.json`. */
export interface ReviewDocument {
  version: 1;
  /** Decisions by entry id. */
  entries: Record<string, ReviewDecision>;
  /** The era a person chose for new work, and who chose it. */
  eras: Record<string, { useForNewWork: boolean; reviewer: string; reviewerKind: "person" | "agent"; reviewedAt: string }>;
}

export function emptyReview(): ReviewDocument {
  return { version: 1, entries: {}, eras: {} };
}

export interface ReviewInput {
  entryId: string;
  action: DesignReviewAction;
  actor: ReviewActor;
  at: string;
  name?: string;
  intoEntryId?: string;
  into?: string[];
  note?: string;
  useForNewWork?: boolean;
  /**
   * The `factsDigest` the caller believes the entry has. A mutation that
   * names a digest the index has moved past is refused rather than applied to
   * something the caller has not seen (the tool contract's retry rule).
   */
  expectedFactsDigest?: string;
}

export class ReviewRefused extends Error {
  readonly code: string;
  readonly next: string;
  constructor(code: string, message: string, next: string) {
    super(message);
    this.name = "ReviewRefused";
    this.code = code;
    this.next = next;
  }
}

/**
 * Apply one decision. Pure: the document in, a new document out, so a refusal
 * never leaves half a decision behind.
 */
export function applyReviewAction(document: ReviewDocument, index: DesignIndex, input: ReviewInput): ReviewDocument {
  const entry = index.entries.find((candidate) => candidate.id === input.entryId);
  if (!entry) {
    throw new ReviewRefused(
      "no_such_entry",
      `This index has no entry called "${input.entryId}".`,
      "call inspect_design_index to list the entries with their ids, then review one of them",
    );
  }
  if (input.expectedFactsDigest !== undefined && entry.factsDigest !== undefined && input.expectedFactsDigest !== entry.factsDigest) {
    throw new ReviewRefused(
      "entry_changed",
      `"${entry.name}" was re-indexed after you read it, so this decision would have been made against facts that have moved.`,
      `call inspect_design_index for ${entry.id} to read it as it is now, then review it again with the digest it reports`,
    );
  }
  const base: ReviewDecision = {
    state: "accepted",
    reviewer: input.actor.label,
    reviewerKind: input.actor.kind,
    reviewedAt: input.at,
    ...(entry.factsDigest !== undefined ? { reviewedFactsDigest: entry.factsDigest } : {}),
    ...(input.note !== undefined ? { note: input.note.slice(0, 1000) } : {}),
  };
  const existing = document.entries[input.entryId];
  const entries = { ...document.entries };
  const eras = { ...document.eras };

  switch (input.action) {
    case "accept":
      entries[input.entryId] = { ...existing, ...base, state: "accepted" };
      break;
    case "rename": {
      const name = input.name?.trim();
      if (name === undefined || name === "") {
        throw new ReviewRefused("missing_name", "A rename needs the new name.", "call review_design_index again with a name");
      }
      entries[input.entryId] = { ...existing, ...base, state: "renamed", name: name.slice(0, 200), renamedFrom: existing?.renamedFrom ?? entry.name };
      break;
    }
    case "merge": {
      const into = input.intoEntryId;
      if (into === undefined || into === input.entryId) {
        throw new ReviewRefused("missing_target", "A merge needs the id of the entry to merge into, and it cannot be the same entry.", "call review_design_index again with into_entry_id");
      }
      if (!index.entries.some((candidate) => candidate.id === into)) {
        throw new ReviewRefused("no_such_entry", `This index has no entry called "${into}" to merge into.`, "call inspect_design_index to list the entries with their ids");
      }
      entries[input.entryId] = { ...existing, ...base, state: "merged", mergedIntoId: into };
      break;
    }
    case "split": {
      const into = (input.into ?? []).map((name) => name.trim()).filter((name) => name !== "");
      if (into.length < 2) {
        throw new ReviewRefused("missing_parts", "A split needs at least two names for the parts.", "call review_design_index again with two or more names in into");
      }
      entries[input.entryId] = { ...existing, ...base, state: "split", note: `${base.note ? `${base.note} ` : ""}split into ${into.join(", ")}`.slice(0, 1000) };
      break;
    }
    case "reject":
      entries[input.entryId] = { ...existing, ...base, state: "rejected" };
      break;
    case "deprecate":
      entries[input.entryId] = { ...existing, ...base, state: existing?.state ?? "accepted", status: "deprecated" };
      break;
    case "undeprecate":
      entries[input.entryId] = { ...existing, ...base, state: existing?.state ?? "accepted", status: "active" };
      break;
    case "pin":
      entries[input.entryId] = { ...existing, ...base, state: existing?.state ?? "accepted", pinned: true };
      break;
    case "unpin":
      entries[input.entryId] = { ...existing, ...base, state: existing?.state ?? "accepted", pinned: false };
      break;
    case "use-for-new-work": {
      if (entry.kind !== "era") {
        throw new ReviewRefused("not_an_era", `"${entry.name}" is not an era, and only an era can be the one new work is composed in.`, "call inspect_design_index with kind era to list the eras, then mark one of them");
      }
      const wanted = input.useForNewWork ?? true;
      if (wanted) {
        // Exactly one era at a time: marking one unmarks the others, which is
        // the rule the composer relies on.
        for (const era of index.eras) {
          const previous = eras[era.id];
          if (era.id === entry.id) continue;
          if (previous?.useForNewWork === true || era.useForNewWork) {
            eras[era.id] = { useForNewWork: false, reviewer: input.actor.label, reviewerKind: input.actor.kind, reviewedAt: input.at };
          }
        }
      }
      eras[entry.id] = { useForNewWork: wanted, reviewer: input.actor.label, reviewerKind: input.actor.kind, reviewedAt: input.at };
      entries[input.entryId] = { ...existing, ...base, state: existing?.state ?? "accepted" };
      break;
    }
    case "reset":
      delete entries[input.entryId];
      delete eras[input.entryId];
      break;
  }
  return { version: 1, entries, eras };
}

/**
 * The reviewed index: decisions applied to a freshly parsed one.
 *
 * Renames show the person's name with the parsed name kept beside it; merged
 * and rejected entries stay in the index, labelled, because hiding them would
 * make the same wrong entry come back at the next re-index with no memory of
 * having been rejected.
 */
export function applyReview(index: DesignIndex, document: ReviewDocument): DesignIndex {
  const entries = index.entries.map((entry): DesignIndexEntry => {
    const decision = document.entries[entry.id];
    if (!decision) return entry;
    const changed = decision.reviewedFactsDigest !== undefined && entry.factsDigest !== undefined && decision.reviewedFactsDigest !== entry.factsDigest;
    return {
      ...entry,
      ...(decision.name !== undefined ? { name: decision.name } : {}),
      ...(decision.status !== undefined ? { status: decision.status } : {}),
      review: {
        state: decision.state,
        reviewer: decision.reviewer,
        reviewedAt: decision.reviewedAt,
        ...(decision.note !== undefined ? { note: decision.note } : {}),
        ...(decision.reviewedFactsDigest !== undefined ? { reviewedFactsDigest: decision.reviewedFactsDigest } : {}),
        ...(decision.renamedFrom !== undefined ? { renamedFrom: decision.renamedFrom } : {}),
        ...(decision.mergedIntoId !== undefined ? { mergedIntoId: decision.mergedIntoId } : {}),
        ...(decision.splitFromId !== undefined ? { splitFromId: decision.splitFromId } : {}),
        ...(decision.pinned !== undefined ? { pinned: decision.pinned } : {}),
      },
      ...(changed ? { changedSinceReview: true } : {}),
      ...(decision.renamedFrom !== undefined && decision.name !== undefined
        ? { detail: { ...(entry.detail ?? {}), parsedName: decision.renamedFrom } }
        : {}),
    };
  });
  const eras = index.eras.map((era) => {
    const decision = document.eras[era.id];
    return decision === undefined ? era : { ...era, useForNewWork: decision.useForNewWork };
  });
  const renamed = new Map<string, string>();
  for (const entry of entries) if (entry.kind === "era") renamed.set(entry.id, entry.name);
  return {
    ...index,
    entries,
    eras: eras.map((era) => ({ ...era, name: renamed.get(era.id) ?? era.name })),
  };
}

/** Entries a person has already decided on whose facts have since moved. */
export function changedSinceReview(index: DesignIndex): DesignIndexEntry[] {
  return index.entries.filter((entry) => entry.changedSinceReview === true);
}

/** How much of the index a person has actually looked at. */
export function reviewProgress(index: DesignIndex): { total: number; reviewed: number; changed: number } {
  const total = index.entries.length;
  const reviewed = index.entries.filter((entry) => entry.review.state !== "unreviewed").length;
  return { total, reviewed, changed: changedSinceReview(index).length };
}
