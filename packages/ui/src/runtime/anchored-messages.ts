/**
 * The rows a person is standing on (RP-5b).
 *
 * Releasing the older part of a conversation must never pull the message the
 * viewport is anchored to, the one that has keyboard focus, or one a surface
 * has pinned while it is open — the page would jump, or focus would land
 * nowhere, in a conversation nobody asked to change.
 *
 * The transcript writes what it is standing on here; the view cache reads it
 * when it plans a trim and puts the ids into the transaction, so the reducer
 * stays a function of its action. Pure: a small map of ids, no React, no DOM,
 * and no reference to anything a view holds.
 */
const anchored = new Map<string, readonly string[]>();

/** Ids the transcript at this path is standing on, newest wins. */
export function setAnchoredMessages(path: string, ids: readonly string[]): void {
  if (ids.length === 0) anchored.delete(path);
  else anchored.set(path, [...new Set(ids)]);
}

export function anchoredMessages(path: string): readonly string[] {
  return anchored.get(path) ?? EMPTY;
}

/** A transcript that has gone stands on nothing. */
export function clearAnchoredMessages(path: string): void {
  anchored.delete(path);
}

export function resetAnchoredMessages(): void {
  anchored.clear();
}

const EMPTY: readonly string[] = Object.freeze([]);
