/**
 * The insertion region: where the new work goes, and how it is found again
 * (M21-T12).
 *
 * `docs/design-phase.md`, "Insertion region": the region records
 * `{ templatePath, structuralPath, textHash, box? }`; comments and later
 * revisions anchor to it; **if the template changes so the structural path no
 * longer resolves, the anchor is shown as orphaned, never silently moved.**
 *
 * The lookup itself is `resolveInsertionRegion` in the protocol, because the
 * workspace resolves anchors too and may not import the worker. This module
 * is the worker's side: making a region out of an outline node or a box, and
 * resolving one against a freshly parsed outline.
 */
import {
  applyInsertionRegionResolution,
  resolveInsertionRegion,
  type InsertionRegion,
  type InsertionRegionResolution,
} from "@lasercode/protocol";
import { stableId } from "../index/facts.js";
import { hashText } from "./files.js";
import { outlineAnchors, type HostOutline, type HostOutlineNode } from "./outline.js";

export interface RegionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The structural path a region drawn on a reference image carries. */
export const REFERENCE_IMAGE_PATH = "/reference-image";

/** A region on an outline node: the normal case. */
export function insertionRegionFromNode(node: HostOutlineNode, box?: RegionBox): InsertionRegion {
  return {
    id: stableId("ir", node.templatePath, node.structuralPath),
    templatePath: node.templatePath,
    structuralPath: node.structuralPath,
    textHash: node.textHash,
    ...(box !== undefined ? { box: roundBox(box) } : {}),
  };
}

export interface BoxRegionInput {
  /** The template this page's content lives in; the region still names one. */
  templatePath: string;
  box: RegionBox;
  /** The node the box sits over, when the person drew it on the outline. */
  node?: HostOutlineNode;
  /** A short note for a box drawn on a reference image with nothing beneath. */
  label?: string;
}

/**
 * A region drawn as a box. When it lands on an outline node the node is the
 * anchor and the box is extra; when it is drawn on a reference image with no
 * structure under it, the anchor is the image itself and the region says so —
 * it resolves as orphaned against any outline, which is honest: nothing in
 * the template claims that rectangle.
 */
export function insertionRegionFromBox(input: BoxRegionInput): InsertionRegion {
  const box = roundBox(input.box);
  if (input.node) return insertionRegionFromNode(input.node, box);
  const label = input.label ?? "";
  return {
    id: stableId("ir", input.templatePath, REFERENCE_IMAGE_PATH, `${String(box.x)},${String(box.y)},${String(box.width)},${String(box.height)}`),
    templatePath: input.templatePath,
    structuralPath: REFERENCE_IMAGE_PATH,
    textHash: hashText(`${REFERENCE_IMAGE_PATH}|${label}|${String(box.x)},${String(box.y)},${String(box.width)},${String(box.height)}`),
    box,
  };
}

function roundBox(box: RegionBox): RegionBox {
  const round = (value: number): number => Math.round(value * 100) / 100;
  return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) };
}

/**
 * Where the region is in a re-parsed outline.
 *
 * A template that is no longer part of the page is its own answer: the
 * structural path cannot be looked up at all, and saying "the file is gone"
 * is more use than saying "the path is gone".
 */
export function resolveRegionAgainstOutline(region: InsertionRegion, outline: HostOutline): InsertionRegionResolution {
  const templateIsHere = outline.nodes.some((node) => node.templatePath === region.templatePath);
  if (!templateIsHere) {
    return {
      state: "orphaned",
      reason: `${region.templatePath} is not part of this page any more, so the region cannot be found in it. Ground the route again and pick the region on the current outline.`,
    };
  }
  if (region.structuralPath === REFERENCE_IMAGE_PATH) {
    return {
      state: "orphaned",
      reason: "This region was drawn on a reference image, not on the template, so there is nothing in the parsed page to re-find it by. Pick it again on the outline to anchor it.",
    };
  }
  return resolveInsertionRegion(region, outlineAnchors(outline, region.templatePath));
}

/** The region as it now reads: `orphaned` set or cleared, nothing else moved. */
export function regionAfterResolution(region: InsertionRegion, resolution: InsertionRegionResolution): InsertionRegion {
  return applyInsertionRegionResolution(region, resolution);
}

export { resolveInsertionRegion };
export type { InsertionRegion, InsertionRegionResolution };
