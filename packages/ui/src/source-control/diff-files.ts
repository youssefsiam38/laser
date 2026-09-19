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
export type ExpansionState = "loading" | "ready" | "unsupported" | "unavailable" | "too-large";

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
    default:
      return null;
  }
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
