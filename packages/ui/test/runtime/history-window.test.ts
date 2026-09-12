import { describe, expect, it, vi } from "vitest";
import { historyWindow, MESSAGE_METADATA_NS, type SessionState } from "@lasercode/protocol";
import { initialState, reduce, type AppState } from "../../src/store.js";
import { projectSessionView, shareProjectedMessages } from "../../src/runtime/projection.js";
import { isUnstartedSession } from "../../src/runtime/new-session.js";

const session: SessionState = { path: "/session", id: "s", cwd: "/project", model: null, thinkingLevel: "medium", isStreaming: false, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true, messageCount: 80, pendingMessageCount: 0 };
const scope = { path: session.path, epoch: "one", seq: 5 };
const entries = Array.from({ length: 80 }, (_, i) => ({ type: "message", id: `e${i}`, parentId: i ? `e${i - 1}` : null, message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `Message ${i}` }] } }));
const snapshot = { entries, leafId: "e79" };
const begin = (app: AppState, token = "read") => reduce(app, { type: "historyBegin", path: session.path, token });
const opened = () => reduce(initialState, { type: "opened", state: session });
const tail = () => historyWindow(snapshot, { tail: 40 }, scope);
const hydrate = (app: AppState, page = tail(), token = "read") => reduce(app, { type: "historySnapshot", path: session.path, token, ...page });

describe("partial history integration", () => {
  it("prepends only new blocks, retains projected tail identities, and keeps original action ordinals", () => {
    let app = hydrate(begin(opened()));
    const before = app.open[session.path]!;
    const messages = projectSessionView(before).messages;
    const older = historyWindow(snapshot, { before: before.history!.before! }, scope);
    app = reduce(app, { type: "historyPrepend", path: session.path, before: before.history!.before!, entries: older.entries, window: older.window });
    const after = app.open[session.path]!;
    expect(after.blocks.slice(-before.blocks.length)).toEqual(before.blocks);
    after.blocks.slice(-before.blocks.length).forEach((block, i) => expect(block).toBe(before.blocks[i]));
    const projected = shareProjectedMessages(projectSessionView(after).messages, messages);
    projected.slice(-messages.length).forEach((message, i) => expect(message).toBe(messages[i]));
    expect(messages[0]?.metadata?.custom?.[MESSAGE_METADATA_NS]).toMatchObject({ userOrdinal: 20, entryId: "e40" });
    expect(projected[0]?.metadata?.custom?.[MESSAGE_METADATA_NS]).toMatchObject({ userOrdinal: 0, entryId: "e0" });
    expect(after.entries).toEqual(entries);
    expect(after.history).toMatchObject({ complete: true, branchesUnloaded: false });
    expect(after.history?.before).toBeUndefined();
    const refreshed = hydrate(begin(app), tail()).open[session.path]!;
    expect(refreshed.history?.complete).toBe(true);
    expect(refreshed.history?.userOffset).toBe(0);
    expect(refreshed.blocks).toHaveLength(80);
    expect(projectSessionView(refreshed).messages[0]?.metadata?.custom?.[MESSAGE_METADATA_NS]).toMatchObject({ userOrdinal: 0, entryId: "e0" });
  });

  it("shares image-bearing blocks without serializing their payloads", () => {
    const source = { ...snapshot, entries: [{ ...entries[0]!, message: { ...entries[0]!.message,
      content: [...entries[0]!.message.content, { type: "image", data: "a".repeat(1024 * 1024), mimeType: "image/png" }],
    } }, ...entries.slice(1)] };
    const page = historyWindow(source, { all: true }, scope);
    const app = hydrate(begin(opened()), page);
    const received = structuredClone(page);
    const stringify = vi.spyOn(JSON, "stringify");
    let next: AppState;
    try {
      next = hydrate(begin(app), received);
      expect(stringify).not.toHaveBeenCalled();
    } finally { stringify.mockRestore(); }
    expect(next.open[session.path]!.blocks[0]).toBe(app.open[session.path]!.blocks[0]);
  });

  it("replays only updates newer than the snapshot, preserving the entire partial response and history", () => {
    let app = begin(opened());
    app = reduce(app, { type: "notification", method: "session/update", params: { sessionPath: session.path, seq: 6, at: "2026-01-01T00:00:00Z", update: { kind: "text_delta", delta: " after", contentIndex: 0 } } });
    const page = historyWindow(snapshot, { tail: 40 }, { ...scope, live: { running: true, tools: [], message: { id: "active", value: { role: "assistant", content: [{ type: "text", text: "before" }] } } } });
    app = hydrate(app, page);
    expect(app.open[session.path]!.blocks).toHaveLength(41);
    expect(app.open[session.path]!.blocks.at(-1)).toMatchObject({ text: "before after", streaming: true });
    expect(app.open[session.path]!.lastSeq).toBe(6);
    expect(app.open[session.path]!.historyPending).toBeUndefined();
    const same = reduce(app, { type: "notification", method: "session/update", params: { sessionPath: session.path, seq: 6, at: "2026-01-01T00:00:00Z", update: { kind: "text_delta", delta: " after", contentIndex: 0 } } });
    expect(same.open[session.path]).toBe(app.open[session.path]);
    const before = app.open[session.path]!.history!.before!;
    const older = historyWindow(snapshot, { before }, { ...scope, seq: 999 });
    app = reduce(app, { type: "historyPrepend", path: session.path, before, entries: older.entries, window: older.window });
    expect(app.open[session.path]!.lastSeq).toBe(6);
    expect(app.open[session.path]!.blocks.at(-1)).toMatchObject({ text: "before after", streaming: true });
  });

  it("adopts a new worker epoch without replaying old updates or discarding its lower sequence", () => {
    let app = hydrate(begin(opened()), historyWindow(snapshot, { tail: 40 }, { ...scope, epoch: "old", seq: 500 }));
    app = begin(app);
    const update = (epoch: string, seq: number, delta: string) => ({ type: "notification" as const, method: "session/update" as const, params: { sessionPath: session.path, epoch, seq, at: "2026-01-01T00:00:00Z", update: { kind: "text_delta" as const, delta, contentIndex: 0 } } });
    app = reduce(app, update("old", 501, " stale"));
    app = reduce(app, update("new", 2, " after"));
    const page = historyWindow(snapshot, { tail: 40 }, { ...scope, epoch: "new", seq: 1, live: { running: true, tools: [], message: { id: "active", value: { role: "assistant", content: [{ type: "text", text: "fresh" }] } } } });
    app = hydrate(app, page);
    expect(app.open[session.path]!.lastSeq).toBe(2);
    expect(app.open[session.path]!.updateEpoch).toBe("new");
    expect(app.open[session.path]!.blocks.at(-1)).toMatchObject({ text: "fresh after" });
    const before = app;
    app = reduce(app, update("old", 502, " stale again"));
    expect(app).toBe(before);
    app = reduce(app, update("new", 3, " next"));
    expect(app.open[session.path]!.blocks.at(-1)).toMatchObject({ text: "fresh after next" });
  });

  it("restores running tool output through the artifact channel, never a terminal result", () => {
    const toolEntries = [{ ...entries[0]!, id: "u", parentId: null }, { type: "message", id: "a", parentId: "u", message: { role: "assistant", content: [{ type: "toolCall", id: "tool", name: "read", arguments: {} }] } }];
    const page = historyWindow({ entries: toolEntries, leafId: "a" }, { tail: 40 }, { ...scope, live: { running: true, tools: [{ toolCallId: "tool", toolName: "read", args: {}, partial: { content: [{ type: "text", text: "partial output" }] } }] } });
    const app = hydrate(begin(opened()), page);
    const view = app.open[session.path]!;
    expect(view.blocks.at(-1)).toMatchObject({ kind: "tool", done: false });
    const projected = projectSessionView(view);
    const part = projected.messages.flatMap(message => typeof message.content === "string" ? [] : message.content).find(part => part.type === "tool-call");
    expect(part).not.toHaveProperty("result");
    expect(part).toMatchObject({ artifact: { partialOutput: expect.stringContaining("partial output") } });
    expect(projected.isRunning).toBe(true);
  });

  it("keeps a tool-only live assistant's message identity when replaced by its persisted snapshot", () => {
    const user = { type: "message", id: "u", parentId: null, message: { role: "user", content: "Run a command" } };
    const assistant = { type: "message", id: "a", parentId: "u", message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "bash", arguments: { command: "test" } }] } };
    let app = opened();
    const updates = [
      { kind: "message_start", role: "user" },
      { kind: "message_end", role: "user", message: user.message, entry: { id: "u", parentId: null } },
      { kind: "message_start", role: "assistant" },
      { kind: "message_end", role: "assistant", message: assistant.message },
      { kind: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "test" } },
    ] as const;
    updates.forEach((update, i) => { app = reduce(app, { type: "notification", method: "session/update", params: { sessionPath: session.path, seq: i + 1, update, at: "2026-01-01T00:00:00Z" } }); });
    expect(app.open[session.path]!.blocks[0]?.id).toBe("entry:u");
    const before = projectSessionView(app.open[session.path]).messages.map(message => message.id);
    const page = historyWindow({ entries: [user, assistant], leafId: "a" }, { tail: 40 }, { ...scope, seq: updates.length, live: { running: true, tools: [{ toolCallId: "t", toolName: "bash", args: { command: "test" } }] } });
    app = hydrate(begin(app), page);
    expect(projectSessionView(app.open[session.path]).messages.map(message => message.id)).toEqual(before);
  });

  it("rejects superseded snapshots/pages and does not let cleanup cancel a successor read", () => {
    const pending = begin(begin(opened(), "old"), "new");
    expect(hydrate(pending, tail(), "old")).toBe(pending);
    expect(reduce(pending, { type: "historyEnd", path: session.path, token: "old" })).toBe(pending);
    const app = hydrate(pending, tail(), "new");
    const page = historyWindow(snapshot, { before: app.open[session.path]!.history!.before! }, scope);
    expect(reduce(app, { type: "historyPrepend", path: session.path, before: "another cursor", entries: page.entries, window: page.window })).toBe(app);
  });

  it("does not reuse a reset branch with unloaded durable history as a fresh session", () => {
    const empty = reduce(initialState, { type: "opened", state: { ...session, messageCount: 0 } });
    const page = historyWindow({ ...snapshot, leafId: null }, { tail: 40 }, scope);
    const app = hydrate(begin(empty), page);
    expect(app.open[session.path]!.blocks).toEqual([]);
    expect(app.open[session.path]!.history?.hasHistory).toBe(true);
    expect(isUnstartedSession(app.open[session.path]!)).toBe(false);
  });

  it("retains canonical goal context without exposing a continuation as a new objective", () => {
    const goal = { type: "custom", id: "goal", parentId: null, customType: "goal-state", data: { goal: { id: "known", text: "Original objective", startedAt: 1, updatedAt: 1, status: "active" } } };
    const turns = entries.map((entry, i) => ({ ...entry, parentId: i ? `e${i - 1}` : "goal", message: i % 2 ? entry.message : { role: "user", content: [{ type: "text", text: "Continue\n<goal_id>known</goal_id>\n<!-- pi-goal-prompt: guard -->" }] } }));
    const source = { entries: [goal, ...turns], leafId: "e79" };
    const page = historyWindow(source, { tail: 40 }, scope);
    expect(page.window.priorGoalIds).toEqual(["known"]);
    const partial = hydrate(begin(opened()), page);
    expect(projectSessionView(partial.open[session.path]).messages.every(message => message.role !== "user")).toBe(true);
    const full = historyWindow(source, { all: true }, scope);
    const complete = hydrate(begin(partial), full);
    const users = projectSessionView(complete.open[session.path]).messages.filter(message => message.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]?.content).toEqual([{ type: "text", text: "Original objective" }]);
  });

  it("adds settlement records without rebuilding the completed transcript or advancing live seq", () => {
    const app = hydrate(begin(opened()));
    const next = { type: "message", id: "next", parentId: "e79", message: { role: "user", content: "Next prompt" } };
    const page = historyWindow({ entries: [...entries, next], leafId: "next" }, { from: "e79" }, { ...scope, seq: 99 });
    const updated = reduce(app, { type: "historyMetadata", path: session.path, from: "e79", ...page });
    expect(updated.open[session.path]!.blocks).toBe(app.open[session.path]!.blocks);
    expect(updated.open[session.path]!.entries).toEqual([...entries.slice(40), next]);
    expect(updated.open[session.path]!.history?.userOffset).toBe(20);
    expect(updated.open[session.path]!.lastSeq).toBe(5);
  });
});
