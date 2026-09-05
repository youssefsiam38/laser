"use client";
/**
 * File (`file`): a file message part — icon by MIME type, name, size when it
 * can be known, and a download when the data is reachable. Registry copy with
 * the tokens mapped: `--surface-2` ground, `--line` hairline, `--ink-3` icon.
 */
import type { FileMessagePartComponent } from "@assistant-ui/react";
import { cva, type VariantProps } from "class-variance-authority";
import { Braces, Download, File as FileIcon, FileText, Image as ImageIcon, Music, Video } from "lucide-react";
import { memo, type ComponentProps, type FC } from "react";

import { cn } from "@/lib/utils";

const fileVariants = cva("inline-flex items-center gap-3 rounded-lg transition-colors duration-(--motion-instant)", {
  variants: {
    variant: {
      outline: "border border-line hover:bg-surface-2",
      ghost: "hover:bg-surface-2",
      muted: "bg-surface-2",
    },
    size: {
      sm: "px-2.5 py-1.5 text-xs",
      default: "px-3 py-2 text-sm",
      lg: "px-4 py-3 text-base",
    },
  },
  defaultVariants: { variant: "outline", size: "default" },
});

function getMimeTypeIcon(mimeType: string): FC<{ className?: string }> {
  const type = mimeType.toLowerCase();
  if (type.startsWith("image/")) return ImageIcon;
  if (type === "application/pdf") return FileText;
  if (type === "application/json") return Braces;
  if (type.startsWith("text/")) return FileText;
  if (type.startsWith("audio/")) return Music;
  if (type.startsWith("video/")) return Video;
  return FileIcon;
}

export type FileDataKind = "data-uri" | "url" | "base64" | "id";

function getFileDataKind(data: string, sourceType?: "url" | "id"): FileDataKind {
  if (sourceType === "url" && /^data:/i.test(data)) return "data-uri";
  if (sourceType) return sourceType;
  if (/^data:/i.test(data)) return "data-uri";
  if (/^https?:\/\//i.test(data)) return "url";
  return "base64";
}

function getBase64Size(base64: string): number {
  const commaIndex = base64.indexOf(",");
  const base64Data = commaIndex >= 0 ? base64.slice(commaIndex + 1) : base64;
  const padding = (base64Data.match(/=/g) || []).length;
  return Math.floor((base64Data.length * 3) / 4) - padding;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type FileRootProps = ComponentProps<"div"> & VariantProps<typeof fileVariants>;

function FileRoot({ className, variant, size, children, ...props }: FileRootProps) {
  return (
    <div data-slot="file-root" data-variant={variant} data-size={size} className={cn(fileVariants({ variant, size, className }))} {...props}>
      {children}
    </div>
  );
}

function FileIconDisplay({ mimeType, className, children, ...props }: ComponentProps<"span"> & { mimeType?: string }) {
  const Icon = mimeType ? getMimeTypeIcon(mimeType) : FileIcon;
  return (
    <span data-slot="file-icon" aria-hidden="true" className={cn("shrink-0 text-ink-3", className)} {...props}>
      {children ?? <Icon className="size-5" />}
    </span>
  );
}

function FileName({ className, children, ...props }: ComponentProps<"span">) {
  return (
    <span data-slot="file-name" className={cn("min-w-0 flex-1 truncate font-medium text-ink", className)} {...props}>
      {children || "Unnamed file"}
    </span>
  );
}

function FileSize({ bytes, className, ...props }: ComponentProps<"span"> & { bytes: number }) {
  return (
    <span data-slot="file-size" className={cn("typed shrink-0 text-ink-3", className)} {...props}>
      {formatFileSize(bytes)}
    </span>
  );
}

type FileDownloadProps = Omit<ComponentProps<"a">, "href"> & {
  data: string;
  mimeType: string;
  filename?: string;
  sourceType?: "url" | "id";
};

function FileDownload({ data, mimeType, filename, sourceType, className, children, ...props }: FileDownloadProps) {
  if (typeof data !== "string") return null;
  const kind = getFileDataKind(data, sourceType);
  if (kind === "id") return null;
  if (kind === "url" && !/^(https?:\/\/|blob:)/i.test(data)) return null;
  const href = kind === "base64" ? `data:${mimeType};base64,${data}` : data;
  return (
    <a
      data-slot="file-download"
      href={href}
      download={filename || "download"}
      aria-label={`Download ${filename || "file"}`}
      {...(kind === "url" && { target: "_blank", rel: "noopener noreferrer" })}
      className={cn(
        "shrink-0 rounded-md p-1 text-ink-3 outline-none transition-colors duration-(--motion-instant) hover:bg-surface-2 hover:text-ink",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
        className,
      )}
      {...props}
    >
      {children || <Download className="size-4" />}
    </a>
  );
}

const FileImpl: FileMessagePartComponent = ({ filename, data, mimeType, sourceType }) => {
  const kind = getFileDataKind(data, sourceType);
  const showSize = typeof data === "string" && (kind === "base64" || kind === "data-uri");
  return (
    <FileRoot>
      <FileIconDisplay mimeType={mimeType} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <FileName>{filename}</FileName>
        {showSize ? <FileSize bytes={getBase64Size(data)} /> : null}
      </div>
      <FileDownload data={data} mimeType={mimeType} {...(filename !== undefined && { filename })} {...(sourceType !== undefined && { sourceType })} />
    </FileRoot>
  );
};

const File = memo(FileImpl) as unknown as FileMessagePartComponent & {
  Root: typeof FileRoot;
  Icon: typeof FileIconDisplay;
  Name: typeof FileName;
  Size: typeof FileSize;
  Download: typeof FileDownload;
};
File.displayName = "File";
File.Root = FileRoot;
File.Icon = FileIconDisplay;
File.Name = FileName;
File.Size = FileSize;
File.Download = FileDownload;

export { File, FileRoot, FileIconDisplay, FileName, FileSize, FileDownload, fileVariants, getMimeTypeIcon, getFileDataKind, getBase64Size, formatFileSize };
