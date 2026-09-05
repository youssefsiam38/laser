"use client";
/**
 * Attachment (`attachment`): the tiles in the composer and on a sent message,
 * the add button, and a click-to-preview dialog for images. Reads the
 * runtime's attachment scope.
 *
 * Divergences from the registry copy: our Radix `Tooltip` / `Dialog` /
 * `TooltipIconButton` (the registry's Base UI variants are not installed), no
 * `Avatar` (an `img` with an icon fallback is the whole need), the uploading
 * state is the app's working dot rather than `Loader2`, and every colour and
 * duration is a token.
 */
import { AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { CircleAlert, FileText, X } from "lucide-react";
import { useState, type FC, type PropsWithChildren } from "react";

import { StatusDot } from "@/components/status";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useAttachmentSrc } from "@/hooks/use-attachment-src";
import { cn } from "@/lib/utils";

const AttachmentPreview: FC<{ src: string }> = ({ src }) => {
  const [loaded, setLoaded] = useState(false);
  return (
    <img
      src={src}
      alt="Attachment preview"
      className={cn(
        "block h-auto max-h-[80vh] w-auto max-w-full rounded-md object-contain transition-opacity duration-(--motion-fast) motion-reduce:transition-none",
        loaded ? "opacity-100" : "opacity-0",
      )}
      onLoad={() => setLoaded(true)}
    />
  );
};

const AttachmentPreviewDialog: FC<PropsWithChildren> = ({ children }) => {
  const src = useAttachmentSrc();
  if (!src) return children;
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="p-2 sm:max-w-3xl">
        <DialogTitle className="sr-only">Image attachment preview</DialogTitle>
        <div className="relative mx-auto flex max-h-[80dvh] w-full items-center justify-center overflow-hidden rounded-md bg-surface-2">
          <AttachmentPreview src={src} />
        </div>
      </DialogContent>
    </Dialog>
  );
};

const AttachmentThumb: FC = () => {
  const src = useAttachmentSrc();
  const name = useAuiState((s) => s.attachment.name);
  if (src) return <img src={src} alt={name} className="size-full object-cover" />;
  return (
    <span className="flex size-full items-center justify-center text-ink-3">
      <FileText aria-hidden="true" className="size-5" />
    </span>
  );
};

const AttachmentUI: FC = () => {
  const aui = useAui();
  const isComposer = aui.attachment.source !== "message";
  const typeLabel = useAuiState((s) => {
    switch (s.attachment.type) {
      case "image":
        return "Image";
      case "document":
        return "Document";
      case "file":
        return "File";
      default:
        return String(s.attachment.type);
    }
  });
  const uploading = useAuiState((s) => s.attachment.status.type === "running");
  const errorMessage = useAuiState((s) =>
    s.attachment.status.type === "incomplete" && s.attachment.status.reason === "error" ? (s.attachment.status.message ?? "Could not attach this file") : undefined,
  );
  const isError = errorMessage !== undefined;

  return (
    <Tooltip>
      <AttachmentPrimitive.Root
        data-slot="attachment"
        data-source={isComposer ? "composer" : "message"}
        className={cn("group/attachment relative", isComposer && "animate-in fade-in-0 zoom-in-95 duration-(--motion-fast) motion-reduce:animate-none")}
      >
        <AttachmentPreviewDialog>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`${typeLabel} attachment${isError ? ", failed" : uploading ? ", attaching" : ""}`}
              className={cn(
                "relative size-14 overflow-hidden rounded-lg border bg-surface-2 outline-none transition-[border-color] duration-(--motion-instant)",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
                isError ? "border-danger" : "border-line hover:border-ink-3",
              )}
            >
              <AttachmentThumb />
              {uploading ? (
                <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center bg-bg/60">
                  <StatusDot status="working" size="md" aria-hidden="true" />
                </span>
              ) : null}
              {isError ? (
                <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center bg-bg/70">
                  <CircleAlert className="size-4 text-danger" />
                </span>
              ) : null}
            </button>
          </TooltipTrigger>
        </AttachmentPreviewDialog>
        {isComposer ? <AttachmentRemove /> : null}
      </AttachmentPrimitive.Root>
      <TooltipContent side="top" className="flex-col items-start">
        <AttachmentPrimitive.Name />
        {errorMessage ? <span className="opacity-80">{errorMessage}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
};

const AttachmentRemove: FC = () => (
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
);

/** Attachments on a sent message. */
export const UserMessageAttachments: FC = () => (
  <div data-slot="user-message-attachments" className="flex w-full flex-row flex-wrap justify-end gap-2 empty:hidden">
    <MessagePrimitive.Attachments>{() => <AttachmentUI />}</MessagePrimitive.Attachments>
  </div>
);

/** Attachments waiting in the composer. */
export const ComposerAttachments: FC = () => (
  <div data-slot="composer-attachments" className="flex flex-wrap gap-2 px-4 pt-3 empty:hidden">
    <ComposerPrimitive.Attachments>{() => <AttachmentUI />}</ComposerPrimitive.Attachments>
  </div>
);

// The attach button lives in `composer.tsx` (`ComposerAttach`), which owns the
// whole composer toolbar; a second copy here had no caller.
