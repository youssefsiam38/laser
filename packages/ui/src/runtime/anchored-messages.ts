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

/**
 * The same rows, told apart (RP-5b §7): which one the viewport is holding,
 * which one has focus, and which ones an open action is aimed at. A trim
 * carries these into its stamp so an authoritative replacement can be checked
 * against them before it is committed.
 *
 * Canonical entry ids only. A row this surface has not read back yet has a
 * message id of its own and no entry behind it; there is nothing to preserve
 * for it, and nothing is invented.
 */
export interface StandingRows {
  anchorEntryId?: string;
  focusedEntryId?: string;
  actionTargetEntryIds?: readonly string[];
}

const standing = new Map<string, StandingRows>();
const listeners = new Map<string, Set<() => void>>();

/** The entry a transcript row belongs to, or nothing when it has none. */
export function entryIdOfMessageId(messageId: string | undefined): string | undefined {
  if (!messageId) return undefined;
  return messageId.startsWith("entry:") ? messageId.slice("entry:".length) || undefined : undefined;
}

/** What the transcript at this path is standing on, told apart. */
export function setStandingRows(path: string, rows: { anchor?: string | undefined; focused?: string | undefined; targets?: readonly (string | undefined)[] }): void {
  const targets = [...new Set((rows.targets ?? []).flatMap(id => { const entry = entryIdOfMessageId(id); return entry ? [entry] : []; }))];
  const next: StandingRows = {
    ...(entryIdOfMessageId(rows.anchor) ? { anchorEntryId: entryIdOfMessageId(rows.anchor)! } : {}),
    ...(entryIdOfMessageId(rows.focused) ? { focusedEntryId: entryIdOfMessageId(rows.focused)! } : {}),
    ...(targets.length > 0 ? { actionTargetEntryIds: targets } : {}),
  };
  const previous = standing.get(path);
  const sameTargets = previous?.actionTargetEntryIds?.length === next.actionTargetEntryIds?.length
    && (previous?.actionTargetEntryIds ?? []).every((id, index) => id === next.actionTargetEntryIds?.[index]);
  if (previous?.anchorEntryId === next.anchorEntryId && previous?.focusedEntryId === next.focusedEntryId && sameTargets) return;
  if (Object.keys(next).length === 0) standing.delete(path);
  else standing.set(path, next);
  for (const listener of listeners.get(path) ?? []) listener();
}

export function standingRows(path: string): StandingRows | undefined {
  return standing.get(path);
}

/** Told when what this path is standing on changes — including its live edge. */
export function onStanding(path: string, listener: () => void): () => void {
  const set = listeners.get(path) ?? new Set();
  set.add(listener);
  listeners.set(path, set);
  return () => { set.delete(listener); if (set.size === 0) listeners.delete(path); };
}

/** Whether the transcript at this path is showing the newest turn. */
const atEdge = new Set<string>();

export function setAtLiveEdge(path: string, following: boolean): void {
  const had = atEdge.has(path);
  if (following) atEdge.add(path); else atEdge.delete(path);
  if (had !== following) for (const listener of listeners.get(path) ?? []) listener();
}

export function atLiveEdge(path: string): boolean {
  return atEdge.has(path);
}

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
  standing.delete(path);
  atEdge.delete(path);
  for (const listener of listeners.get(path) ?? []) listener();
}

export function resetAnchoredMessages(): void {
  anchored.clear();
  standing.clear();
  atEdge.clear();
  for (const set of listeners.values()) for (const listener of set) listener();
}

const EMPTY: readonly string[] = Object.freeze([]);
