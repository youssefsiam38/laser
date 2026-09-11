"use client";
/**
 * Message attachments (`elements-message-attachment`): the attachments on a
 * SENT message, as chips — distinct from `attachment`, which is the composer's
 * tile and the runtime-bound message tile. The transcript projection keeps
 * only a count of images per prompt (the bytes live in Pi's session file), so
 * the chips carry a kind and a name, never a thumbnail that would have to be
 * invented.
 *
 * Divergences from the registry copy: chips, not cards; no swatch, no fake
 * size; tokens throughout.
 */
import { FileText, Image as ImageIcon, Paperclip } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { mono, paper } from "./surfaces.js";

export interface MessageAttachmentItem {
  id: string;
  name: string;
  kind: "image" | "document" | "file";
  /** Already formatted: "24 KB", "3 pages". Omit when unknown. */
  detail?: string | undefined;
}

const ICON = { image: ImageIcon, document: FileText, file: Paperclip } as const;

export interface MessageAttachmentsProps extends Omit<ComponentProps<"div">, "children"> {
  attachments: readonly MessageAttachmentItem[];
  onOpen?: ((id: string, trigger: HTMLButtonElement) => void) | undefined;
}

export function MessageAttachments({ attachments, onOpen, className, ...props }: MessageAttachmentsProps) {
  if (attachments.length === 0) return null;
  return (
    <div data-slot="message-attachments" className={cn("flex flex-wrap justify-end gap-1.5", className)} {...props}>
      {attachments.map((item) => {
        const Icon = ICON[item.kind];
        const body = (
          <>
            <Icon aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
            <span className="min-w-0 truncate" title={item.name}>
              {item.name}
            </span>
            {item.detail ? <span className={cn(mono, "shrink-0 text-ink-3")}>{item.detail}</span> : null}
          </>
        );
        const classes = cn(paper, "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full pe-2.5 ps-2 text-xs text-ink-2");
        return onOpen ? (
          <button
            key={item.id}
            type="button"
            onClick={event => onOpen(item.id, event.currentTarget)}
            className={cn(classes, "pointer-coarse:min-h-11 outline-none transition-colors duration-(--motion-instant) hover:border-ink-3 hover:text-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live")}
          >
            {body}
          </button>
        ) : (
          <span key={item.id} className={classes}>
            {body}
          </span>
        );
      })}
    </div>
  );
}
