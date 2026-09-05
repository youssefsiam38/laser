/**
 * The `RemoteThreadListAdapter` over piorbit's session catalog, plus the pure
 * builders it is made of.
 *
 * Identity: a thread's `remoteId` (and `externalId`) is the Pi **session file
 * path**. Ids are only unique per cwd, so the path is the one stable handle
 * (`@piorbit/protocol` SessionSummary.path).
 *
 * Archiving is client-local for now: piorbit's protocol has no archive verb, so
 * an archived path is remembered in `localStorage` under
 * {@link ARCHIVE_STORAGE_KEY}. Deleting is not supported at all — Pi session
 * files are the user's transcript history.
 *
 * The builders below are pure and tested in test/runtime/threadList.test.ts.
 */
import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import type { SessionAttention, SessionSummary } from "@piorbit/protocol";
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

export const ARCHIVE_STORAGE_KEY = "piorbit-archived";

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

/** `name` from Pi, else the extension-set title, else a short id. */
export function sessionTitle(summary: SessionSummary, view?: SessionView | undefined): string {
  return summary.name ?? view?.title ?? summary.id.slice(0, 8);
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
    if (!view || merged.has(view.path)) continue;
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
    });
  }
  return [...merged.values()];
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
      ...(summary.parentPath !== undefined ? { parentPath: summary.parentPath } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Client-local archive
// ---------------------------------------------------------------------------

export interface ArchiveStore {
  has(path: string): boolean;
  add(path: string): void;
  remove(path: string): void;
  list(): string[];
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
  const persist = (): void => {
    try {
      storage?.setItem(ARCHIVE_STORAGE_KEY, JSON.stringify([...set]));
    } catch {
      /* private mode / quota — the archive stays in memory */
    }
  };
  return {
    has: (path) => set.has(path),
    add: (path) => {
      set.add(path);
      persist();
    },
    remove: (path) => {
      set.delete(path);
      persist();
    },
    list: () => [...set],
  };
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
  /** cwd a brand-new session is created in. */
  currentProject(): string | undefined;
  /** `session/new` → returns the new session path. */
  createSession(cwd: string): Promise<string>;
  /** `pi/session/rename`. */
  renameSession(path: string, name: string): Promise<void>;
  /** `session/load` + `pi/session/entries` hydration. */
  loadSession(path: string): Promise<void>;
  /** `pi/session/list` refresh. */
  refreshSessions(): Promise<void>;
  /**
   * Brackets `initialize()` so the host can hold back `threads.reload()`.
   *
   * Creating a session dispatches into the store, which changes the thread-list
   * signature, which fires a reload. If that reload lands while assistant-ui is
   * still adopting the thread it just initialized, the runtime loses the entry
   * and every render throws `useClientLookup: key "<path>" not found` — a blank
   * screen until a reload. Verified in the sandbox: every first send from the
   * empty state crashed this way. The host counts these brackets and defers the
   * reload until the count returns to zero.
   */
  beginInitialize?(): void;
  endInitialize?(): void;
}

/** An always-closed stream: Pi has no server-side title generation. */
const emptyTitleStream = () =>
  new ReadableStream({
    start(controller) {
      controller.close();
    },
  }) as never;

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
      deps.archive.add(remoteId);
    },

    unarchive: async (remoteId) => {
      deps.archive.remove(remoteId);
    },

    delete: async () => {
      throw new Error(
        "piorbit does not delete Pi sessions: the transcript file is the user's history. Archive the session instead.",
      );
    },

    initialize: async () => {
      const cwd = deps.currentProject();
      if (!cwd) throw new Error("Pick a project before starting a session.");
      deps.beginInitialize?.();
      try {
        const path = await deps.createSession(cwd);
        // Deliberately no `refreshSessions()` here: the catalog reload that the
        // host runs once this bracket closes covers it, and doing it inside the
        // bracket only widens the window described on `beginInitialize`.
        return { remoteId: path, externalId: path };
      } finally {
        deps.endInitialize?.();
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
      [s.path, sessionTitle(s, views[s.path]), sessionAttention(s, views[s.path]), s.modifiedAt, archive.has(s.path) ? "a" : "r"].join(
        "\u0001",
      ),
    )
    .join("\u0002");
}
