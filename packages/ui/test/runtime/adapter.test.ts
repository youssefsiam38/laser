import { describe, expect, it, vi } from "vitest";
import type { AppendMessage } from "@assistant-ui/react";
import type { ClientMethod, ClientRequests, SessionState } from "@piorbit/protocol";
import type { Action, SessionView } from "../../src/store.js";
import {
  composerSendPlan,
  contentBlocksFromAppendMessage,
  createThreadAdapter,
  imageContentFromDataUrl,
  isSteerQueueItemId,
  queueItemsOf,
  requestIdOfInterruptPayload,
  resolveSendBehavior,
  sendToSession,
  uiResponseForApproval,
  uiResponseForInterrupt,
  type RequestClient,
} from "../../src/runtime/adapter.js";

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
  queue: { steering: [], followUp: [] },
  dialogs: [],
  statuses: {},
  widgets: {},
  openedAt: "2026-09-05T00:00:00.000Z",
  hydrated: true,
  entries: [],
  ...over,
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

  it("steers on the steer lane and follows up on the queue lane while running", () => {
    expect(resolveSendBehavior({ running: true, lane: "steer" })).toBe("steer");
    expect(resolveSendBehavior({ running: true, lane: "queue" })).toBe("followUp");
  });

  it("honours an explicit runConfig.custom.streamingBehavior while running", () => {
    const followUp = message({ runConfig: { custom: { streamingBehavior: "followUp" } } });
    expect(resolveSendBehavior({ running: true, lane: "steer", message: followUp })).toBe("followUp");
    const steer = message({ runConfig: { custom: { streamingBehavior: "steer" } } });
    expect(resolveSendBehavior({ running: true, lane: "queue", message: steer })).toBe("steer");
    // …but a steer with nothing to interrupt is just a prompt.
    expect(resolveSendBehavior({ running: false, lane: "queue", message: steer })).toBe("prompt");
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

  it("Enter prompts when idle and steers while running", () => {
    expect(composerSendPlan(key(), false)).toMatchObject({ action: "send", behavior: "prompt", sendOptions: { steer: false } });
    expect(composerSendPlan(key(), true)).toMatchObject({ action: "send", behavior: "steer", sendOptions: { steer: true } });
  });

  it("Cmd/Ctrl+Enter follows up while running", () => {
    expect(composerSendPlan(key({ metaKey: true }), true)).toMatchObject({ behavior: "followUp", sendOptions: { steer: false } });
    expect(composerSendPlan(key({ ctrlKey: true }), true)).toMatchObject({ behavior: "followUp" });
    expect(composerSendPlan(key({ ctrlKey: true }), false)).toMatchObject({ behavior: "prompt" });
  });

  it("Shift+Enter is a newline and other keys are ignored", () => {
    expect(composerSendPlan(key({ shiftKey: true }), true).action).toBe("newline");
    expect(composerSendPlan(key({ key: "a" }), true).action).toBe("ignore");
  });

  it("carries the behavior in runConfig so onNew can see it", () => {
    expect(composerSendPlan(key({ metaKey: true }), true).runConfig).toEqual({
      custom: { streamingBehavior: "followUp" },
    });
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
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "optimisticUser", path: "/s.jsonl", text: "hi", images: 0 }));
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
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "optimisticUser", path: "/s.jsonl", text: "hello", images: 0 }));
  });

  it("queue.steer steers and queue.enqueue follows up while running", async () => {
    const { adapter, client } = build({ view: view({ running: true }) });
    adapter.queue!.steer(message());
    adapter.queue!.enqueue(message());
    await flush();
    expect(client.calls.map((c) => c.method)).toEqual(["pi/session/steer", "pi/session/follow_up"]);
  });

  it("onNew takes the queue lane", async () => {
    const { adapter, client } = build({ view: view({ running: true }) });
    await adapter.onNew(message());
    expect(client.calls.map((c) => c.method)).toEqual(["pi/session/follow_up"]);
  });

  it("onNew falls back to a steer when session/prompt is refused", async () => {
    const client = mockClient({ "session/prompt": { accepted: false, queued: false } });
    const { adapter } = build({ client });
    await adapter.onNew(message());
    expect(client.calls.map((c) => c.method)).toEqual(["session/prompt", "pi/session/steer"]);
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
    const { adapter, client, dispatch } = build();
    await adapter.onRespondToToolApproval!({ approvalId: "u1", approved: false });
    expect(dispatch).toHaveBeenCalledWith({ type: "dialogAnswered", id: "u1", path: "/s.jsonl" });
    expect(client.calls).toEqual([{ method: "pi/ui/response", params: { id: "u1", confirmed: false } }]);
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
      view: view({ blocks: [{ kind: "user", id: "b1", text: "hi", images: 0 }] }),
    });
    expect(adapter.messages).toHaveLength(1);
    expect(adapter.convertMessage!(adapter.messages![0]!, 0)).toBe(adapter.messages![0]);
  });
});
