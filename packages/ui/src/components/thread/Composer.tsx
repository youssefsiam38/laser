import { ComposerPrimitive, useAui, useAuiState, unstable_useMentionAdapter, unstable_useSlashCommandAdapter } from "@assistant-ui/react";
import { AtSign, FolderOpen, GitFork, History, ListX, Pencil, Plus, Shrink, SlashSquare } from "lucide-react";
import { useMemo, type KeyboardEvent } from "react";

import {
  ComposerAttachButton,
  ComposerAttachmentTile,
  ComposerAttachments,
  ComposerBar,
  ComposerSend,
  ComposerToolbar,
} from "@/components/assistant-ui/elements/composer";
import { ComposerTriggerPopover } from "@/components/assistant-ui/elements/composer-trigger-popover.aui";
import { ContextRingButton } from "@/components/assistant-ui/elements/context-display";
import { ComposerDraftRestore } from "@/components/assistant-ui/elements/draft-restore";
import { ComposerQueue } from "@/components/assistant-ui/elements/message-queue";
import { ComposerQuotePreview, quoteAsMarkdown } from "@/components/assistant-ui/elements/quote.aui";
import { MobileComposer, MobileComposerButtonClass } from "@/components/assistant-ui/elements/mobile-composer";
import { SessionModelSelector } from "@/components/assistant-ui/elements/model-selector";
import { ThinkingEffort } from "@/components/assistant-ui/elements/reasoning-effort";
import { DictateButton } from "@/components/mobile";
import { useShell } from "@/components/shell/shell-context";
import { Kbd } from "@/components/ui/kbd";
import { modKey } from "@/format";
import { useIsMobile, useIsTouch } from "@/hooks/use-mobile";
import { usePanelEntries } from "@/panels";
import { composerSendPlan, usePiorbitStable, usePiorbitView, useSessionMeta } from "@/runtime";
import { ProjectLine } from "./ProjectLine.js";
import { StatusLine } from "./StatusLine.js";

/**
 * The composer (DESIGN.md "Composer"), composed from the catalog: the
 * `composer` element's card and controls, `message-queue` above it, the
 * `draft-restore` offer, `model-selector`, `reasoning-effort`,
 * `context-display`, and `composer-trigger-popover` for `/` and `@`
 * (docs/ux-elements.md "Composer"). Enter = prompt when idle / steer while
 * running, Shift+Enter = newline, Cmd/Ctrl+Enter = follow-up while running —
 * decided by `composerSendPlan` from the runtime module.
 *
 * On a phone the same primitives take the `mobile-composer` layout: a pill
 * between two 44px controls, the microphone inside the pill.
 *
 * Above the card: the draft offer, the queue chips, then the status line
 * (D-20 §5). Below it: the project's git line on the left and the key legend
 * on the right.
 */
export function Composer() {
  const mobile = useIsMobile();
  const slash = useSlashCommands();
  const mention = useHandleMentions();
  const onInputKeyDown = useComposerKeys();
  const disabled = useAuiState((s) => s.thread.isDisabled);
  const placeholder = usePlaceholder();
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root data-slot="composer" className="relative flex flex-col gap-2">
        <ComposerDraftRestore />
        <ComposerQueue />
        <StatusLine />
        {mobile ? (
          <MobileComposer
            above={
              <>
                <SessionModelSelector />
                <span className="flex-1" />
                <ThinkingEffort />
                <ContextRingButton />
              </>
            }
            leading={<ComposerAttachButton size="icon-lg" className={MobileComposerButtonClass()} />}
            inline={<DictateButton size="icon-lg" />}
            trailing={<SendOrStop mobile />}
            onInputKeyDown={onInputKeyDown}
            disabled={disabled}
            placeholder={placeholder}
          />
        ) : (
          <ComposerPrimitive.AttachmentDropzone asChild>
            <ComposerBar>
              <ComposerAttachments>
                <ComposerPrimitive.Attachments>{() => <ComposerAttachmentTile />}</ComposerPrimitive.Attachments>
              </ComposerAttachments>
              {/* Quoted transcript text rides above the input until it is sent (the `quote` element). */}
              <ComposerQuotePreview />
              <ComposerInput />
              <ComposerToolbar>
                <ComposerAttachButton />
                <DictateButton />
                <SessionModelSelector />
                <span className="flex-1" />
                <ThinkingEffort />
                <ContextRingButton />
                <SendOrStop />
              </ComposerToolbar>
            </ComposerBar>
          </ComposerPrimitive.AttachmentDropzone>
        )}
        {/* `/` runs a piorbit command; `@` addresses a running subagent by handle. */}
        <ComposerTriggerPopover char="/" adapter={slash.adapter} action={slash.action} {...(slash.iconMap ? { iconMap: slash.iconMap } : {})} fallbackIcon={SlashSquare} className="bottom-[calc(100%-2rem)]" />
        <ComposerTriggerPopover char="@" adapter={mention.adapter} directive={mention.directive} fallbackIcon={AtSign} emptyItemsLabel="No subagent has a handle right now" className="bottom-[calc(100%-2rem)]" />
        {!mobile && <ComposerFooterLine />}
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}

// ---------------------------------------------------------------------------
// Input and keys
// ---------------------------------------------------------------------------

function usePlaceholder(): string {
  const running = useAuiState((s) => s.thread.isRunning);
  const disabled = useAuiState((s) => s.thread.isDisabled);
  return disabled ? "Reconnecting to the host…" : running ? "Steer the agent…" : "Message the agent…";
}

function useComposerKeys(): (e: KeyboardEvent<HTMLTextAreaElement>) => void {
  const aui = useAui();
  const running = useAuiState((s) => s.thread.isRunning);
  const disabled = useAuiState((s) => s.thread.isDisabled);
  const touch = useIsTouch();
  return (e) => {
    if (e.nativeEvent.isComposing) return;
    const plan = composerSendPlan(e, running);
    // `suppress` still has to call `preventDefault`: the primitive's handler
    // runs after ours and only stands down on a prevented event.
    if (plan.action === "suppress") {
      e.preventDefault();
      return;
    }
    if (plan.action !== "send") return;
    // Touch keyboards: plain Enter is a newline; the Send button submits.
    if (touch && !e.metaKey && !e.ctrlKey) return;
    e.preventDefault();
    if (disabled || !aui.composer.getState().canSend) return;
    foldQuote(aui);
    aui.composer.setRunConfig(plan.runConfig);
    aui.composer.send(plan.sendOptions);
  };
}

/**
 * Pi's prompt is plain text, so a quote set from the selection toolbar is
 * folded into the message as a markdown blockquote at send time; the sent
 * message renders it back as a quote (`quote-reply`).
 */
function foldQuote(aui: ReturnType<typeof useAui>): void {
  const composer = aui.composer;
  const { quote, text } = composer.getState();
  if (!quote) return;
  const block = quoteAsMarkdown(quote.text);
  composer.setText(text.trim() ? `${block}\n\n${text}` : block);
  composer.setQuote(undefined);
}

function ComposerInput() {
  const onKeyDown = useComposerKeys();
  const disabled = useAuiState((s) => s.thread.isDisabled);
  const placeholder = usePlaceholder();
  return (
    <ComposerPrimitive.Input
      rows={1}
      maxRows={8}
      autoFocus
      aria-label="Message"
      placeholder={placeholder}
      submitMode="enter"
      cancelOnEscape={false}
      unstable_insertNewlineOnTouchEnter
      disabled={disabled}
      onKeyDown={onKeyDown}
      className="w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-base leading-base text-ink outline-none placeholder:text-ink-3 disabled:cursor-not-allowed"
    />
  );
}

function SendOrStop({ mobile = false }: { mobile?: boolean }) {
  const aui = useAui();
  const running = useAuiState((s) => s.thread.isRunning);
  const empty = useAuiState((s) => s.composer.isEmpty);
  const stop = running && empty;
  const size = mobile ? "icon-lg" : "icon-sm";
  const className = mobile ? MobileComposerButtonClass(true) : undefined;
  if (stop) {
    return (
      <ComposerPrimitive.Cancel asChild>
        <ComposerSend streaming size={size} className={className} />
      </ComposerPrimitive.Cancel>
    );
  }
  return (
    <ComposerPrimitive.Send asChild>
      <ComposerSend
        streaming={false}
        tooltip={running ? "Steer" : "Send"}
        shortcut="⏎"
        size={size}
        className={className}
        onClick={() => {
          foldQuote(aui);
          aui.composer.setRunConfig({ custom: { streamingBehavior: running ? "steer" : "prompt" } });
        }}
      />
    </ComposerPrimitive.Send>
  );
}

// ---------------------------------------------------------------------------
// `/` — piorbit's own commands. Pi's slash commands, extension commands and
// `/skill:` commands need `pi/commands/list` (protocol request filed in the
// wave report); until then the popover offers what the app itself can do.
// ---------------------------------------------------------------------------

const SLASH_ICONS = { compact: Shrink, fork: GitFork, rename: Pencil, history: History, "new": Plus, queue: ListX, project: FolderOpen } as const;

function useSlashCommands() {
  const aui = useAui();
  const { actions } = usePiorbitStable();
  const view = usePiorbitView();
  const shell = useShell();
  const { running, compacting } = useSessionMeta();
  const busy = running || compacting;
  const commands = useMemo(
    () => [
      { id: "compact", label: "/compact", description: busy ? "Waits for the turn to finish" : "Summarise the conversation so far and keep going", icon: "compact", execute: () => void actions.compact() },
      { id: "fork", label: "/fork", description: "Start a new session from the last prompt", icon: "fork", execute: () => void forkFromLastPrompt() },
      { id: "new", label: "/new", description: "A new session in this project", icon: "new", execute: () => void shell.newSession() },
      { id: "queue", label: "/clear-queue", description: "Drop the queued steers and follow-ups back into the composer", icon: "queue", execute: () => void clearQueue() },
      { id: "history", label: "/history", description: "Open the session tree", icon: "history", execute: () => shell.openHistory() },
      { id: "project", label: "/project", description: "Add a project directory", icon: "project", execute: () => shell.setAddProjectOpen(true) },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the callbacks below read the latest values themselves
    [busy, actions, shell],
  );

  async function forkFromLastPrompt() {
    if (!view) return;
    const entries = view.entries;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as { type?: string; id?: string; message?: { role?: string } };
      if (e.type === "message" && e.message?.role === "user" && e.id) return actions.fork(e.id);
    }
    await actions.refreshEntries();
    actions.toast("warning", "Nothing to fork yet: this session has no prompt.");
  }

  async function clearQueue() {
    const text = await actions.clearQueue();
    if (!text) return;
    const current = aui.composer.getState().text;
    aui.composer.setText(current ? `${current}\n${text}` : text);
  }

  return unstable_useSlashCommandAdapter({ commands, removeOnExecute: true, iconMap: SLASH_ICONS });
}

// ---------------------------------------------------------------------------
// `@` — a running subagent's handle, where the package provides one.
// `@file` mentions need `pi/project/files` (protocol request filed).
// ---------------------------------------------------------------------------

function useHandleMentions() {
  const view = usePiorbitView();
  const entries = usePanelEntries(view?.path);
  const items = useMemo(
    () =>
      entries.flatMap((entry) => {
        const panel = entry.panel;
        if (panel.kind !== "run" || !panel.handle) return [];
        return [{ id: panel.handle, type: "agent", label: panel.handle, description: panel.title }];
      }),
    [entries],
  );
  return unstable_useMentionAdapter({ items, includeModelContextTools: false });
}

// ---------------------------------------------------------------------------
// Under the card: project line on the left, key legend on the right (md+).
// ---------------------------------------------------------------------------

function ComposerFooterLine() {
  const { running } = useSessionMeta();
  const mod = modKey();
  return (
    <div className="flex h-5 min-w-0 items-center justify-between gap-3 px-1 text-xs text-ink-3">
      <ProjectLine className="min-w-0 flex-1" />
      <span className="hidden shrink-0 items-center gap-2 leading-4 md:flex" aria-hidden="true">
        <span className="flex items-center gap-1">
          <Kbd>⏎</Kbd> {running ? "steer" : "send"}
        </span>
        {running ? (
          <span className="flex items-center gap-1">
            <Kbd>{mod}</Kbd>
            <Kbd>⏎</Kbd> queue
          </span>
        ) : null}
        <span className="flex items-center gap-1">
          <Kbd>⇧</Kbd>
          <Kbd>⏎</Kbd> newline
        </span>
        <span className="flex items-center gap-1">
          <Kbd>/</Kbd> commands
        </span>
      </span>
    </div>
  );
}
