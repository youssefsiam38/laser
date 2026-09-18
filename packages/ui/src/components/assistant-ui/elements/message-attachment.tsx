"use client";
/**
 * Message attachments (`elements-message-attachment`): the attachments on a
 * SENT message: image thumbnails above the prose, text-file chips alongside it.
 * The store retains the actual bytes through optimistic, live and loaded paths.
 *
 * Divergences from the registry copy: chips, not cards; no swatch, no fake
 * size; tokens throughout.
 */
import { FileText, Image as ImageIcon, ImageOff, Paperclip, RotateCw } from "lucide-react";
import type { ComponentProps } from "react";
import type { ImageContent } from "@lasercode/protocol";

import { cn } from "@/lib/utils";

import { mono, paper } from "./surfaces.js";

/**
 * Where one of a message's images is (RP-5b, M16-T82).
 *
 * `ready` has a picture. `loading` is being read. `waiting` is a picture this
 * window has not decoded right now — off screen, or past what it may hold at
 * once — which is a place, not a failure: its bytes are still on the
 * conversation's authority and opening it still works. `failed` is the image
 * itself, and says what to do about it.
 */
export interface MessageImageSource {
  src?: string | undefined;
  state: "ready" | "loading" | "waiting" | "failed";
  message?: string | undefined;
  openable: boolean;
  onRetry?: (() => void) | undefined;
}

export function MessageImages({ images, onOpen, sourceFor, observe }: {
  images: readonly ImageContent[];
  onOpen?: ((index: number, trigger: HTMLButtonElement) => void) | undefined;
  /**
   * RP-5b: where an image's bytes are, when the transcript is not holding
   * them. A blob URL while this window has it decoded, and an honest state
   * when it does not.
   */
  sourceFor?: ((index: number, image: ImageContent) => MessageImageSource) | undefined;
  /**
   * Told where each picture actually is, so the window decodes what a person
   * can see before what they cannot.
   */
  observe?: ((index: number) => (element: HTMLElement | null) => void) | undefined;
}) {
  if (!images.length) return null;
  const many = images.length > 1;
  return <div data-slot="message-images" className="mb-2 flex max-w-full flex-wrap gap-2">
    {images.map((image, index) => {
      const resolved: MessageImageSource = sourceFor?.(index, image)
        ?? (image.data
          ? { src: `data:${image.mimeType};base64,${image.data}`, state: "ready", openable: true }
          : { state: "failed", message: "Not kept in this window", openable: false });
      const frame = many ? "size-28" : "w-full max-w-full sm:w-auto sm:max-w-80";
      const surface = cn("flex flex-col items-center justify-center gap-1.5 rounded-lg border border-line bg-surface-2 p-3 text-center text-xs leading-tight text-ink-2", many ? "size-full" : "min-h-24 w-full");
      return <div key={index} ref={observe?.(index)} data-slot="message-image-tile" className={cn("max-w-full", frame)}>
        {resolved.state === "failed" && resolved.onRetry
          ? <button type="button" data-slot="message-image-retry" aria-label={`Try image ${index + 1} again`} onClick={resolved.onRetry}
              className={cn(surface, "pointer-coarse:min-h-11 outline-none transition-colors duration-(--motion-instant) hover:border-ink-3 hover:text-ink active:opacity-80 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live", many ? "size-full" : "w-full")}>
              <ImageOff className="size-4 shrink-0" aria-hidden="true" />
              <span data-slot="message-image-placeholder" role="status" className="max-w-full">{resolved.message}</span>
              <span className="inline-flex items-center gap-1 text-ink"><RotateCw className="size-3 shrink-0" aria-hidden="true" />Try again</span>
            </button>
          : <button type="button" aria-label={`Open Image ${index + 1}`} disabled={!onOpen || !resolved.openable} onClick={event => onOpen?.(index, event.currentTarget)}
              className={cn("max-w-full overflow-hidden rounded-lg pointer-coarse:min-h-11 pointer-coarse:min-w-11 outline-none hover:opacity-90 active:opacity-80 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live disabled:opacity-70", many ? "size-full" : "block w-full max-w-full")}>
              {resolved.src
                ? <img data-slot="message-image" src={resolved.src} alt={`Image ${index + 1}`} className={many ? "size-full object-cover" : "max-h-60 w-full max-w-full object-contain sm:w-auto"} />
                : <span data-slot="message-image-placeholder" role="status" className={surface}>
                    <ImageIcon className="size-4 shrink-0" aria-hidden="true" />
                    {resolved.message ?? "Loading image…"}
                  </span>}
            </button>}
      </div>;
    })}
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
