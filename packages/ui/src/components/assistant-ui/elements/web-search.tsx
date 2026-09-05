"use client";
/**
 * `elements-web-search` (assistant-ui registry), de-demoed and restyled:
 * `pi-web-access` results as a `collection` panel (M8-T4, docs/ux-elements.md
 * "Web search").
 *
 * The registry copy takes `visibleResults`/`cycle` (a demo's typewriter) and
 * hard-codes "Read 3 sources". Here the results are a `CollectionPanel`'s
 * items — `primary` is the title, `secondary` the URL or domain, `ref` opens
 * the page as a document — and the count is real. `searching` is true while
 * the producing tool call is still running. Domains draw as a letter, never
 * a fetched favicon (a diagram of what the agent read must not phone home).
 */
import type { CollectionItem, CollectionPanel } from "@piorbit/protocol";
import { ExternalLink, Search } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { field, mono, ShimmerLabel } from "./surfaces.js";

export interface WebSearchProps extends Omit<ComponentProps<"div">, "children"> {
  panel: CollectionPanel;
  /** The producing tool call is still running. */
  searching?: boolean | undefined;
  /** Open an item's ref as a document panel. */
  onOpenRef?: ((ref: string, label: string) => void) | undefined;
}

/** `https://www.example.com/a/b` → `example.com`; anything else unchanged. */
export function domainOf(value: string | undefined): string {
  if (!value) return "";
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

const isHttp = (value: string | undefined): value is string => value !== undefined && /^https?:\/\//i.test(value);

export function WebSearch({ panel, searching = false, onOpenRef, className, ...props }: WebSearchProps) {
  const total = panel.total ?? panel.items.length;
  return (
    <div data-slot="web-search" className={cn("flex w-full min-w-0 flex-col gap-2.5", className)} {...props}>
      <span className={cn(field, "inline-flex w-fit max-w-full items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-ink")}>
        <Search aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
        <span className="min-w-0 truncate" title={panel.title}>
          {panel.title}
        </span>
      </span>
      <div className="text-sm text-ink-3" role="status">
        {searching ? (
          <ShimmerLabel className="relative inline-block leading-none">Searching</ShimmerLabel>
        ) : total === 0 ? (
          "Nothing found."
        ) : (
          `Read ${total} ${total === 1 ? "source" : "sources"}${total > panel.items.length ? `, showing ${panel.items.length}` : ""}`
        )}
      </div>
      {panel.items.length > 0 ? (
        <ul role="list" className="flex flex-col">
          {panel.items.map((item) => (
            <Result key={item.id} item={item} onOpenRef={onOpenRef} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Result({ item, onOpenRef }: { item: CollectionItem; onOpenRef: WebSearchProps["onOpenRef"] }) {
  const domain = domainOf(item.secondary);
  const opens = item.ref !== undefined && onOpenRef !== undefined;
  const external = !opens && isHttp(item.secondary) ? item.secondary : undefined;
  const Row = opens ? "button" : external ? "a" : "div";
  const rowProps =
    Row === "button"
      ? { type: "button" as const, onClick: () => onOpenRef?.(item.ref!, item.primary) }
      : Row === "a"
        ? { href: external, target: "_blank", rel: "noopener noreferrer" }
        : {};
  return (
    <li>
      <Row
        {...rowProps}
        className={cn(
          "-mx-2 flex h-8 w-[calc(100%+var(--spacing)*4)] min-w-0 items-center gap-2.5 rounded-md px-2 text-start outline-none",
          Row !== "div" &&
            "transition-colors duration-(--motion-instant) hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-live",
        )}
        title={item.secondary}
      >
        <span aria-hidden="true" className={cn(mono, "flex size-4 shrink-0 items-center justify-center rounded-sm bg-surface-2 text-ink-3")}>
          {domain.charAt(0).toUpperCase() || "?"}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-ink" title={item.primary}>
          {item.primary}
        </span>
        {domain ? (
          <span className={cn(mono, "shrink-0 max-w-[12ch] truncate text-ink-3")} title={domain}>
            {domain}
          </span>
        ) : null}
        {Row === "a" ? <ExternalLink aria-hidden="true" className="size-3 shrink-0 text-ink-3" /> : null}
      </Row>
    </li>
  );
}
