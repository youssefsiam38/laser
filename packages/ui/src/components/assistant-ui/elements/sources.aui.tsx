"use client";
/**
 * `sources` (assistant-ui registry), restyled: the `source` message-part
 * renderer — web-access sources under an answer (docs/ux-elements.md
 * "Sources"). Registered in the transcript's part switch for `source` parts.
 *
 * Divergences from the registry copy: the cva of eight tinted variants is
 * gone (one chip, tokens); the favicon is opt-in via `faviconUrl` and off by
 * default, because fetching `icons.duckduckgo.com/<domain>` for every domain
 * the agent read tells a third party what was read; titles are text only.
 */
import type { SourceMessagePartComponent } from "@assistant-ui/react";
import { ExternalLink, FileText } from "lucide-react";
import { memo, useState, type ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { mono } from "./surfaces.js";

const extractDomain = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const chip = cn(
  "inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-line bg-surface px-2 text-xs text-ink-2 outline-none",
  "transition-colors duration-(--motion-instant) [a&]:hover:bg-surface-2 [a&]:hover:text-ink",
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
);

function SourceIcon({
  url,
  faviconUrl,
  className,
  ...props
}: ComponentProps<"span"> & { url: string; faviconUrl?: ((domain: string) => string) | undefined }) {
  const domain = extractDomain(url);
  const src = faviconUrl?.(domain);
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return <img data-slot="source-icon" src={src} alt="" className={cn("size-3 shrink-0 rounded-sm", className)} onError={() => setFailed(true)} />;
  }
  return (
    <span
      data-slot="source-icon-fallback"
      aria-hidden="true"
      className={cn(mono, "flex size-3.5 shrink-0 items-center justify-center rounded-sm bg-surface-2 text-ink-3", className)}
      {...props}
    >
      {domain.charAt(0).toUpperCase() || "?"}
    </span>
  );
}

function SourceTitle({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="source-title" className={cn("min-w-0 max-w-[24ch] truncate", className)} {...props} />;
}

export type SourceProps = ComponentProps<"a">;

function Source({ className, target = "_blank", rel = "noopener noreferrer", ...props }: SourceProps) {
  return <a data-slot="source" className={cn(chip, className)} target={target} rel={rel} {...props} />;
}

const SourcesImpl: SourceMessagePartComponent = (part) => {
  if (part.sourceType === "url" && part.url) {
    const domain = extractDomain(part.url);
    return (
      <Source href={part.url} title={part.url}>
        <SourceIcon url={part.url} />
        <SourceTitle>{part.title || domain}</SourceTitle>
        <ExternalLink aria-hidden="true" className="size-3 shrink-0 text-ink-3" />
      </Source>
    );
  }
  if (part.sourceType === "document") {
    return (
      <span data-slot="source" className={chip} title={part.title}>
        <FileText aria-hidden="true" className="size-3 shrink-0 text-ink-3" />
        <SourceTitle>{part.title}</SourceTitle>
      </span>
    );
  }
  return null;
};

const Sources = memo(SourcesImpl) as unknown as SourceMessagePartComponent & {
  Root: typeof Source;
  Icon: typeof SourceIcon;
  Title: typeof SourceTitle;
};
Sources.displayName = "Sources";
Sources.Root = Source;
Sources.Icon = SourceIcon;
Sources.Title = SourceTitle;

export { Sources, Source, SourceIcon, SourceTitle };
