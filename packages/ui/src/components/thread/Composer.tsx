import {
  AttachmentPrimitive,
  AuiIf,
  ComposerPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";

import { StatusRing } from "@/components/status";
import { Kbd } from "@/components/ui/kbd";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { tokens } from "@/format";
import { useIsTouch } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { composerSendPlan, usePiorbitStable, useSessionMeta } from "@/runtime";
import { isMac } from "./DialogBody.js";
import { ModelSelector } from "./ModelSelector.js";
import { QueueChips } from "./QueueChips.js";
import { ThinkingButton, ThinkingSlider } from "./ThinkingSlider.js";

/**
 * Floating composer card (DESIGN.md "Composer"): 12px radius, `--surface` on
 * `--bg`, one soft shadow. Enter = prompt when idle / steer while running,
 * Shift+Enter = newline, Cmd/Ctrl+Enter = follow-up while running — decided
 * by `composerSendPlan` from the runtime module.
 */
export function Composer() {
  return (
    <ComposerPrimitive.Root data-slot="composer" className="flex flex-col gap-2">
      <QueueChips />
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="composer-card"
          className={cn(
            "flex flex-col rounded-2xl border border-line bg-surface shadow-float transition-[border-color] duration-75",
            "focus-within:border-[color-mix(in_oklab,var(--line)_40%,var(--ink-3))]",
            "data-[dragging=true]:border-dashed data-[dragging=true]:border-live",
          )}
        >
          <ComposerAttachments />
          <ComposerInput />
          <ComposerBar />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
      <ComposerHints />
    </ComposerPrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function ComposerInput() {
  const aui = useAui();
  const running = useAuiState((s) => s.thread.isRunning);
  const disabled = useAuiState((s) => s.thread.isDisabled);
  const touch = useIsTouch();

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const plan = composerSendPlan(e, running);
    if (plan.action !== "send") return;
    // Touch keyboards: plain Enter is a newline; the Send button submits.
    if (touch && !e.metaKey && !e.ctrlKey) return;
    e.preventDefault();
    if (disabled || !aui.composer.getState().canSend) return;
    aui.composer.setRunConfig(plan.runConfig);
    aui.composer.send(plan.sendOptions);
  };

  return (
    <ComposerPrimitive.Input
      rows={1}
      maxRows={8}
      autoFocus
      aria-label="Message"
      placeholder={disabled ? "Reconnecting to the host…" : running ? "Steer the agent…" : "Message the agent…"}
      submitMode="enter"
      cancelOnEscape={false}
      unstable_insertNewlineOnTouchEnter
      onKeyDown={onKeyDown}
      className={cn(
        "w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-base leading-[21px] text-ink outline-none",
        "placeholder:text-ink-3 disabled:cursor-not-allowed",
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Attachments (images only; paste works through ComposerPrimitive.Input)
// ---------------------------------------------------------------------------

function ComposerAttachments() {
  return (
    <div className="flex flex-wrap gap-2 px-4 pt-3 empty:hidden">
      <ComposerPrimitive.Attachments>{() => <AttachmentTile />}</ComposerPrimitive.Attachments>
    </div>
  );
}

function useAttachmentSrc(): string | undefined {
  const file = useAuiState((s) => s.attachment.file);
  const image = useAuiState((s) => {
    const part = s.attachment.content?.find((p) => p.type === "image");
    return part && part.type === "image" ? part.image : undefined;
  });
  const [objectUrl, setObjectUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setObjectUrl(undefined);
    };
  }, [file]);
  return image ?? objectUrl;
}

function AttachmentTile() {
  const src = useAttachmentSrc();
  const name = useAuiState((s) => s.attachment.name);
  const failed = useAuiState((s) => s.attachment.status.type === "incomplete");
  return (
    <AttachmentPrimitive.Root
      className={cn(
        "group/attachment relative size-14 overflow-hidden rounded-lg border border-line bg-surface-2",
        failed && "border-danger",
      )}
    >
      {src ? (
        <img src={src} alt={name} className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center text-ink-3">
          <Paperclip aria-hidden="true" className="size-4" />
        </span>
      )}
      <AttachmentPrimitive.Remove asChild>
        <TooltipIconButton
          tooltip="Remove"
          size="icon-xs"
          variant="secondary"
          side="top"
          className="absolute top-1 end-1 size-5 rounded-full bg-bg/90 opacity-0 shadow-float-sm group-hover/attachment:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100"
        >
          <X className="size-3" />
        </TooltipIconButton>
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

function AttachButton() {
  const supported = useAuiState((s) => s.thread.capabilities.attachments);
  return (
    <ComposerPrimitive.AddAttachment asChild>
      <TooltipIconButton tooltip={supported ? "Attach image" : "Attachments unavailable"} side="top">
        <Paperclip />
      </TooltipIconButton>
    </ComposerPrimitive.AddAttachment>
  );
}

// ---------------------------------------------------------------------------
// Bottom bar: attach · model · (spacer) · thinking · context · send/stop
// ---------------------------------------------------------------------------

function ComposerBar() {
  return (
    <div className="flex items-center gap-1 px-2 pt-1 pb-2">
      <AttachButton />
      <ModelSelector />
      <span className="flex-1" />
      <ThinkingSlider className="hidden sm:flex" />
      <ThinkingButton className="sm:hidden" />
      <ContextRing />
      <SendOrStop />
    </div>
  );
}

function ContextRing() {
  const { actions } = usePiorbitStable();
  const { contextUsage, running, compacting } = useSessionMeta();
  if (!contextUsage) return null;
  const percent = contextUsage.percent;
  const used = contextUsage.tokens;
  const window = contextUsage.contextWindow;
  const idle = !running && !compacting;
  const tooltip = compacting
    ? "Compacting…"
    : percent === null
      ? `Context ${tokens(window)} · fresh after compaction`
      : `Context ${Math.round(percent)}% · ${tokens(used ?? 0)} / ${tokens(window)}${idle ? " · compact" : ""}`;
  return (
    <TooltipIconButton
      tooltip={tooltip}
      side="top"
      disabled={!idle || percent === null}
      onClick={() => void actions.compact()}
      className="disabled:opacity-100"
    >
      <StatusRing
        percent={percent ?? 0}
        size={20}
        thickness={2}
        showLabel={false}
        label={tooltip}
        className={cn(compacting && "motion-safe:animate-attention")}
      />
    </TooltipIconButton>
  );
}

function SendOrStop() {
  const aui = useAui();
  const running = useAuiState((s) => s.thread.isRunning);
  return (
    <>
      <AuiIf condition={(s) => !s.thread.isRunning || !s.composer.isEmpty}>
        <ComposerPrimitive.Send asChild>
          <TooltipIconButton
            tooltip={running ? "Steer" : "Send"}
            shortcut="⏎"
            side="top"
            variant="default"
            className="ms-1 rounded-full"
            onClick={() => aui.composer.setRunConfig({ custom: { streamingBehavior: running ? "steer" : "prompt" } })}
          >
            <ArrowUp className="size-4" />
          </TooltipIconButton>
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.isRunning && s.composer.isEmpty}>
        <ComposerPrimitive.Cancel asChild>
          <TooltipIconButton tooltip="Stop" side="top" variant="secondary" className="ms-1 rounded-full">
            <Square className="size-3 fill-current" />
          </TooltipIconButton>
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </>
  );
}

// ---------------------------------------------------------------------------
// Hints: connection reason on the left, key legend on the right
// ---------------------------------------------------------------------------

function ComposerHints() {
  const { connection, running } = useSessionMeta();
  const mod = isMac() ? "⌘" : "Ctrl";
  const offline = connection !== "open";
  return (
    <div className="flex h-4 items-center justify-between px-1 text-2xs text-ink-3">
      <span className="flex items-center gap-1.5" role={offline ? "status" : undefined}>
        {offline ? (
          <>
            <span aria-hidden="true" className="size-1.5 rounded-full bg-danger" />
            {connection === "connecting" ? "Connecting to the host… composer paused" : "Disconnected from the host… composer paused"}
          </>
        ) : null}
      </span>
      <span className="hidden items-center gap-2 md:flex" aria-hidden="true">
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
      </span>
    </div>
  );
}
