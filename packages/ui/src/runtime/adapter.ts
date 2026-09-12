/**
 * The per-thread `ExternalStoreAdapter`: assistant-ui's thread surface mapped
 * onto one laser session over `HostClient`.
 *
 * Send routing. When an adapter exposes a `queue`, assistant-ui routes EVERY
 * composer send through it (`queue.steer` when `opts.steer ?? isRunning`,
 * `queue.enqueue` otherwise) and never calls `onNew` for a thread-composer
 * send. So both lanes and `onNew` funnel into one place, and the laser verb
 * is decided by {@link resolveSendBehavior}:
 *
 * | lane   | idle   | running |
 * | ------ | ------ | ------- |
 * | queue  | prompt | pending |
 * | steer  | prompt | steer   |
 *
 * Writing while the agent works puts the message in the *pending tray* — a
 * waiting row the person can steer, edit or drop one at a time — and leaving it
 * alone is what happens by default (M13-T28). Interrupting is the deliberate
 * act: the row's Steer button, or Cmd/Ctrl+Enter on the way in, which is the
 * one keyboard path to it. A `session/prompt` the worker refuses
 * (`accepted: false`, an extension is holding the prompt) falls back to a steer
 * so the message is never silently dropped.
 *
 * Steering never aborts anything. The engine delivers a steer at the next turn
 * boundary, so the transcript keeps only the message and the reply — no stop
 * notice for a person who redirected rather than stopped.
 *
 * A message the worker never took (M13-T89 U1). assistant-ui's composer clears
 * its text the moment Send is pressed and puts it back only when `onNew`
 * rejects with `MessageNotSentError` — and `onNew` is exactly the lane a
 * thread-composer send never takes here, because `queue.enqueue` and
 * `queue.steer` are called without their result being awaited. So `send`
 * owns the restoration for every lane: it reads the composer of the thread it
 * serves *as the send starts* (`deps.composer`), and when nothing reached the
 * worker it puts the text and attachments back into that composer, provided
 * it is still empty. The tentative first-turn choice needs no restoring: a
 * send never clears `runConfig`. Every such failure is rethrown as a
 * `MessageNotSentError` so the one lane assistant-ui does handle behaves the
 * same, and the toast says what happened next.
 *
 * Everything above `createThreadAdapter` is pure and unit-tested.
 */
import { MessageNotSentError, SimpleImageAttachmentAdapter, type AttachmentAdapter } from "@assistant-ui/react";
import { toast } from "sonner";
import { attachmentMediaType } from "@/components/preview/media";
import { ATTACHMENT_SIZE_MESSAGE, MAX_ATTACHMENT_BYTES, imagesOfContent, splitAttachedFiles, wrapFileAttachment } from "./attachments.js";
import type {
  AppendMessage,
  ExternalStoreAdapter,
  ExternalThreadQueueAdapter,
  QueueItemState,
  ThreadComposerRuntime,
  ThreadMessageLike,
} from "@assistant-ui/react";
import type { ContentBlock, ImageContent, PendingMessage, UiDialogResponse } from "@lasercode/protocol";
import type { HostClient } from "../client.js";
import { asRawClient, getMobileDictationAdapter } from "../pwa/index.js";
import { newBlockId, type Action, type SessionView } from "../store.js";
import { firstTurnFromRunConfig, type TentativeFirstTurn } from "./first-turn.js";
import { projectSessionView, type ProjectionResult } from "./projection.js";

/** `pending` is the tray; the other three go straight to the engine. */
export type SendBehavior = "prompt" | "steer" | "followUp" | "pending";
/** Which assistant-ui queue lane a send arrived on. */
export type SendLane = "queue" | "steer";

export const STEER_QUEUE_PREFIX = "steer:";
export const FOLLOW_UP_QUEUE_PREFIX = "followUp:";
/** The tray's own rows carry the worker's id, so every action names one message. */
export const PENDING_QUEUE_PREFIX = "pending:";

export function queueItemId(mode: "steer" | "followUp", index: number): string {
  return `${mode}:${index}`;
}

export function pendingQueueItemId(id: string): string {
  return `${PENDING_QUEUE_PREFIX}${id}`;
}

/** The worker's pending id inside a queue item id, or undefined for another lane. */
export function pendingIdOfQueueItemId(id: string): string | undefined {
  return id.startsWith(PENDING_QUEUE_PREFIX) ? id.slice(PENDING_QUEUE_PREFIX.length) : undefined;
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

const EXPLICIT_BEHAVIORS = new Set<string>(["prompt", "steer", "followUp", "pending"]);

/**
 * An explicit `runConfig.custom.streamingBehavior` wins (a caller that knows
 * what it wants — a denied approval still interrupts); otherwise the lane plus
 * the run state decide. With nothing running there is nothing to wait behind
 * and nothing to interrupt, so every lane is an ordinary prompt.
 */
export function resolveSendBehavior(options: {
  running: boolean;
  lane: SendLane;
  message?: AppendMessage | undefined;
}): SendBehavior {
  const requested = options.message?.runConfig?.custom?.["streamingBehavior"];
  if (typeof requested === "string" && EXPLICIT_BEHAVIORS.has(requested)) {
    return options.running ? (requested as SendBehavior) : "prompt";
  }
  if (!options.running) return "prompt";
  return options.lane === "steer" ? "steer" : "pending";
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
 * Enter = prompt when idle / a waiting row in the tray while running;
 * Shift+Enter = newline; Cmd/Ctrl+Enter = steer while running (a plain prompt
 * when idle). Those three are the whole contract (DESIGN.md "Composer") and
 * the whole of the composer's key legend.
 *
 * The two mid-run bindings changed places in M13-T28. Enter used to interrupt,
 * which made the safe outcome the one that needed a chord and left people
 * pressing Stop to force a message in. Now the message waits unless the person
 * says otherwise — with the row's Steer button, or with this one chord.
 *
 * Cmd/Ctrl+Shift+Enter is `suppress`, not `newline`: assistant-ui's own
 * `ComposerInput` handler treats it as "send with steer" whenever a queue
 * exists, which ours always supplies — so leaving the event un-prevented
 * shipped a fourth, undocumented binding that fired even on an idle thread.
 */
export function composerSendPlan(event: ComposerKeyState, running: boolean): ComposerSendPlan {
  if (event.key !== "Enter") return plan("ignore", "prompt");
  if (event.shiftKey) return plan(event.metaKey || event.ctrlKey ? "suppress" : "newline", "prompt");
  const steer = event.metaKey || event.ctrlKey;
  if (!running) return plan("send", "prompt");
  return plan("send", steer ? "steer" : "pending");
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
  firstTurn?: TentativeFirstTurn,
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
  if (behavior === "pending") {
    // Laser's own tray, not the engine's queue: the row that appears can be
    // steered, edited or dropped on its own, and nothing has interrupted the
    // run to put it there.
    await client.request("session/pending/add", { path, content });
    return "pending";
  }
  const optimisticId = newBlockId();
  dispatch?.({
    type: "optimisticUser",
    path,
    id: optimisticId,
    text: textOfContentBlocks(content),
    images: imagesOfContent(content),
  });
  let result: { accepted: boolean };
  try {
    result = await client.request("session/prompt", { path, content, ...(firstTurn ? { firstTurn } : {}) });
  } catch (error) {
    // Nothing reached the worker: a permanent bubble for a message Pi never
    // saw would also corrupt the next real user message's reconciliation.
    dispatch?.({ type: "optimisticFailed", path, id: optimisticId });
    throw error;
  }
  if (result.accepted) return "prompt";
  // First-turn preparation and the prompt are one operation. Falling back to a
  // steer would send the text without the chosen agent after a race or refusal.
  if (firstTurn) {
    dispatch?.({ type: "optimisticFailed", path, id: optimisticId });
    throw new Error("This conversation started before the agent choice could be applied. Review it and send again.");
  }
  // An extension is holding the prompt (a blocking dialog, a command): steer it
  // in. Steering lands mid-run, so the real user message will arrive after
  // assistant deltas — drop the stand-in rather than leave two user bubbles.
  dispatch?.({ type: "optimisticFailed", path, id: optimisticId });
  await client.request("pi/session/steer", { path, content });
  return "steer";
}

// ---------------------------------------------------------------------------
// A message that never reached the worker
// ---------------------------------------------------------------------------

/** The slice of a thread composer an unsent message goes back into. */
export type UnsentMessageComposer = Pick<ThreadComposerRuntime, "getState" | "setText" | "addAttachment">;

/** What a composer holds: nothing the person typed or attached since the send. */
function composerIsEmpty(composer: UnsentMessageComposer): boolean {
  const { text, attachments, quote } = composer.getState();
  return text.trim() === "" && attachments.length === 0 && quote === undefined;
}

/**
 * Put an unsent message back into the composer that sent it: its text and its
 * completed attachments, exactly as they were. Refused — and the composer left
 * untouched — when it holds anything of its own, so a refusal that arrives
 * late never writes over what the person typed in the meantime. Reports
 * whether the message came back, so the toast can say so.
 */
export async function restoreUnsentMessage(
  composer: UnsentMessageComposer | undefined,
  message: AppendMessage,
): Promise<boolean> {
  if (!composer || !composerIsEmpty(composer)) return false;
  const text = message.content
    .filter((part): part is Extract<AppendMessage["content"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
  const parsed = splitAttachedFiles(text);
  if (parsed.text) composer.setText(parsed.text);
  const restoredFiles = parsed.files.map(file => composer.addAttachment({ id: crypto.randomUUID(), type: "document", name: file.name, contentType: file.mediaType, content: [{ type: "text", text: wrapFileAttachment(file) }] }));
  // `addAttachment` with content (not a File) is synchronous in effect and
  // marks the attachment complete; it was accepted once already, so a refusal
  // here is not a state the person can reach — settle rather than throw so one
  // odd attachment never hides the reason the send failed.
  await Promise.allSettled(
    [...restoredFiles, ...(message.attachments ?? []).flatMap((attachment) =>
      attachment.content
        ? [composer.addAttachment({
            id: attachment.id,
            type: attachment.type,
            name: attachment.name,
            ...(attachment.contentType !== undefined ? { contentType: attachment.contentType } : {}),
            content: attachment.content,
          })]
        : [],
    )],
  );
  return true;
}

/**
 * The toast for a message that was not sent: what went wrong, in the worker's
 * words, and what to do next — which is only worth saying when the message is
 * actually back in the composer.
 */
export function notSentMessage(reason: string, options: { restored: boolean; firstTurn: boolean }): string {
  const trimmed = reason.trim();
  if (!options.restored) return trimmed;
  const sentence = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  const next = options.firstTurn ? "check the agent and thinking choice, then send it again" : "send it again when you are ready";
  return `${sentence} Your message is back in the composer — ${next}.`;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/**
 * The two lanes assistant-ui draws, in the order it draws them
 * (`[...steerItems, ...items]`):
 *
 *   - `steerItems` — already handed to the engine: what the person steered,
 *     plus anything the engine queued itself. It goes in at the next turn
 *     boundary, and nothing above can take it back one item at a time.
 *   - `items` — the pending tray, Laser's own, with the id the worker minted
 *     inside each row's id so Steer / Edit / Drop can each name one message.
 *     The engine's follow-up queue joins this lane on the rare occasion
 *     something else put a message there; those rows carry no id of ours and
 *     so offer none of the three (a control that cannot work is not drawn).
 */
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
    items: [
      ...(view?.pending ?? []).map(pendingQueueItem),
      ...(view?.queue.followUp ?? []).map(toItem("followUp")),
    ],
    steerItems: (view?.queue.steering ?? []).map(toItem("steer")),
  };
}

export function pendingQueueItem(message: PendingMessage): QueueItemState {
  const text = message.text || (message.images > 0 ? `${message.images} image${message.images === 1 ? "" : "s"}` : "");
  return { id: pendingQueueItemId(message.id), prompt: text, parts: [{ type: "text", text }] };
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
  /**
   * The composer of the thread this adapter serves, read at send time. It is
   * where a message the worker never took goes back to — that composer and no
   * other, whichever session is on screen by the time the refusal arrives.
   */
  composer?: (() => UnsentMessageComposer | undefined) | undefined;
  /** Lazy main-destination fence. Scoped runtimes omit it. */
  assertCanAct?: ((resolvedPath?: string) => void) | undefined;
}

/**
 * Stateless and shared by every thread: assistant-ui only reads `accept` and
 * calls `add`/`send`/`remove`, and a stable identity keeps `capabilities` from
 * churning on each render.
 */
/** Images retain the native adapter; bounded text files become canonical prompt text. */
export class ConversationAttachmentAdapter implements AttachmentAdapter {
  accept = "*";
  private images = new SimpleImageAttachmentAdapter();
  async add({ file }: { file: File }) {
    if (file.type.startsWith("image/")) return this.images.add({ file });
    const refuse = (message: string): never => { toast.error(message); throw new Error(message); };
    const mediaType = attachmentMediaType(file.type, file.name);
    if (!mediaType) return refuse("This file format can’t be attached. Attach an image or a text file instead.");
    if (file.size > MAX_ATTACHMENT_BYTES) return refuse(ATTACHMENT_SIZE_MESSAGE);
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
    catch { return refuse("This file isn’t UTF-8 text. Save a text copy and attach it again."); }
    if (content.includes("\0")) return refuse("Binary files can’t be attached. Attach an image or a text file instead.");
    return { id: crypto.randomUUID(), type: "document" as const, name: file.name, contentType: mediaType, file,
      status: { type: "requires-action" as const, reason: "composer-send" as const },
      content: [{ type: "text" as const, text: wrapFileAttachment({ name: file.name, mediaType, size: new TextEncoder().encode(content).length, content }) }] };
  }
  async send(attachment: Parameters<AttachmentAdapter["send"]>[0]) {
    if (attachment.type === "image") return this.images.send(attachment);
    return { ...attachment, status: { type: "complete" as const }, content: attachment.content ?? [] };
  }
  async remove() { /* Files remain owned by the browser; there is no upload to delete. */ }
}
const attachmentAdapter = new ConversationAttachmentAdapter();

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
    // The sending composer's runtime owns this value. Capturing it from the
    // message prevents another composer on the same path from replacing it.
    const firstTurn = firstTurnFromRunConfig(message.runConfig);
    // The composer that is sending, captured now for the same reason: a
    // refusal that lands after the person moved on must find this composer,
    // never the one on screen.
    const origin = deps.composer?.();
    try {
      deps.assertCanAct?.();
      const path = await resolvePath();
      deps.assertCanAct?.(path);
      const running = deps.path === path ? projection.isRunning : false;
      const behavior = resolveSendBehavior({ running, lane, message });
      await sendToSession(deps.client, path, content, behavior, deps.dispatch, behavior === "prompt" ? firstTurn : undefined);
    } catch (error) {
      // Nothing reached the worker: `sendToSession` rolled back its optimistic
      // bubble (or never drew one), so the message has nowhere to live but the
      // composer it came from.
      const restored = await restoreUnsentMessage(origin, message);
      const reason = error instanceof Error ? error.message : String(error);
      const notSent = new MessageNotSentError(notSentMessage(reason, { restored, firstTurn: firstTurn !== undefined }));
      notSent.cause = error;
      throw notSent;
    }
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
    deps.assertCanAct?.();
    const path = deps.path;
    const dialog = deps.view?.dialogs.find((candidate) => candidate.id === id);
    if (!path || !dialog) throw new Error("That question no longer belongs to this conversation.");
    deps.dispatch({ type: "dialogAnswered", id, path });
    try {
      await deps.client.request("pi/ui/response", response);
    } catch (error) {
      deps.dispatch({ type: "notification", method: "pi/ui/request", params: { path, ...dialog } });
      throw error;
    }
  };

  const { items, steerItems } = queueItemsOf(deps.view);
  /** Run `work` for the tray row `queueItemId`, or do nothing if it is not one. */
  const onPending = (queueItemId: string, work: (path: string, id: string) => Promise<unknown>): void => {
    const id = pendingIdOfQueueItemId(queueItemId);
    // A row from the engine's own queue has no id of ours. The UI does not draw
    // these controls on such a row; a stray call is a no-op, never a throw.
    if (!id || !deps.path) return;
    try {
      deps.assertCanAct?.();
    } catch (error) {
      deps.onError(error);
      return;
    }
    fireAndForget(work(deps.path, id));
  };
  const queue: ExternalThreadQueueAdapter = {
    items,
    steerItems,
    enqueue: (message) => fireAndForget(send(message, "queue")),
    steer: (message) => fireAndForget(send(message, "steer")),
    /**
     * Only one placement is ours: into the steer lane. assistant-ui's default
     * for that is to cancel the live run and dispatch the item; the worker
     * instead hands the message to the engine's steering queue, which delivers
     * it at the next turn boundary. Nothing is aborted, so the transcript
     * carries no stop notice for a person who redirected the agent.
     */
    move: (queueItemId, placement) => {
      if (placement.lane !== "steer") return;
      onPending(queueItemId, (path, id) => deps.client.request("session/pending/steer", { path, id }));
    },
    edit: (queueItemId, message) => {
      const content = contentBlocksFromAppendMessage(message);
      if (content.length === 0) return;
      onPending(queueItemId, (path, id) => deps.client.request("session/pending/edit", { path, id, content }));
    },
    remove: (queueItemId) => {
      onPending(queueItemId, (path, id) => deps.client.request("session/pending/remove", { path, id }));
    },
    // Keep the queue paused across a cancel so a cancelled run does not promote
    // the next queued prompt into a fresh run.
    __internal_notifyCancelled: () => {},
  };

  return {
    messages: projection.messages,
    convertMessage: (message) => message,
    isRunning: projection.isRunning,
    // A closed socket or a main destination in motion disables the composer.
    isDisabled: deps.connection !== "open" || (() => {
      try {
        deps.assertCanAct?.();
        return false;
      } catch {
        return true;
      }
    })(),
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
        deps.assertCanAct?.();
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
