/**
 * Pure projection: piorbit `SessionView` blocks → assistant-ui `ThreadMessageLike[]`.
 *
 * Rules (see PLAN M1-T10 / DESIGN.md "Transcript"):
 * - A `user` block becomes one user message (text part, plus a short note part
 *   when the prompt carried images — the store keeps only the count).
 * - A maximal run of consecutive `assistant` + `tool` blocks becomes ONE
 *   assistant message whose parts keep the streaming order they arrived in:
 *   reasoning (from the block's `thinking`), text, then the tool calls that
 *   followed. A multi-step turn therefore renders as one message with
 *   interleaved reasoning / text / tool rows.
 * - `notice` blocks (compaction, auto-retry, extension errors) become a
 *   standalone assistant message carrying a single `data` part named
 *   {@link NOTICE_DATA_PART}. Data parts are the only transcript slot
 *   assistant-ui renders through a consumer-registered component, so the shell
 *   owns their look; an unregistered notice renders as nothing rather than as
 *   fake agent prose.
 * - Ids are block ids, so a re-render of a streaming turn keeps message
 *   identity stable.
 * - Only the LAST text/reasoning part of the LAST message may report a
 *   `running` status, and an empty text part is never emitted.
 * - A turn that ended for any reason other than "it finished" or "it wants to
 *   run tools" projects as an `incomplete` status carrying that reason, which
 *   is what `stopped-run` draws. Pi's vocabulary is mapped onto assistant-ui's
 *   once, here, so no component has to know both.
 * - The turn's own token counts and the speaker of a child run ride on
 *   `metadata.custom.piorbit`, where `message-timing` and `speaker-identity`
 *   already look for them.
 * - Dialogs raised while exactly one tool ran carry that `toolCallId`: a
 *   `confirm` projects onto the tool call as a native `approval`, and
 *   `select`/`input`/`editor` as a native `interrupt`. Everything else stays
 *   free-standing and is rendered above the composer.
 *
 * Pure: no React, no DOM, no network. Tested in test/runtime/projection.test.ts.
 */
import { namespaced } from "@piorbit/protocol";
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { MessageSpeaker, StopReason, UiDialogRequest, Usage } from "@piorbit/protocol";
import type { Block, SessionView } from "../store.js";

/** `data` part name used for transcript notices. */
export const NOTICE_DATA_PART = namespaced("notice");

export type ProjectedContentPart = Exclude<ThreadMessageLike["content"], string>[number];
export type ProjectedToolCallPart = Extract<ProjectedContentPart, { type: "tool-call" }>;
export type ProjectedMessageStatus = NonNullable<ThreadMessageLike["status"]>;
/** The status a UI may want to show on a tool row; not expressible on `ThreadMessageLike`. */
export type ProjectedToolStatus = "running" | "complete" | "incomplete";

export interface ProjectionInput {
  readonly blocks: readonly Block[];
  readonly running: boolean;
  readonly dialogs: readonly UiDialogRequest[];
}

export interface ProjectionResult {
  readonly messages: ThreadMessageLike[];
  readonly isRunning: boolean;
  /** Dialogs projected onto a tool call, keyed by `toolCallId`. */
  readonly toolDialogs: ReadonlyMap<string, UiDialogRequest>;
  /** Dialogs with no `toolCallId` (or naming a tool that is not in the transcript). */
  readonly freeStandingDialogs: UiDialogRequest[];
}

const EMPTY_RESULT: ProjectionResult = {
  messages: [],
  isRunning: false,
  toolDialogs: new Map(),
  freeStandingDialogs: [],
};

/**
 * Partition pending dialogs into the ones a tool row owns and the ones the
 * free-standing side channel owns. A dialog is only tool-associated when the
 * worker stamped a `toolCallId` AND that tool call is in this transcript; the
 * UI never infers causality on its own (AGENTS.md inv. 6, D-2).
 */
export function splitDialogs(
  dialogs: readonly UiDialogRequest[],
  toolCallIds: ReadonlySet<string>,
): { toolAssociated: Map<string, UiDialogRequest>; freeStanding: UiDialogRequest[] } {
  const toolAssociated = new Map<string, UiDialogRequest>();
  const freeStanding: UiDialogRequest[] = [];
  for (const dialog of dialogs) {
    const id = dialog.toolCallId;
    if (id !== undefined && toolCallIds.has(id) && !toolAssociated.has(id)) toolAssociated.set(id, dialog);
    else freeStanding.push(dialog);
  }
  return { toolAssociated, freeStanding };
}

/** The native tool-call fields a pending dialog contributes. */
export function dialogToToolFields(
  dialog: UiDialogRequest,
): Pick<ProjectedToolCallPart, "approval"> | Pick<ProjectedToolCallPart, "interrupt"> {
  if (dialog.method === "confirm") {
    // `approved` omitted = still awaiting an answer.
    return { approval: { id: dialog.id, ...(dialog.message ? { prompt: dialog.message } : { prompt: dialog.title }) } };
  }
  return { interrupt: { type: "human", payload: { requestId: dialog.id, ...dialog } } };
}

/** `requires-action` reason a pending dialog implies. */
export function dialogActionReason(dialog: UiDialogRequest): "tool-calls" | "interrupt" {
  return dialog.method === "confirm" ? "tool-calls" : "interrupt";
}

/**
 * Pi's stop reason → assistant-ui's `incomplete` reason, or undefined when the
 * turn ended the ordinary way.
 *
 * `stop` is a finished reply and `toolUse` is "it wants to run tools next" —
 * both are complete turns and neither draws a stopped row. `pending` is a turn
 * still in flight, which the running status already covers. Everything left is
 * a turn that ended short, and R3 says the reason is never lost: `deferred`
 * has no assistant-ui name of its own, so it maps to `other`, which the
 * transcript renders as "Stopped" with the detail beside it.
 */
export function incompleteReason(
  stopReason: StopReason | undefined,
): "cancelled" | "length" | "error" | "other" | undefined {
  switch (stopReason) {
    case "aborted":
      return "cancelled";
    case "length":
      return "length";
    case "error":
      return "error";
    case "deferred":
      return "other";
    default:
      return undefined;
  }
}

/** The turn's token counts, in the shape `message-timing` reads. */
function usageMeta(usage: Usage | undefined): Record<string, number> | undefined {
  if (!usage) return undefined;
  return { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite };
}

/** The status a tool row should show. Exported because `ThreadMessageLike` has no per-tool status field. */
export function toolStatus(block: Extract<Block, { kind: "tool" }>, messageRunning: boolean): ProjectedToolStatus {
  if (block.done) return "complete";
  return messageRunning ? "running" : "incomplete";
}

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const argsOf = (value: unknown): Record<string, never> =>
  (isJsonObject(value) ? value : {}) as Record<string, never>;

const argsTextOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

const createdAtOf = (block: Block): Date | undefined => {
  if (!block.at) return undefined;
  const date = new Date(block.at);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const imagesNote = (count: number): string => (count === 1 ? "1 image attached" : `${count} images attached`);

const isTurnBlock = (block: Block): block is Extract<Block, { kind: "assistant" | "tool" }> =>
  block.kind === "assistant" || block.kind === "tool";

/**
 * Who a block belongs to, for grouping. Tool rows inherit whoever is speaking
 * — a subagent's tools belong under its header, not the parent's — so they
 * answer `undefined` and never break a group on their own.
 */
const speakerKey = (block: Extract<Block, { kind: "assistant" | "tool" }>): string | undefined =>
  block.kind === "assistant" && block.speaker ? `${block.speaker.kind}:${block.speaker.name}` : undefined;

// ---------------------------------------------------------------------------
// Per-block part cache
//
// The store replaces only the block a delta touched (`replaceLast` / a `map`
// that returns `b` unchanged), so every settled block keeps its identity across
// a streamed turn. Keying on that identity turns projection from O(transcript)
// per token into O(tail) — and stops re-running `JSON.stringify` over tool args
// that have not changed since the call ended.
// ---------------------------------------------------------------------------

type AssistantBlock = Extract<Block, { kind: "assistant" }>;
type ToolBlock = Extract<Block, { kind: "tool" }>;

interface AssistantParts {
  readonly parts: readonly ProjectedContentPart[];
  /** Offsets within `parts` that came from a still-streaming block. */
  readonly streaming: readonly number[];
}

const assistantPartCache = new WeakMap<AssistantBlock, AssistantParts>();
const toolPartCache = new WeakMap<ToolBlock, ProjectedToolCallPart>();

function assistantPartsOf(block: AssistantBlock): AssistantParts {
  const cached = assistantPartCache.get(block);
  if (cached) return cached;
  const parts: ProjectedContentPart[] = [];
  const streaming: number[] = [];
  if (block.thinking.trim()) {
    if (block.streaming) streaming.push(parts.length);
    parts.push({ type: "reasoning", text: block.thinking, status: { type: "complete" } });
  }
  // Never emit an empty text part: a turn that has only started streaming
  // carries its "running" on the message, not on a blank part.
  if (block.text.trim()) {
    if (block.streaming) streaming.push(parts.length);
    parts.push({ type: "text", text: block.text, status: { type: "complete" } });
  }
  const value: AssistantParts = { parts, streaming };
  assistantPartCache.set(block, value);
  return value;
}

/** A dialog makes the part depend on more than the block, so it is not cached. */
function toolPartOf(block: ToolBlock, dialog: UiDialogRequest | undefined): ProjectedToolCallPart {
  if (!dialog) {
    const cached = toolPartCache.get(block);
    if (cached) return cached;
  }
  const result = block.done ? block.result : block.partial;
  const part: ProjectedToolCallPart = {
    type: "tool-call",
    toolCallId: block.id,
    toolName: block.name,
    args: argsOf(block.args),
    argsText: argsTextOf(block.args),
    ...(result !== undefined ? { result } : {}),
    ...(block.isError ? { isError: true } : {}),
    ...(dialog ? dialogToToolFields(dialog) : {}),
  };
  if (!dialog) toolPartCache.set(block, part);
  return part;
}

const userMessage = (block: Extract<Block, { kind: "user" }>): ThreadMessageLike => {
  const content: ProjectedContentPart[] = [];
  if (block.text.trim()) content.push({ type: "text", text: block.text });
  if (block.images > 0) content.push({ type: "text", text: imagesNote(block.images) });
  const createdAt = createdAtOf(block);
  return {
    id: block.id,
    role: "user",
    content,
    ...(createdAt ? { createdAt } : {}),
    metadata: {
      custom: { piorbit: { kind: "user", images: block.images, optimistic: block.optimistic === true } },
    },
  };
};

const noticeMessage = (block: Extract<Block, { kind: "notice" }>): ThreadMessageLike => {
  const createdAt = createdAtOf(block);
  return {
    id: block.id,
    role: "assistant",
    content: [{ type: "data", name: NOTICE_DATA_PART, data: { level: block.level, text: block.text } }],
    status: { type: "complete", reason: "stop" },
    ...(createdAt ? { createdAt } : {}),
    metadata: { custom: { piorbit: { kind: "notice", level: block.level, text: block.text } } },
  };
};

/**
 * Build the single assistant message for one run of assistant/tool blocks.
 * `isTail` says this group ends the transcript, so a live run's status and the
 * streaming caret belong to it.
 */
const turnMessage = (
  group: readonly Extract<Block, { kind: "assistant" | "tool" }>[],
  isTail: boolean,
  input: ProjectionInput,
  toolDialogs: ReadonlyMap<string, UiDialogRequest>,
): ThreadMessageLike => {
  const running = isTail && input.running;
  const parts: ProjectedContentPart[] = [];
  /** Indices in `parts` of text/reasoning parts sourced from a still-streaming block. */
  const streamingTextParts: number[] = [];
  let pendingDialog: UiDialogRequest | undefined;

  for (const block of group) {
    if (block.kind === "assistant") {
      const cached = assistantPartsOf(block);
      for (const offset of cached.streaming) streamingTextParts.push(parts.length + offset);
      parts.push(...cached.parts);
      continue;
    }

    const dialog = toolDialogs.get(block.id);
    if (dialog) pendingDialog = dialog;
    parts.push(toolPartOf(block, dialog));
  }

  // Only the last still-streaming text/reasoning part of a live tail may run.
  if (running) {
    const last = streamingTextParts.at(-1);
    if (last !== undefined) {
      const part = parts[last];
      if (part && (part.type === "text" || part.type === "reasoning")) {
        parts[last] = { ...part, status: { type: "running" } };
      }
    }
  }

  // The last assistant block is the one that ended the turn; the counts are
  // summed across the group because one message here may be several of Pi's.
  let stopReason: StopReason | undefined;
  let stopError: string | undefined;
  let speaker: MessageSpeaker | undefined;
  let usage: Usage | undefined;
  for (const block of group) {
    if (block.kind !== "assistant") continue;
    speaker ??= block.speaker;
    if (block.stopReason !== undefined) {
      stopReason = block.stopReason;
      stopError = block.errorMessage;
    }
    if (block.usage) {
      usage = usage
        ? {
            input: usage.input + block.usage.input,
            output: usage.output + block.usage.output,
            cacheRead: usage.cacheRead + block.usage.cacheRead,
            cacheWrite: usage.cacheWrite + block.usage.cacheWrite,
            totalTokens: usage.totalTokens + block.usage.totalTokens,
          }
        : block.usage;
    }
  }
  const incomplete = running ? undefined : incompleteReason(stopReason);

  const status: ProjectedMessageStatus = pendingDialog
    ? { type: "requires-action", reason: dialogActionReason(pendingDialog) }
    : running
      ? { type: "running" }
      : incomplete
        ? { type: "incomplete", reason: incomplete, ...(stopError ? { error: stopError } : {}) }
        : { type: "complete", reason: "stop" };

  const head = group[0]!;
  const createdAt = createdAtOf(head);
  const usageCustom = usageMeta(usage);
  return {
    id: head.id,
    role: "assistant",
    content: parts,
    status,
    ...(createdAt ? { createdAt } : {}),
    metadata: {
      custom: {
        piorbit: {
          kind: "turn",
          blockIds: group.map((b) => b.id),
          ...(usageCustom ? { usage: usageCustom } : {}),
          ...(speaker ? { speaker } : {}),
        },
      },
    },
  };
};

/** Project a transcript. Pure; safe to call on every render. */
export function projectMessages(input: ProjectionInput): ProjectionResult {
  const toolCallIds = new Set<string>();
  for (const block of input.blocks) if (block.kind === "tool") toolCallIds.add(block.id);
  const { toolAssociated, freeStanding } = splitDialogs(input.dialogs, toolCallIds);

  const messages: ThreadMessageLike[] = [];
  let group: Extract<Block, { kind: "assistant" | "tool" }>[] = [];

  const flush = (isTail: boolean): void => {
    if (group.length === 0) return;
    messages.push(turnMessage(group, isTail, input, toolAssociated));
    group = [];
  };

  for (const block of input.blocks) {
    if (isTurnBlock(block)) {
      // A change of speaker ends the group: a child run's words are its own
      // message with its own header, never folded into the reply above them.
      if (group.length > 0 && speakerKey(block) !== speakerKey(group[0]!)) flush(false);
      group.push(block);
      continue;
    }
    flush(false);
    messages.push(block.kind === "user" ? userMessage(block) : noticeMessage(block));
  }
  flush(true);

  return { messages, isRunning: input.running, toolDialogs: toolAssociated, freeStandingDialogs: freeStanding };
}

/** Convenience wrapper over a `SessionView`; an absent view projects to nothing. */
export function projectSessionView(view: SessionView | undefined): ProjectionResult {
  if (!view) return EMPTY_RESULT;
  return projectMessages({ blocks: view.blocks, running: view.running, dialogs: view.dialogs });
}

// ---------------------------------------------------------------------------
// Referential sharing — keeps assistant-ui from re-converting untouched
// messages when only the streaming tail changed.
// ---------------------------------------------------------------------------

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
};

/** Reuse the previous array/messages wherever nothing changed. */
export function shareProjectedMessages(
  next: readonly ThreadMessageLike[],
  previous: readonly ThreadMessageLike[],
): readonly ThreadMessageLike[] {
  let changed = next.length !== previous.length;
  const shared = next.map((message, index) => {
    const prev = previous[index];
    if (prev && deepEqual(message, prev)) return prev;
    changed = true;
    return message;
  });
  return changed ? shared : previous;
}
