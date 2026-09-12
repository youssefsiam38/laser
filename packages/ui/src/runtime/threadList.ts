/**
 * The `RemoteThreadListAdapter` over laser's session catalog, plus the pure
 * builders it is made of.
 *
 * Identity: a thread's `remoteId` (and `externalId`) is the Pi **session file
 * path**. Ids are only unique per cwd, so the path is the one stable handle
 * (`@lasercode/protocol` SessionSummary.path).
 *
 * Archiving is client-local for now: laser's protocol has no archive verb, so
 * an archived path is remembered in `localStorage` under
 * {@link ARCHIVE_STORAGE_KEY}. Deleting is not supported at all — Pi session
 * files are the user's transcript history.
 *
 * The builders below are pure and tested in test/runtime/threadList.test.ts.
 */
import { storageKey, WORKTREES_DIR_NAME } from "@lasercode/protocol";
import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import type { ProjectInfo, SessionAttention, SessionSummary } from "@lasercode/protocol";
import type { SessionView } from "../store.js";

/**
 * `@assistant-ui/react` re-exports the adapter type but not its thread
 * metadata, so derive it from `fetch` rather than reaching into
 * `@assistant-ui/core` (not a direct dependency).
 */
export type RemoteThreadMetadata = Awaited<ReturnType<RemoteThreadListAdapter["fetch"]>>;

/** Attention order for the sidebar (DESIGN.md "Layout" → Sessions). */
export const ATTENTION_ORDER: readonly SessionAttention[] = [
  "waiting_for_input",
  "error",
  "finished_unread",
  "working",
  "idle",
];

export const ARCHIVE_STORAGE_KEY = storageKey("archived");

/** Lower sorts first. An absent (or unknown) attention is `idle`. */
export function attentionRank(attention: SessionAttention | undefined): number {
  const index = attention ? ATTENTION_ORDER.indexOf(attention) : -1;
  return index === -1 ? ATTENTION_ORDER.indexOf("idle") : index;
}

/**
 * The catalog does not fill `attention` yet (M2-T2), so an open view's live
 * state wins: a pending dialog outranks a running turn.
 */
export function sessionAttention(summary: SessionSummary, view?: SessionView | undefined): SessionAttention {
  if (view) {
    if (view.dialogs.length > 0) return "waiting_for_input";
    if (view.running) return "working";
  }
  return summary.attention ?? "idle";
}

/**
 * `name` from Pi, else the extension-set title, else what the person asked for.
 *
 * A session's identity is what it is about. Showing `01a07364` in the tab
 * title, the top bar, the sessions list and the mobile header names four
 * places after a hash the person has never seen and cannot use — while the
 * first line they typed is sitting right there in the catalog. So the fallback
 * is that line, and a session with nothing in it yet is "New session", which is
 * true and readable.
 *
 * Clipped to one line and a sane width here rather than in CSS, because this
 * string is also the browser tab title and a notification's heading, where
 * `truncate` does not reach.
 *
 * A child session an agent started carries the instance name its parent gave
 * it (`agent.subagentName`); before its first message, that name is what the
 * parent calls it, so it is what the person sees.
 */
export function sessionTitle(summary: SessionSummary, view?: SessionView | undefined): string {
  const named = summary.name ?? view?.title;
  if (named) return named;
  const first = firstUserText(view) ?? summary.firstMessage?.trim();
  if (first) return clipToTitle(first);
  const subagent = summary.agent?.subagentName ?? view?.state.agent?.subagentName;
  return subagent ? clipToTitle(subagent) : "New session";
}

/** The transcript's own first user line, for a session opened before the catalog scanned it. */
function firstUserText(view: SessionView | undefined): string | undefined {
  if (!view) return undefined;
  for (const block of view.blocks) if (block.kind === "user") return block.text;
  return undefined;
}

/** One line, no runs of whitespace, and an ellipsis rather than a hard cut mid-word. */
function clipToTitle(text: string, max = 60): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const modifiedTime = (summary: SessionSummary): number => {
  const time = Date.parse(summary.modifiedAt);
  return Number.isNaN(time) ? 0 : time;
};

/** Attention first, then most recently modified. Returns a new array. */
export function sortSessions(
  sessions: readonly SessionSummary[],
  views: Readonly<Record<string, SessionView | undefined>> = {},
): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    const rank = attentionRank(sessionAttention(a, views[a.path])) - attentionRank(sessionAttention(b, views[b.path]));
    if (rank !== 0) return rank;
    return modifiedTime(b) - modifiedTime(a);
  });
}

/**
 * Union the catalog with the sessions we have open. Pi only writes the session
 * file on the first message, so a just-created session is missing from
 * `pi/session/list` and would otherwise be unswitchable.
 */
export function mergeSessions(
  sessions: readonly SessionSummary[],
  open: Readonly<Record<string, SessionView | undefined>>,
): SessionSummary[] {
  const merged = new Map<string, SessionSummary>();
  for (const summary of sessions) merged.set(summary.path, summary);
  for (const view of Object.values(open)) {
    if (!view) continue;
    const listed = merged.get(view.path);
    if (listed) {
      // The catalog row wins, except for what only the open session can know
      // yet: an unwritten session has no file to read an agent record from,
      // and a row with no attribution makes the launcher treat a Beam chat as
      // the default agent's (M13-T47). The view's state carries the truth.
      if (listed.agent === undefined && view.state.agent !== undefined) merged.set(view.path, { ...listed, agent: view.state.agent });
      continue;
    }
    // `openedAt`, never `Date.now()`: a synthesized row must be byte-identical
    // across calls or every derived list (and `threadListSignature`) churns.
    const at = view.openedAt;
    merged.set(view.path, {
      path: view.path,
      id: view.state.id,
      cwd: view.state.cwd,
      ...(view.state.name !== undefined ? { name: view.state.name } : {}),
      createdAt: at,
      modifiedAt: at,
      messageCount: view.state.messageCount,
      // A child an agent just started is attributed by its own state before
      // the catalog scans the file, so it nests under its parent at once.
      ...(view.state.agent !== undefined ? { agent: view.state.agent } : {}),
      ...(view.state.agent?.parentPath !== undefined ? { parentPath: view.state.agent.parentPath } : {}),
    });
  }
  return [...merged.values()];
}

/** A first prompt is visible locally before the catalog or state snapshot catches up. */
export function sessionIsEmpty(summary: SessionSummary, view: SessionView | undefined): boolean {
  return summary.messageCount === 0 && (view?.state.messageCount ?? 0) === 0
    && !view?.blocks.some(block => block.kind === "user");
}

export function toThreadMetadata(
  summary: SessionSummary,
  view: SessionView | undefined,
  archived: boolean,
): RemoteThreadMetadata {
  const lastMessageAt = new Date(summary.modifiedAt);
  return {
    status: archived ? "archived" : "regular",
    remoteId: summary.path,
    externalId: summary.path,
    title: sessionTitle(summary, view),
    ...(Number.isNaN(lastMessageAt.getTime()) ? {} : { lastMessageAt }),
    custom: {
      cwd: summary.cwd,
      attention: sessionAttention(summary, view),
      modifiedAt: summary.modifiedAt,
      createdAt: summary.createdAt,
      empty: sessionIsEmpty(summary, view),
      ...(parentPathOf(summary) !== undefined ? { parentPath: parentPathOf(summary) } : {}),
      // Agent attribution (agents leap): the sessions panel nests a child
      // under its parent and labels it with the instance name.
      ...(summary.agent !== undefined ? { agentKind: summary.agent.kind, agentName: summary.agent.agentName } : {}),
      ...(summary.agent?.subagentName !== undefined ? { subagentName: summary.agent.subagentName } : {}),
      ...(summary.agent?.runId !== undefined ? { runId: summary.agent.runId } : {}),
    },
  };
}

/** The parent a child session names: the catalog's own link, else the agent record's. */
export function parentPathOf(summary: Pick<SessionSummary, "parentPath" | "agent">): string | undefined {
  return summary.parentPath ?? summary.agent?.parentPath;
}

// ---------------------------------------------------------------------------
// Client-local archive
// ---------------------------------------------------------------------------

export interface ArchiveStore {
  has(path: string): boolean;
  add(path: string): void;
  remove(path: string): void;
  list(): string[];
  /** React-compatible change subscription for project and thread visibility. */
  subscribe(listener: () => void): () => void;
  getSnapshot(): number;
}

/** Storage-backed archive set; degrades to in-memory when storage is unavailable. */
export function createArchiveStore(storage?: Pick<Storage, "getItem" | "setItem"> | null): ArchiveStore {
  const load = (): Set<string> => {
    try {
      const raw = storage?.getItem(ARCHIVE_STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
    } catch {
      return new Set();
    }
  };
  const set = load();
  const listeners = new Set<() => void>();
  let revision = 0;
  const persist = (): void => {
    try {
      storage?.setItem(ARCHIVE_STORAGE_KEY, JSON.stringify([...set]));
    } catch {
      /* private mode / quota — the archive stays in memory */
    }
  };
  const publish = (): void => {
    revision += 1;
    for (const listener of listeners) listener();
  };
  return {
    has: (path) => set.has(path),
    add: (path) => {
      if (set.has(path)) return;
      set.add(path);
      persist();
      publish();
    },
    remove: (path) => {
      if (!set.delete(path)) return;
      persist();
      publish();
    },
    list: () => [...set],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => revision,
  };
}

/**
 * Projects that belong in navigation for this client.
 *
 * The host counts every transcript on disk, including client-local archived
 * ones. That is correct for storage, but not for navigation: after a person
 * unpins a project and archives its last chat, the archived files must not
 * make the project look active. Open work remains reachable even when its
 * transcript was archived.
 */
/**
 * The project a directory belongs to: a child agent's worktree under
 * `<project>/.worktrees/<slug>` is part of that project, never a project of
 * its own (D-140).
 */
export function projectRootOfCwd(cwd: string): string {
  const marker = `/${WORKTREES_DIR_NAME}/`;
  const at = cwd.indexOf(marker);
  return at > 0 ? cwd.slice(0, at) : cwd;
}

export function visibleProjectCwds(
  projects: readonly ProjectInfo[],
  sessions: readonly SessionSummary[],
  open: Readonly<Record<string, SessionView | undefined>>,
  archive: ArchiveStore,
  options: { /** Directories that are never projects: the Beam and Chat workspaces. */ exclude?: readonly string[] } = {},
): string[] {
  const excluded = (options.exclude ?? []).map((cwd) => cwd.replace(/\\/g, "/").replace(/\/+$/, ""));
  const isExcluded = (cwd: string): boolean => {
    const path = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    return excluded.some((root) => path === root || path.startsWith(`${root}/`));
  };
  const archivedByCwd = new Map<string, number>();
  for (const session of sessions) {
    if (!archive.has(session.path)) continue;
    archivedByCwd.set(session.cwd, (archivedByCwd.get(session.cwd) ?? 0) + 1);
  }
  const visible: string[] = [];
  const seen = new Set<string>();
  const append = (raw: string) => {
    const cwd = projectRootOfCwd(raw);
    if (seen.has(cwd) || isExcluded(cwd)) return;
    seen.add(cwd);
    visible.push(cwd);
  };
  // Preserve the host's priority order. Sessions and open views only append
  // directories the host has not indexed yet, so a transient catalog update
  // cannot reshuffle a person's rail.
  for (const project of projects) {
    if (project.pinned || project.sessionCount > (archivedByCwd.get(project.cwd) ?? 0)) append(project.cwd);
  }
  const workspaceKind = (kind: string | undefined) => kind === "beam" || kind === "chat";
  for (const session of sessions) if (!archive.has(session.path) && !workspaceKind(session.agent?.kind)) append(session.cwd);
  for (const view of Object.values(open)) if (view && !workspaceKind(view.state.agent?.kind)) append(view.state.cwd);
  return visible;
}

/** Apply a partial project priority while retaining omitted host records. */
export function orderProjectInfos(projects: readonly ProjectInfo[], cwds: readonly string[]): ProjectInfo[] {
  const byCwd = new Map(projects.map((project) => [project.cwd, project]));
  const ordered: ProjectInfo[] = [];
  const seen = new Set<string>();
  for (const cwd of cwds) {
    const project = byCwd.get(cwd);
    if (!project || seen.has(cwd)) continue;
    seen.add(cwd);
    ordered.push(project);
  }
  for (const project of projects) {
    if (seen.has(project.cwd)) continue;
    ordered.push(project);
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface ThreadListDeps {
  /** Current catalog. Read lazily so the adapter identity can stay stable. */
  sessions(): readonly SessionSummary[];
  /** Currently open views, keyed by path. */
  views(): Readonly<Record<string, SessionView | undefined>>;
  archive: ArchiveStore;
  /** Explicit destination-owned target for a brand-new session. Never guessed from an open view. */
  creationTarget(): { cwd: string; agentName?: string | undefined; intent?: number | undefined } | undefined;
  /**
   * Reuse an unstarted session for this exact target, or create one; returns
   * its path. Must not make it current: the runtime adopts it first.
   */
  createSession(target: { cwd: string; agentName?: string | undefined; intent?: number | undefined }): Promise<string>;
  /** `pi/session/rename`. */
  renameSession(path: string, name: string): Promise<void>;
  /** Permanently delete a closed persisted transcript. */
  deleteSession(path: string): Promise<void>;
  /** `session/load` + `pi/session/entries` hydration. */
  loadSession(path: string): Promise<void>;
  /** `pi/session/list` refresh. */
  refreshSessions(): Promise<void>;
  /**
   * Brackets `initialize()` so the host can hold back `threads.reload()` and
   * the controlled selection.
   *
   * Creating a session dispatches into the store, which changes the thread-list
   * signature, which fires a reload. If that reload lands while assistant-ui is
   * still adopting the thread it just initialized, the runtime loses the entry
   * and every render throws `useClientLookup: key "<path>" not found` — a blank
   * screen until a reload. Verified in the sandbox: every first send from the
   * empty state crashed this way. The host counts these brackets and defers the
   * reload until the count returns to zero.
   *
   * The selection is held for the same reason (M13-T53). The runtime adopts
   * the returned path into the "new" thread and, when the catalog already
   * listed that path under its own row — a session the CLI created, reused by
   * the launcher — drops that row as an orphan. Had the host moved the runtime
   * onto the row meanwhile (a deep link, the launcher selecting what it
   * reused), the main thread pointed at an entry that no longer existed and
   * every render threw. So `createSession` never selects, and the controlled
   * `threadId` stays where it was until `endInitialize`, which fires only after
   * the runtime has finished adopting the result (see `initialize`).
   */
  beginInitialize?(target: { cwd: string; agentName?: string | undefined; intent?: number | undefined }): void;
  endInitialize?(target: { cwd: string; agentName?: string | undefined; intent?: number | undefined }): void;
}

/** An always-closed stream: Pi has no server-side title generation. */
const emptyTitleStream = () =>
  new ReadableStream({
    start(controller) {
      controller.close();
    },
  }) as never;

/** The displayed lineage, including children in other working directories. Cycles are harmless. */
export function sessionSubtreePaths(paths: readonly string[], sessions: readonly SessionSummary[]): string[] {
  const children = new Map<string, string[]>();
  for (const session of sessions) {
    const parent = parentPathOf(session);
    if (!parent) continue;
    const list = children.get(parent) ?? [];
    list.push(session.path);
    children.set(parent, list);
  }
  const found = new Set<string>();
  const pending = [...paths];
  while (pending.length) {
    const path = pending.pop()!;
    if (found.has(path)) continue;
    found.add(path);
    pending.push(...(children.get(path) ?? []));
  }
  return [...found];
}

export function createThreadListAdapter(deps: ThreadListDeps): RemoteThreadListAdapter {
  const metadataFor = (path: string): RemoteThreadMetadata | undefined => {
    const views = deps.views();
    const summary = mergeSessions(deps.sessions(), views).find((s) => s.path === path);
    if (!summary) return undefined;
    return toThreadMetadata(summary, views[path], deps.archive.has(path));
  };

  return {
    list: async () => {
      const views = deps.views();
      const merged = sortSessions(mergeSessions(deps.sessions(), views), views);
      return { threads: merged.map((s) => toThreadMetadata(s, views[s.path], deps.archive.has(s.path))) };
    },

    rename: async (remoteId, newTitle) => {
      await deps.renameSession(remoteId, newTitle);
      await deps.refreshSessions();
    },

    archive: async (remoteId) => {
      for (const path of sessionSubtreePaths([remoteId], mergeSessions(deps.sessions(), deps.views()))) deps.archive.add(path);
    },

    unarchive: async (remoteId) => {
      for (const path of sessionSubtreePaths([remoteId], mergeSessions(deps.sessions(), deps.views()))) deps.archive.remove(path);
    },

    delete: async (remoteId) => {
      await deps.deleteSession(remoteId);
      deps.archive.remove(remoteId);
      await deps.refreshSessions();
    },

    initialize: async () => {
      const target = deps.creationTarget();
      if (!target) throw new Error("This destination is not ready to start a conversation.");
      deps.beginInitialize?.(target);
      try {
        const path = await deps.createSession(target);
        // Deliberately no `refreshSessions()` here: the catalog reload that the
        // host runs once this bracket closes covers it, and doing it inside the
        // bracket only widens the window described on `beginInitialize`.
        return { remoteId: path, externalId: path };
      } finally {
        // The runtime applies this result on the microtask after the promise
        // settles; a bracket closed synchronously here would let the reload
        // and the selection catch-up land in between. The next macrotask is
        // strictly after that adoption.
        setTimeout(() => deps.endInitialize?.(target), 0);
      }
    },

    generateTitle: async () => emptyTitleStream(),

    fetch: async (threadId) => {
      await deps.loadSession(threadId);
      const metadata = metadataFor(threadId);
      if (metadata) return metadata;
      // Freshly created and not yet in the catalog: report the bare minimum.
      return { status: "regular", remoteId: threadId, externalId: threadId, custom: {} };
    },
  };
}

/**
 * A cheap signature of everything `list()` would return. Compare it across
 * renders and call `runtime.threads.reload()` when it changes, instead of
 * swapping the adapter (which drops cached threads and cancels mutations).
 */
export function threadListSignature(
  sessions: readonly SessionSummary[],
  views: Readonly<Record<string, SessionView | undefined>>,
  archive: ArchiveStore,
): string {
  const merged = sortSessions(mergeSessions(sessions, views), views);
  return merged
    .map((s) =>
      [
        s.path,
        sessionTitle(s, views[s.path]),
        sessionAttention(s, views[s.path]),
        s.modifiedAt,
        sessionIsEmpty(s, views[s.path]) ? "empty" : "started",
        archive.has(s.path) ? "a" : "r",
        // A child attributed after the fact moves under its parent: the list
        // has to reload for that, so the attribution is part of the signature.
        s.agent?.kind ?? "",
        parentPathOf(s) ?? "",
        s.agent?.subagentName ?? "",
      ].join("\u0001"),
    )
    .join("\u0002");
}
