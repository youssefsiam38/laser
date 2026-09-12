/**
 * Pi's persisted session tree, read for the transcript's message actions
 * (edit here, try again, jump, versions, fork). Pure; tested in
 * test/thread/entries.test.ts.
 *
 * The store's blocks carry no entry ids (`blocksFromEntries` mints its own),
 * so a user message is matched to its entry by ORDINAL: the n-th user message
 * before presentation filtering is the n-th user `message` entry ON THE
 * ACTIVE BRANCH. Projection preserves that ordinal in message metadata when it
 * hides automatic goal prompts. An optimistic prompt that Pi has not persisted
 * yet has no entry and therefore no actions (R2).
 *
 * `pi/session/entries` returns the whole tree (`SessionManager.getEntries`),
 * every branch of it, together with `leafId` — the entry the session is
 * sitting on. The conversation is the path from the root to that leaf, and
 * everything off that path is a version the person can come back to. `leafId`
 * is `null` when the leaf was reset to before the first entry (editing the
 * opening message) and `undefined` when the answer carried none; in that last
 * case the last entry in the file is the leaf, which is exactly how the engine
 * rebuilds it when it re-opens a session.
 */

export interface EntryLike {
  id?: string;
  parentId?: string | null;
  type?: string;
  message?: { role?: string; content?: unknown };
}

const asEntry = (raw: unknown): EntryLike => (raw && typeof raw === "object" ? (raw as EntryLike) : {});

const isUserEntry = (e: EntryLike): boolean => e.type === "message" && e.message?.role === "user" && typeof e.id === "string";

/**
 * The ids on the live branch, root to leaf. `undefined` means "all of them":
 * a file with a single branch is its own conversation, so it costs no
 * filtering and asks nothing of entries that carry no parent at all.
 */
type LeafKey = string | null | undefined;
const pathCache = new WeakMap<readonly unknown[], Map<LeafKey, Set<string> | undefined>>();
const userCache = new WeakMap<readonly unknown[], Map<LeafKey, string[]>>();

export function activePathIds(entries: readonly unknown[], leafId?: string | null): Set<string> | undefined {
  let cache = pathCache.get(entries);
  if (!cache) pathCache.set(entries, cache = new Map());
  if (cache.has(leafId)) return cache.get(leafId);
  const path = computeActivePathIds(entries, leafId);
  cache.set(leafId, path);
  return path;
}

function computeActivePathIds(entries: readonly unknown[], leafId?: string | null): Set<string> | undefined {
  // A leaf reset to before the first entry: the person is editing the opening
  // message, and nothing in the file is live until they send it.
  if (leafId === null) return new Set();
  // Told nothing, and one branch: the file is its own conversation. This is
  // also what keeps a plain list of messages — entries with no parent at all —
  // working exactly as it did.
  if (leafId === undefined && !isBranched(entries)) return undefined;
  const byId = new Map<string, EntryLike>();
  let last: string | undefined;
  for (const raw of entries) {
    const e = asEntry(raw);
    if (typeof e.id !== "string") continue;
    byId.set(e.id, e);
    last = e.id;
  }
  // A leaf the entries do not hold is a snapshot from either side of a change:
  // read the file the way the engine does rather than blank the transcript.
  const path = new Set<string>();
  let current = leafId !== undefined && byId.has(leafId) ? leafId : last;
  // A parent is always appended before its child, so this terminates; the
  // guard is only for a file whose parent chain was corrupted.
  for (let guard = 0; current !== undefined && guard < 100_000; guard++) {
    if (path.has(current)) break;
    path.add(current);
    const parent = byId.get(current)?.parentId;
    current = parent ?? undefined;
  }
  return path;
}

/**
 * Whether any entry has a sibling — whether the file holds more than one
 * branch. An entry carrying no `parentId` at all is not tree-shaped and makes
 * no claim either way, so a plain list of messages stays a plain list.
 */
function isBranched(entries: readonly unknown[]): boolean {
  const seen = new Set<string>();
  for (const raw of entries) {
    const e = asEntry(raw);
    if (typeof e.id !== "string" || e.type === "label" || e.parentId === undefined) continue;
    // A root entry has `parentId: null`; the prefix keeps it out of the id space.
    const key = e.parentId ?? "root:";
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/** Ids of user message entries on the live branch, in order. */
export function userEntryIds(entries: readonly unknown[], leafId?: string | null): string[] {
  let cache = userCache.get(entries);
  if (!cache) userCache.set(entries, cache = new Map());
  const cached = cache.get(leafId);
  if (cached) return cached;
  const path = activePathIds(entries, leafId);
  const out: string[] = [];
  for (const raw of entries) {
    const e = asEntry(raw);
    if (isUserEntry(e) && (!path || path.has(e.id!))) out.push(e.id!);
  }
  cache.set(leafId, out);
  return out;
}

/** Entry id of the n-th (zero-based) user message on the live branch, or undefined when it is not persisted yet. */
export function userEntryAt(entries: readonly unknown[], ordinal: number, leafId?: string | null): string | undefined {
  if (ordinal < 0) return undefined;
  return userEntryIds(entries, leafId)[ordinal];
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
 * Every version of one prompt: the user messages that share its place in the
 * tree, oldest first, including the one asked about. Editing a message in
 * place, and running a reply again, both append a sibling here — which is why
 * this, and not the entry's children, is what the version picker counts.
 */
export function versionsOf(entries: readonly unknown[], entryId: string): string[] {
  let parentId: string | null | undefined;
  for (const raw of entries) {
    const e = asEntry(raw);
    if (e.id !== entryId) continue;
    // No parent field at all is not a place in a tree, and every other entry
    // would look like a sibling of it. Such a file has one version of anything.
    if (e.parentId === undefined) return [];
    parentId = e.parentId;
    break;
  }
  if (parentId === undefined) return [];
  const out: string[] = [];
  for (const raw of entries) {
    const e = asEntry(raw);
    if ((e.parentId ?? null) === parentId && isUserEntry(e)) out.push(e.id!);
  }
  return out;
}

/**
 * The leaf a branch ends at: from `entryId`, follow the LAST child (file
 * order) until an entry has none. Switching to a version means moving the
 * session to its leaf, so the next prompt lands at the end of that branch.
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

/** How many user messages follow the one at `ordinal` — what an edit leaves on the other version. */
export function laterUserMessages(userCount: number, ordinal: number): number {
  return Math.max(0, userCount - ordinal - 1);
}
