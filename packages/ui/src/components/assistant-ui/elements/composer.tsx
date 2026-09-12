"use client";
/**
 * Composer — the unified input (docs/ux-elements.md "Composer"). Installed
 * from `elements-composer` and restyled to DESIGN.md tokens.
 *
 * The registry file is a self-contained specimen: a single-line `<input>`,
 * a demo model list, a fake waveform, its own slash and mention filters. This
 * app already runs an assistant-ui runtime, so the pieces that duplicate a
 * primitive were removed and the pieces that are pure presentation stayed
 * and became the composer's vocabulary:
 *
 *   - `ComposerBar`, `ComposerToolbar`, `ComposerActions`: the floating card
 *     and its bottom row.
 *   - `ComposerAttachments`, `ComposerAttachmentChip`: staged files, now fed
 *     from `AttachmentPrimitive` state.
 *   - `ComposerAttachButton`, `ComposerVoiceButton`, `ComposerSend`: the
 *     three icon controls, each wrapping a primitive through `asChild`.
 *   - `ComposerVoice`: the listening row, driven by the *real* microphone
 *     level (`useDictationLevel`) rather than a sine wave.
 *
 * Removed, with the reason:
 *   - `ComposerInput` (an `<input>`): `ComposerPrimitive.Input` is the
 *     textarea with autosize, paste-to-attach, Enter semantics and dictation.
 *   - `ComposerMenu*`, `useSlashMatches`, `useMentionMatches`, `applyMention`:
 *     `composer-trigger-popover` owns `/` and `@`.
 *   - `ComposerModelTrigger`, `ComposerModelItem`: `model-selector` owns models.
 *   - `ComposerContext`: `context-display` owns the ring, from real usage.
 *
 * The runtime composition lives in `components/thread/Composer.tsx`.
 */
import { AttachmentPrimitive, ComposerPrimitive, useAuiState } from "@assistant-ui/react";
import {
  ArrowUpIcon,
  CheckIcon,
  FileArchiveIcon,
  FileImageIcon,
  FileTextIcon,
  MicIcon,
  Paperclip,
  SquareIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps } from "react";

import { StatusDot } from "@/components/status";
import { TooltipIconButton, type TooltipIconButtonProps } from "@/components/ui/tooltip-icon-button";
import { duration } from "@/format";
import { cn } from "@/lib/utils";

import { field, iconSwap, iconSwapIn, iconSwapOut, ShimmerLabel } from "./surfaces.js";

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/**
 * The floating card (DESIGN.md "Composer"): `--surface` on `--bg`, one soft
 * shadow, a dashed `--live` edge while a file is dragged over it. Wrap it in
 * `ComposerPrimitive.AttachmentDropzone asChild` to get `data-dragging`.
 */
export function ComposerBar({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-card"
      className={cn(
        "flex flex-col rounded-2xl border border-line bg-surface shadow-float transition-[border-color] duration-(--motion-instant)",
        "focus-within:border-[color-mix(in_oklab,var(--line)_40%,var(--ink-3))]",
        "data-[dragging=true]:border-dashed data-[dragging=true]:border-live",
        "data-[dictation-insert=true]:border-live data-[dictation-insert=true]:ring-2 data-[dictation-insert=true]:ring-live/20",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The bottom row. A container query root: controls inside choose their form
 * by the composer's own width, not the window's — a thread column beside a
 * two-column dock is narrower than a phone.
 */
export function ComposerToolbar({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="composer-toolbar" className={cn("@container flex flex-wrap items-center gap-1 px-2 pt-1 pb-2", className)} {...props} />;
}

export function ComposerActions({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="composer-actions" className={cn("flex min-w-0 flex-1 items-center justify-end gap-1", className)} {...props} />;
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export type ComposerAttachmentKind = "image" | "text" | "archive";

export interface ComposerAttachment {
  name: string;
  /** Size, type, or the failure — one short line. */
  meta: string;
  state: "uploading" | "done" | "error";
  kind?: ComposerAttachmentKind | undefined;
  /** An image's preview, when there is one. */
  src?: string | undefined;
}

const ATTACHMENT_ICONS: Record<ComposerAttachmentKind, LucideIcon> = {
  image: FileImageIcon,
  text: FileTextIcon,
  archive: FileArchiveIcon,
};

/** The row of staged files; hidden when empty. */
export function ComposerAttachments({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="composer-attachments" className={cn("flex flex-wrap gap-2 px-3 pt-3 empty:hidden", className)} {...props} />;
}

export interface ComposerAttachmentChipProps extends Omit<ComponentProps<"div">, "children"> {
  attachment: ComposerAttachment;
  /** The remove control, already wired (an `AttachmentPrimitive.Remove`). */
  remove?: React.ReactNode;
}

/** One staged file: a thumbnail or a type icon, the name, one line of meta. */
export function ComposerAttachmentChip({ attachment, remove, className, ...props }: ComposerAttachmentChipProps) {
  const Icon = ATTACHMENT_ICONS[attachment.kind ?? "text"];
  return (
    <div
      data-slot="composer-attachment"
      data-state={attachment.state}
      className={cn(
        field,
        "group/attachment relative flex max-w-full items-center gap-2.5 overflow-hidden rounded-xl py-1.5 ps-1.5 pe-2",
        attachment.state === "error" && "border border-danger",
        className,
      )}
      {...props}
    >
      <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface text-ink-3">
        {attachment.src ? <img src={attachment.src} alt="" className="size-full object-cover" /> : <Icon aria-hidden="true" className="size-4" />}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="max-w-40 truncate text-xs font-medium text-ink">{attachment.name}</span>
        <span className={cn("truncate text-xs", attachment.state === "error" ? "text-danger" : "text-ink-3")}>{attachment.meta}</span>
      </span>
      <span className="ms-1 flex w-6 shrink-0 items-center justify-end">
        {attachment.state === "uploading" ? (
          <StatusDot status="working" size="sm" label="Attaching" />
        ) : (
          remove ?? <CheckIcon aria-hidden="true" className="size-3.5 text-ok" />
        )}
      </span>
    </div>
  );
}

const IMAGE_TYPES = /^image\//;
const ARCHIVE_TYPES = /zip|tar|gzip|compressed/;

export function attachmentKind(contentType: string | undefined): ComposerAttachmentKind {
  if (contentType && IMAGE_TYPES.test(contentType)) return "image";
  if (contentType && ARCHIVE_TYPES.test(contentType)) return "archive";
  return "text";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One staged file from `AttachmentPrimitive` state; render it inside
 * `ComposerPrimitive.Attachments`. The preview is an object URL for the
 * local file, revoked when the chip goes away.
 */
export function ComposerAttachmentTile() {
  const name = useAuiState((s) => s.attachment.name);
  const file = useAuiState((s) => s.attachment.file);
  const type = useAuiState((s) => s.attachment.contentType);
  const status = useAuiState((s) => s.attachment.status);
  const image = useAuiState((s) => {
    const part = s.attachment.content?.find((p) => p.type === "image");
    return part && part.type === "image" ? part.image : undefined;
  });
  const [objectUrl, setObjectUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setObjectUrl(undefined);
    };
  }, [file]);

  const kind = attachmentKind(type);
  const failed = status.type === "incomplete";
  const uploading = status.type === "running";
  const meta = failed
    ? status.reason === "error"
      ? "Could not attach"
      : "Cancelled"
    : file
      ? formatBytes(file.size)
      : (type ?? "file");

  return (
    <AttachmentPrimitive.Root asChild>
      <ComposerAttachmentChip
        attachment={{
          name,
          meta,
          kind,
          state: failed ? "error" : uploading ? "uploading" : "done",
          src: kind === "image" ? (image ?? objectUrl) : undefined,
        }}
        remove={
          <AttachmentPrimitive.Remove asChild>
            <TooltipIconButton tooltip="Remove" size="icon-xs" side="top" className="text-ink-3">
              <XIcon />
            </TooltipIconButton>
          </AttachmentPrimitive.Remove>
        }
      />
    </AttachmentPrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** Attach a file. Wraps `ComposerPrimitive.AddAttachment`; the tooltip says why when it cannot. */
export function ComposerAttachButton({ className, ...props }: Omit<TooltipIconButtonProps, "tooltip" | "children">) {
  const supported = useAuiState((s) => s.thread.capabilities.attachments);
  return (
    <ComposerPrimitive.AddAttachment asChild>
      <TooltipIconButton tooltip={supported ? "Attach file" : "Attachments unavailable"} side="top" className={className} {...props}>
        <Paperclip />
      </TooltipIconButton>
    </ComposerPrimitive.AddAttachment>
  );
}

export interface ComposerVoiceButtonProps extends Omit<TooltipIconButtonProps, "tooltip" | "children"> {
  active: boolean;
  /** Overrides the default tooltip. */
  tooltip?: string | undefined;
}

/**
 * The microphone. Idle: a ghost icon button. Active: a filled stop button in
 * the same slot — the button morphs, nothing pops in elsewhere. The caller
 * wraps it in `ComposerPrimitive.Dictate` or `.StopDictation`.
 */
export function ComposerVoiceButton({ active, tooltip, className, ...props }: ComposerVoiceButtonProps) {
  return (
    <TooltipIconButton
      tooltip={tooltip ?? (active ? "Stop and transcribe" : "Dictate")}
      side="top"
      variant={active ? "default" : "ghost"}
      className={cn(active && "rounded-full", className)}
      {...props}
    >
      {active ? <SquareIcon className="size-3 fill-current" /> : <MicIcon />}
    </TooltipIconButton>
  );
}

const BARS = 5;

export interface ComposerVoiceProps extends Omit<ComponentProps<"span">, "children"> {
  /** Microphone RMS level, 0…1. */
  level: number;
  phase: "starting" | "listening" | "transcribing";
  /** Finished phrases currently crossing from audio to text. */
  pending?: number | undefined;
  /** Epoch ms the recording started; drives the elapsed readout. */
  startedAt: number;
}

/**
 * The listening row: five bars driven by the live level, each lagging the
 * last so the shape reads as sound; the elapsed time in typed digits; the
 * word while the audio is being transcribed. Height, never scale: a bar is
 * 2px wide and 3–16px tall. Under reduced motion the bars hold their level.
 */
export function ComposerVoice({ level, phase, pending = 0, startedAt, className, ...props }: ComposerVoiceProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const history = useRef<number[]>(Array.from({ length: BARS }, () => 0));
  history.current = [level, ...history.current.slice(0, BARS - 1)];
  const label = phase === "transcribing" ? "Transcribing…" : phase === "starting" ? "Starting…" : "Listening";

  return (
    <span
      role="status"
      data-slot="composer-voice"
      data-phase={phase}
      className={cn("flex min-h-8 min-w-0 flex-wrap items-center gap-2 rounded-full bg-surface-2 ps-2.5 pe-3 text-xs text-ink-2", className)}
      {...props}
    >
      {phase === "listening" ? (
        <span aria-hidden="true" className="flex h-4 items-center gap-0.5">
          {history.current.map((v, i) => (
            <span
              key={i}
              className="w-0.5 rounded-full bg-live motion-safe:transition-[height] motion-safe:duration-(--motion-instant)"
              style={{ height: `${3 + Math.round(Math.min(1, v * (1 + (BARS - i) * 0.15)) * 13)}px` }}
            />
          ))}
        </span>
      ) : (
        <StatusDot status={phase === "transcribing" ? "working" : "idle"} size="sm" aria-hidden="true" />
      )}
      {phase === "transcribing" ? (
        <ShimmerLabel className="font-medium">{label}</ShimmerLabel>
      ) : (
        <span className="font-medium text-ink">{label}</span>
      )}
      {pending > 0 && phase === "listening" && (
        <span className="flex items-center gap-1 text-live">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-live motion-safe:animate-attention" />
          {pending} {pending === 1 ? "phrase" : "phrases"}
        </span>
      )}
      {phase !== "transcribing" && <span className="typed text-ink-3">{now - startedAt < 1000 ? "0s" : duration(now - startedAt).replace(/\.\ds$/, "s")}</span>}
    </span>
  );
}

export interface ComposerSendProps extends Omit<TooltipIconButtonProps, "tooltip" | "children" | "shortcut"> {
  /** A turn is running: the arrow becomes a stop square. */
  streaming: boolean;
  /** Overrides the default tooltip. */
  tooltip?: string | undefined;
  shortcut?: string | undefined;
}

/**
 * Send, or stop. One button, two glyphs that swap in place (`iconSwap`), so
 * the eye never loses the control. Wrap it in `ComposerPrimitive.Send` or
 * `.Cancel` through `asChild`.
 */
export function ComposerSend({ streaming, tooltip, shortcut, className, ...props }: ComposerSendProps) {
  return (
    <TooltipIconButton
      tooltip={tooltip ?? (streaming ? "Stop" : "Send")}
      {...(shortcut !== undefined ? { shortcut } : {})}
      side="top"
      variant={streaming ? "secondary" : "default"}
      className={cn("ms-1 grid place-items-center rounded-full", className)}
      {...props}
    >
      <ArrowUpIcon className={cn(iconSwap, "size-4", streaming ? iconSwapOut : iconSwapIn)} />
      <SquareIcon className={cn(iconSwap, "size-3 fill-current", streaming ? iconSwapIn : iconSwapOut)} />
    </TooltipIconButton>
  );
}
