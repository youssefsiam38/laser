/**
 * The per-thread `ExternalStoreAdapter`: assistant-ui's thread surface mapped
 * onto one piorbit session over `HostClient`.
 *
 * Send routing. When an adapter exposes a `queue`, assistant-ui routes EVERY
 * composer send through it (`queue.steer` when `opts.steer ?? isRunning`,
 * `queue.enqueue` otherwise) and never calls `onNew` for a thread-composer
 * send. So both lanes and `onNew` funnel into one place, and the piorbit verb
 * is decided by {@link resolveSendBehavior}:
 *
 * | lane   | idle   | running   |
 * | ------ | ------ | --------- |
 * | queue  | prompt | follow-up |
 * | steer  | prompt | steer     |
 *
 * which is exactly DESIGN.md's composer contract: Enter prompts when idle and
 * steers while running, Cmd/Ctrl+Enter queues a follow-up. A `session/prompt`
 * the worker refuses (`accepted: false`, an extension is holding the prompt)
 * falls back to a steer so the message is never silently dropped.
 *
 * Everything above `createThreadAdapter` is pure and unit-tested.
 */
import { SimpleImageAttachmentAdapter } from "@assistant-ui/react";
import type {
  AppendMessage,
  ExternalStoreAdapter,
  ExternalThreadQueueAdapter,
  QueueItemState,
  ThreadMessageLike,
} from "@assistant-ui/react";
import type { ContentBlock, ImageContent, UiDialogResponse } from "@piorbit/protocol";
import type { HostClient } from "../client.js";
import { asRawClient, getMobileDictationAdapter } from "../pwa/index.js";
import { newBlockId, type Action, type SessionView } from "../store.js";
import { projectSessionView, type ProjectionResult } from "./projection.js";

export type SendBehavior = "prompt" | "steer" | "followUp";
/** Which assistant-ui queue lane a send arrived on. */
export type SendLane = "queue" | "steer";

export const STEER_QUEUE_PREFIX = "steer:";
export const FOLLOW_UP_QUEUE_PREFIX = "followUp:";

export function queueItemId(mode: "steer" | "followUp", index: number): string {
  return `${mode}:${index}`;
}

export function isSteerQueueItemId(id: string): boolean {
  return id.startsWith(STEER_QUEUE_PREFIX);
}

// ---------------------------------------------------------------------------
// Message → protocol content
// ---------------------------------------------------------------------------

/** `data:<mime>;base64,<data>` → an `ImageContent`; anything else is skipped. */
export function imageContentFromDataUrl(image: string): ImageContent | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(image);
  if (!match) return undefined;
  const [, mimeType, data] = match;
  if (!mimeType || !data) return undefined;
  return { type: "image", mimeType, data };
}

/**
 * Flatten an `AppendMessage` (composer content + completed attachments) into
 * protocol `ContentBlock`s. Text parts join with a blank line, mirroring how
 * Pi renders a multi-part user turn; non-image binary parts are dropped
 * because Pi's user-content surface has no slot for them.
 */
export function contentBlocksFromAppendMessage(message: AppendMessage): ContentBlock[] {
  const parts = [...message.content, ...(message.attachments?.flatMap((a) => a.content ?? []) ?? [])];
  const text: string[] = [];
  const images: ImageContent[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text) text.push(part.text);
    } else if (part.type === "image") {
      const image = imageContentFromDataUrl(part.image);
      if (image) images.push(image);
    }
  }
  const blocks: ContentBlock[] = [];
  if (text.length > 0) blocks.push({ type: "text", text: text.join("\n\n") });
  blocks.push(...images);
  return blocks;
}

export function textOfContentBlocks(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export function imageCountOfContentBlocks(blocks: readonly ContentBlock[]): number {
  return blocks.filter((b) => b.type === "image").length;
}

/**
 * An explicit `runConfig.custom.streamingBehavior` wins (a caller that knows
 * what it wants); otherwise the lane plus the run state decide.
 */
export function resolveSendBehavior(options: {
  running: boolean;
  lane: SendLane;
  message?: AppendMessage | undefined;
}): SendBehavior {
  const requested = options.message?.runConfig?.custom?.["streamingBehavior"];
  if (requested === "steer" || requested === "followUp" || requested === "prompt") {
    // A steer/follow-up is meaningless with no run to interrupt.
    return options.running ? requested : "prompt";
  }
  if (!options.running) return "prompt";
  return options.lane === "steer" ? "steer" : "followUp";
}

// ---------------------------------------------------------------------------
// Extension dialog answers
// ---------------------------------------------------------------------------

export function uiResponseForApproval(id: string, approved: boolean): UiDialogResponse {
  return { id, confirmed: approved };
}

/** What a UI may hand back when resolving a select/input/editor interrupt. */
export type InterruptAnswer =
  | string
  | { value?: string | null | undefined; cancelled?: boolean | undefined; dismissed?: boolean | undefined }
  | null
  | undefined;

export function uiResponseForInterrupt(id: string, answer: InterruptAnswer): UiDialogResponse {
  if (typeof answer === "string") return { id, value: answer };
  if (answer && typeof answer === "object" && !answer.cancelled && !answer.dismissed && typeof answer.value === "string") {
    return { id, value: answer.value };
  }
  return { id, cancelled: true };
}

/** Pull the dialog id out of an `interrupt` payload the projection produced. */
export function requestIdOfInterruptPayload(payload: unknown): string | undefined {
  if (payload && typeof payload === "object") {
    const id = (payload as { requestId?: unknown }).requestId;
    if (typeof id === "string") return id;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Composer key semantics (DESIGN.md "Composer")
// ---------------------------------------------------------------------------

export interface ComposerKeyState {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

export interface ComposerSendPlan {
  /**
   * `newline` means: let the textarea handle the key. `suppress` means:
   * swallow it — the app has no binding here, and the primitive's own handler
   * must not get a turn either.
   */
  readonly action: "newline" | "send" | "ignore" | "suppress";
  readonly behavior: SendBehavior;
  /** Pass to `aui.composer.send(...)`. */
  readonly sendOptions: { steer: boolean };
  /** Pass to `aui.composer.setRunConfig(...)` before sending. */
  readonly runConfig: { custom: { streamingBehavior: SendBehavior } };
}

/**
 * Enter = prompt when idle / steer while running; Shift+Enter = newline;
 * Cmd/Ctrl+Enter = follow-up while running (a plain prompt when idle).
 * Those three are the whole contract (DESIGN.md "Composer") and the whole of
 * the composer's key legend.
 *
 * Cmd/Ctrl+Shift+Enter is `suppress`, not `newline`: assistant-ui's own
 * `ComposerInput` handler treats it as "send with steer" whenever a queue
 * exists, which ours always supplies — so leaving the event un-prevented
 * shipped a fourth, undocumented binding that fired even on an idle thread.
 */
export function composerSendPlan(event: ComposerKeyState, running: boolean): ComposerSendPlan {
  if (event.key !== "Enter") return plan("ignore", "prompt");
  if (event.shiftKey) return plan(event.metaKey || event.ctrlKey ? "suppress" : "newline", "prompt");
  const followUp = event.metaKey || event.ctrlKey;
  if (!running) return plan("send", "prompt");
  return plan("send", followUp ? "followUp" : "steer");
}

const plan = (action: ComposerSendPlan["action"], behavior: SendBehavior): ComposerSendPlan => ({
  action,
  behavior,
  sendOptions: { steer: behavior === "steer" },
  runConfig: { custom: { streamingBehavior: behavior } },
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** The slice of `HostClient` the adapter needs; keeps tests free of a socket. */
export type RequestClient = Pick<HostClient, "request">;

/**
 * Issue the right protocol verb for `behavior`, dispatching the optimistic user
 * block for a prompt. Returns the behavior that actually reached the worker
 * (a refused prompt reports `"steer"`).
 */
export async function sendToSession(
  client: RequestClient,
  path: string,
  content: ContentBlock[],
  behavior: SendBehavior,
  dispatch?: (action: Action) => void,
): Promise<SendBehavior> {
  if (content.length === 0) return behavior;
  if (behavior === "steer") {
    await client.request("pi/session/steer", { path, content });
    return "steer";
  }
  if (behavior === "followUp") {
    await client.request("pi/session/follow_up", { path, content });
    return "followUp";
  }
  const optimisticId = newBlockId();
  dispatch?.({
    type: "optimisticUser",
    path,
    id: optimisticId,
    text: textOfContentBlocks(content),
    images: imageCountOfContentBlocks(content),
  });
  let result: { accepted: boolean };
  try {
    result = await client.request("session/prompt", { path, content });
  } catch (error) {
    // Nothing reached the worker: a permanent bubble for a message Pi never
    // saw would also corrupt the next real user message's reconciliation.
    dispatch?.({ type: "optimisticFailed", path, id: optimisticId });
    throw error;
  }
  if (result.accepted) return "prompt";
  // An extension is holding the prompt (a blocking dialog, a command): steer it
  // in. Steering lands mid-run, so the real user message will arrive after
  // assistant deltas — drop the stand-in rather than leave two user bubbles.
  dispatch?.({ type: "optimisticFailed", path, id: optimisticId });
  await client.request("pi/session/steer", { path, content });
  return "steer";
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export function queueItemsOf(view: SessionView | undefined): {
  items: QueueItemState[];
  steerItems: QueueItemState[];
} {
  const toItem = (mode: "steer" | "followUp") => (text: string, index: number): QueueItemState => ({
    id: queueItemId(mode, index),
    prompt: text,
    parts: [{ type: "text", text }],
  });
  return {
    items: (view?.queue.followUp ?? []).map(toItem("followUp")),
    steerItems: (view?.queue.steering ?? []).map(toItem("steer")),
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface ThreadAdapterDeps {
  client: RequestClient;
  /** The session this thread is bound to; `undefined` while a new thread is still local. */
  path: string | undefined;
  view: SessionView | undefined;
  connection: "connecting" | "open" | "closed";
  dispatch: (action: Action) => void;
  /** Every rejected request lands here (the provider turns it into a toast). */
  onError: (error: unknown) => void;
  /**
   * Resolve the session path for a send. The new-thread adapter uses this to
   * create the session first (`aui.threadListItem.initialize()`).
   */
  resolvePath?: (() => Promise<string>) | undefined;
  /** Pre-projected messages; supplied by the hook so the projection is memoized. */
  projection?: ProjectionResult | undefined;
}

/**
 * Stateless and shared by every thread: assistant-ui only reads `accept` and
 * calls `add`/`send`/`remove`, and a stable identity keeps `capabilities` from
 * churning on each render.
 */
const attachmentAdapter = new SimpleImageAttachmentAdapter();

export function createThreadAdapter(deps: ThreadAdapterDeps): ExternalStoreAdapter<ThreadMessageLike> {
  const projection = deps.projection ?? projectSessionView(deps.view);

  const resolvePath = async (): Promise<string> => {
    if (deps.path) return deps.path;
    if (deps.resolvePath) return await deps.resolvePath();
    throw new Error("No session is open.");
  };

  const send = async (message: AppendMessage, lane: SendLane): Promise<void> => {
    const content = contentBlocksFromAppendMessage(message);
    if (content.length === 0) return;
    const path = await resolvePath();
    const running = deps.path === path ? projection.isRunning : false;
    const behavior = resolveSendBehavior({ running, lane, message });
    await sendToSession(deps.client, path, content, behavior, deps.dispatch);
  };

  const fireAndForget = (work: Promise<unknown>): void => {
    void work.catch(deps.onError);
  };

  /**
   * Remove the dialog optimistically, then put it back if the answer never
   * reached the worker: the extension's `ask()` is still blocked, so a card
   * that silently disappeared would leave the user no way to answer it.
   */
  const answerDialog = async (id: string, response: UiDialogResponse): Promise<void> => {
    const path = deps.path;
    const dialog = deps.view?.dialogs.find((d) => d.id === id);
    deps.dispatch({ type: "dialogAnswered", id, ...(path !== undefined ? { path } : {}) });
    try {
      await deps.client.request("pi/ui/response", response);
    } catch (error) {
      if (path !== undefined && dialog) {
        deps.dispatch({ type: "notification", method: "pi/ui/request", params: { path, ...dialog } });
      }
      throw error;
    }
  };

  const { items, steerItems } = queueItemsOf(deps.view);
  const queue: ExternalThreadQueueAdapter = {
    items,
    steerItems,
    enqueue: (message) => fireAndForget(send(message, "queue")),
    steer: (message) => fireAndForget(send(message, "steer")),
    // Pi owns the queue server-side and exposes no per-item operations. These
    // deliberately no-op rather than throw on an unguarded click.
    move: () => {},
    edit: () => {},
    remove: () => {},
    // Keep the queue paused across a cancel so a cancelled run does not promote
    // the next queued prompt into a fresh run.
    __internal_notifyCancelled: () => {},
  };

  return {
    messages: projection.messages,
    convertMessage: (message) => message,
    isRunning: projection.isRunning,
    // A closed socket disables the whole composer; there is nothing to send to.
    isDisabled: deps.connection !== "open",
    queue,
    unstable_capabilities: { copy: true },
    // Enables ComposerPrimitive.AddAttachment and paste-to-attach; the pending
    // image parts land back here through contentBlocksFromAppendMessage.
    // Attachments enable AddAttachment and paste-to-attach; dictation drives
    // ComposerPrimitive.Dictate from the composer's microphone button. The
    // dictation adapter is memoised per client, so this is safe every render.
    adapters: {
      attachments: attachmentAdapter,
      dictation: getMobileDictationAdapter(asRawClient(deps.client)),
    },

    onNew: async (message) => {
      try {
        await send(message, "queue");
      } catch (error) {
        deps.onError(error);
        throw error;
      }
    },

    onCancel: async () => {
      const path = deps.path;
      if (!path) return;
      try {
        await deps.client.request("session/cancel", { path });
      } catch (error) {
        deps.onError(error);
        throw error;
      }
    },

    onRespondToToolApproval: async ({ approvalId, approved }) => {
      try {
        await answerDialog(approvalId, uiResponseForApproval(approvalId, approved));
      } catch (error) {
        deps.onError(error);
        throw error;
      }
    },

    onResumeToolCall: ({ toolCallId, payload }) => {
      const dialog = projection.toolDialogs.get(toolCallId);
      const id = requestIdOfInterruptPayload(payload) ?? dialog?.id;
      if (!id) return;
      fireAndForget(answerDialog(id, uiResponseForInterrupt(id, payload as InterruptAnswer)));
    },
  };
}
