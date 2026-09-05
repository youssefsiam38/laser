import { describe, expect, it } from "vitest";
import type { SessionState } from "@piorbit/protocol";
import { blocksFromEntries, initialState, reduce, type AppState, type SessionView } from "../../src/store.js";

const sessionState: SessionState = {
  path: "/s.jsonl",
  id: "s",
  cwd: "/p",
  model: null,
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
};

const view = (): SessionView => ({
  path: "/s.jsonl",
  state: sessionState,
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
});

const withView = (): AppState => ({ ...initialState, open: { "/s.jsonl": view() } });

describe("dialogResolved", () => {
  it("removes a dialog the worker settled without us", () => {
    let s = reduce(withView(), {
      type: "notification",
      method: "pi/ui/request",
      params: { path: "/s.jsonl", method: "confirm", id: "u1", title: "Write?" },
    });
    s = reduce(s, {
      type: "notification",
      method: "pi/ui/request",
      params: { path: "/s.jsonl", method: "input", id: "u2", title: "Name?" },
    });
    expect(s.open["/s.jsonl"]!.dialogs.map((d) => d.id)).toEqual(["u1", "u2"]);

    s = reduce(s, {
      type: "notification",
      method: "pi/ui/event",
      params: { path: "/s.jsonl", method: "dialogResolved", id: "u1" },
    });
    expect(s.open["/s.jsonl"]!.dialogs.map((d) => d.id)).toEqual(["u2"]);
  });

  it("is a no-op for an unknown id and keeps the view identity", () => {
    const s0 = reduce(withView(), {
      type: "notification",
      method: "pi/ui/request",
      params: { path: "/s.jsonl", method: "confirm", id: "u1", title: "Write?" },
    });
    const s1 = reduce(s0, {
      type: "notification",
      method: "pi/ui/event",
      params: { path: "/s.jsonl", method: "dialogResolved", id: "nope" },
    });
    expect(s1.open["/s.jsonl"]).toBe(s0.open["/s.jsonl"]);
  });

  it("does not raise a toast or touch other sessions", () => {
    const s = reduce(withView(), {
      type: "notification",
      method: "pi/ui/event",
      params: { path: "/other.jsonl", method: "dialogResolved", id: "u1" },
    });
    expect(s.toasts).toEqual([]);
    expect(s.open["/s.jsonl"]).toBeDefined();
  });
});

describe("block timestamps", () => {
  it("stamps `at` on blocks a notification appended", () => {
    const at = "2026-09-05T12:00:00.000Z";
    let s = reduce(withView(), {
      type: "notification",
      method: "session/update",
      params: { sessionPath: "/s.jsonl", seq: 1, at, update: { kind: "text_delta", delta: "a", contentIndex: 0 } },
    });
    s = reduce(s, {
      type: "notification",
      method: "session/update",
      params: { sessionPath: "/s.jsonl", seq: 2, at: "2026-09-05T12:00:05.000Z", update: { kind: "text_delta", delta: "b", contentIndex: 0 } },
    });
    const blocks = s.open["/s.jsonl"]!.blocks;
    expect(blocks).toHaveLength(1);
    // The block was created by the first delta, so it keeps that timestamp.
    expect(blocks[0]).toMatchObject({ at, text: "ab" });
  });

  it("reads timestamps back out of persisted entries", () => {
    const blocks = blocksFromEntries([
      { type: "message", timestamp: 1_757_073_600_000, message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "message", timestamp: "2026-09-05T12:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "yo" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "no stamp" }] } },
    ]);
    expect(blocks[0]!.at).toBe(new Date(1_757_073_600_000).toISOString());
    expect(blocks[1]!.at).toBe("2026-09-05T12:00:00.000Z");
    expect(blocks[2]!.at).toBeUndefined();
  });
});
