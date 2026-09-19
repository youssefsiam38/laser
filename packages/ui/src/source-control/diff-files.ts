import type { FileDiffPage, FileSource } from "./contract.js";

export function appendPatchPage(current: FileDiffPage, next: FileDiffPage): FileDiffPage {
  const { nextOffset: _previous, ...rest } = current;
  return {
    ...rest,
    patch: `${current.patch}${next.patch}`,
    ...(next.offset !== undefined ? { offset: next.offset } : {}),
    bytes: (current.bytes ?? 0) + (next.bytes ?? 0),
    truncated: next.truncated === true,
    ...(next.nextOffset !== undefined ? { nextOffset: next.nextOffset } : {}),
  };
}

/** Both sides of a file, as the overlay fetched them. */
export type FetchedSides = { old: FileSource | null; next: FileSource | null };

/** Why a file's surrounding lines are, or are not, open to the person. */
export type ExpansionState = "loading" | "ready" | "unsupported" | "unavailable" | "too-large" | "mismatched";

/**
 * Only a two-sided change can gain context: an added or deleted file already
 * carries the one side it has, and a pure rename has no lines to open.
 */
export function expansionApplies(pierreType: string | undefined): boolean {
  return pierreType === "change" || pierreType === "rename-changed";
}

/**
 * The sentence under a diff whose context cannot be opened. `ready`,
 * `loading` and `unsupported` say nothing: a live expander, a fetch in
 * flight, and a file that never had surrounding lines are all self-evident.
 * What this must never be is "may be available" — a promise with no control
 * behind it, which is what the renderer writes when it is handed a patch and
 * a loader (`diff-expand.ts`).
 */
export function expansionNotice(state: ExpansionState): string | null {
  switch (state) {
    case "unavailable":
      return "The unchanged lines around these changes could not be read, so this file opens at its hunks only.";
    case "too-large":
      return "This file is too large to read whole, so only the lines around each change are shown.";
    case "mismatched":
      return "The rest of this file no longer matches this diff, so it opens at its hunks only. Reopen it to read it against the file as it is now.";
    default:
      return null;
  }
}

/**
 * The shape of a patch-parsed file diff, structurally.
 *
 * This module is in the overlay's eager chunk; `@pierre/diffs` is in the lazy
 * one and must stay there (D-317, pinned by `diff-body-guard.test.ts`), so
 * the parsed metadata is described here rather than imported. Every field is
 * one the library's `FileDiffMetadata` already carries.
 */
export type PatchContent =
  | { type: "context"; lines: number; additionLineIndex: number; deletionLineIndex: number }
  | { type: "change"; additions: number; deletions: number; additionLineIndex: number; deletionLineIndex: number };

export type PatchHunk = {
  additionStart: number;
  additionCount: number;
  deletionStart: number;
  deletionCount: number;
  hunkContent: readonly PatchContent[];
};

export type PatchedFile = {
  hunks: readonly PatchHunk[];
  additionLines: readonly string[];
  deletionLines: readonly string[];
};

/** The library's own line split, so our indices are its indices. */
export function splitSideLines(contents: string): string[] {
  return contents === "" ? [] : contents.split(/(?<=\n)/);
}

/** A unified hunk side's start/count as a zero-based index into its file. */
function sideStart(start: number, count: number): number {
  return start - (count === 0 ? 0 : 1);
}

function lines(count: number): string {
  return count === 1 ? "1 line" : `${count} lines`;
}

/**
 * Whether two fetched sides really are the two ends the patch was computed
 * from — and, when they are not, the first place they disagree.
 *
 * This is the guard that keeps a renderer throw from ever being reached.
 * `hydratePartialDiff` does not check: it copies the two files into the
 * metadata and keeps the hunk headers, so a mismatched pair produces a diff
 * whose internal invariants are broken. The renderer discovers that later,
 * *during render*, while estimating row heights — and a throw there unmounts
 * everything above it.
 *
 * Checked here, in the order a mismatch shows up:
 *  - the unchanged gap before each hunk is the same length on both sides;
 *  - each hunk's declared range fits inside the file it names;
 *  - every context, deleted and added line in the patch is that line of that
 *    side, character for character;
 *  - the hunk fills exactly the range its header claims;
 *  - the tail after the last hunk is the same length on both sides — the
 *    renderer's own assertion, stated in our words.
 *
 * A file we cannot verify (no hunks, missing arrays) counts as a mismatch:
 * hydration is an optimisation, and hunks-only is always correct.
 */
export function hydrationMismatch(file: PatchedFile, oldContents: string, newContents: string): string | undefined {
  const oldLines = splitSideLines(oldContents);
  const newLines = splitSideLines(newContents);
  if (!Array.isArray(file.hunks) || file.hunks.length === 0) return "the patch has no hunks to place";
  if (!Array.isArray(file.additionLines) || !Array.isArray(file.deletionLines)) return "the patch carries no lines";
  let oldPrevEnd = 0;
  let newPrevEnd = 0;
  for (const [index, hunk] of file.hunks.entries()) {
    const at = `hunk ${index + 1}`;
    const oldFrom = sideStart(hunk.deletionStart, hunk.deletionCount);
    const newFrom = sideStart(hunk.additionStart, hunk.additionCount);
    const oldTo = oldFrom + hunk.deletionCount;
    const newTo = newFrom + hunk.additionCount;
    if (oldFrom < oldPrevEnd || newFrom < newPrevEnd) return `${at} starts before the hunk above it ends`;
    if (oldFrom - oldPrevEnd !== newFrom - newPrevEnd) {
      return `the unchanged gap before ${at} is ${lines(oldFrom - oldPrevEnd)} on the old side and ${lines(newFrom - newPrevEnd)} on the new side`;
    }
    if (oldTo > oldLines.length || newTo > newLines.length) return `${at} runs past the end of the file it names`;
    let oldAt = oldFrom;
    let newAt = newFrom;
    for (const content of hunk.hunkContent ?? []) {
      const deletions = content.type === "context" ? content.lines : content.deletions;
      const additions = content.type === "context" ? content.lines : content.additions;
      for (let i = 0; i < deletions; i += 1) {
        if (file.deletionLines[content.deletionLineIndex + i] !== oldLines[oldAt + i]) {
          return `line ${oldAt + i + 1} of the old side is not the line ${at} expects`;
        }
      }
      for (let i = 0; i < additions; i += 1) {
        if (file.additionLines[content.additionLineIndex + i] !== newLines[newAt + i]) {
          return `line ${newAt + i + 1} of the new side is not the line ${at} expects`;
        }
      }
      oldAt += deletions;
      newAt += additions;
    }
    if (oldAt !== oldTo || newAt !== newTo) return `${at} does not fill the range its header claims`;
    oldPrevEnd = oldTo;
    newPrevEnd = newTo;
  }
  const oldTail = oldLines.length - oldPrevEnd;
  const newTail = newLines.length - newPrevEnd;
  if (oldTail !== newTail) {
    return `the last hunk is followed by ${lines(newTail)} on the new side and ${lines(oldTail)} on the old side`;
  }
  return undefined;
}

/**
 * Whether a pair of fetched sides may be handed to the renderer as the whole
 * file, and why not when they may not.
 *
 * Hydration rewrites every hunk's line index against the arrays it is given,
 * so a *prefix* of a file is worse than no file: the diff would render at
 * plausible but wrong line numbers. A truncated side is therefore refused
 * outright and the person is told the file is too large to open whole — that
 * is the bounded-expansion rule at its source, not at the DOM.
 */
export function expandableSides(pierreType: string | undefined, sides: FetchedSides | undefined): ExpansionState {
  if (!expansionApplies(pierreType)) return "unsupported";
  if (!sides) return "loading";
  if (sides.old?.truncated === true || sides.next?.truncated === true) return "too-large";
  if (!sides.old || !sides.next) return "unavailable";
  return "ready";
}
