import { describe, expect, it, vi } from "vitest";
import { isMessageNotSentError } from "@assistant-ui/react";
import type { AppendMessage } from "@assistant-ui/react";
import type { ClientMethod, ClientRequests, PendingMessage, SessionState } from "@lasercode/protocol";
import type { Action, SessionView } from "../../src/store.js";
import {
  composerSendPlan,
  contentBlocksFromAppendMessage,
  createThreadAdapter,
  imageContentFromDataUrl,
  isSteerQueueItemId,
  pendingIdOfQueueItemId,
  queueItemsOf,
  requestIdOfInterruptPayload,
  resolveSendBehavior,
  sendToSession,
  uiResponseForApproval,
  uiResponseForInterrupt,
  type RequestClient,
} from "../../src/runtime/adapter.js";
import { withFirstTurn } from "../../src/runtime/first-turn.js";

// --- helpers ---------------------------------------------------------------

interface Call {
  method: ClientMethod;
  params: unknown;
}

function mockClient(results: Partial<Record<ClientMethod, unknown>> = {}): RequestClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    request: (<M extends ClientMethod>(method: M, params: ClientRequests[M]["params"]) => {
      calls.push({ method, params });
      return Promise.resolve((results[method] ?? {}) as ClientRequests[M]["result"]);
    }) as RequestClient["request"],
  };
}

const message = (over: Partial<AppendMessage> = {}): AppendMessage =>
  ({
    role: "user",
    content: [{ type: "text", text: "hello" }],
    attachments: [],
    createdAt: new Date(0),
    parentId: null,
    sourceId: null,
    runConfig: undefined,
    metadata: { custom: {} },
    ...over,
  }) as AppendMessage;

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

const view = (over: Partial<SessionView> = {}): SessionView => ({
  path: "/s.jsonl",
  state: sessionState,
  blocks: [],
  lastSeq: 0,
  running: false,
  queue: { steering: [], followUp: [] }, capabilities: [], goal: null, namerLabels: {},
  pending: [],
  dialogs: [],
  statuses: {},
  widgets: {},
  openedAt: "2026-09-05T00:00:00.000Z",
  hydrated: true,
  entries: [],
  ...over,
});

const pendingMessage = (id: string, text: string): PendingMessage => ({
  id,
  content: [{ type: "text", text }],
  text,
  images: 0,
  createdAt: "2026-09-08T00:00:00.000Z",
  state: "waiting",
});

// --- content ---------------------------------------------------------------

describe("contentBlocksFromAppendMessage", () => {
  it("joins text parts and lifts data-url images out of attachments", () => {
    const blocks = contentBlocksFromAppendMessage(
      message({
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
        attachments: [
          {
            id: "a1",
            type: "image",
            name: "shot.png",
            contentType: "image/png",
            status: { type: "complete" },
            content: [{ type: "image", image: "data:image/png;base64,QUJD" }],
          },
        ],
      } as Partial<AppendMessage>),
    );
    expect(blocks).toEqual([
      { type: "text", text: "one\n\ntwo" },
      { type: "image", mimeType: "image/png", data: "QUJD" },
    ]);
  });

  it("drops images that are not base64 data urls", () => {
    expect(imageContentFromDataUrl("https://example.com/a.png")).toBeUndefined();
    expect(imageContentFromDataUrl("data:image/png;base64,")).toBeUndefined();
    const blocks = contentBlocksFromAppendMessage(
      message({ content: [{ type: "image", image: "blob:https://x/y" }] } as Partial<AppendMessage>),
    );
    expect(blocks).toEqual([]);
  });
});

// --- behavior --------------------------------------------------------------

describe("resolveSendBehavior", () => {
  it("prompts when idle on either lane", () => {
    expect(resolveSendBehavior({ running: false, lane: "queue" })).toBe("prompt");
    expect(resolveSendBehavior({ running: false, lane: "steer" })).toBe("prompt");
  });

  it("steers on the steer lane and waits in the tray on the queue lane while running", () => {
    expect(resolveSendBehavior({ running: true, lane: "steer" })).toBe("steer");
    // The default outcome of writing mid-run is a waiting row, not an interrupt.
    expect(resolveSendBehavior({ running: true, lane: "queue" })).toBe("pending");
  });

  it("honours an explicit runConfig.custom.streamingBehavior while running", () => {
    const followUp = message({ runConfig: { custom: { streamingBehavior: "followUp" } } });
    expect(resolveSendBehavior({ running: true, lane: "steer", message: followUp })).toBe("followUp");
    const steer = message({ runConfig: { custom: { streamingBehavior: "steer" } } });
    expect(resolveSendBehavior({ running: true, lane: "queue", message: steer })).toBe("steer");
    const pending = message({ runConfig: { custom: { streamingBehavior: "pending" } } });
    expect(resolveSendBehavior({ running: true, lane: "steer", message: pending })).toBe("pending");
    // …but a steer with nothing to interrupt is just a prompt.
    expect(resolveSendBehavior({ running: false, lane: "queue", message: steer })).toBe("prompt");
    expect(resolveSendBehavior({ running: false, lane: "queue", message: pending })).toBe("prompt");
  });
});

describe("composerSendPlan", () => {
  const key = (over: Partial<{ key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) => ({
    key: "Enter",
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    ...over,
  });

  it("Enter prompts when idle and queues a waiting row while running", () => {
    expect(composerSendPlan(key(), false)).toMatchObject({ action: "send", behavior: "prompt", sendOptions: { steer: false } });
    // The queue lane, not the steer lane: pressing Enter mid-run interrupts
    // nothing, which is the whole change in M13-T28.
    expect(composerSendPlan(key(), true)).toMatchObject({ action: "send", behavior: "pending", sendOptions: { steer: false } });
  });

  it("Cmd/Ctrl+Enter is the one keyboard path to steer", () => {
    expect(composerSendPlan(key({ metaKey: true }), true)).toMatchObject({ behavior: "steer", sendOptions: { steer: true } });
    expect(composerSendPlan(key({ ctrlKey: true }), true)).toMatchObject({ behavior: "steer" });
    expect(composerSendPlan(key({ ctrlKey: true }), false)).toMatchObject({ behavior: "prompt" });
  });

  it("Shift+Enter is a newline and other keys are ignored", () => {
    expect(composerSendPlan(key({ shiftKey: true }), true).action).toBe("newline");
    // Cmd/Ctrl+Shift+Enter is not one of the three bindings, and the
    // primitive's own handler reads it as "send with steer" — so it is
    // swallowed rather than passed through.
    expect(composerSendPlan(key({ shiftKey: true, metaKey: true }), true).action).toBe("suppress");
    expect(composerSendPlan(key({ shiftKey: true, ctrlKey: true }), false).action).toBe("suppress");
    expect(composerSendPlan(key({ key: "a" }), true).action).toBe("ignore");
  });

  it("carries the behavior in runConfig so onNew can see it", () => {
    expect(composerSendPlan(key({ metaKey: true }), true).runConfig).toEqual({
      custom: { streamingBehavior: "steer" },
    });
    expect(composerSendPlan(key(), true).runConfig).toEqual({ custom: { streamingBehavior: "pending" } });
  });
});

// --- sending ---------------------------------------------------------------

describe("sendToSession", () => {
  const content = [{ type: "text" as const, text: "hi" }];

  it("prompts and dispatches the optimistic user block", async () => {
    const client = mockClient({ "session/prompt": { accepted: true, queued: false } });
    const dispatch = vi.fn<(action: Action) => void>();
    await expect(sendToSession(client, "/s.jsonl", content, "prompt", dispatch)).resolves.toBe("prompt");
    expect(client.calls.map((c) => c.method)).toEqual(["session/prompt"]);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "optimisticUser", path: "/s.jsonl", text: "hi", images: [] }));
  });

  it("forwards tentative first-turn configuration on the prompt", async () => {
    const client = mockClient({ "session/prompt": { accepted: true, queued: false } });
    const firstTurn = { agentName: "reviewer", thinkingLevel: "high" as const };
    await expect(sendToSession(client, "/s.jsonl", content, "prompt", undefined, firstTurn)).resolves.toBe("prompt");
    expect(client.calls[0]).toEqual({
      method: "session/prompt",
      params: { path: "/s.jsonl", content, firstTurn },
    });
  });

  it("never steers a refused first-turn prompt without its chosen agent", async () => {
    const client = mockClient({ "session/prompt": { accepted: false, queued: false } });
    const dispatch = vi.fn<(action: Action) => void>();
    await expect(sendToSession(client, "/s.jsonl", content, "prompt", dispatch, { agentName: "reviewer" }))
      .rejects.toThrow("started before the agent choice");
    expect(client.calls.map((call) => call.method)).toEqual(["session/prompt"]);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "optimisticFailed", path: "/s.jsonl" }));
  });

  it("falls back to a steer when the worker refuses the prompt", async () => {
    const client = mockClient({ "session/prompt": { accepted: false, queued: false } });
    await expect(sendToSession(client, "/s.jsonl", content, "prompt")).resolves.toBe("steer");
    expect(client.calls.map((c) => c.method)).toEqual(["session/prompt", "pi/session/steer"]);
    expect(client.calls[1]!.params).toEqual({ path: "/s.jsonl", content });
  });

  it("rolls the optimistic block back before steering a refused prompt", async () => {
    const client = mockClient({ "session/prompt": { accepted: false, queued: false } });
    const dispatch = vi.fn<(action: Action) => void>();
    await sendToSession(client, "/s.jsonl", content, "prompt", dispatch);
    const optimistic = dispatch.mock.calls.find(([a]) => a.type === "optimisticUser")?.[0] as
      | { id?: string }
      | undefined;
    expect(optimistic?.id).toBeTypeOf("string");
    expect(dispatch).toHaveBeenCalledWith({ type: "optimisticFailed", path: "/s.jsonl", id: optimistic!.id });
  });

  it("rolls the optimistic block back when the prompt request rejects", async () => {
    const client: RequestClient & { calls: Call[] } = {
      calls: [],
      request: ((method: ClientMethod) => {
        if (method === "session/prompt") return Promise.reject(new Error("connection closed"));
        return Promise.resolve({});
      }) as RequestClient["request"],
    };
    const dispatch = vi.fn<(action: Action) => void>();
    await expect(sendToSession(client, "/s.jsonl", content, "prompt", dispatch)).rejects.toThrow("connection closed");
    const optimistic = dispatch.mock.calls.find(([a]) => a.type === "optimisticUser")?.[0] as { id?: string };
    expect(dispatch).toHaveBeenCalledWith({ type: "optimisticFailed", path: "/s.jsonl", id: optimistic.id });
  });

  it("routes steer and follow-up to their own verbs", async () => {
    const client = mockClient();
    await sendToSession(client, "/s.jsonl", content, "steer");
    await sendToSession(client, "/s.jsonl", content, "followUp");
    expect(client.calls.map((c) => c.method)).toEqual(["pi/session/steer", "pi/session/follow_up"]);
  });

  it("does nothing for empty content", async () => {
    const client = mockClient();
    await sendToSession(client, "/s.jsonl", [], "prompt");
    expect(client.calls).toEqual([]);
  });
});

// --- dialogs ---------------------------------------------------------------

describe("dialog responses", () => {
  it("maps an approval to confirmed", () => {
    expect(uiResponseForApproval("u1", true)).toEqual({ id: "u1", confirmed: true });
    expect(uiResponseForApproval("u1", false)).toEqual({ id: "u1", confirmed: false });
  });

  it("maps an interrupt answer to a value or a cancellation", () => {
    expect(uiResponseForInterrupt("u1", "yes")).toEqual({ id: "u1", value: "yes" });
    expect(uiResponseForInterrupt("u1", { value: "yes" })).toEqual({ id: "u1", value: "yes" });
    expect(uiResponseForInterrupt("u1", { value: "yes", cancelled: true })).toEqual({ id: "u1", cancelled: true });
    expect(uiResponseForInterrupt("u1", { dismissed: true })).toEqual({ id: "u1", cancelled: true });
    expect(uiResponseForInterrupt("u1", undefined)).toEqual({ id: "u1", cancelled: true });
  });

  it("reads a requestId back out of an interrupt payload", () => {
    expect(requestIdOfInterruptPayload({ requestId: "u9", value: "x" })).toBe("u9");
    expect(requestIdOfInterruptPayload("x")).toBeUndefined();
  });
});

// --- queue -----------------------------------------------------------------

describe("queueItemsOf", () => {
  it("ids follow-ups and steering separately", () => {
    const { items, steerItems } = queueItemsOf(view({ queue: { steering: ["s0"], followUp: ["f0", "f1"] } }));
    expect(items.map((i) => i.id)).toEqual(["followUp:0", "followUp:1"]);
    expect(steerItems.map((i) => i.id)).toEqual(["steer:0"]);
    expect(items[0]!.parts).toEqual([{ type: "text", text: "f0" }]);
    expect(isSteerQueueItemId("steer:0")).toBe(true);
    expect(isSteerQueueItemId("followUp:0")).toBe(false);
  });

  it("puts the tray first in the waiting lane, carrying the worker's id in each row", () => {
    const { items } = queueItemsOf(
      view({
        pending: [pendingMessage("p-1", "run the tests"), pendingMessage("p-2", "then commit")],
        queue: { steering: [], followUp: ["f0"] },
      }),
    );
    expect(items.map((i) => i.id)).toEqual(["pending:p-1", "pending:p-2", "followUp:0"]);
    // The id is the whole point: it is what Steer, Edit and Drop each name.
    expect(items.map((i) => pendingIdOfQueueItemId(i.id))).toEqual(["p-1", "p-2", undefined]);
  });

  it("names an image-only message rather than drawing an empty row", () => {
    const { items } = queueItemsOf(view({ pending: [{ ...pendingMessage("p-1", ""), images: 2 }] }));
    expect(items[0]!.prompt).toBe("2 images");
  });

  it("is empty without a view", () => {
    expect(queueItemsOf(undefined)).toEqual({ items: [], steerItems: [] });
  });
});

// --- adapter ---------------------------------------------------------------

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createThreadAdapter", () => {
  const build = (over: Partial<Parameters<typeof createThreadAdapter>[0]> = {}) => {
    const client = mockClient({ "session/prompt": { accepted: true, queued: false } });
    const dispatch = vi.fn<(action: Action) => void>();
    const onError = vi.fn();
    const adapter = createThreadAdapter({
      client,
      path: "/s.jsonl",
      view: view(),
      connection: "open",
      dispatch,
      onError,
      ...over,
    });
    return { adapter, client, dispatch, onError };
  };

  it("exposes cancel, queue and copy but not edit or reload", () => {
    const { adapter } = build();
    expect(adapter.onCancel).toBeTypeOf("function");
    expect(adapter.queue).toBeTruthy();
    expect(adapter.unstable_capabilities).toEqual({ copy: true });
    expect(adapter.onEdit).toBeUndefined();
    expect(adapter.onReload).toBeUndefined();
  });

  it("disables the thread while the socket is down", () => {
    expect(build({ connection: "open" }).adapter.isDisabled).toBe(false);
    expect(build({ connection: "closed" }).adapter.isDisabled).toBe(true);
    expect(build({ connection: "connecting" }).adapter.isDisabled).toBe(true);
  });

  it("queue.enqueue prompts when idle", async () => {
    const { adapter, client, dispatch } = build();
    adapter.queue!.enqueue(message());
    await flush();
    expect(client.calls.map((c) => c.method)).toEqual(["session/prompt"]);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "optimisticUser", path: "/s.jsonl", text: "hello", images: [] }));
  });

  it("queue.steer steers and queue.enqueue trays the message while running", async () => {
    const { adapter, client } = build({ view: view({ running: true }) });
    adapter.queue!.steer(message());
    adapter.queue!.enqueue(message());
    await flush();
    expect(client.calls.map((c) => c.method)).toEqual(["pi/session/steer", "session/pending/add"]);
  });

  it("onNew takes the queue lane", async () => {
    const { adapter, client } = build({ view: view({ running: true }) });
    await adapter.onNew(message());
    expect(client.calls.map((c) => c.method)).toEqual(["session/pending/add"]);
  });

  it("steers, edits and drops one tray row by the worker's id, and ignores a row that is not ours", async () => {
    const pending = [pendingMessage("p-1", "run the tests")];
    const { adapter, client } = build({ view: view({ running: true, pending, queue: { steering: ["s0"], followUp: ["f0"] } }) });
    adapter.queue!.move("pending:p-1", { lane: "steer", insertAfter: null });
    adapter.queue!.edit("pending:p-1", message({ content: [{ type: "text", text: "run them twice" }] }));
    adapter.queue!.remove("pending:p-1");
    await flush();
    expect(client.calls).toEqual([
      { method: "session/pending/steer", params: { path: "/s.jsonl", id: "p-1" } },
      { method: "session/pending/edit", params: { path: "/s.jsonl", id: "p-1", content: [{ type: "text", text: "run them twice" }] } },
      { method: "session/pending/remove", params: { path: "/s.jsonl", id: "p-1" } },
    ]);

    // A row the engine owns has no id of ours: the UI draws no control for it,
    // and a stray call is a no-op rather than a request that cannot mean
    // anything. A move that is not into the steer lane is not ours either.
    client.calls.length = 0;
    adapter.queue!.remove("steer:0");
    adapter.queue!.remove("followUp:0");
    adapter.queue!.move("pending:p-1", { lane: "queue" });
    await flush();
    expect(client.calls).toEqual([]);
  });

  it("onNew falls back to a steer when session/prompt is refused", async () => {
    const client = mockClient({ "session/prompt": { accepted: false, queued: false } });
    const { adapter } = build({ client });
    await adapter.onNew(message());
    expect(client.calls.map((c) => c.method)).toEqual(["session/prompt", "pi/session/steer"]);
  });

  it("captures a landing choice from the sending message before creating the session", async () => {
    const firstTurn = { agentName: "reviewer", thinkingLevel: "high" as const };
    let resolve!: (path: string) => void;
    const resolvePath = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    const { adapter, client } = build({ path: undefined, view: undefined, resolvePath });

    const sending = adapter.onNew(message({ runConfig: withFirstTurn(undefined, firstTurn) }));
    resolve("/created.jsonl");
    await sending;

    expect(client.calls[0]).toEqual({
      method: "session/prompt",
      params: { path: "/created.jsonl", content: [{ type: "text", text: "hello" }], firstTurn },
    });
  });

  it("keeps a refused message's first-turn choice available for retry", async () => {
    const path = "/retry-created.jsonl";
    const firstTurn = { agentName: "reviewer", thinkingLevel: "high" as const };
    const configured = message({ runConfig: withFirstTurn(undefined, firstTurn) });
    const client = mockClient({ "session/prompt": { accepted: false, queued: false } });
    const { adapter } = build({ client, path: undefined, view: undefined, resolvePath: async () => path });

    // Rethrown as the error assistant-ui hands a message back to the composer on.
    await expect(adapter.onNew(configured)).rejects.toSatisfy((error: unknown) => isMessageNotSentError(error) && (error as Error).message.includes("started before the agent choice"));
    await expect(adapter.onNew(configured)).rejects.toThrow("started before the agent choice");
    expect(client.calls).toEqual([
      { method: "session/prompt", params: { path, content: [{ type: "text", text: "hello" }], firstTurn } },
      { method: "session/prompt", params: { path, content: [{ type: "text", text: "hello" }], firstTurn } },
    ]);
  });

  it("keeps two composers on one path bound to each sending message in either order", async () => {
    const client = mockClient({ "session/prompt": { accepted: true, queued: false } });
    const first = build({ client }).adapter;
    const second = build({ client }).adapter;
    const high = message({ content: [{ type: "text", text: "high" }], runConfig: withFirstTurn(undefined, { agentName: "reviewer", thinkingLevel: "high" }) });
    const low = message({ content: [{ type: "text", text: "low" }], runConfig: withFirstTurn(undefined, { agentName: "reviewer", thinkingLevel: "low" }) });

    await second.onNew(low);
    await first.onNew(high);
    expect(client.calls.map((call) => call.params)).toEqual([
      { path: "/s.jsonl", content: [{ type: "text", text: "low" }], firstTurn: { agentName: "reviewer", thinkingLevel: "low" } },
      { path: "/s.jsonl", content: [{ type: "text", text: "high" }], firstTurn: { agentName: "reviewer", thinkingLevel: "high" } },
    ]);
  });

  it("creates the session first when the thread has no path yet", async () => {
    const client = mockClient({ "session/prompt": { accepted: true, queued: false } });
    const resolvePath = vi.fn(async () => "/created.jsonl");
    const { adapter } = build({ client, path: undefined, view: undefined, resolvePath });
    await adapter.onNew(message());
    expect(resolvePath).toHaveBeenCalledOnce();
    expect(client.calls[0]).toEqual({
      method: "session/prompt",
      params: { path: "/created.jsonl", content: [{ type: "text", text: "hello" }] },
    });
  });

  it("onCancel cancels the run without clearing the queue", async () => {
    const { adapter, client } = build({ view: view({ running: true, queue: { steering: ["s"], followUp: [] } }) });
    await adapter.onCancel!();
    expect(client.calls).toEqual([{ method: "session/cancel", params: { path: "/s.jsonl" } }]);
    // Pausing the queue is what keeps the cancelled run from promoting "s".
    expect(adapter.queue!.__internal_notifyCancelled).toBeTypeOf("function");
    adapter.queue!.__internal_notifyCancelled!();
  });

  it("onRespondToToolApproval answers the dialog and clears it locally", async () => {
    const dialog = { method: "confirm" as const, id: "u1", title: "Sure?" };
    const { adapter, client, dispatch } = build({ view: view({ dialogs: [dialog] }) });
    await adapter.onRespondToToolApproval!({ approvalId: "u1", approved: false });
    expect(dispatch).toHaveBeenCalledWith({ type: "dialogAnswered", id: "u1", path: "/s.jsonl" });
    expect(client.calls).toEqual([{ method: "pi/ui/response", params: { id: "u1", confirmed: false } }]);
  });

  it("refuses an approval that no longer belongs to this thread", async () => {
    const { adapter, client, dispatch } = build();
    await expect(adapter.onRespondToToolApproval!({ approvalId: "old", approved: true })).rejects.toThrow("no longer belongs");
    expect(dispatch).not.toHaveBeenCalled();
    expect(client.calls).toEqual([]);
  });

  it("puts the dialog back when the answer never reaches the worker", async () => {
    const dialog = { method: "confirm" as const, id: "u1", title: "Sure?" };
    const client: RequestClient & { calls: Call[] } = {
      calls: [],
      request: (() => Promise.reject(new Error("connection closed"))) as RequestClient["request"],
    };
    const dispatch = vi.fn<(action: Action) => void>();
    const onError = vi.fn();
    const adapter = createThreadAdapter({
      client,
      path: "/s.jsonl",
      view: view({ dialogs: [dialog] }),
      connection: "open",
      dispatch,
      onError,
    });
    await expect(adapter.onRespondToToolApproval!({ approvalId: "u1", approved: true })).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledWith({ type: "dialogAnswered", id: "u1", path: "/s.jsonl" });
    expect(dispatch).toHaveBeenCalledWith({
      type: "notification",
      method: "pi/ui/request",
      params: { path: "/s.jsonl", ...dialog },
    });
  });

  it("onResumeToolCall answers the interrupt that the tool row owns", async () => {
    const current = view({
      blocks: [{ kind: "tool", id: "t1", name: "write", args: {}, done: false }],
      dialogs: [{ method: "input", id: "u7", title: "Name?", toolCallId: "t1" }],
      running: true,
    });
    const { adapter, client, dispatch } = build({ view: current });
    adapter.onResumeToolCall!({ toolCallId: "t1", payload: "Bob" });
    await flush();
    expect(dispatch).toHaveBeenCalledWith({ type: "dialogAnswered", id: "u7", path: "/s.jsonl" });
    expect(client.calls).toEqual([{ method: "pi/ui/response", params: { id: "u7", value: "Bob" } }]);
  });

  it("onResumeToolCall cancels when the answer is a dismissal", async () => {
    const current = view({
      blocks: [{ kind: "tool", id: "t1", name: "write", args: {}, done: false }],
      dialogs: [{ method: "editor", id: "u8", title: "Edit", toolCallId: "t1" }],
      running: true,
    });
    const { adapter, client } = build({ view: current });
    adapter.onResumeToolCall!({ toolCallId: "t1", payload: { cancelled: true } });
    await flush();
    expect(client.calls).toEqual([{ method: "pi/ui/response", params: { id: "u8", cancelled: true } }]);
  });

  it("routes a rejected send to onError rather than an unhandled rejection", async () => {
    const failing: RequestClient = {
      request: () => Promise.reject(new Error("not connected")),
    };
    const { adapter, onError } = build({ client: failing });
    adapter.queue!.enqueue(message());
    await flush();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "not connected" }));
  });

  it("projects the view into messages", () => {
    const { adapter } = build({
      view: view({ blocks: [{ kind: "user", files: [], id: "b1", text: "hi", images: [] }] }),
    });
    expect(adapter.messages).toHaveLength(1);
    expect(adapter.convertMessage!(adapter.messages![0]!, 0)).toBe(adapter.messages![0]);
  });
});
