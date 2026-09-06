import { WIRE_NAMESPACE } from "@lasercode/protocol";
import { MessagePrimitive, useAui, useAuiState, type MessageState } from "@assistant-ui/react";
import type { ModelRef, ThinkingLevel } from "@lasercode/protocol";
import { Info, TriangleAlert } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { UserMessageAttachments } from "@/components/assistant-ui/elements/attachment.aui";
import { DaySeparator, MessageTimestamp, dayChanged } from "@/components/assistant-ui/elements/day-separator";
import { DirectiveString } from "@/components/assistant-ui/elements/directive-text.aui";
import { EditMessage } from "@/components/assistant-ui/elements/edit-message";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { File } from "@/components/assistant-ui/elements/file";
import { Image } from "@/components/assistant-ui/elements/image";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { MessageActions } from "@/components/assistant-ui/elements/message-actions";
import { MessageAttachments, type MessageAttachmentItem } from "@/components/assistant-ui/elements/message-attachment";
import { MessageBranches } from "@/components/assistant-ui/elements/message-branches";
import { AssistantBody, MessageFooter, UserBubble, hoverReveal } from "@/components/assistant-ui/elements/message-pair";
import { MessageTiming } from "@/components/assistant-ui/elements/message-timing.aui";
import { QuoteReply, splitLeadingQuote } from "@/components/assistant-ui/elements/quote-reply";
import { ReasoningGroup } from "@/components/assistant-ui/elements/reasoning.aui";
import { RegenerateMenu, type RegeneratePick } from "@/components/assistant-ui/elements/regenerate-menu";
import { Sources } from "@/components/assistant-ui/elements/sources.aui";
import { SpeakerIdentity, type Speaker } from "@/components/assistant-ui/elements/speaker-identity";
import { StoppedRun } from "@/components/assistant-ui/elements/stopped-run";
import { ThinkingIndicator } from "@/components/assistant-ui/elements/thinking-indicator";
import { useWorkbench } from "@/components/workbench";
import { readProviderFailure } from "./provider-error.js";
import { StreamingText } from "@/components/assistant-ui/elements/streaming-text";
import { ToolGroup } from "@/components/assistant-ui/elements/tool-group.aui";
import { useCopy } from "@/hooks/use-copy";
import { duration as formatDuration } from "@/format";
import { cn } from "@/lib/utils";
import { NOTICE_DATA_PART, useLaserStable, useLaserState } from "@/runtime";
import { continuationsOf, laterUserMessages, leafOf, userEntryAt } from "./entries.js";
import { THINKING_LEVELS, useSupportedThinkingLevels } from "@/components/assistant-ui/elements/reasoning-effort";
import { useElapsed } from "./timing.js";
import { toolGroupKey } from "./tool-groups.js";
import { ToolRow } from "./ToolRow.js";

/** `metadata.custom.laser` the projection stamps on every message. */
interface LaserMeta {
  kind?: "user" | "turn" | "notice";
  images?: number;
  optimistic?: boolean;
  level?: "info" | "warning" | "error";
  /** Which agent produced this message, when the session is a child run. */
  speaker?: Speaker;
}

const laserMeta = (message: MessageState): LaserMeta =>
  ((message.metadata as { custom?: Record<string, unknown> } | undefined)?.custom?.[WIRE_NAMESPACE] as LaserMeta | undefined) ?? {};

const MESSAGE_ROOT = "[content-visibility:auto] [contain-intrinsic-size:auto_320px]";

const EMPTY_ENTRIES: readonly unknown[] = [];

/** The whole session tree, as Pi persisted it; stable between hydrations. */
const useEntries = (): readonly unknown[] => useLaserState((s) => (s.current ? s.open[s.current]?.entries : undefined)) ?? EMPTY_ENTRIES;

/** Text of every text part of the message in scope, for copying. */
const useMessageText = (): string =>
  useAuiState((s) =>
    s.message.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .filter(Boolean)
      .join("\n\n"),
  );

/** The day this message starts, when it is the first message of that day. */
function useNewDay(): Date | undefined {
  return useAuiState((s) => {
    const at = s.message.createdAt;
    if (!at) return undefined;
    if (s.message.index === 0) return at;
    const previous = s.thread.messages[s.message.index - 1];
    return dayChanged(previous?.createdAt, at) ? at : undefined;
  });
}

function useSessionPath(): string | undefined {
  return useLaserState((s) => s.current);
}

/** Chooser: assistant-ui's `ThreadPrimitive.Messages` render function target. */
export function ThreadMessage() {
  const role = useAuiState((s) => s.message.role);
  if (role === "user") return <UserMessage />;
  return <AssistantMessage />;
}

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

export function UserMessage() {
  const aui = useAui();
  const { actions } = useLaserStable();
  const text = useMessageText();
  const images = useAuiState((s) => laserMeta(s.message).images ?? 0);
  const optimistic = useAuiState((s) => laserMeta(s.message).optimistic === true);
  const busy = useAuiState((s) => s.thread.isRunning);
  const newDay = useNewDay();
  const path = useSessionPath();
  const entries = useEntries();
  const { copied, copy } = useCopy();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);

  // The n-th prompt on screen is the n-th user entry on disk (entries.ts).
  const ordinal = useAuiState((s) => {
    let n = 0;
    for (let i = 0; i < s.message.index; i++) if (s.thread.messages[i]?.role === "user") n++;
    return n;
  });
  const userCount = useAuiState((s) => s.thread.messages.reduce((n, m) => (m.role === "user" ? n + 1 : n), 0));
  const entryId = useMemo(() => (optimistic ? undefined : userEntryAt(entries, ordinal)), [entries, ordinal, optimistic]);
  const continuations = useMemo(() => (entryId ? continuationsOf(entries, entryId) : []), [entries, entryId]);
  const { quote, rest } = useMemo(() => splitLeadingQuote(text), [text]);
  const attachments = useMemo<MessageAttachmentItem[]>(
    () => Array.from({ length: images }, (_, i) => ({ id: `image-${i}`, name: images === 1 ? "Image" : `Image ${i + 1}`, kind: "image" })),
    [images],
  );

  const fork = entryId ? () => void actions.fork(entryId) : undefined;
  const jump = entryId ? () => void actions.jump(entryId) : undefined;
  const copyPath = path ? () => void copy(path) : undefined;
  const startEdit = entryId
    ? () => {
        setDraft(text);
        setEditing(true);
      }
    : undefined;
  const sendEdit = async () => {
    if (!entryId) return;
    setEditing(false);
    await actions.fork(entryId);
    await actions.send([{ type: "text", text: draft }], "prompt");
    aui.composer.setText("");
  };

  return (
    <MessagePrimitive.Root data-role="user" className={cn("group/message flex flex-col items-end gap-1", MESSAGE_ROOT)}>
      {newDay ? <DaySeparator date={newDay} className="self-stretch" /> : null}
      <div className={cn("flex min-w-0 flex-col items-end gap-1", editing ? "w-full" : "max-w-[85%]")}>
        {editing ? (
          <EditMessage
            value={draft}
            onValueChange={setDraft}
            onSend={() => void sendEdit()}
            onCancel={() => setEditing(false)}
            laterMessages={laterUserMessages(userCount, ordinal)}
            busy={busy}
          />
        ) : (
          <UserBubble data-optimistic={optimistic || undefined} className={cn(optimistic && "opacity-70")}>
            {quote ? <QuoteReply text={quote} /> : null}
            {rest ? (
              <p className="wrap-break-word whitespace-pre-wrap">
                <DirectiveString text={rest} />
              </p>
            ) : null}
            <MessageAttachments attachments={attachments} className="self-end" />
            <UserMessageAttachments />
          </UserBubble>
        )}
        <MessageFooter className="ms-0 me-0 h-auto min-h-6 justify-end">
          <MessageBranches
            count={continuations.length}
            busy={busy}
            onIndexChange={(i) => {
              const target = continuations[i];
              if (target) void actions.jump(leafOf(entries, target));
            }}
          />
          <MessageActions
            className={hoverReveal}
            copied={copied}
            onCopy={() => void copy(text)}
            onEdit={startEdit}
            onFork={fork}
            onJump={jump}
            onCopyPath={copyPath}
            busy={busy}
          />
          <MessageTimestamp className={hoverReveal} />
        </MessageFooter>
      </div>
    </MessagePrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------

/**
 * Consecutive reasoning parts coalesce; every uninterrupted run of tool calls
 * shares one chronological activity parent. The parent names and counts each
 * family; registered standalone tool UIs remain the detailed children.
 */
type GroupKey = `group-${string}`;
const groupBy = (part: { type: string; toolName?: string }): GroupKey[] => {
  if (part.type === "reasoning") return ["group-reasoning"];
  if (part.type === "tool-call") return [`group-tool-${toolGroupKey(part.toolName ?? "")}`];
  return [];
};

/** Why a turn stopped short, in a person's words (R3). */
function stopReason(reason: string, detail: string | undefined): { reason: string; detail?: string; tone: "muted" | "danger" } {
  switch (reason) {
    case "cancelled":
      return { reason: "You stopped it", tone: "muted" };
    case "length":
      return { reason: "Hit the output limit", tone: "muted" };
    case "content-filter":
      return { reason: "The provider blocked this reply", tone: "danger" };
    case "tool-calls":
      return { reason: "Stopped before its tool calls ran", tone: "muted" };
    case "error":
      return { reason: "The provider returned an error", tone: "danger", ...(detail ? { detail } : {}) };
    default:
      return { reason: "Stopped", tone: "muted", ...(detail ? { detail } : {}) };
  }
}

export function AssistantMessage() {
  const streaming = useAuiState((s) => s.message.role === "assistant" && s.message.status?.type === "running");
  const isNotice = useAuiState((s) => laserMeta(s.message).kind === "notice");
  const speaker = useAuiState((s) => laserMeta(s.message).speaker);
  const messageId = useAuiState((s) => s.message.id);
  // Two primitive selectors rather than one object, so the row does not re-render on every state change.
  const stoppedReason = useAuiState((s) => {
    const status = s.message.status;
    return status?.type === "incomplete" ? status.reason : undefined;
  });
  const stoppedError = useAuiState((s) => {
    const status = s.message.status;
    if (status?.type !== "incomplete") return undefined;
    const error = status.error;
    if (typeof error === "string") return error;
    return error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : undefined;
  });
  const stopped = stoppedReason !== undefined ? stopReason(stoppedReason, stoppedError) : undefined;
  const newDay = useNewDay();

  return (
    <MessagePrimitive.Root data-role="assistant" data-streaming={streaming || undefined} className={cn("group/message flex flex-col", MESSAGE_ROOT)}>
      {newDay ? <DaySeparator date={newDay} /> : null}
      {speaker ? <SpeakerIdentity {...speaker} /> : null}
      <AssistantBody streaming={streaming}>
        <MessagePrimitive.GroupedParts groupBy={groupBy}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-reasoning":
                return (
                  <ReasoningGroup timingKey={`${messageId}:r${part.indices[0] ?? 0}`} running={part.status.type === "running"}>
                    {children}
                  </ReasoningGroup>
                );
              case "text":
                return (
                  <StreamingText streaming={part.status.type === "running"} className="my-3 first:mt-0 last:mb-0">
                    <MarkdownText />
                  </StreamingText>
                );
              case "reasoning":
                return <MarkdownText className="text-sm text-ink-2" />;
              case "tool-call":
                return part.toolUI ?? <ToolRow {...part} />;
              case "source":
                // web-access sources under an answer (docs/ux-elements.md "Sources").
                return <Sources {...part} />;
              case "image":
                return (
                  <div className="my-3 first:mt-0 last:mb-0">
                    <Image {...part} />
                  </div>
                );
              case "file":
                return (
                  <div className="my-3 first:mt-0 last:mb-0">
                    <File {...part} />
                  </div>
                );
              case "data":
                if (part.name === NOTICE_DATA_PART) return <Notice data={part.data} />;
                return part.dataRendererUI;
              case "indicator":
                // A turn that has started and sent nothing yet. The catalog
                // thinking indicator names the state and proves time is moving.
                return <EmptyReplyThinking timingKey={`${messageId}:indicator`} />;
              default:
                // Consecutive calls collapse into one counted activity row
                // (D-20 §4, D-83); a group of one remains its own row.
                if (part.type.startsWith("group-tool")) {
                  return (
                    <div className="my-2 flex flex-col first:mt-0 last:mb-0">
                      <ToolGroup part={part as MessagePrimitive.GroupedParts.GroupPart}>{children}</ToolGroup>
                    </div>
                  );
                }
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
      </AssistantBody>
      {stopped ? <AssistantStopped {...stopped} /> : null}
      {!isNotice && !streaming ? <AssistantFooter /> : null}
      {isNotice && !streaming ? (
        <MessageFooter>
          <span />
          <MessageTimestamp className={hoverReveal} />
        </MessageFooter>
      ) : null}
    </MessagePrimitive.Root>
  );
}

function EmptyReplyThinking({ timingKey }: { timingKey: string }) {
  const elapsed = useElapsed(timingKey, "running");
  return (
    <ThinkingIndicator
      label="Thinking"
      elapsed={elapsed === undefined ? undefined : formatDuration(elapsed)}
      className="my-3 h-6 first:mt-0 last:mb-0"
    />
  );
}

function AssistantStopped({ reason, detail, tone }: ReturnType<typeof stopReason>) {
  const { actions } = useLaserStable();
  const workbench = useWorkbench();
  const running = useAuiState((s) => s.thread.isRunning);
  const disabled = useAuiState((s) => s.thread.isDisabled);
  const isLast = useAuiState((s) => s.message.isLast);
  // A provider payload is never the sentence a person reads: it becomes what
  // happened, what to do, and — when the fix is in this app — the button that
  // goes there. "Continue" is withheld when resending would only fail again in
  // the same way, which is what a rejected key or an exhausted context does.
  const failure = useMemo(() => (tone === "danger" ? readProviderFailure(detail) : undefined), [tone, detail]);
  const canContinue = isLast && !running && !disabled && (failure?.retryable ?? true);
  const onContinue = canContinue ? () => void actions.send([{ type: "text", text: "Continue" }], "prompt") : undefined;
  const action =
    failure?.destination !== undefined
      ? { label: "Open Providers and models", onClick: () => workbench.open("settings", failure.destination) }
      : undefined;
  return (
    <StoppedRun
      reason={reason}
      detail={failure?.headline ?? detail}
      advice={failure?.next}
      raw={failure?.raw}
      action={action}
      tone={tone}
      onContinue={onContinue}
    />
  );
}

/**
 * Under the reply: copy, fork-and-re-run with another model or thinking
 * level, the session path; and the turn's timing on the end. The re-run
 * forks before the prompt that produced this reply and sends it again.
 */
function AssistantFooter() {
  const { actions } = useLaserStable();
  const text = useMessageText();
  const { copied, copy } = useCopy();
  const path = useSessionPath();
  const entries = useEntries();
  const busy = useAuiState((s) => s.thread.isRunning);
  const model = useLaserState((s) => (s.current ? s.open[s.current]?.state.model ?? null : null));
  const thinking = useLaserState((s) => (s.current ? s.open[s.current]?.state.thinkingLevel : undefined));
  // Only what this model accepts (R2). Unknown yet → offer them all.
  const supported = useSupportedThinkingLevels();
  const thinkingLevels = supported ?? THINKING_LEVELS;

  // The prompt this reply answers: the nearest user message above, by ordinal.
  // One string so the selector returns a primitive: "<ordinal> <text>".
  const prompt = useAuiState((s) => {
    let i = s.message.index - 1;
    while (i >= 0 && s.thread.messages[i]?.role !== "user") i--;
    if (i < 0) return undefined;
    let ordinal = 0;
    for (let j = 0; j < i; j++) if (s.thread.messages[j]?.role === "user") ordinal++;
    const text = s.thread.messages[i]!.content
      .map((p) => (p.type === "text" ? p.text : ""))
      .filter(Boolean)
      .join("\n\n");
    // NUL as the separator, not a space: prompt text is arbitrary and may
    // begin with digits or spaces, so any printable delimiter is ambiguous.
    return `${ordinal}\u0000${text}`;
  });
  const [promptOrdinal, promptText] = useMemo(() => {
    if (prompt === undefined) return [undefined, undefined] as const;
    const at = prompt.indexOf("\u0000");
    return [Number(prompt.slice(0, at)), prompt.slice(at + 1)] as const;
  }, [prompt]);
  const promptEntryId = promptOrdinal === undefined ? undefined : userEntryAt(entries, promptOrdinal);

  const regenerate = async (pick: RegeneratePick) => {
    if (!promptEntryId || promptText === undefined) return;
    await actions.fork(promptEntryId);
    if ("model" in pick) await actions.setModel(pick.model as ModelRef);
    else await actions.setThinking(pick.thinking as ThinkingLevel);
    await actions.send([{ type: "text", text: promptText }], "prompt");
  };

  return (
    <MessageFooter>
      <MessageActions
        className={hoverReveal}
        copied={copied}
        onCopy={() => void copy(text)}
        onCopyPath={path ? () => void copy(path) : undefined}
        busy={busy}
        regenerate={
          promptEntryId ? (
            <RegenerateMenu
              loadModels={actions.listModels}
              thinkingLevels={thinkingLevels}
              currentModel={model}
              currentThinking={thinking}
              onPick={(pick) => void regenerate(pick)}
              disabled={busy}
            />
          ) : undefined
        }
      />
      <span className="flex min-w-0 items-center gap-2">
        <MessageTiming />
        <MessageTimestamp className={hoverReveal} />
      </span>
    </MessageFooter>
  );
}

// ---------------------------------------------------------------------------
// Notices: compaction, auto-retry, extension errors (`data` part)
// ---------------------------------------------------------------------------

const NoticeImpl = ({ data }: { data: unknown }) => {
  const { level, text = "" } = (data as { level?: string; text?: string } | undefined) ?? {};
  if (level === "error") {
    // `extension_error` arrives as "extension: message" (store.ts).
    const at = text.indexOf(": ");
    const title = at > 0 ? `${text.slice(0, at)} failed` : "A feature reported an error";
    const detail = at > 0 ? text.slice(at + 2) : text;
    return <ErrorState title={title} detail={detail} className="my-1" />;
  }
  if (level === "warning" && /^Retrying\b/.test(text)) {
    // auto_retry_start: "Retrying (2/3)…"
    const count = /\(([^)]+)\)/.exec(text)?.[1];
    return <ErrorState retrying title="Retrying" detail={count} className="my-1" />;
  }
  const Icon = level === "warning" ? TriangleAlert : Info;
  return (
    <div role="status" data-level={level} className={cn("my-1 flex items-start gap-2 text-sm", level === "warning" ? "text-attention" : "text-ink-2")}>
      <Icon aria-hidden="true" className="mt-[3px] size-3.5 shrink-0" />
      <span className="min-w-0 wrap-break-word whitespace-pre-wrap">
        <DirectiveString text={text} />
      </span>
    </div>
  );
};

export const Notice = memo(NoticeImpl);
