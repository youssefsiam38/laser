/**
 * Where an insertion region still is after the template moved (M21-T12).
 *
 * `project-work-bodies.ts` says what a `HostPage` and an `InsertionRegion`
 * *are*; this says how an anchor is **found again**. The rule is
 * `docs/design-phase.md`, "Insertion region":
 *
 * > if the template changes so the structural path no longer resolves, the
 * > anchor is shown as orphaned, never silently moved.
 *
 * So the resolution has three outcomes and only three:
 *
 * | Outcome | When | What a surface shows |
 * | --- | --- | --- |
 * | `resolved` | the structural path is in the re-parsed outline and the text hash matches | the region, anchored |
 * | `changed` | the path is there, the text under it is not what it was | the region, anchored, with "the content here changed" |
 * | `orphaned` | the path is gone | the region, detached, with the reason — and, when exactly one node still carries the same text, *where* it went, as an offer the person or the model has to take deliberately |
 *
 * The text hash is therefore a fallback for **finding** the content, never for
 * moving the anchor: nothing in this file rewrites a region's structural path.
 *
 * Pure: no DOM, no I/O, no hashing (the worker hashes; the UI compares).
 */
import type { InsertionRegion } from "./project-work-bodies.js";

/** One node of a re-parsed host outline, as far as an anchor is concerned. */
export interface HostOutlineAnchor {
  /** The outline node's stable id, when the outline carries ids. */
  id?: string;
  /** Its structural path in the template: `/main[0]/section[1]`. */
  structuralPath: string;
  /** A digest over the node's own text, whitespace-normalised. */
  textHash: string;
  /** What to call it in a sentence, when the outline knows. */
  label?: string;
}

export const INSERTION_REGION_STATES = ["resolved", "changed", "orphaned"] as const;
export type InsertionRegionState = (typeof INSERTION_REGION_STATES)[number];

export interface InsertionRegionResolution {
  state: InsertionRegionState;
  /** The outline node the region points at, while it still points at one. */
  nodeId?: string;
  structuralPath?: string;
  /** Written for a person: what happened and what to do about it. */
  reason?: string;
  /**
   * Where the same text lives now, when exactly one node still carries it.
   * An offer, never an action: the region is not moved by this function.
   */
  candidate?: { structuralPath: string; nodeId?: string; label?: string };
}

/** What a region needs to carry to be looked up again. */
export type InsertionRegionAnchorRef = Pick<InsertionRegion, "structuralPath" | "textHash"> &
  Partial<Pick<InsertionRegion, "templatePath">>;

function where(region: InsertionRegionAnchorRef): string {
  return region.templatePath === undefined ? "the template" : region.templatePath;
}

/**
 * Find an insertion region in a re-parsed outline: structural path first, text
 * hash only as a fallback that *reports* where the content went.
 */
export function resolveInsertionRegion(
  region: InsertionRegionAnchorRef,
  anchors: readonly HostOutlineAnchor[],
): InsertionRegionResolution {
  const atPath = anchors.filter((anchor) => anchor.structuralPath === region.structuralPath);
  const exact = atPath.find((anchor) => anchor.textHash === region.textHash);
  if (exact) {
    return {
      state: "resolved",
      structuralPath: exact.structuralPath,
      ...(exact.id !== undefined ? { nodeId: exact.id } : {}),
    };
  }
  const first = atPath[0];
  if (first) {
    return {
      state: "changed",
      structuralPath: first.structuralPath,
      ...(first.id !== undefined ? { nodeId: first.id } : {}),
      reason: `The content at ${region.structuralPath} in ${where(region)} changed since this region was recorded. The region still points there; re-read it before you compose into it.`,
    };
  }
  const sameText = anchors.filter((anchor) => anchor.textHash === region.textHash);
  const moved = sameText.length === 1 ? sameText[0] : undefined;
  if (moved) {
    return {
      state: "orphaned",
      reason: `${region.structuralPath} no longer exists in ${where(region)}. The same content now sits at ${moved.structuralPath}; nothing was moved for you — re-anchor the region there if that is still the place.`,
      candidate: {
        structuralPath: moved.structuralPath,
        ...(moved.id !== undefined ? { nodeId: moved.id } : {}),
        ...(moved.label !== undefined ? { label: moved.label } : {}),
      },
    };
  }
  return {
    state: "orphaned",
    reason: `${region.structuralPath} no longer exists in ${where(region)}, and no part of the page carries the text it had. The section was removed or rewritten; pick the region again on the current outline.`,
  };
}

/** True while the anchor still points at something in the template. */
export function insertionRegionIsAnchored(resolution: InsertionRegionResolution): boolean {
  return resolution.state !== "orphaned";
}

/**
 * The region as it now reads: the `orphaned` flag set or cleared, and nothing
 * else touched. The structural path a person picked stays the path they
 * picked, whatever the template did.
 */
export function applyInsertionRegionResolution(region: InsertionRegion, resolution: InsertionRegionResolution): InsertionRegion {
  if (resolution.state === "orphaned") return { ...region, orphaned: true };
  const { orphaned: _dropped, ...rest } = region;
  return rest;
}
