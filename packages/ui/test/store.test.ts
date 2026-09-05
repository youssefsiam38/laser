import { describe, expect, it } from "vitest";
import type { SessionState, SessionUpdate } from "@piorbit/protocol";
import { applyUpdate, blocksFromEntries, initialState, reduce, type SessionView } from "../src/store.js";

const state: SessionState = {
  path: "/s.jsonl", id: "s", cwd: "/p", model: null, thinkingLevel: "medium", isStreaming: false, isCompacting: false,
  steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0,
};

function view(): SessionView {
  return { path: "/s.jsonl", state, blocks: [], lastSeq: 0, running: false, queue: { steering: [], followUp: [] }, dialogs: [], statuses: {}, widgets: {}, hydrated: true, entries: [] };
}

function run(v: SessionView, updates: SessionUpdate[]): SessionView {
  return updates.reduce(applyUpdate, v);
}

describe("applyUpdate", () => {
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
    let v = reduce({ ...initialState, open: { "/s.jsonl": view() } }, { type: "optimisticUser", path: "/s.jsonl", text: "hi", images: 0 }).open["/s.jsonl"]!;
    v = run(v, [
      { kind: "message_start", role: "user" },
      { kind: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    ]);
    expect(v.blocks).toHaveLength(1);
    expect(v.blocks[0]).toMatchObject({ kind: "user", text: "hi", optimistic: false });
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
  it("moves the view to the new path and selects it", () => {
    const s0 = { ...initialState, open: { "/s.jsonl": { ...view(), lastSeq: 7 } }, current: "/s.jsonl" };
    const s1 = reduce(s0, { type: "forked", from: "/s.jsonl", state: { ...state, path: "/f.jsonl" } });
    expect(Object.keys(s1.open)).toEqual(["/f.jsonl"]);
    expect(s1.current).toBe("/f.jsonl");
    expect(s1.open["/f.jsonl"]).toMatchObject({ path: "/f.jsonl", lastSeq: 0, hydrated: false });
  });
});

describe("blocksFromEntries", () => {
  it("rebuilds user, assistant, tool call and result from Pi entries", () => {
    const blocks = blocksFromEntries([
      { type: "session", version: 3 },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "do it" }, { type: "image" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "ok" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "a b" }], isError: false } },
      { type: "model_change" },
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "assistant", "tool"]);
    expect(blocks[0]).toMatchObject({ text: "do it", images: 1 });
    expect(blocks[1]).toMatchObject({ text: "ok", thinking: "t" });
    expect(blocks[2]).toMatchObject({ name: "bash", result: "a b", done: true });
  });
});
