"use client";
/**
 * Image (`image`): an image message part — preview with a loading and a
 * failed state, click to zoom, download and copy. Registry copy with the
 * tokens mapped and the spinner replaced by the app's working dot.
 */
import type { ImageMessagePart, ImageMessagePartComponent } from "@assistant-ui/react";
import { cva, type VariantProps } from "class-variance-authority";
import { Copy, Download, Image as ImageIcon, ImageOff, ShieldAlert, X } from "lucide-react";
import { memo, useCallback, useContext, useEffect, useRef, useState, type ComponentProps, type PropsWithChildren } from "react";
import { createPortal } from "react-dom";

import { StatusDot } from "@/components/status";
import { FileViewer } from "@/components/thread/FileViewer";
import { FileLinkDirectory } from "@/components/ui/source-file-link";
import { projectReferencePath, useProjectFile } from "@/components/ui/project-file-link";
import { cn } from "@/lib/utils";

const extensionForMimeType = (mimeType?: string): string => {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    default:
      return "png";
  }
};

const dataUriToBlob = (dataUri: string): Blob => {
  const commaIndex = dataUri.indexOf(",");
  const meta = commaIndex >= 0 ? dataUri.slice(0, commaIndex) : dataUri;
  const data = commaIndex >= 0 ? dataUri.slice(commaIndex + 1) : "";
  const mime = meta.match(/data:([^;]+)/i)?.[1]?.toLowerCase() ?? "application/octet-stream";
  if (!/;base64/i.test(meta)) {
    const text = data.replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq;
      }
    });
    return new Blob([text], { type: mime });
  }
  const bytes = atob(data);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
};

const mimeFromImage = (image: string): string | undefined => image.match(/^data:([^;,]+)/i)?.[1]?.toLowerCase();

const downloadImagePart = (part: Pick<ImageMessagePart, "image" | "filename">): void => {
  if (typeof document === "undefined") return;
  const ext = extensionForMimeType(mimeFromImage(part.image));
  const filename = part.filename ?? `image.${ext}`;
  const isDataUri = /^data:/i.test(part.image);
  const objectUrl = isDataUri ? URL.createObjectURL(dataUriToBlob(part.image)) : null;
  const a = document.createElement("a");
  a.href = objectUrl ?? part.image;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 40_000);
};

const copyImagePart = async (part: Pick<ImageMessagePart, "image">): Promise<void> => {
  if (typeof navigator === "undefined" || !navigator.clipboard || typeof ClipboardItem === "undefined") {
    throw new Error("The clipboard is not available here.");
  }
  const blob = /^data:/i.test(part.image) ? dataUriToBlob(part.image) : await fetch(part.image).then((r) => r.blob());
  const mime = mimeFromImage(part.image) ?? blob.type ?? "image/png";
  await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
};

const imageVariants = cva("relative overflow-hidden rounded-lg", {
  variants: {
    variant: { outline: "border border-line", ghost: "", muted: "bg-surface-2" },
    size: { sm: "max-w-64", default: "max-w-96", lg: "max-w-lg", full: "w-full" },
  },
  defaultVariants: { variant: "outline", size: "default" },
});

export type ImageRootProps = ComponentProps<"div"> & VariantProps<typeof imageVariants>;

function ImageRoot({ className, variant, size, children, ...props }: ImageRootProps) {
  return (
    <div data-slot="image-root" data-variant={variant} data-size={size} className={cn(imageVariants({ variant, size, className }))} {...props}>
      {children}
    </div>
  );
}

type ImagePreviewProps = Omit<ComponentProps<"img">, "children"> & { containerClassName?: string };

function ImagePreview({ className, containerClassName, onLoad, onError, alt = "Image", src, ...props }: ImagePreviewProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | undefined>(undefined);
  const [errorSrc, setErrorSrc] = useState<string | undefined>(undefined);
  const loaded = loadedSrc === src;
  const error = errorSrc === src;

  useEffect(() => {
    const image = imgRef.current;
    if (typeof src !== "string" || !image?.complete) return;
    if (image.naturalWidth > 0) setLoadedSrc(src);
    else setErrorSrc(src);
  }, [src]);

  return (
    <div data-slot="image-preview" className={cn("relative min-h-32", containerClassName)}>
      {!loaded && !error ? (
        <div data-slot="image-preview-loading" role="status" aria-label="Loading image" className="absolute inset-0 flex items-center justify-center bg-surface-2">
          <ImageIcon aria-hidden="true" className="size-8 text-ink-3" />
        </div>
      ) : null}
      {error ? (
        <div data-slot="image-preview-error" role="img" aria-label="Image could not be loaded" className="flex min-h-32 items-center justify-center bg-surface-2 p-4">
          <ImageOff aria-hidden="true" className="size-8 text-ink-3" />
        </div>
      ) : (
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          className={cn("block h-auto w-full object-contain", !loaded && "invisible", className)}
          onLoad={(e) => {
            if (typeof src === "string") setLoadedSrc(src);
            onLoad?.(e);
          }}
          onError={(e) => {
            if (typeof src === "string") setErrorSrc(src);
            onError?.(e);
          }}
          {...props}
        />
      )}
    </div>
  );
}

function ImageFilename({ className, children, ...props }: ComponentProps<"span">) {
  if (!children) return null;
  return (
    <span data-slot="image-filename" className={cn("block truncate px-2 py-1.5 text-xs text-ink-3", className)} {...props}>
      {children}
    </span>
  );
}

function ImageZoom({ src, alt = "Image preview", children }: PropsWithChildren<{ src: string; alt?: string }>) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const handleOpen = useCallback(() => setIsOpen(true), []);
  const handleClose = useCallback(() => {
    setIsOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = overlayRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
      const first = focusables?.[0];
      const last = focusables?.[focusables.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    closeRef.current?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, handleClose]);

  return (
    <>
      <div
        ref={triggerRef}
        onClick={handleOpen}
        onKeyDown={(e) => e.key === "Enter" && handleOpen()}
        role="button"
        tabIndex={0}
        className="cursor-zoom-in outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
        aria-label="Zoom image"
      >
        {children}
      </div>
      {isOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={overlayRef}
              data-slot="image-zoom-overlay"
              role="dialog"
              aria-modal="true"
              aria-label="Zoomed image"
              className="fixed inset-0 z-50 flex items-center justify-center bg-bg/90 animate-in fade-in-0 duration-(--motion-fast) motion-reduce:animate-none"
              onClick={handleClose}
            >
              <img
                data-slot="image-zoom-content"
                src={src}
                alt={alt}
                className="max-h-[90vh] max-w-[90vw] cursor-zoom-out object-contain animate-in fade-in-0 zoom-in-95 duration-(--motion-fast) motion-reduce:animate-none"
                onClick={(e) => {
                  e.stopPropagation();
                  handleClose();
                }}
              />
              <button
                ref={closeRef}
                type="button"
                aria-label="Close"
                onClick={(e) => {
                  e.stopPropagation();
                  handleClose();
                }}
                className="absolute end-4 top-4 rounded-md bg-surface p-2 text-ink-2 shadow-float-sm outline-none hover:text-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
              >
                <X className="size-5" />
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function ImageGenerating({ className }: { className?: string }) {
  return (
    <div data-slot="image-generating" role="status" aria-label="Generating image" className={cn("flex min-h-32 items-center justify-center bg-surface-2 p-4", className)}>
      <StatusDot status="working" size="md" aria-hidden="true" />
    </div>
  );
}

function ImageContentFilterError({ className, reason }: { className?: string; reason?: string }) {
  return (
    <div data-slot="image-content-filter-error" role="alert" className={cn("flex min-h-32 flex-col items-center justify-center gap-2 bg-surface-2 p-4 text-center", className)}>
      <ShieldAlert aria-hidden="true" className="size-8 text-ink-3" />
      <p className="text-sm font-medium text-ink">The image was not produced</p>
      {reason ? <p className="text-xs text-ink-2">{reason}</p> : null}
    </div>
  );
}

const actionClass =
  "inline-flex size-7 items-center justify-center rounded-md text-ink-3 outline-none transition-colors duration-(--motion-instant) hover:bg-surface-2 hover:text-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live disabled:opacity-45";

function ImageActions({ part, className }: { part: ImageMessagePart; className?: string }) {
  return (
    <div data-slot="image-actions" className={cn("flex items-center gap-1 p-1", className)}>
      <button type="button" onClick={() => downloadImagePart(part)} aria-label="Download image" className={actionClass}>
        <Download className="size-4" />
      </button>
      <button type="button" onClick={() => void copyImagePart(part).catch(() => {})} aria-label="Copy image" className={actionClass}>
        <Copy className="size-4" />
      </button>
    </div>
  );
}

const ImageImpl: ImageMessagePartComponent = (props) => {
  const { image, filename, status } = props;
  if (status?.type === "running") {
    return (
      <ImageRoot>
        <ImageGenerating />
        <ImageFilename>{filename}</ImageFilename>
      </ImageRoot>
    );
  }
  if (status?.type === "incomplete" && status.reason === "content-filter") {
    return (
      <ImageRoot>
        <ImageContentFilterError reason="The provider blocked this image." />
      </ImageRoot>
    );
  }
  return (
    <ImageRoot>
      <ImageZoom src={image} alt={filename || "Image"}>
        <ImagePreview src={image} alt={filename || "Image"} />
      </ImageZoom>
      <ImageFilename>{filename}</ImageFilename>
    </ImageRoot>
  );
};

const Image = memo(ImageImpl) as unknown as ImageMessagePartComponent & {
  Root: typeof ImageRoot;
  Preview: typeof ImagePreview;
  Filename: typeof ImageFilename;
  Zoom: typeof ImageZoom;
  Actions: typeof ImageActions;
  Generating: typeof ImageGenerating;
  ContentFilterError: typeof ImageContentFilterError;
};
Image.displayName = "Image";
Image.Root = ImageRoot;
Image.Preview = ImagePreview;
Image.Filename = ImageFilename;
Image.Zoom = ImageZoom;
Image.Actions = ImageActions;
Image.Generating = ImageGenerating;
Image.ContentFilterError = ImageContentFilterError;

export { Image, ImageRoot, ImagePreview, ImageFilename, ImageZoom, ImageActions, ImageGenerating, ImageContentFilterError, imageVariants };

/** Markdown's project-image form of this element: retained bytes, existing viewer. */
export function ProjectMarkdownImage({ src, alt = "", interactive = true, ...props }: Omit<ComponentProps<"img">, "src"> & { src?: string | undefined; interactive?: boolean }) {
  const cwd = useContext(FileLinkDirectory);
  if (src && /^(?:https?:)?\/\//i.test(src)) return <img {...props} src={src} alt={alt} />;
  const path = projectReferencePath(src ?? "", cwd);
  if (!cwd || !path) return <>{alt}</>;
  return <LocalMarkdownImage key={`${cwd}:${path}`} cwd={cwd} path={path} alt={alt} interactive={interactive} />;
}
function LocalMarkdownImage({ cwd, path, alt, interactive }: { cwd: string; path: string; alt: string; interactive: boolean }) {
  const { file } = useProjectFile(cwd, path, true);
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!file || broken || file.truncated || file.encoding !== "base64" || !file.mediaType.startsWith("image/")) return <>{alt}</>;
  const image = <img data-slot="project-image" src={`data:${file.mediaType};base64,${file.content}`} alt={alt} onError={() => setBroken(true)} className="block max-h-96 max-w-full rounded-lg object-contain" />;
  if (!interactive) return image;
  return <>
    <button ref={trigger} type="button" aria-label={`Open ${alt || file.name}`} onClick={() => setOpen(true)} className="my-2 inline-block max-w-full overflow-hidden rounded-lg align-middle pointer-coarse:min-h-11 pointer-coarse:min-w-11 outline-none hover:opacity-90 active:opacity-80 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live">{image}</button>
    {open ? <FileViewer source={{ request: { cwd, path }, file }} open onOpenChange={setOpen} returnFocus={trigger.current} /> : null}
  </>;
}
