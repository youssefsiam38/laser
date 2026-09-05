/**
 * Pi's persisted session tree, read for the transcript's message actions
 * (fork here, jump here, branches, edit-and-resend). Pure; tested in
 * test/thread/entries.test.ts.
 *
 * The store's blocks carry no entry ids (`blocksFromEntries` mints its own),
 * so a user message is matched to its entry by ORDINAL: the n-th user
 * message on screen is the n-th user `message` entry in file order, because
 * both walk the same entries with the same filter. An optimistic prompt that
 * Pi has not persisted yet has no entry and therefore no actions (R2).
 *
 * `pi/session/entries` returns the whole tree (`SessionManager.getEntries`),
 * not the current branch, and the session state does not expose the leaf, so
 * which continuation is "current" cannot be known here — the branch picker
 * says how many there are and moves between them, never which one is live.
 */

export interface EntryLike {
  id?: string;
  parentId?: string | null;
  type?: string;
  message?: { role?: string };
}

const asEntry = (raw: unknown): EntryLike => (raw && typeof raw === "object" ? (raw as EntryLike) : {});

const isUserEntry = (e: EntryLike): boolean => e.type === "message" && e.message?.role === "user" && typeof e.id === "string";

/** Ids of user message entries in file order — the same walk `blocksFromEntries` makes. */
export function userEntryIds(entries: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of entries) {
    const e = asEntry(raw);
    if (isUserEntry(e)) out.push(e.id!);
  }
  return out;
}

/** Entry id of the n-th (zero-based) user message, or undefined when it is not persisted yet. */
export function userEntryAt(entries: readonly unknown[], ordinal: number): string | undefined {
  if (ordinal < 0) return undefined;
  let n = 0;
  for (const raw of entries) {
    const e = asEntry(raw);
    if (!isUserEntry(e)) continue;
    if (n === ordinal) return e.id;
    n++;
  }
  return undefined;
}

/**
 * The continuations of an entry: its children in file order, excluding
 * labels (a label is a tree node too, but not a branch). Two or more means
 * the conversation forks here.
 */
export function continuationsOf(entries: readonly unknown[], entryId: string): string[] {
  const out: string[] = [];
  for (const raw of entries) {
    const e = asEntry(raw);
    if (e.parentId === entryId && e.type !== "label" && typeof e.id === "string") out.push(e.id);
  }
  return out;
}

/**
 * The leaf a branch ends at: from `entryId`, follow the LAST child (file
 * order) until an entry has none. Jumping to a continuation means jumping
 * to its leaf, so the next prompt lands at the end of that branch.
 */
export function leafOf(entries: readonly unknown[], entryId: string): string {
  let current = entryId;
  for (let guard = 0; guard < 10_000; guard++) {
    const children = continuationsOf(entries, current);
    const last = children.at(-1);
    if (last === undefined) return current;
    current = last;
  }
  return current;
}

/** How many user messages follow the one at `ordinal` — what a fork-with-edit leaves behind. */
export function laterUserMessages(userCount: number, ordinal: number): number {
  return Math.max(0, userCount - ordinal - 1);
}
