import { describe, expect, it } from "vitest";
import type { ProjectInfo, SessionState, SessionSummary } from "@lasercode/protocol";
import type { SessionView } from "../../src/store.js";
import {
  ARCHIVE_STORAGE_KEY,
  attentionRank,
  createArchiveStore,
  createThreadListAdapter,
  mergeSessions,
  orderProjectInfos,
  sessionAttention,
  sessionTitle,
  sortSessions,
  threadListSignature,
  toThreadMetadata,
  visibleProjectCwds,
} from "../../src/runtime/threadList.js";

const summary = (over: Partial<SessionSummary> & Pick<SessionSummary, "path" | "id">): SessionSummary => ({
  cwd: "/p",
  createdAt: "2026-09-01T00:00:00.000Z",
  modifiedAt: "2026-09-01T00:00:00.000Z",
  messageCount: 0,
  ...over,
});

const sessionState = (over: Partial<SessionState> = {}): SessionState => ({
  path: "/a.jsonl",
  id: "abcdefgh1234",
  cwd: "/p",
  model: null,
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  autoCompactionEnabled: true,
  messageCount: 3,
  pendingMessageCount: 0,
  ...over,
});

const view = (over: Partial<SessionView> = {}): SessionView => ({
  path: "/a.jsonl",
  state: sessionState(),
  blocks: [],
  lastSeq: 0,
  running: false,
  queue: { steering: [], followUp: [] },
  dialogs: [],
  statuses: {},
  widgets: {},
  openedAt: "2026-09-05T00:00:00.000Z",
  hydrated: true,
  entries: [],
  ...over,
});

describe("sortSessions", () => {
  it("orders by attention, then by modifiedAt descending", () => {
    const sessions = [
      summary({ path: "/idle-old.jsonl", id: "1", attention: "idle", modifiedAt: "2026-01-01T00:00:00.000Z" }),
      summary({ path: "/idle-new.jsonl", id: "2", attention: "idle", modifiedAt: "2026-06-01T00:00:00.000Z" }),
      summary({ path: "/working.jsonl", id: "3", attention: "working", modifiedAt: "2026-01-01T00:00:00.000Z" }),
      summary({ path: "/error.jsonl", id: "4", attention: "error", modifiedAt: "2026-01-01T00:00:00.000Z" }),
      summary({ path: "/unread.jsonl", id: "5", attention: "finished_unread", modifiedAt: "2026-01-01T00:00:00.000Z" }),
      summary({ path: "/waiting.jsonl", id: "6", attention: "waiting_for_input", modifiedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(sortSessions(sessions).map((s) => s.path)).toEqual([
      "/waiting.jsonl",
      "/error.jsonl",
      "/unread.jsonl",
      "/working.jsonl",
      "/idle-new.jsonl",
      "/idle-old.jsonl",
    ]);
  });

  it("treats a missing attention as idle and does not mutate the input", () => {
    const sessions = [summary({ path: "/a.jsonl", id: "1" }), summary({ path: "/b.jsonl", id: "2", attention: "error" })];
    const sorted = sortSessions(sessions);
    expect(sorted.map((s) => s.path)).toEqual(["/b.jsonl", "/a.jsonl"]);
    expect(sessions.map((s) => s.path)).toEqual(["/a.jsonl", "/b.jsonl"]);
    expect(attentionRank(undefined)).toBe(attentionRank("idle"));
  });

  it("lets a live view outrank the catalog: a pending dialog beats a running turn", () => {
    const sessions = [
      summary({ path: "/a.jsonl", id: "1", modifiedAt: "2026-06-01T00:00:00.000Z" }),
      summary({ path: "/b.jsonl", id: "2", modifiedAt: "2026-06-02T00:00:00.000Z" }),
    ];
    const views = {
      "/a.jsonl": view({ path: "/a.jsonl", dialogs: [{ method: "confirm", id: "u1", title: "?" }] }),
      "/b.jsonl": view({ path: "/b.jsonl", running: true }),
    };
    expect(sessionAttention(sessions[0]!, views["/a.jsonl"])).toBe("waiting_for_input");
    expect(sessionAttention(sessions[1]!, views["/b.jsonl"])).toBe("working");
    expect(sortSessions(sessions, views).map((s) => s.path)).toEqual(["/a.jsonl", "/b.jsonl"]);
  });
});

describe("titles and metadata", () => {
  it("prefers the Pi name, then the extension title, then the first line the person typed", () => {
    expect(sessionTitle(summary({ path: "/a", id: "abcdefgh1234", name: "Refactor" }))).toBe("Refactor");
    expect(sessionTitle(summary({ path: "/a", id: "abcdefgh1234" }), view({ title: "From extension" }))).toBe(
      "From extension",
    );
    // Never the id: a hash names nothing a person can recognise.
    expect(sessionTitle(summary({ path: "/a", id: "abcdefgh1234", firstMessage: "  Fix the\n  flaky test " }))).toBe("Fix the flaky test");
    expect(sessionTitle(summary({ path: "/a", id: "abcdefgh1234" }))).toBe("New session");
  });

  it("clips a long first line on a word, and keeps it to one line", () => {
    const long = `Please ${"refactor ".repeat(20)}everything`;
    const title = sessionTitle(summary({ path: "/a", id: "x", firstMessage: long }));
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });

  it("maps a summary onto RemoteThreadMetadata with the path as remoteId", () => {
    const metadata = toThreadMetadata(
      summary({ path: "/a.jsonl", id: "abcdefgh", cwd: "/proj", modifiedAt: "2026-06-01T00:00:00.000Z", attention: "error", firstMessage: "Ship it" }),
      undefined,
      false,
    );
    expect(metadata).toMatchObject({
      status: "regular",
      remoteId: "/a.jsonl",
      externalId: "/a.jsonl",
      title: "Ship it",
      custom: { cwd: "/proj", attention: "error", modifiedAt: "2026-06-01T00:00:00.000Z" },
    });
    expect(metadata.lastMessageAt).toEqual(new Date("2026-06-01T00:00:00.000Z"));
  });

  it("marks archived threads archived", () => {
    expect(toThreadMetadata(summary({ path: "/a", id: "x" }), undefined, true).status).toBe("archived");
  });
});

describe("mergeSessions", () => {
  it("adds open sessions that the catalog has not seen yet", () => {
    const merged = mergeSessions([summary({ path: "/a.jsonl", id: "a" })], {
      "/new.jsonl": view({ path: "/new.jsonl", state: sessionState({ path: "/new.jsonl", id: "new", cwd: "/other" }) }),
    });
    expect(merged.map((s) => s.path).sort()).toEqual(["/a.jsonl", "/new.jsonl"]);
    expect(merged.find((s) => s.path === "/new.jsonl")).toMatchObject({ id: "new", cwd: "/other" });
  });
});

describe("createArchiveStore", () => {
  it("round-trips through storage under the documented key", () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
    };
    const store = createArchiveStore(storage);
    store.add("/a.jsonl");
    expect(store.has("/a.jsonl")).toBe(true);
    expect(JSON.parse(backing.get(ARCHIVE_STORAGE_KEY)!)).toEqual(["/a.jsonl"]);

    expect(createArchiveStore(storage).has("/a.jsonl")).toBe(true);
    store.remove("/a.jsonl");
    expect(store.list()).toEqual([]);
  });

  it("survives a missing or hostile storage", () => {
    const store = createArchiveStore(null);
    store.add("/x");
    expect(store.has("/x")).toBe(true);
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const guarded = createArchiveStore(throwing);
    guarded.add("/y");
    expect(guarded.has("/y")).toBe(true);
  });

  it("publishes only real archive changes", () => {
    const store = createArchiveStore(null);
    const revisions: number[] = [];
    const unsubscribe = store.subscribe(() => revisions.push(store.getSnapshot()));
    store.add("/a");
    store.add("/a");
    store.remove("/missing");
    store.remove("/a");
    unsubscribe();
    store.add("/b");
    expect(revisions).toEqual([1, 2]);
  });
});

describe("visibleProjectCwds", () => {
  const project = (cwd: string, pinned: boolean): ProjectInfo => ({
    cwd,
    name: cwd.slice(1),
    addedAt: "2026-09-06T00:00:00.000Z",
    trust: "not_required",
    pinned,
    sessionCount: 1,
  });

  it("hides an unpinned project whose on-disk chats are all archived", () => {
    const archive = createArchiveStore(null);
    archive.add("/old.jsonl");
    expect(
      visibleProjectCwds(
        [project("/archived", false), project("/pinned", true)],
        [summary({ path: "/old.jsonl", id: "old", cwd: "/archived" })],
        {},
        archive,
      ),
    ).toEqual(["/pinned"]);
  });

  it("keeps unarchived and open projects reachable", () => {
    const archive = createArchiveStore(null);
    archive.add("/open.jsonl");
    const open = view({ path: "/open.jsonl", state: sessionState({ path: "/open.jsonl", cwd: "/open" }) });
    expect(
      visibleProjectCwds(
        [project("/active", false), project("/open", false)],
        [
          summary({ path: "/active.jsonl", id: "active", cwd: "/active" }),
          summary({ path: "/open.jsonl", id: "open", cwd: "/open" }),
        ],
        { "/open.jsonl": open },
        archive,
      ),
    ).toEqual(["/active", "/open"]);
  });

  it("keeps a discovered project visible until its complete catalog is archived", () => {
    const archive = createArchiveStore(null);
    archive.add("/known.jsonl");
    expect(
      visibleProjectCwds(
        [{ ...project("/partial", false), sessionCount: 2 }],
        [summary({ path: "/known.jsonl", id: "known", cwd: "/partial" })],
        {},
        archive,
      ),
    ).toEqual(["/partial"]);
  });

  it("preserves host priority and only appends not-yet-indexed projects", () => {
    const archive = createArchiveStore(null);
    expect(
      visibleProjectCwds(
        [project("/z-priority", true), project("/a-later", true)],
        [summary({ path: "/new.jsonl", id: "new", cwd: "/new" })],
        {},
        archive,
      ),
    ).toEqual(["/z-priority", "/a-later", "/new"]);
  });
});

describe("orderProjectInfos", () => {
  const project = (cwd: string): ProjectInfo => ({
    cwd,
    name: cwd.slice(1),
    addedAt: "2026-09-06T00:00:00.000Z",
    trust: "not_required",
    pinned: true,
    sessionCount: 0,
  });

  it("applies a partial order without losing unknown or omitted records", () => {
    const projects = [project("/a"), project("/b"), project("/c")];
    expect(orderProjectInfos(projects, ["/c", "/missing", "/a", "/c"]).map((entry) => entry.cwd)).toEqual([
      "/c",
      "/a",
      "/b",
    ]);
  });
});

describe("createThreadListAdapter", () => {
  const deps = (over: Partial<Parameters<typeof createThreadListAdapter>[0]> = {}) => {
    const calls: string[] = [];
    const archive = createArchiveStore(null);
    const adapter = createThreadListAdapter({
      sessions: () => [summary({ path: "/a.jsonl", id: "aaaabbbb", attention: "idle", firstMessage: "Start here" })],
      views: () => ({}),
      archive,
      creationTarget: () => ({ cwd: "/proj", intent: 7 }),
      createSession: async (target) => {
        calls.push(`new:${target.cwd}:${target.intent}`);
        return "/created.jsonl";
      },
      renameSession: async (path, name) => void calls.push(`rename:${path}:${name}`),
      deleteSession: async (path) => void calls.push(`delete:${path}`),
      loadSession: async (path) => void calls.push(`load:${path}`),
      refreshSessions: async () => void calls.push("refresh"),
      beginInitialize: () => void calls.push("begin"),
      endInitialize: () => void calls.push("end"),
      ...over,
    });
    return { adapter, calls, archive };
  };

  it("lists sorted threads keyed by path", async () => {
    const { adapter } = deps();
    const { threads } = await adapter.list();
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ remoteId: "/a.jsonl", externalId: "/a.jsonl", title: "Start here" });
  });

  it("initialize creates a session in the current project", async () => {
    const { adapter, calls } = deps();
    await expect(adapter.initialize("local-1")).resolves.toEqual({
      remoteId: "/created.jsonl",
      externalId: "/created.jsonl",
    });
    // No "refresh": refreshing here changes the thread-list signature while
    // assistant-ui is still adopting the new thread, and the reload it triggers
    // makes the runtime throw `useClientLookup: key … not found`. The host
    // reloads once `end` closes the bracket instead — and the bracket closes
    // only on the next macrotask, after the runtime has applied the result
    // (M13-T53), so nothing the host holds back can land in between.
    expect(calls).toEqual(["begin", "new:/proj:7"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["begin", "new:/proj:7", "end"]);
  });

  it("initialize refuses without a project", async () => {
    const { adapter } = deps({ creationTarget: () => undefined });
    await expect(adapter.initialize("local-1")).rejects.toThrow(/destination/i);
  });

  it("initialize closes its bracket even when the session cannot be created", async () => {
    const { adapter, calls } = deps({
      createSession: async () => {
        throw new Error("worker is down");
      },
    });
    await expect(adapter.initialize("local-1")).rejects.toThrow(/worker is down/);
    // A leaked "begin" would gate every later thread-list reload forever.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["begin", "end"]);
  });

  it("rename goes through pi/session/rename and refreshes", async () => {
    const { adapter, calls } = deps();
    await adapter.rename("/a.jsonl", "New name");
    expect(calls).toEqual(["rename:/a.jsonl:New name", "refresh"]);
  });

  it("archive and unarchive flip the client-local set", async () => {
    const { adapter, archive } = deps();
    await adapter.archive("/a.jsonl");
    expect(archive.has("/a.jsonl")).toBe(true);
    expect((await adapter.list()).threads[0]!.status).toBe("archived");
    await adapter.unarchive("/a.jsonl");
    expect(archive.has("/a.jsonl")).toBe(false);
  });

  it("deletes an archived transcript through the host and removes the local archive flag", async () => {
    const { adapter, archive, calls } = deps();
    archive.add("/a.jsonl");
    await adapter.delete("/a.jsonl");
    expect(calls).toEqual(["delete:/a.jsonl", "refresh"]);
    expect(archive.has("/a.jsonl")).toBe(false);
  });

  it("fetch loads and hydrates the session, then reports its metadata", async () => {
    const { adapter, calls } = deps();
    const metadata = await adapter.fetch("/a.jsonl");
    expect(calls).toEqual(["load:/a.jsonl"]);
    expect(metadata).toMatchObject({ remoteId: "/a.jsonl", status: "regular" });
  });

  it("fetch tolerates a session the catalog has not caught up with", async () => {
    const { adapter } = deps();
    await expect(adapter.fetch("/unknown.jsonl")).resolves.toMatchObject({ remoteId: "/unknown.jsonl" });
  });

  it("generateTitle returns an already-closed stream", async () => {
    const { adapter } = deps();
    const stream = (await adapter.generateTitle("/a.jsonl", [])) as unknown as ReadableStream;
    await expect(stream.getReader().read()).resolves.toEqual({ done: true, value: undefined });
  });
});

describe("threadListSignature", () => {
  it("changes when a title, attention, or archive flag changes", () => {
    const archive = createArchiveStore(null);
    const sessions = [summary({ path: "/a.jsonl", id: "aaaabbbb" })];
    const base = threadListSignature(sessions, {}, archive);
    expect(threadListSignature(sessions, {}, archive)).toBe(base);
    expect(threadListSignature([{ ...sessions[0]!, name: "Renamed" }], {}, archive)).not.toBe(base);
    archive.add("/a.jsonl");
    expect(threadListSignature(sessions, {}, archive)).not.toBe(base);
  });

  // A synthesized row used to stamp `new Date()`, so the signature changed on
  // every call and `runtime.threads.reload()` fired on every streamed token.
  it("is stable for a session that is open but not yet in the catalog", async () => {
    const archive = createArchiveStore(null);
    const open = { "/new.jsonl": view({ path: "/new.jsonl", state: sessionState({ path: "/new.jsonl" }) }) };
    const first = threadListSignature([], open, archive);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(threadListSignature([], open, archive)).toBe(first);
  });

  it("synthesizes a summary from the view's openedAt, not the clock", () => {
    const open = { "/new.jsonl": view({ path: "/new.jsonl", state: sessionState({ path: "/new.jsonl" }) }) };
    const merged = mergeSessions([], open);
    expect(merged[0]).toMatchObject({
      path: "/new.jsonl",
      createdAt: "2026-09-05T00:00:00.000Z",
      modifiedAt: "2026-09-05T00:00:00.000Z",
    });
  });
});
