import { describe, expect, it, vi } from "vitest";
import { PRODUCT_VERSION } from "@lasercode/protocol";

import { initialState, reduce, type AppState } from "../../src/store.js";
import { TAIL_HARD_LIMITS, TAIL_RECORD_SCHEMA } from "../../src/runtime/tail-cache/bounds.js";
import type { TailRecord } from "../../src/runtime/tail-cache/record.js";
import { BODY_EXCERPT_MAX_BYTES } from "../../src/runtime/body-excerpt.js";
import { NOT_CONFIRMED, createProvisionalAuthority, pathsOfRun, sessionAuthorityRefusal } from "../../src/runtime/provisional-authority.js";
import {
  PROVISIONAL_SESSION_ID_MAX,
  provisionalPaintFrom,
  refusalFor,
  sessionIdForPath,
  summaryForPath,
} from "../../src/runtime/provisional-paint.js";
import { captureViewTail } from "../../src/runtime/view-tail.js";
import { sessionState, summary } from "../agents/fixtures.js";

const ENVIRONMENT = "e1.environment";
const PATH = "/p/conversation.jsonl";
const NOW = Date.parse("2026-09-16T12:00:00.000Z");

const entry = (id: string, parentId: string | null, text: string): unknown => ({
  type: "message", id, parentId,
  message: { role: id.startsWith("u") ? "user" : "assistant", content: [{ type: "text", text }] },
});

function record(over: Partial<TailRecord> = {}): TailRecord {
  const entries = [entry("u1", null, "What broke?"), entry("a1", "u1", "The build did.")];
  return {
    schema: TAIL_RECORD_SCHEMA,
    appVersion: PRODUCT_VERSION,
    environmentKey: ENVIRONMENT,
    sessionId: "session-1",
    revision: "r1.env.12",
    leafId: "a1",
    epoch: "worker-1",
    seq: 12,
    entries: entries.map((value) => ({
      id: (value as { id: string }).id,
      parentId: (value as { parentId: string | null }).parentId,
      json: JSON.stringify(value),
    })),
    truncated: false,
    attachments: [],
    attachmentsOmitted: 0,
    bytes: 512,
    capturedAt: new Date(NOW - 60_000).toISOString(),
    lastUsedAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  };
}

const options = { path: PATH, environmentKey: ENVIRONMENT, expectedSessionId: "session-1", appVersion: PRODUCT_VERSION, now: NOW };

/** A navigation that has chosen this row and is still resolving it. */
const resolving = (intent = 0): AppState["destination"] => ({
  phase: "resolving", intent, target: { kind: "session", path: PATH, visibleTab: "code" },
  rememberedCode: { kind: "no-project-landing" },
});

describe("choosing what a paint may come from", () => {
  it("takes the session's own id from the open view first, then the catalog, and refuses an unusable one", () => {
    const withView = reduce(initialState, { type: "opened", state: sessionState({ path: PATH, id: "from-state" }) });
    expect(sessionIdForPath(withView, PATH)).toBe("from-state");

    const catalog: AppState = { ...initialState, sessions: [summary({ path: PATH, id: "from-catalog" })] };
    expect(sessionIdForPath(catalog, PATH)).toBe("from-catalog");
    expect(summaryForPath(catalog, PATH)?.id).toBe("from-catalog");
    expect(sessionIdForPath(catalog, "/p/other.jsonl")).toBeUndefined();

    const oversized: AppState = { ...initialState, sessions: [summary({ path: PATH, id: "x".repeat(PROVISIONAL_SESSION_ID_MAX + 1) })] };
    expect(sessionIdForPath(oversized, PATH)).toBeUndefined();
    const empty: AppState = { ...initialState, sessions: [summary({ path: PATH, id: "" })] };
    expect(sessionIdForPath(empty, PATH)).toBeUndefined();
  });

  it("refuses a record from another environment, another build, another schema, an expired one and an identityless one", () => {
    expect(refusalFor(record(), options)).toBeUndefined();
    expect(refusalFor(record({ environmentKey: "e1.somewhere-else" }), options)).toBe("environment");
    expect(refusalFor(record({ appVersion: "0.0.1-other" }), options)).toBe("app-version");
    expect(refusalFor(record({ schema: "tail-cache/1" as TailRecord["schema"] }), options)).toBe("schema");
    expect(refusalFor(record({ sessionId: "" }), options)).toBe("identity");
    // A well-formed record for another conversation, however it arrived here.
    expect(refusalFor(record({ sessionId: "session-2" }), options)).toBe("foreign-session");
    expect(provisionalPaintFrom(record({ sessionId: "session-2" }), options)).toBeUndefined();
    expect(refusalFor(record({ revision: "" }), options)).toBe("revision");
    expect(refusalFor(record({ entries: [] }), options)).toBe("empty");
    const old = new Date(NOW - (TAIL_HARD_LIMITS.ageHours * 60 * 60 * 1000 + 1)).toISOString();
    expect(refusalFor(record({ capturedAt: old }), options)).toBe("expired");
    expect(refusalFor(record({ capturedAt: "not a date" }), options)).toBe("expired");
    // A capture from the future is not readable either: it cannot be aged.
    expect(refusalFor(record({ capturedAt: new Date(NOW + 60_000).toISOString() }), options)).toBe("expired");
    // A narrower policy than this build's ceiling is honoured.
    expect(refusalFor(record(), { ...options, maxAgeMs: 1_000 })).toBe("expired");

    for (const refused of [
      record({ environmentKey: "e1.somewhere-else" }),
      record({ appVersion: "0.0.1-other" }),
      record({ schema: "tail-cache/1" as TailRecord["schema"] }),
      record({ sessionId: "" }),
      record({ capturedAt: old }),
    ]) expect(provisionalPaintFrom(refused, options)).toBeUndefined();
  });
});

describe("the provisional transaction", () => {
  const paint = (over: Partial<AppState> = {}, intent = 0) => {
    const base: AppState = { ...initialState, destination: resolving(intent), sessions: [summary({ path: PATH, id: "session-1", cwd: "/p" })], ...over };
    const rows = provisionalPaintFrom(record(), { ...options, summary: summaryForPath(base, PATH), previous: base.open[PATH] })!;
    return reduce(base, {
      type: "views/provisional", path: PATH, intent,
      entries: rows.entries, stubs: rows.stubs, leafId: rows.leafId, mark: rows.mark,
      ...(rows.state ? { state: rows.state } : {}),
    });
  };

  it("builds rows with the canonical fold and claims no durable revision", () => {
    const view = paint().open[PATH]!;
    expect(view.blocks.map((block) => block.kind)).toEqual(["user", "assistant"]);
    expect(view.entries).toHaveLength(2);
    expect(view.leafId).toBe("a1");
    expect(view.provisional?.revision).toBe("r1.env.12");
    expect(view.validated).toBeUndefined();
    expect(view.hydrated).toBe(false);
  });

  it("is refused by a navigation that has already been superseded, and by one that is not resolving this row", () => {
    const moved: AppState = {
      ...initialState,
      sessions: [summary({ path: PATH, id: "session-1" })],
      destination: resolving(4),
    };
    expect(paint(moved, 3).open[PATH]).toBeUndefined();
    expect(paint(moved, 4).open[PATH]?.provisional).toBeDefined();

    // Committed elsewhere, or resolving another row: this paint belongs to no
    // navigation on screen and is refused.
    const elsewhere: AppState = {
      ...initialState,
      sessions: [summary({ path: PATH, id: "session-1" })],
      destination: { phase: "ready-code", intent: 4, code: { kind: "project-session", project: "/p", path: PATH } },
    };
    expect(paint(elsewhere, 4).open[PATH]).toBeUndefined();
    const otherRow: AppState = {
      ...initialState,
      sessions: [summary({ path: PATH, id: "session-1" })],
      destination: { phase: "resolving", intent: 4, target: { kind: "session", path: "/p/other.jsonl", visibleTab: "code" }, rememberedCode: { kind: "no-project-landing" } },
    };
    expect(paint(otherRow, 4).open[PATH]).toBeUndefined();
  });

  it("never paints over authority, a read in flight, or rows already on screen", () => {
    const hydrated = reduce(reduce(initialState, { type: "opened", state: sessionState({ path: PATH, id: "session-1" }) }),
      { type: "hydrate", path: PATH, entries: [entry("h1", null, "Already here")], leafId: "h1" });
    expect(paint({ open: hydrated.open }).open[PATH]?.provisional).toBeUndefined();
    expect(paint({ open: hydrated.open }).open[PATH]?.entries).toHaveLength(1);

    const reading = reduce(reduce(initialState, { type: "opened", state: sessionState({ path: PATH, id: "session-1" }) }),
      { type: "historyBegin", path: PATH, token: "t1" });
    expect(paint({ open: reading.open }).open[PATH]?.provisional).toBeUndefined();
  });

  it("keeps a dormant view's own drafts, questions and tray, and wakes it", () => {
    let app = reduce(initialState, { type: "opened", state: sessionState({ path: PATH, id: "session-1" }) });
    app = reduce(app, { type: "hydrate", path: PATH, entries: [entry("old", null, "Seen a while ago")], leafId: "old" });
    app = reduce(app, { type: "notification", method: "pi/ui/request", params: { path: PATH, method: "confirm", id: "q1", title: "Sure?" } } as never);
    app = reduce(app, { type: "views/evict", paths: [PATH], reason: "count", at: "2026-09-16T00:00:00.000Z" });
    expect(app.open[PATH]?.dormant).toBeDefined();
    const painted = paint({ open: app.open }).open[PATH]!;
    expect(painted.provisional).toBeDefined();
    expect(painted.dormant).toBeUndefined();
    expect(painted.dialogs.map((dialog) => dialog.id)).toEqual(["q1"]);
  });

  it("cannot be written back to this device as a record of its own", () => {
    const view = paint().open[PATH]!;
    // A provisional view holds no accepted revision, so the tail it would
    // release carries nothing (RP-5/RP-10): this device never re-files a guess.
    const tail = captureViewTail(view, "2026-09-16T12:00:00.000Z");
    expect(tail.omitted).toBe("no-revision");
    expect(tail.entries).toEqual([]);
  });

  it("is released with the transcript it belongs to", () => {
    const app = paint();
    const released = reduce(app, { type: "views/evict", paths: [PATH], reason: "pressure", at: "2026-09-16T00:00:00.000Z" }).open[PATH]!;
    expect(released.provisional).toBeUndefined();
    expect(released.blocks).toEqual([]);
  });
});

describe("turning a cached record into rows", () => {
  it("parses the authority's own entries and carries the record's identity, not a guess", () => {
    const paint = provisionalPaintFrom(record(), options)!;
    expect(paint.entries.map((value) => (value as { id: string }).id)).toEqual(["u1", "a1"]);
    expect(paint.leafId).toBe("a1");
    expect(paint.mark).toMatchObject({ revision: "r1.env.12", epoch: "worker-1", seq: 12, sessionId: "session-1", environmentKey: ENVIRONMENT });
    expect(paint.mark.at).toBe(new Date(NOW).toISOString());
  });

  it("drops one unreadable row and paints the conversation around it", () => {
    const broken = record();
    const rows = [...broken.entries];
    rows[0] = { ...rows[0]!, json: "{not json" };
    const paint = provisionalPaintFrom({ ...broken, entries: rows }, options)!;
    expect(paint.entries.map((value) => (value as { id: string }).id)).toEqual(["a1"]);
  });

  it("refuses a row whose stored identity does not match the record it claims to be", () => {
    const tampered = record();
    const rows = [...tampered.entries];
    rows[1] = { ...rows[1]!, json: JSON.stringify(entry("someone-elses-entry", "u1", "Injected")) };
    const paint = provisionalPaintFrom({ ...tampered, entries: rows }, options)!;
    expect(paint.entries.map((value) => (value as { id: string }).id)).toEqual(["u1"]);
  });

  it("points at a body larger than this view may hold instead of holding it (RP-5b bounds)", () => {
    const huge = entry("a2", "u1", "x".repeat(BODY_EXCERPT_MAX_BYTES + 1_000));
    const rows = [...record().entries, { id: "a2", parentId: "u1", json: JSON.stringify(huge) }];
    const paint = provisionalPaintFrom({ ...record(), entries: rows }, options)!;
    expect(paint.entries.map((value) => (value as { id: string }).id)).toEqual(["u1", "a1"]);
    expect(paint.stubs.map((stub) => stub.id)).toEqual(["a2"]);
    expect(JSON.stringify(paint.stubs)).not.toContain("xxxxxxxxxx");
  });

  it("carries a placeholder state only for a conversation this page holds no view for", () => {
    const catalog = summary({ path: PATH, id: "session-1", cwd: "/p", name: "Broken build" });
    const cold = provisionalPaintFrom(record(), { ...options, summary: catalog })!;
    expect(cold.state).toMatchObject({ path: PATH, id: "session-1", cwd: "/p", name: "Broken build", model: null, isStreaming: false });

    const warm = provisionalPaintFrom(record(), {
      ...options,
      previous: reduce(initialState, { type: "opened", state: sessionState({ path: PATH, id: "session-1" }) }).open[PATH]!,
    })!;
    expect(warm.state).toBeUndefined();
  });
});

describe("the fence every host-mutating control asks", () => {
  const painted = (): AppState => {
    const base: AppState = {
      ...initialState,
      destination: resolving(2),
      sessions: [summary({ path: PATH, id: "session-1", cwd: "/p" })],
    };
    const rows = provisionalPaintFrom(record(), { ...options, summary: summaryForPath(base, PATH) })!;
    return reduce(base, {
      type: "views/provisional", path: PATH, intent: 2,
      entries: rows.entries, stubs: rows.stubs, leafId: rows.leafId, mark: rows.mark,
      ...(rows.state ? { state: rows.state } : {}),
    });
  };

  it("refuses a conversation painted from this device, one still resolving and one that failed", () => {
    expect(sessionAuthorityRefusal(painted(), PATH)).toBe(NOT_CONFIRMED);

    const resolvingOnly: AppState = { ...initialState, destination: resolving(1) };
    expect(sessionAuthorityRefusal(resolvingOnly, PATH)).toBe(NOT_CONFIRMED);

    const failed: AppState = {
      ...initialState,
      destination: { phase: "unavailable", intent: 1, target: { kind: "session", path: PATH, visibleTab: "code" }, rememberedCode: { kind: "no-project-landing" }, error: "It did not open." },
    };
    expect(sessionAuthorityRefusal(failed, PATH)).toBe(NOT_CONFIRMED);
  });

  it("refuses nothing for a conversation nobody is painting, or for no conversation at all", () => {
    const state = painted();
    expect(sessionAuthorityRefusal(state, "/p/another.jsonl")).toBeUndefined();
    expect(sessionAuthorityRefusal(state, undefined)).toBeUndefined();
    const committed: AppState = {
      ...initialState,
      destination: { phase: "ready-code", intent: 2, code: { kind: "project-session", project: "/p", path: PATH } },
    };
    expect(sessionAuthorityRefusal(committed, PATH)).toBeUndefined();
  });

  it("reads an agent run's conversations from the registry: its own, its parent's and its root", () => {
    expect(pathsOfRun(undefined)).toEqual([]);
    const child = {
      runId: "r1", sessionPath: "/p/child.jsonl", rootSessionPath: "/p/root.jsonl",
      parent: { sessionPath: "/p/parent.jsonl", sessionId: "parent" },
    } as Parameters<typeof pathsOfRun>[0];
    expect(pathsOfRun(child)).toEqual(["/p/child.jsonl", "/p/parent.jsonl", "/p/root.jsonl"]);
  });
});


describe("what a paint holds on to", () => {
  const environmentRecord = (index: number, environmentKey: string): TailRecord =>
    record({ sessionId: `session-${index}`, environmentKey, revision: `r1.env.${index}` });

  const harness = (environmentKey = ENVIRONMENT) => {
    let app: AppState = { ...initialState, environment: { environmentKey } };
    const source = {
      peek: vi.fn((target: { sessionId: string }) => held.get(target.sessionId)),
      prime: vi.fn(async () => {}),
      supersede: vi.fn(),
    };
    const held = new Map<string, TailRecord>();
    const authority = createProvisionalAuthority({
      readState: () => app,
      dispatch: (action) => { app = reduce(app, action); },
      appVersion: PRODUCT_VERSION,
      now: () => NOW,
      source: () => source,
    });
    return {
      authority, source, held,
      environment(key: string) { app = { ...app, environment: { environmentKey: key } }; },
      /** One navigation that chooses `path` and never gets an answer. */
      choose(path: string, index: number, environmentKey: string) {
        held.set(`session-${index}`, environmentRecord(index, environmentKey));
        app = {
          ...app,
          sessions: [summary({ path, id: `session-${index}`, cwd: "/p" })],
          destination: { phase: "resolving", intent: index, target: { kind: "session", path, visibleTab: "code" }, rememberedCode: { kind: "no-project-landing" } },
        };
        authority.paint(path, index);
      },
      state: () => app,
    };
  };

  it("holds one paint at a time however many conversations fail to open", () => {
    const view = harness();
    for (let index = 1; index <= 60; index++) {
      // Every one of these is a host that never answered: nothing settles.
      view.choose(`/p/failed-${index}.jsonl`, index, ENVIRONMENT);
      expect(view.state().open[`/p/failed-${index}.jsonl`]?.provisional).toBeDefined();
      expect(view.authority.retainedCaptures()).toBe(1);
    }
    // Environments come and go under the same owner; the bound does not move.
    for (let index = 61; index <= 80; index++) {
      const environmentKey = `e1.environment-${index}`;
      view.environment(environmentKey);
      view.choose(`/p/switched-${index}.jsonl`, index, environmentKey);
      expect(view.authority.retainedCaptures()).toBe(1);
    }
    expect(view.authority.retainedCaptures()).toBe(1);
    // And nothing was retired for any of them: the host never spoke.
    expect(view.source.supersede).not.toHaveBeenCalled();
  });

  it("settles only the conversation it is holding, and holds nothing afterwards", () => {
    const view = harness();
    view.choose("/p/one.jsonl", 1, ENVIRONMENT);
    expect(view.authority.retainedCaptures()).toBe(1);
    // A conversation this owner is not holding settles nothing and keeps nothing.
    view.authority.settle("/p/another.jsonl");
    expect(view.authority.retainedCaptures()).toBe(1);
    expect(view.source.supersede).not.toHaveBeenCalled();
    view.authority.settle("/p/one.jsonl");
    expect(view.authority.retainedCaptures()).toBe(0);
    // Nothing authoritative was accepted, so nothing was retired either.
    expect(view.source.supersede).not.toHaveBeenCalled();
    view.authority.settle("/p/one.jsonl");
    expect(view.authority.retainedCaptures()).toBe(0);
  });
});
