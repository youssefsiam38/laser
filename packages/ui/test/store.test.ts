import { describe, expect, it } from "vitest";
import type { PendingMessage, SessionState, SessionUpdate } from "@lasercode/protocol";
import { applyUpdate, blocksFromEntries, initialState, reduce, type SessionView } from "../src/store.js";

const state: SessionState = {
  path: "/s.jsonl", id: "s", cwd: "/p", model: null, thinkingLevel: "medium", isStreaming: false, isCompacting: false,
  steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0,
};

function view(): SessionView {
  return { path: "/s.jsonl", state, blocks: [], lastSeq: 0, running: false, queue: { steering: [], followUp: [] }, dialogs: [], statuses: {}, widgets: {}, openedAt: "2026-09-05T00:00:00.000Z", hydrated: true, entries: [] };
}

function run(v: SessionView, updates: SessionUpdate[]): SessionView {
  return updates.reduce(applyUpdate, v);
}

const pending = (id: string): PendingMessage => ({
  id,
  content: [{ type: "text", text: id }],
  text: id,
  images: [],
  createdAt: "2026-09-10T00:00:00.000Z",
  state: "waiting",
});

describe("pending snapshot hydration", () => {
  it("does not resurrect a row when a newer empty update overtakes the list request", () => {
    const captured = [pending("sending")];
    const opened = { ...view(), pending: captured };
    const app = { ...initialState, open: { [opened.path]: opened } };
    const updated = reduce(app, {
      type: "notification",
      method: "session/update",
      params: {
        sessionPath: opened.path,
        seq: 1,
        at: "2026-09-10T00:00:00.000Z",
        update: { kind: "pending_update", pending: [] },
      },
    });
    const hydrated = reduce(updated, {
      type: "pending",
      path: opened.path,
      messages: captured,
      expectPending: captured,
    });
    expect(hydrated.open[opened.path]?.pending).toEqual([]);
  });

  it("still hydrates after an unrelated view update preserves the captured reference", () => {
    const captured: PendingMessage[] = [];
    const opened = { ...view(), pending: captured };
    const app = { ...initialState, open: { [opened.path]: opened } };
    const updated = reduce(app, { type: "goal", path: opened.path, goal: null });
    expect(updated.open[opened.path]?.pending).toBe(captured);
    const hydrated = reduce(updated, {
      type: "pending",
      path: opened.path,
      messages: [pending("from-list")],
      expectPending: captured,
    });
    expect(hydrated.open[opened.path]?.pending.map((message) => message.id)).toEqual(["from-list"]);
  });
});

describe("applyUpdate", () => {
  it("keeps startup capabilities when opening the session view", () => {
    const next = reduce(initialState, {
      type: "opened",
      state: { ...state, capabilities: ["provider-log", "transcribe"] },
    });
    expect(next.open["/s.jsonl"]?.capabilities).toEqual(["provider-log", "transcribe"]);
  });

  it("keeps the latest account allowance on the owning session", () => {
    const opened = reduce(initialState, { type: "opened", state });
    const next = reduce(opened, {
      type: "notification",
      method: "pi/extension/message",
      params: {
        path: "/s.jsonl",
        message: {
          type: "lasercode/account-usage/state",
          state: {
            provider: "openai-codex",
            status: "ready",
            snapshot: { provider: "openai-codex", fetchedAt: "2026-09-06T10:00:00.000Z", windows: [] },
          },
        },
      },
    });
    expect(next.open["/s.jsonl"]?.state.accountUsage).toMatchObject({ status: "ready" });
  });

  it("assembles a streamed assistant turn with a tool call", () => {
    const v = run(view(), [
      { kind: "agent_start" },
      { kind: "message_start", role: "user" },
      { kind: "message_end", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
      { kind: "message_start", role: "assistant" },
      { kind: "thinking_delta", delta: "hmm", contentIndex: 0 },
      { kind: "text_delta", delta: "Hel", contentIndex: 1 },
      { kind: "text_delta", delta: "lo", contentIndex: 1 },
      { kind: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } },
      { kind: "tool_execution_update", toolCallId: "t1", partial: "line1" },
      { kind: "tool_execution_end", toolCallId: "t1", result: "ok", isError: false },
      { kind: "message_start", role: "assistant" },
      { kind: "text_delta", delta: "Done.", contentIndex: 0 },
      { kind: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
      { kind: "agent_settled" },
    ]);
    expect(v.running).toBe(false);
    expect(v.blocks.map((b) => b.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(v.blocks[0]).toMatchObject({ text: "hello" });
    expect(v.blocks[1]).toMatchObject({ text: "Hello", thinking: "hmm", streaming: false });
    expect(v.blocks[2]).toMatchObject({ name: "read", partial: "line1", result: "ok", done: true, isError: false });
    expect(v.blocks[3]).toMatchObject({ text: "Done.", streaming: false });
  });

  it("keeps an optimistic user block instead of duplicating it", () => {
    let v = reduce({ ...initialState, open: { "/s.jsonl": view() } }, { type: "optimisticUser", path: "/s.jsonl", text: "hi", images: [] }).open["/s.jsonl"]!;
    v = run(v, [
      { kind: "message_start", role: "user" },
      { kind: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    ]);
    expect(v.blocks).toHaveLength(1);
    expect(v.blocks[0]).toMatchObject({ kind: "user", text: "hi", optimistic: false });
  });

  it("stamps a prompt's entry on its block the moment the engine writes it, and lends it to the tree", () => {
    const opened = { ...view(), entries: [{ type: "message", id: "u1", parentId: null, message: { role: "user", content: [] } }, { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [] } }], leafId: "a1" };
    let v = reduce({ ...initialState, open: { "/s.jsonl": opened } }, { type: "optimisticUser", path: "/s.jsonl", text: "next", images: [] }).open["/s.jsonl"]!;
    v = run(v, [
      { kind: "agent_start" },
      { kind: "message_start", role: "user" },
      { kind: "message_end", role: "user", message: { role: "user", content: [{ type: "text", text: "next" }] }, entry: { id: "u2", parentId: "a1" } },
      { kind: "message_start", role: "assistant" },
      { kind: "text_delta", delta: "on it", contentIndex: 0 },
    ]);
    // Mid-turn: the block knows its entry, and the tree holds a copy of it
    // so versions can be counted, while the leaf stays where the last read
    // put it — nothing between has been read yet.
    expect(v.running).toBe(true);
    expect(v.blocks[0]).toMatchObject({ kind: "user", text: "next", optimistic: false, entryId: "u2" });
    expect(v.entries.map((e) => (e as { id: string }).id)).toEqual(["u1", "a1", "u2"]);
    expect(v.entries[2]).toMatchObject({ type: "message", id: "u2", parentId: "a1", message: { role: "user" } });
    expect(v.leafId).toBe("a1");
    // Already read (a refresh raced the event): no duplicate.
    const again = applyUpdate(v, { kind: "message_end", role: "user", message: { role: "user", content: [{ type: "text", text: "next" }] }, entry: { id: "u2", parentId: "a1" } });
    expect(again.entries).toHaveLength(3);
  });

  it("leaves a prompt without an entry to the ordinal lookup", () => {
    let v = reduce({ ...initialState, open: { "/s.jsonl": view() } }, { type: "optimisticUser", path: "/s.jsonl", text: "hi", images: [] }).open["/s.jsonl"]!;
    v = run(v, [{ kind: "message_end", role: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }]);
    expect(v.blocks[0]).not.toHaveProperty("entryId");
    expect(v.entries).toEqual([]);
  });

  it("ignores replayed duplicates by seq and records queue, notices, and state", () => {
    let s = reduce({ ...initialState, open: { "/s.jsonl": view() } }, {
      type: "notification", method: "session/update",
      params: { sessionPath: "/s.jsonl", seq: 1, at: "", update: { kind: "text_delta", delta: "a", contentIndex: 0 } },
    });
    s = reduce(s, { type: "notification", method: "session/update", params: { sessionPath: "/s.jsonl", seq: 1, at: "", update: { kind: "text_delta", delta: "a", contentIndex: 0 } } });
    s = reduce(s, { type: "notification", method: "session/update", params: { sessionPath: "/s.jsonl", seq: 2, at: "", update: { kind: "queue_update", steering: ["x"], followUp: [] } } });
    s = reduce(s, { type: "notification", method: "session/update", params: { sessionPath: "/s.jsonl", seq: 3, at: "", update: { kind: "extension_error", extension: "ext", message: "boom" } } });
    const v = s.open["/s.jsonl"]!;
    expect((v.blocks[0] as { text: string }).text).toBe("a");
    expect(v.lastSeq).toBe(3);
    expect(v.queue.steering).toEqual(["x"]);
    expect(v.blocks.at(-1)).toMatchObject({ kind: "notice", level: "error" });
  });

  it("tracks dialogs, statuses, widgets, toasts and worker status", () => {
    let s = reduce({ ...initialState, open: { "/s.jsonl": view() } }, { type: "notification", method: "pi/ui/request", params: { path: "/s.jsonl", method: "select", id: "u1", title: "Pick", options: ["a"] } });
    s = reduce(s, { type: "notification", method: "pi/ui/request", params: { path: "/s.jsonl", method: "select", id: "u1", title: "Pick", options: ["a"] } });
    s = reduce(s, { type: "notification", method: "pi/ui/event", params: { path: "/s.jsonl", method: "setStatus", key: "k", text: "busy" } });
    s = reduce(s, { type: "notification", method: "pi/ui/event", params: { path: "/s.jsonl", method: "setWidget", key: "w", lines: ["l1"], placement: "belowEditor" } });
    s = reduce(s, { type: "notification", method: "pi/ui/event", params: { path: "/s.jsonl", method: "notify", message: "hey", level: "warning" } });
    s = reduce(s, { type: "notification", method: "pi/worker/status", params: { cwd: "/p", status: "crashed", message: "exit 1" } });
    const v = s.open["/s.jsonl"]!;
    expect(v.dialogs).toHaveLength(1);
    expect(reduce(s, { type: "dialogAnswered", id: "u1" }).open["/s.jsonl"]!.dialogs).toHaveLength(0);
    expect(v.statuses).toEqual({ k: "busy" });
    expect(v.widgets["w"]).toEqual({ lines: ["l1"], placement: "belowEditor" });
    expect(s.toasts.map((t) => t.level)).toEqual(["warning", "error"]);
    expect(s.workers["/p"]).toMatchObject({ status: "crashed" });
  });
});

describe("forked", () => {
  it("moves the cached view without selecting outside the destination controller", () => {
    const s0 = { ...initialState, open: { "/s.jsonl": { ...view(), lastSeq: 7 } }, current: "/s.jsonl" };
    const s1 = reduce(s0, { type: "forked", from: "/s.jsonl", state: { ...state, path: "/f.jsonl" } });
    expect(Object.keys(s1.open)).toEqual(["/f.jsonl"]);
    expect(s1.current).toBe("/s.jsonl");
    expect(s1.open["/f.jsonl"]).toMatchObject({ path: "/f.jsonl", lastSeq: 0, hydrated: false });
  });
});

describe("blocksFromEntries", () => {
  it("rebuilds user, assistant, tool call and result from Pi entries", () => {
    const blocks = blocksFromEntries([
      { type: "session", version: 3 },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "do it" }, { type: "image", mimeType: "image/png", data: "cGlj" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "ok" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "a b" }], isError: false } },
      { type: "model_change" },
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "assistant", "tool"]);
    expect(blocks[0]).toMatchObject({ text: "do it", images: [{ type: "image", mimeType: "image/png", data: "cGlj" }] });
    // An entry without an id (a hand-written fixture) stamps nothing.
    expect(blocks[0]).not.toHaveProperty("entryId");
    expect(blocks[1]).toMatchObject({ text: "ok", thinking: "t" });
    expect(blocks[2]).toMatchObject({ name: "bash", result: "a b", done: true });
  });

  it("stamps each prompt with the entry it was rebuilt from", () => {
    const blocks = blocksFromEntries([
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "one" }] } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "1" }] } },
      { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: [{ type: "text", text: "two" }] } },
    ]);
    expect(blocks.filter((b) => b.kind === "user").map((b) => (b as { entryId?: string }).entryId)).toEqual(["u1", "u2"]);
  });

  it("keeps a turn that ended short, even when it said nothing", () => {
    // A provider that rejects the key writes an assistant entry with no
    // content. Dropping it reloaded the session as a bare question with no
    // answer and nothing to explain the silence.
    const blocks = blocksFromEntries([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
      { type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 invalid key" } },
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "assistant"]);
    expect(blocks[1]).toMatchObject({ text: "", stopReason: "error", errorMessage: "401 invalid key" });
  });

  it("hides provider attempts that a later attempt recovered, including all but the final failure", () => {
    const entry = (text: string, stopReason: string, errorMessage?: string) => ({
      type: "message",
      message: { role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason, ...(errorMessage ? { errorMessage } : {}) },
    });
    const recovered = blocksFromEntries([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
      entry("", "error", "socket closed"),
      entry("done", "stop"),
    ]);
    expect(recovered.filter((block) => block.kind === "assistant")).toEqual([expect.objectContaining({ text: "done" })]);

    const exhausted = blocksFromEntries([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
      entry("", "error", "first socket close"),
      entry("", "error", "still unavailable"),
    ]);
    expect(exhausted.filter((block) => block.kind === "assistant")).toEqual([
      expect.objectContaining({ stopReason: "error", errorMessage: "still unavailable" }),
    ]);
  });

  it("draws no stopped row for the ordinary endings", () => {
    for (const stopReason of ["stop", "toolUse", "pending"]) {
      expect(blocksFromEntries([{ type: "message", message: { role: "assistant", content: [], stopReason } }])).toEqual([]);
    }
    const [block] = blocksFromEntries([
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } },
    ]);
    expect(block).toMatchObject({ text: "done" });
    expect(block).not.toHaveProperty("stopReason");
  });
});
