"use client";
/**
 * Message attachments (`elements-message-attachment`): the attachments on a
 * SENT message: image thumbnails above the prose, text-file chips alongside it.
 * The store retains the actual bytes through optimistic, live and loaded paths.
 *
 * Divergences from the registry copy: chips, not cards; no swatch, no fake
 * size; tokens throughout.
 */
import { FileText, Image as ImageIcon, Paperclip } from "lucide-react";
import type { ComponentProps } from "react";
import type { ImageContent } from "@lasercode/protocol";

import { cn } from "@/lib/utils";

import { mono, paper } from "./surfaces.js";

export function MessageImages({ images, onOpen }: { images: readonly ImageContent[]; onOpen(index: number, trigger: HTMLButtonElement): void }) {
  if (!images.length) return null;
  return <div data-slot="message-images" className="mb-2 flex max-w-full flex-wrap gap-2">
    {images.map((image, index) => <button key={index} type="button" aria-label={`Open Image ${index + 1}`} onClick={event => onOpen(index, event.currentTarget)}
      className={cn("max-w-full overflow-hidden rounded-lg outline-none hover:opacity-90 active:opacity-80 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live", images.length > 1 ? "size-28" : "w-full sm:w-auto")}>
      <img data-slot="message-image" src={`data:${image.mimeType};base64,${image.data}`} alt={`Image ${index + 1}`} className={images.length > 1 ? "size-full object-cover" : "max-h-60 w-full max-w-80 object-contain sm:w-auto"} />
    </button>)}
  </div>;
}

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
            <span className="flex min-w-0 flex-col items-start">
              <span className="max-w-full truncate" title={item.name}>{item.name}</span>
              {item.detail ? <span className={cn(mono, "max-w-full truncate text-ink-3")}>{item.detail}</span> : null}
            </span>
          </>
        );
        const classes = cn(paper, "inline-flex min-h-11 max-w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-ink-2");
        return onOpen ? (
          <button
            key={item.id}
            data-slot="file-chip"
            type="button"
            onClick={event => onOpen(item.id, event.currentTarget)}
            className={cn(classes, "pointer-coarse:min-h-11 outline-none transition-colors duration-(--motion-instant) hover:border-ink-3 hover:text-ink active:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live")}
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
