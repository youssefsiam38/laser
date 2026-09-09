import { MESSAGE_METADATA_NS } from "@lasercode/protocol";
import { MessagePrimitive, useAui, useAuiState, type MessageState } from "@assistant-ui/react";
import type { ModelRef, ThinkingLevel } from "@lasercode/protocol";
import { Bot, Info, Target, TriangleAlert } from "lucide-react";
import { GoalRecord } from "./GoalRecord.js";
import { AgentCompletion } from "./AgentCompletion.js";
import { AgentEventMessage } from "./AgentEventMessage.js";
import { TaskEventNotice } from "./TaskEventNotice.js";
import { AGENT_COMPLETION_DATA_PART, AGENT_EVENT_DATA_PART, GOAL_DATA_PART, TASK_EVENT_DATA_PART, type AgentCompletionData } from "@/runtime/projection";
import type { GoalRecord as GoalRecordData } from "@/runtime/goal-history";
import { memo, useContext, useMemo, useState } from "react";
import { FindSelectionContext, SearchMessageContext, useSearchReveal } from "./search-state.js";

import { UserMessageAttachments } from "@/components/assistant-ui/elements/attachment.aui";
import { MessageTimestamp } from "@/components/assistant-ui/elements/message-timestamp";
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
import { RegenerateMenu, type RegeneratePick } from "@/components/assistant-ui/elements/regenerate-menu";
import { Sources } from "@/components/assistant-ui/elements/sources.aui";
import { SpeakerIdentity, type Speaker } from "@/components/assistant-ui/elements/speaker-identity";
import { StoppedRun } from "@/components/assistant-ui/elements/stopped-run";
import { ThinkingIndicator } from "@/components/assistant-ui/elements/thinking-indicator";
import { useWorkbench } from "@/components/workbench";
import { readProviderFailure } from "./provider-error.js";
import { StreamingText } from "@/components/assistant-ui/elements/streaming-text";
import { ActivityReasoning, ToolGroup } from "@/components/assistant-ui/elements/tool-group.aui";
import { useCopy } from "@/hooks/use-copy";
import { duration as formatDuration } from "@/format";
import { cn } from "@/lib/utils";
import { NOTICE_DATA_PART, sessionTitle, useLaserStable, useLaserState } from "@/runtime";
import { leafOf, userEntryAt, versionsOf } from "./entries.js";
import { THINKING_LEVELS, useSupportedThinkingLevels } from "@/components/assistant-ui/elements/reasoning-effort";
import { useElapsed } from "./timing.js";
import { toolGroupKey } from "./tool-groups.js";
import { ToolRow } from "./ToolRow.js";
import { ApiRequestDialog } from "@/components/logs/ApiRequestDialog";

/** `metadata.custom.laser` the projection stamps on every message. */
interface LaserMeta {
  /** `custom`: a message the transcript draws itself (an agent event, a task exit). */
  kind?: "user" | "turn" | "notice" | "custom";
  images?: number;
  optimistic?: boolean;
  userOrdinal?: number;
  /** Pi's entry for a persisted prompt; see `Block.entryId`. */
  entryId?: string;
  goalSetter?: boolean;
  /** Set when a parent agent, not the person, sent this prompt into a child session. */
  sentBy?: { parentPath: string; runId?: string };
  level?: "info" | "warning" | "error";
  /** Which agent produced this message, when the session is a child run. */
  speaker?: Speaker;
}

const laserMeta = (message: MessageState): LaserMeta =>
  ((message.metadata as { custom?: Record<string, unknown> } | undefined)?.custom?.[MESSAGE_METADATA_NS] as LaserMeta | undefined) ?? {};

const MESSAGE_ROOT = "[content-visibility:auto] [contain-intrinsic-size:auto_320px]";

const EMPTY_ENTRIES: readonly unknown[] = [];

/** The whole session tree, as Pi persisted it; stable between hydrations. */
const useEntries = (): readonly unknown[] => useLaserState((s) => (s.current ? s.open[s.current]?.entries : undefined)) ?? EMPTY_ENTRIES;

/**
 * The entry the session is sitting on. The tree above holds every version of
 * every message; this says which branch is the conversation, so a message maps
 * to the entry the person is actually looking at.
 */
const useLeafId = (): string | null | undefined => useLaserState((s) => (s.current ? s.open[s.current]?.leafId : undefined));

/** Text of every text part of the message in scope, for copying. */
const useMessageText = (): string =>
  useAuiState((s) =>
    s.message.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .filter(Boolean)
      .join("\n\n"),
  );

function useSessionPath(): string | undefined {
  return useLaserState((s) => s.current);
}

/**
 * A fork hands the forked prompt back for the composer (`setEditorText`), and
 * the action that forked has just sent it; leaving a copy in the box would
 * read as an unsent message. Take it out — but only while it is still exactly
 * that text, so a draft typed in the meantime is never eaten.
 *
 * Inside a message, `aui.composer` is that message's *edit* composer, which
 * throws "Composer is not available" whenever nothing is being edited. The
 * thread's own composer is the one that holds a handed-back prompt, and a
 * surface without one (a read-only transcript) simply has nothing to clear.
 */
const clearHandedBackPrompt = (aui: ReturnType<typeof useAui>, sent: string) => {
  try {
    const composer = aui.thread.composer();
    if (composer.getState().text.trim() === sent.trim()) composer.setText("");
  } catch {
    // No thread composer on this surface.
  }
};

/** Chooser: assistant-ui's `ThreadPrimitive.Messages` render function target. */
export function ThreadMessage() {
  const role = useAuiState((s) => s.message.role);
  const id = useAuiState(s => s.message.id);
  const selected = useContext(FindSelectionContext);
  return <SearchMessageContext value={selected === id}>{role === "user" ? <UserMessage /> : <AssistantMessage />}</SearchMessageContext>;
}

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

export function UserMessage() {
  const searchReveal = useSearchReveal();
  const aui = useAui();
  const { actions } = useLaserStable();
  const text = useMessageText();
  const images = useAuiState((s) => laserMeta(s.message).images ?? 0);
  const optimistic = useAuiState((s) => laserMeta(s.message).optimistic === true);
  const goalSetter = useAuiState((s) => laserMeta(s.message).goalSetter === true);
  // A primitive, so the selector keeps its identity across re-renders.
  const parentPath = useAuiState((s) => laserMeta(s.message).sentBy?.parentPath);
  const busy = useAuiState((s) => s.thread.isRunning);
  const path = useSessionPath();
  const entries = useEntries();
  const leafId = useLeafId();
  const { copied, copy } = useCopy();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [sending, setSending] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const requestAt = useAuiState(s => s.message.createdAt?.toISOString());
  const nextRequestAt = useAuiState(s => s.thread.messages.slice(s.message.index + 1).find(m => m.role === "user")?.createdAt?.toISOString());

  // Hidden automatic goal prompts still occupy entries on disk. Use the raw
  // ordinal stamped by projection, not the filtered on-screen position.
  const ordinal = useAuiState((s) => {
    const original = laserMeta(s.message).userOrdinal;
    if (original !== undefined) return original;
    let n = 0;
    for (let i = 0; i < s.message.index; i++) if (s.thread.messages[i]?.role === "user") n++;
    return n;
  });
  const laterMessages = useAuiState(s => s.thread.messages.slice(s.message.index + 1).filter(m => m.role === "user").length);
  // The entry the prompt was written to, known the moment the engine wrote
  // it; the ordinal lookup is for a prompt reported without one.
  const persistedEntryId = useAuiState((s) => laserMeta(s.message).entryId);
  const entryId = useMemo(
    () => (optimistic ? undefined : persistedEntryId ?? userEntryAt(entries, ordinal, leafId)),
    [entries, leafId, ordinal, optimistic, persistedEntryId],
  );
  // Every version of this prompt, oldest first: editing it in place, and
  // running its reply again, both leave the previous one here.
  const versions = useMemo(() => (entryId ? versionsOf(entries, entryId) : []), [entries, entryId]);
  const versionIndex = entryId ? versions.indexOf(entryId) : -1;
  const { quote, rest } = useMemo(() => splitLeadingQuote(text), [text]);
  const attachments = useMemo<MessageAttachmentItem[]>(
    () => Array.from({ length: images }, (_, i) => ({ id: `image-${i}`, name: images === 1 ? "Image" : `Image ${i + 1}`, kind: "image" })),
    [images],
  );

  // The engine will not move the leaf while a turn streams, so during one
  // each of these asks the worker to stop the reply first and then move —
  // the Stop button's own stop, recorded on the branch being left (M13-T46).
  // One request: the worker owns the sequence, and a move that fails leaves
  // the session stopped and where it was.
  const move = { stopFirst: busy };
  const fork = entryId ? () => void actions.fork(entryId, move) : undefined;
  const jump = entryId ? () => void actions.jump(entryId, move) : undefined;
  const copyPath = path ? () => void copy(path) : undefined;
  const startEdit = entryId
    ? () => {
        setDraft(text);
        setEditing(true);
      }
    : undefined;
  /**
   * Editing changes THIS session by default: the engine moves the leaf to
   * before this prompt, and the edited text lands beside the old one as
   * another version of it — nothing is deleted, and the version picker under
   * the bubble reaches what was here before. "In a new session" is the same
   * edit into a fork, and leaves this session untouched.
   */
  const sendEdit = async (where: "here" | "fork") => {
    if (!entryId || sending) return;
    setSending(true);
    try {
      if (where === "here") {
        // Stay in the editor when it did not happen: the person's words are
        // still in the box, and the reason is already on screen. Mid-turn the
        // worker has stopped the reply by then, so the send below goes out,
        // it does not wait in the tray (D-149).
        if (!(await actions.navigate(entryId, move))) return;
        setEditing(false);
        await actions.send([{ type: "text", text: draft }], "prompt");
        return;
      }
      setEditing(false);
      await actions.fork(entryId, move);
      await actions.send([{ type: "text", text: draft }], "prompt");
      clearHandedBackPrompt(aui, text);
    } finally {
      setSending(false);
    }
  };

  return (
    <MessagePrimitive.Root data-role="user" data-optimistic={optimistic || undefined} data-search-selected={searchReveal || undefined} className={cn("group/message flex flex-col items-end gap-1", MESSAGE_ROOT)}>
      <div className={cn("flex min-w-0 flex-col items-end gap-1", editing ? "w-full" : "max-w-[85%]")}>
        {editing ? (
          <EditMessage
            value={draft}
            onValueChange={setDraft}
            onSend={() => void sendEdit("here")}
            onSendInNewSession={() => void sendEdit("fork")}
            onCancel={() => setEditing(false)}
            laterMessages={laterMessages}
            stopsReply={busy}
            busy={sending}
          />
        ) : (
          <UserBubble
            data-sent-by={parentPath ? "parent" : undefined}
            className={cn(
              optimistic && "opacity-70",
              // A task, not something the person typed: a live hairline marks
              // it without touching the text or the bubble's shape.
              parentPath && "ring-1 ring-[color-mix(in_oklab,var(--live)_35%,transparent)]",
            )}
          >
            {parentPath ? <ParentTask parentPath={parentPath} /> : null}
            {goalSetter && <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-2"><Target className="size-3.5 text-live" aria-hidden="true" />Goal set</span>}
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
            {...(versionIndex >= 0 ? { index: versionIndex } : {})}
            count={versions.length}
            busy={busy}
            onIndexChange={(i) => {
              // A version is reached through its own last entry: navigating
              // onto a prompt would put the session before it instead of on it.
              const target = versions[i];
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
            onViewRequest={path ? () => setRequestOpen(true) : undefined}
            busy={busy}
          />
          <MessageTimestamp className={hoverReveal} />
        </MessageFooter>
      </div>
      {requestOpen && path && <ApiRequestDialog target={{ kind: "message", path, ...(entryId ? { entryId } : {}), ...(requestAt ? { at: requestAt } : {}), ...(nextRequestAt ? { beforeAt: nextRequestAt } : {}) }} onClose={() => setRequestOpen(false)} />}
    </MessagePrimitive.Root>
  );
}

/**
 * Who asked. A child session's opening prompt — and every later
 * `send_agent_message` — is a task its parent sent, not something the person
 * typed, and an anonymous bubble left nobody able to tell on arrival
 * (docs/agents.md "Follow-up messages and user-origin runs").
 *
 * The parent's name is the catalog's, so it reads the same here as in the
 * header's parent control, and the button is that same navigation rather than
 * a second one. `data-search-exclude` keeps this label out of find: the task
 * text beside it is untouched and stays selectable, copyable and searchable.
 */
function ParentTask({ parentPath }: { parentPath: string }) {
  const { actions } = useLaserStable();
  const label = useLaserState((s) => {
    const summary = s.sessions.find((session) => session.path === parentPath);
    const open = s.open[parentPath];
    if (summary) return sessionTitle(summary, open);
    return open?.state.name ?? open?.title ?? "the parent session";
  });
  return (
    <span data-slot="parent-task" data-search-exclude className="mb-1 flex min-w-0 items-center gap-1.5 text-xs leading-xs text-ink-2">
      <Bot className="size-3.5 shrink-0 text-live" aria-hidden="true" />
      <span className="shrink-0">Task from</span>
      <button
        type="button"
        onClick={() => void actions.openSession(parentPath)}
        title={`Open ${label}
${parentPath}`}
        className={cn(
          "min-w-0 truncate rounded px-1 font-medium text-ink outline-none",
          "transition-colors duration-(--motion-instant) hover:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))]",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live motion-reduce:transition-none",
        )}
      >
        {label}
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------

/**
 * One uninterrupted run of reasoning and tool work shares a chronological
 * activity parent. The parent names and counts thought plus each action family;
 * expansion preserves the complete reasoning and registered tool UIs.
 */
type GroupKey = `group-${string}`;
const groupBy = (part: { type: string; toolName?: string }): GroupKey[] => {
  if (part.type === "reasoning" || part.type === "tool-call") return [`group-${toolGroupKey(part.toolName ?? "")}`];
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
  const searchReveal = useSearchReveal();
  const streaming = useAuiState((s) => s.message.role === "assistant" && s.message.status?.type === "running");
  // Notices and the custom messages the transcript draws (agent events, task
  // exits) are records, not replies: no actions, no regenerate, a clock only.
  const isNotice = useAuiState((s) => laserMeta(s.message).kind === "notice" || laserMeta(s.message).kind === "custom");
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

  return (
    <MessagePrimitive.Root data-role="assistant" data-search-selected={searchReveal || undefined} data-streaming={streaming || undefined} className={cn("group/message flex flex-col", MESSAGE_ROOT)}>
      {speaker ? <SpeakerIdentity {...speaker} /> : null}
      <AssistantBody streaming={streaming}>
        <MessagePrimitive.GroupedParts groupBy={groupBy} indicator="empty">
          {({ part, children }) => {
            switch (part.type) {
              case "text":
                return (
                  <StreamingText streaming={part.status.type === "running"} className="my-2 first:mt-0 last:mb-0">
                    <MarkdownText />
                  </StreamingText>
                );
              case "reasoning":
                return (
                  <ActivityReasoning running={part.status.type === "running"}>
                    <MarkdownText className="text-sm text-ink-2" />
                  </ActivityReasoning>
                );
              case "tool-call":
                return part.toolUI ?? <ToolRow {...part} />;
              case "source":
                // web-access sources under an answer (docs/ux-elements.md "Sources").
                return <Sources {...part} />;
              case "image":
                return (
                  <div className="my-2 first:mt-0 last:mb-0">
                    <Image {...part} />
                  </div>
                );
              case "file":
                return (
                  <div className="my-2 first:mt-0 last:mb-0">
                    <File {...part} />
                  </div>
                );
              case "data":
                if (part.name === GOAL_DATA_PART) return <GoalRecord goal={part.data as GoalRecordData} />;
                if (part.name === NOTICE_DATA_PART) return <Notice data={part.data} />;
                // Agents leap: a child's final message, a parent's agent event, a task exit.
                if (part.name === AGENT_COMPLETION_DATA_PART) return <AgentCompletion data={part.data as AgentCompletionData} />;
                if (part.name === AGENT_EVENT_DATA_PART) return <AgentEventMessage data={part.data} />;
                if (part.name === TASK_EVENT_DATA_PART) return <TaskEventNotice data={part.data} />;
                return part.dataRendererUI;
              case "indicator":
                // A turn that has started and sent nothing yet. The catalog
                // thinking indicator names the state and proves time is moving.
                return <EmptyReplyPending timingKey={`${messageId}:indicator`} />;
              default:
                // Consecutive reasoning and calls collapse into one activity
                // row (D-20 §4, D-83, D-89); a single tool stays standalone.
                if (part.type === "group-activity") {
                  // One action already has its own disclosure; do not make
                  // the reader open a second identical header to reach it.
                  if (part.indices.length === 1) return children;
                  return (
                    <div className="my-2 flex flex-col first:mt-0 last:mb-0">
                      <ToolGroup part={part as MessagePrimitive.GroupedParts.GroupPart} timingKey={`${messageId}:activity:${part.indices[0] ?? 0}`}>
                        {children}
                      </ToolGroup>
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

function EmptyReplyPending({ timingKey }: { timingKey: string }) {
  const elapsed = useElapsed(timingKey, "running");
  return (
    <ThinkingIndicator
      label="Waiting for response"
      elapsed={elapsed === undefined ? undefined : formatDuration(elapsed)}
      className="my-2 h-6 first:mt-0 last:mb-0"
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
 * Under the reply: copy, try again, try again with another model or thinking
 * level, the session path; and the turn's timing on the end.
 *
 * Trying again changes THIS session: the engine moves the leaf to before the
 * prompt that produced this reply and runs it again, so the new answer stands
 * beside the old one as another version of the same question rather than
 * after it. The old reply is one click away in the version picker under that
 * prompt. "In a new session" is the same re-run into a fork.
 */
function AssistantFooter() {
  const aui = useAui();
  const { actions } = useLaserStable();
  const text = useMessageText();
  const { copied, copy } = useCopy();
  const path = useSessionPath();
  const entries = useEntries();
  const leafId = useLeafId();
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
    ordinal = laserMeta(s.thread.messages[i] as MessageState).userOrdinal ?? ordinal;
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
  const promptEntryId = promptOrdinal === undefined ? undefined : userEntryAt(entries, promptOrdinal, leafId);

  const rerun = async (where: "here" | "fork", pick?: RegeneratePick) => {
    if (!promptEntryId) return;
    let prompt = promptText;
    if (where === "here") {
      const moved = await actions.navigate(promptEntryId);
      if (!moved) return;
      // The engine's own text for that entry, rather than one re-derived from
      // what the transcript happens to render.
      if (moved.editorText !== undefined) prompt = moved.editorText;
    } else {
      await actions.fork(promptEntryId);
    }
    if (prompt === undefined) return;
    if (pick && "model" in pick) await actions.setModel(pick.model as ModelRef);
    else if (pick) await actions.setThinking(pick.thinking as ThinkingLevel);
    await actions.send([{ type: "text", text: prompt }], "prompt");
    if (where === "fork") clearHandedBackPrompt(aui, prompt);
  };

  return (
    <MessageFooter>
      <MessageActions
        className={hoverReveal}
        copied={copied}
        onCopy={() => void copy(text)}
        onCopyPath={path ? () => void copy(path) : undefined}
        onRegenerate={promptEntryId ? () => void rerun("here") : undefined}
        onRegenerateFork={promptEntryId ? () => void rerun("fork") : undefined}
        busy={busy}
        regenerate={
          promptEntryId ? (
            <RegenerateMenu
              loadModels={actions.listModels}
              thinkingLevels={thinkingLevels}
              currentModel={model}
              currentThinking={thinking}
              onPick={(pick) => void rerun("here", pick)}
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
