import { describe, expect, it } from "vitest";
import type { SessionState, SessionUpdate, UiDialogRequest } from "@lasercode/protocol";
import { applyUpdate, reduce, initialState, type Block, type SessionView } from "../../src/store.js";
import {
  NOTICE_DATA_PART,
  projectMessages,
  projectSessionView,
  shareProjectedMessages,
  splitDialogs,
  toolStatus,
  toolDisplayResult,
  type ProjectedContentPart,
  type ProjectionResult,
} from "../../src/runtime/projection.js";

type Part = { type: string; [key: string]: unknown };
const parts = (message: { content: unknown }): Part[] => message.content as Part[];

const sessionState: SessionState = {
  path: "/s.jsonl",
  id: "sess1234",
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

function view(overrides: Partial<SessionView> = {}): SessionView {
  return {
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
    ...overrides,
  };
}

const run = (v: SessionView, updates: SessionUpdate[]): SessionView => updates.reduce(applyUpdate, v);

describe("projectMessages — streaming order", () => {
  it("folds one run of assistant + tool blocks into a single assistant message, in order", () => {
    const v = run(view(), [
      { kind: "agent_start" },
      { kind: "message_start", role: "user" },
      { kind: "message_end", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
      { kind: "message_start", role: "assistant" },
      { kind: "thinking_delta", delta: "hmm", contentIndex: 0 },
      { kind: "text_delta", delta: "Working", contentIndex: 1 },
      { kind: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } },
      { kind: "tool_execution_end", toolCallId: "t1", result: "ok", isError: false },
      { kind: "message_start", role: "assistant" },
      { kind: "text_delta", delta: "Done.", contentIndex: 0 },
      { kind: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
      { kind: "agent_settled" },
    ]);

    const { messages } = projectSessionView(v);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    const turn = messages[1]!;
    expect(parts(turn).map((p) => p.type)).toEqual(["reasoning", "text", "tool-call", "text"]);
    expect(parts(turn)[0]).toMatchObject({ text: "hmm" });
    expect(parts(turn)[2]).toMatchObject({ toolCallId: "t1", toolName: "read", result: "ok" });
    expect(parts(turn)[2]).toMatchObject({ argsText: '{"path":"a.ts"}' });
    expect(turn.status).toEqual({ type: "complete", reason: "stop" });
  });

  it("uses block ids as message ids so a streaming turn keeps identity", () => {
    const blocks: Block[] = [
      { kind: "user", id: "b1", text: "hi", images: 0 },
      { kind: "assistant", id: "b2", text: "a", thinking: "", streaming: true },
      { kind: "tool", id: "t9", name: "bash", args: {}, done: false },
    ];
    const { messages } = projectMessages({ blocks, running: true, dialogs: [] });
    expect(messages.map((m) => m.id)).toEqual(["b1", "b2"]);
  });

  it("notes an image count on the user message", () => {
    const { messages } = projectMessages({
      blocks: [{ kind: "user", id: "b1", text: "look", images: 2 }],
      running: false,
      dialogs: [],
    });
    expect(parts(messages[0]!)).toEqual([
      { type: "text", text: "look" },
      { type: "text", text: "2 images attached" },
    ]);
  });

  it("carries createdAt when a block was stamped", () => {
    const at = "2026-09-05T10:00:00.000Z";
    const { messages } = projectMessages({
      blocks: [{ kind: "user", id: "b1", at, text: "hi", images: 0 }],
      running: false,
      dialogs: [],
    });
    expect(messages[0]!.createdAt).toEqual(new Date(at));
  });
});

describe("projectMessages — running status", () => {
  it("marks only the last streaming text part running, and only on the tail message", () => {
    const blocks: Block[] = [
      { kind: "assistant", id: "b1", text: "first", thinking: "", streaming: false },
      { kind: "user", id: "b2", text: "again", images: 0 },
      { kind: "assistant", id: "b3", text: "thinking out loud", thinking: "why", streaming: true },
    ];
    const { messages } = projectMessages({ blocks, running: true, dialogs: [] });
    expect(messages).toHaveLength(3);

    expect(parts(messages[0]!)[0]!.status).toEqual({ type: "complete" });
    expect(messages[0]!.status).toEqual({ type: "complete", reason: "stop" });

    const tail = messages[2]!;
    expect(parts(tail).map((p) => p.status)).toEqual([{ type: "complete" }, { type: "running" }]);
    expect(tail.status).toEqual({ type: "running" });
  });

  it("never emits an empty trailing text part", () => {
    const blocks: Block[] = [{ kind: "assistant", id: "b1", text: "", thinking: "", streaming: true }];
    const { messages } = projectMessages({ blocks, running: true, dialogs: [] });
    expect(parts(messages[0]!)).toEqual([]);
    expect(messages[0]!.status).toEqual({ type: "running" });
  });

  it("does not mark a settled turn running even when another session runs", () => {
    const blocks: Block[] = [{ kind: "assistant", id: "b1", text: "done", thinking: "", streaming: false }];
    const { messages } = projectMessages({ blocks, running: false, dialogs: [] });
    expect(parts(messages[0]!)[0]!.status).toEqual({ type: "complete" });
  });

  it("shows a live tool's partial output until the result lands", () => {
    const blocks: Block[] = [{ kind: "tool", id: "t1", name: "bash", args: { command: "ls" }, partial: "a\nb", done: false }];
    const { messages } = projectMessages({ blocks, running: true, dialogs: [] });
    const part = parts(messages[0]!)[0]!;
    expect(part.result).toBeUndefined();
    expect(part.artifact).toEqual({ partialOutput: "a\nb" });
    expect(toolDisplayResult(part)).toBe("a\nb");
    expect(toolStatus(blocks[0] as Extract<Block, { kind: "tool" }>, true)).toBe("running");
    expect(toolStatus(blocks[0] as Extract<Block, { kind: "tool" }>, false)).toBe("incomplete");
  });

  it("only final output settles a tool, including an empty result", () => {
    const blocks: Block[] = [{ kind: "tool", id: "t1", name: "bash", args: {}, partial: "progress", done: true }];
    const part = parts(projectMessages({ blocks, running: true, dialogs: [] }).messages[0]!)[0]!;
    expect(part.result).toBeNull();
    expect(part.artifact).toBeUndefined();
    expect(toolDisplayResult(part)).toBeNull();
  });
});

describe("projectMessages — dialogs", () => {
  const toolBlock: Block = { kind: "tool", id: "t1", name: "write", args: { path: "x" }, done: false };

  it("maps a tool-associated confirm onto a native approval", () => {
    const dialog: UiDialogRequest = { method: "confirm", id: "u1", title: "Write x?", toolCallId: "t1" };
    const { messages, freeStandingDialogs, toolDialogs } = projectMessages({
      blocks: [toolBlock],
      running: true,
      dialogs: [dialog],
    });
    expect(freeStandingDialogs).toEqual([]);
    expect(toolDialogs.get("t1")).toBe(dialog);
    expect(parts(messages[0]!)[0]).toMatchObject({ approval: { id: "u1", prompt: "Write x?" } });
    expect(messages[0]!.status).toEqual({ type: "requires-action", reason: "tool-calls" });
  });

  it.each(["select", "input", "editor"] as const)("maps a tool-associated %s onto a native interrupt", (method) => {
    const dialog = { method, id: "u2", title: "Pick", options: ["a"], toolCallId: "t1" } as UiDialogRequest;
    const { messages } = projectMessages({ blocks: [toolBlock], running: true, dialogs: [dialog] });
    expect(parts(messages[0]!)[0]!.interrupt).toEqual({
      type: "human",
      payload: { requestId: "u2", ...dialog },
    });
    expect(messages[0]!.status).toEqual({ type: "requires-action", reason: "interrupt" });
  });

  it("keeps a dialog free-standing without a toolCallId or with an unknown one", () => {
    const free: UiDialogRequest = { method: "input", id: "u3", title: "Name?" };
    const orphan: UiDialogRequest = { method: "confirm", id: "u4", title: "?", toolCallId: "nope" };
    const { freeStandingDialogs } = projectMessages({ blocks: [toolBlock], running: true, dialogs: [free, orphan] });
    expect(freeStandingDialogs.map((d) => d.id)).toEqual(["u3", "u4"]);
  });

  it("splitDialogs keeps only the first claimant of a toolCallId", () => {
    const a: UiDialogRequest = { method: "confirm", id: "a", title: "1", toolCallId: "t1" };
    const b: UiDialogRequest = { method: "confirm", id: "b", title: "2", toolCallId: "t1" };
    const { toolAssociated, freeStanding } = splitDialogs([a, b], new Set(["t1"]));
    expect(toolAssociated.get("t1")).toBe(a);
    expect(freeStanding).toEqual([b]);
  });
});

describe("projectMessages — notices", () => {
  it("emits a standalone assistant message with a notice data part", () => {
    let s = reduce({ ...initialState, open: { "/s.jsonl": view() } }, {
      type: "notification",
      method: "session/update",
      params: { sessionPath: "/s.jsonl", seq: 1, at: "", update: { kind: "compaction_start" } },
    });
    s = reduce(s, {
      type: "notification",
      method: "session/update",
      params: { sessionPath: "/s.jsonl", seq: 2, at: "", update: { kind: "extension_error", extension: "x", message: "boom" } },
    });
    const { messages } = projectSessionView(s.open["/s.jsonl"]);
    expect(messages).toHaveLength(2);
    expect(parts(messages[1]!)[0]).toEqual({
      type: "data",
      name: NOTICE_DATA_PART,
      data: { level: "error", text: "x: boom" },
    });
    expect(messages[1]!.role).toBe("assistant");
  });

  it("breaks a turn group so a notice never lands inside an assistant message", () => {
    const blocks: Block[] = [
      { kind: "assistant", id: "b1", text: "one", thinking: "", streaming: false },
      { kind: "notice", id: "b2", level: "info", text: "Compacting…" },
      { kind: "assistant", id: "b3", text: "two", thinking: "", streaming: false },
    ];
    const { messages } = projectMessages({ blocks, running: false, dialogs: [] });
    expect(messages.map((m) => m.id)).toEqual(["b1", "b2", "b3"]);
  });
});

describe("shareProjectedMessages", () => {
  it("reuses the previous array when nothing changed", () => {
    const a = projectMessages({
      blocks: [{ kind: "user", id: "b1", text: "hi", images: 0 }],
      running: false,
      dialogs: [],
    }).messages;
    const b = projectMessages({
      blocks: [{ kind: "user", id: "b1", text: "hi", images: 0 }],
      running: false,
      dialogs: [],
    }).messages;
    expect(shareProjectedMessages(b, a)).toBe(a);
  });

  it("reuses untouched messages when only the tail changed", () => {
    const previous = projectMessages({
      blocks: [
        { kind: "user", id: "b1", text: "hi", images: 0 },
        { kind: "assistant", id: "b2", text: "a", thinking: "", streaming: true },
      ],
      running: true,
      dialogs: [],
    }).messages;
    const next = projectMessages({
      blocks: [
        { kind: "user", id: "b1", text: "hi", images: 0 },
        { kind: "assistant", id: "b2", text: "ab", thinking: "", streaming: true },
      ],
      running: true,
      dialogs: [],
    }).messages;
    const shared = shareProjectedMessages(next, previous);
    expect(shared).not.toBe(previous);
    expect(shared[0]).toBe(previous[0]);
    expect(shared[1]).toBe(next[1]);
  });
});

// A settled block keeps its identity across deltas, so its projected part must
// be reused rather than rebuilt (which re-ran JSON.stringify over tool args on
// every streamed token).
describe("per-block part cache", () => {
  it("reuses the projected part for a block whose identity did not change", () => {
    const tool: Block = { kind: "tool", id: "t1", name: "read", args: { path: "a.ts" }, result: "ok", done: true };
    const tail: Block = { kind: "assistant", id: "b2", text: "a", thinking: "", streaming: true };
    const first = projectMessages({ blocks: [tool, tail], running: true, dialogs: [] });
    const second = projectMessages({
      blocks: [tool, { ...tail, text: "ab" }],
      running: true,
      dialogs: [],
    });
    const partOf = (r: ProjectionResult) => (r.messages[0]!.content as ProjectedContentPart[])[0];
    expect(partOf(second)).toBe(partOf(first));
  });

  it("rebuilds the part when the block object changes", () => {
    const tool: Block = { kind: "tool", id: "t1", name: "read", args: {}, done: false };
    const first = projectMessages({ blocks: [tool], running: true, dialogs: [] });
    const second = projectMessages({ blocks: [{ ...tool, result: "ok", done: true }], running: false, dialogs: [] });
    const partOf = (r: ProjectionResult) => (r.messages[0]!.content as ProjectedContentPart[])[0];
    expect(partOf(second)).not.toBe(partOf(first));
    expect(partOf(second)).toMatchObject({ result: "ok" });
  });

  it("never caches a part that carries a pending dialog", () => {
    const tool: Block = { kind: "tool", id: "t1", name: "write", args: {}, done: false };
    const withDialog = projectMessages({
      blocks: [tool],
      running: true,
      dialogs: [{ method: "confirm", id: "u1", title: "Sure?", toolCallId: "t1" }],
    });
    const withoutDialog = projectMessages({ blocks: [tool], running: true, dialogs: [] });
    const partOf = (r: ProjectionResult) => (r.messages[0]!.content as ProjectedContentPart[])[0] as { approval?: unknown };
    expect(partOf(withDialog).approval).toBeTruthy();
    expect(partOf(withoutDialog).approval).toBeUndefined();
  });
});
