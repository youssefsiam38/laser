/**
 * What a file with no textual diff is, and what we say about it (M20-T5).
 *
 * Pure: no DOM, no adapter, no `@pierre/diffs`. The body that draws it lives
 * in `image-diff.tsx`; everything here is the decision and the words, so both
 * can be tested without a browser.
 *
 * Two outcomes, and the difference is whether a browser can paint the bytes:
 *
 *  - an **image** shows the picture — the new one, the old one beside it when
 *    both exist, with both sizes, both pixel sizes and the delta in bytes;
 *  - **anything else** (an archive, a font, a `.wasm`) gets a written state.
 *    It is not a failure: we read the file perfectly well, there is simply
 *    nothing in it that a line-by-line diff could say.
 */
import { imageMediaTypeForPath } from "@lasercode/protocol";

import { formatBytes } from "@/format";

import type { ChangedFile, FileDiffPage } from "./contract.js";

export type BinaryChangeKind = "added" | "modified" | "deleted" | "renamed";
export type BinarySide = "old" | "new";

export type BinaryFileView = {
  repo: string;
  path: string;
  oldPath?: string;
  kind: BinaryChangeKind;
  /** Set when the path names an image this app draws; the media type it draws it as. */
  mediaType?: string;
  /** The ends that exist for this change, oldest first. */
  sides: BinarySide[];
  /** Git said the two ends are the same blob (`similarity index 100%`). */
  bytesUnchanged?: true;
};

/**
 * Git's own two ways of saying "no lines here". `git diff` writes the first
 * for a binary file it will not inline and the second for `--binary`, and
 * neither is a patch anything can render.
 */
export function looksBinaryPatch(patch: string): boolean {
  return /^Binary files .* differ$/m.test(patch) || /^GIT binary patch$/m.test(patch);
}

/**
 * The file's change kind, taken from what the authority said and falling back
 * to what the patch header states. Never guessed from the absence of hunks:
 * an added empty file and a modified binary both have none.
 */
function changeKind(page: FileDiffPage, meta: ChangedFile | undefined): BinaryChangeKind {
  const oldPath = meta?.oldPath ?? page.oldPath;
  if (oldPath && oldPath !== page.path) return "renamed";
  const declared = meta?.change ?? page.change;
  if (declared) return declared;
  if (meta?.status === "added" || meta?.status === "deleted") return meta.status;
  if (/^new file mode /m.test(page.patch)) return "added";
  if (/^deleted file mode /m.test(page.patch)) return "deleted";
  return "modified";
}

/**
 * The view for a file the text path cannot draw, or `null` when this is an
 * ordinary patch and nothing about the text path changes.
 */
export function binaryFileView(page: FileDiffPage, meta?: ChangedFile): BinaryFileView | null {
  const binary = page.status === "binary" || meta?.status === "binary" || looksBinaryPatch(page.patch);
  if (!binary) return null;
  const kind = changeKind(page, meta);
  const mediaType = imageMediaTypeForPath(page.path);
  const oldPath = meta?.oldPath ?? page.oldPath;
  const view: BinaryFileView = {
    repo: page.repo,
    path: page.path,
    ...(oldPath && oldPath !== page.path ? { oldPath } : {}),
    kind,
    ...(mediaType ? { mediaType } : {}),
    sides: kind === "added" ? ["new"] : kind === "deleted" ? ["old"] : ["old", "new"],
  };
  // A rename that kept its bytes has two identical ends. Drawing the same
  // picture twice under "Before" and "After" would be a lie about the change.
  if (renameKeptBytes(view, page.patch)) return { ...view, sides: ["new"], bytesUnchanged: true };
  return view;
}

/** `src/logo.png, after` — what the picture is, in words, for a screen reader. */
export function imageAltText(view: BinaryFileView, side: BinarySide): string {
  const path = side === "old" ? (view.oldPath ?? view.path) : view.path;
  return `${path}, ${side === "old" ? "before" : "after"}`;
}

/** The label above a pane. A change with one side does not need "after". */
export function sideLabel(view: BinaryFileView, side: BinarySide): string {
  if (view.sides.length > 1) return side === "old" ? "Before" : "After";
  switch (view.kind) {
    case "deleted":
      return "Deleted";
    case "added":
      return "Added";
    case "renamed":
      return "Moved";
    default:
      return "After";
  }
}

/** `512 × 256`, with the multiplication sign, or nothing when we do not know. */
export function dimensionText(size: { width?: number; height?: number } | undefined): string | undefined {
  if (!size || !size.width || !size.height) return undefined;
  return `${size.width} × ${size.height}`;
}

/** `+1.2 KB`, `−340 B`, or the honest "same size" when the bytes moved but the count did not. */
export function byteDelta(oldBytes: number | undefined, newBytes: number | undefined): string | undefined {
  if (oldBytes === undefined || newBytes === undefined) return undefined;
  const delta = newBytes - oldBytes;
  if (delta === 0) return "same size";
  return `${delta > 0 ? "+" : "−"}${formatBytes(Math.abs(delta))}`;
}

/**
 * What happened to the file, and by how much — the predicate only. The
 * surface supplies the subject, which is the path, typed and isolated, so a
 * long path never ends up inside a sentence as plain prose.
 */
export function binarySizePredicate(
  view: BinaryFileView,
  sizes: { old?: number | undefined; next?: number | undefined },
): string {
  const old = sizes.old;
  const next = sizes.next;
  if (view.bytesUnchanged) {
    const size = next ?? old;
    return `moved from ${view.oldPath ?? "another path"}${size === undefined ? "" : `, still ${formatBytes(size)}`}, and its bytes did not change.`;
  }
  if (view.kind === "added") return next === undefined ? "was added in this scope." : `was added in this scope, at ${formatBytes(next)}.`;
  if (view.kind === "deleted") return old === undefined ? "was deleted in this scope." : `was deleted in this scope, at ${formatBytes(old)}.`;
  if (old === undefined || next === undefined) return "changed in this scope, byte for byte rather than line by line.";
  const delta = byteDelta(old, next);
  return `went from ${formatBytes(old)} to ${formatBytes(next)}${delta && delta !== "same size" ? ` (${delta})` : ", the same size"}.`;
}

/** `PNG`, `WOFF2`, or the honest fallback for a path with no extension. */
export function fileFormatWord(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const at = name.lastIndexOf(".");
  if (at <= 0 || at === name.length - 1) return "binary";
  const extension = name.slice(at + 1);
  return extension.length <= 8 && /^[a-z0-9]+$/i.test(extension) ? extension.toUpperCase() : "binary";
}

/** Title for the written state of a file we read perfectly well and cannot diff. */
export function binaryTitle(view: BinaryFileView): string {
  switch (view.kind) {
    case "added":
      return "Added";
    case "deleted":
      return "Deleted";
    case "renamed":
      return view.bytesUnchanged ? "Renamed, unchanged" : "Renamed";
    default:
      return "Changed";
  }
}

export type SideRefusal = "not-an-image" | "too-large" | "empty" | "missing" | "unavailable";

/**
 * Why a pane has no picture in it, written for a person. Every one of these
 * still states what is true about the file; none of them is an apology.
 */
export function refusalSentence(refusal: SideRefusal, totalBytes: number | undefined, capBytes: number): string {
  switch (refusal) {
    case "too-large":
      return `This image is ${totalBytes === undefined ? "larger" : formatBytes(totalBytes)}, over the ${formatBytes(capBytes)} this window draws, so its size is shown instead of the picture.`;
    case "empty":
      return "This side of the file is empty, so there is nothing to draw.";
    case "not-an-image":
      return "These bytes are not an image this window draws.";
    case "missing":
      return "This side does not exist in this scope.";
    case "unavailable":
      return "These bytes could not be read just now. Try opening the file again.";
  }
}

/**
 * A rename whose bytes did not change — on git's word, not on a guess. Git
 * writes `similarity index 100%` only when the two blobs are identical, so
 * this is the one case where we can say it and show the file once instead of
 * drawing the same picture twice.
 */
export function renameKeptBytes(view: BinaryFileView, patch: string): boolean {
  return view.kind === "renamed" && /^similarity index 100%$/m.test(patch);
}
