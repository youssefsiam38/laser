"use client";
/**
 * Server panel (`elements-mcp-server-panel`): one row per MCP server a project
 * can use — what it is, whether it works, and how much of it the model sees
 * (docs/ux-elements.md "Server panel", docs/mcp.md "The list"). Mounted by
 * `settings/mcp/McpServerList.tsx` from `mcp/list`.
 *
 * Divergences from the registry copy, each on purpose:
 *   - Fed from the protocol, not from demo props: `rows` carry the status in
 *     the protocol's seven words rendered for a person, the tool count with
 *     how many are direct, the scope, and the sentence `shadowed` /
 *     `overridesGlobal` need. The registry's four hard-coded statuses and its
 *     `tools: string[]` chip cloud are gone — a row is a way into the
 *     inspector, which is where the tools live.
 *   - Tokens throughout: `--live` / `--attention` / `--danger` through the
 *     shared `StatusDot`, never `bg-emerald-500`; `typed` (12px) instead of
 *     the catalog's 11px monospace, which is under the legibility floor.
 *   - A row is a real button with hover, focus and pressed states, a title
 *     carrying the values it had to truncate, and a 44px target on touch.
 *   - The sign-in affordance stays: a server whose row says "Needs sign-in"
 *     offers it inline rather than making the person open the inspector.
 */
import { ChevronRight, Plug } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { pressable } from "./surfaces.js";

export type McpServerPanelTone = "live" | "attention" | "danger" | "muted" | "quiet";

export interface McpServerPanelRow {
  /** Unique across both scopes: `<scope>:<name>`. */
  id: string;
  /** The label when the person set one, otherwise the name. */
  name: string;
  /** `npx @playwright/mcp`, `mcp.context7.com`, `…/memory.sock`. */
  transport: string;
  /** Command · HTTP · Socket. */
  transportKind: string;
  /** The whole command line or URL, for the title. */
  transportFull: string;
  statusLabel: string;
  statusHelp: string;
  tone: McpServerPanelTone;
  /** The status is being established right now. */
  working?: boolean | undefined;
  /** "24 tools · 24 direct". */
  tools?: string | undefined;
  scope: string;
  /** What `shadowed` / `overridesGlobal` mean here. */
  note?: string | undefined;
  /** The server's own message when it failed or needs attention. */
  detail?: string | undefined;
  needsAuth?: boolean | undefined;
  dimmed?: boolean | undefined;
}

const TONE_DOT: Record<McpServerPanelTone, string> = {
  live: "bg-live",
  attention: "bg-attention",
  danger: "bg-danger",
  quiet: "bg-ink-3",
  muted: "bg-line",
};

const TONE_TEXT: Record<McpServerPanelTone, string> = {
  live: "text-live",
  attention: "text-attention",
  danger: "text-danger",
  quiet: "text-ink-2",
  muted: "text-ink-3",
};

export interface McpServerPanelProps extends Omit<ComponentProps<"div">, "children" | "onSelect"> {
  rows: readonly McpServerPanelRow[];
  /** The row the inspector is open on. */
  selectedId?: string | undefined;
  onSelect?: ((id: string) => void) | undefined;
  onSignIn?: ((id: string) => void) | undefined;
  /** Drawn above the rows: "This project", "Every project". */
  heading?: ReactNode;
}

export function McpServerPanel({ rows, selectedId, onSelect, onSignIn, heading, className, ...props }: McpServerPanelProps) {
  return (
    <div data-slot="mcp-server-panel" className={cn("flex min-w-0 flex-col gap-2", className)} {...props}>
      {heading !== undefined && <div className="eyebrow px-1 text-ink-3">{heading}</div>}
      <ul className="flex min-w-0 flex-col gap-1.5">
        {rows.map((row) => (
          <li key={row.id} className="min-w-0">
            <div
              data-slot="mcp-server-row"
              data-server={row.id}
              data-status={row.statusLabel}
              className={cn(
                "group flex min-w-0 items-stretch rounded-xl border border-line bg-surface",
                "transition-colors duration-(--motion-fast)",
                selectedId === row.id && "border-live",
                row.dimmed && "opacity-80",
              )}
            >
              <button
                type="button"
                onClick={() => onSelect?.(row.id)}
                aria-current={selectedId === row.id ? "true" : undefined}
                title={`${row.name} · ${row.transportFull} · ${row.statusLabel}. ${row.statusHelp}`}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-start outline-none",
                  "min-h-11 transition-colors duration-(--motion-fast) hover:bg-surface-2",
                  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
                  pressable,
                )}
              >
                <Plug aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{row.name}</span>
                    <Badge variant="outline" className="shrink-0">{row.scope}</Badge>
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="typed min-w-0 truncate text-ink-2">{row.transport}</span>
                    <span className="text-xs text-ink-3">· {row.transportKind}</span>
                    {row.tools && <span className="tnum text-xs text-ink-3">· {row.tools}</span>}
                  </span>
                  {row.note && <span className="text-xs leading-5 text-ink-3">{row.note}</span>}
                  {row.detail && <span className="text-xs leading-5 text-ink-2">{row.detail}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 rounded-full",
                      TONE_DOT[row.tone],
                      row.working && "motion-safe:animate-attention",
                    )}
                  />
                  <span className={cn("text-xs font-medium", TONE_TEXT[row.tone])}>{row.statusLabel}</span>
                  <ChevronRight aria-hidden="true" className="size-4 text-ink-3" />
                </span>
              </button>
              {row.needsAuth && onSignIn && (
                <span className="flex items-center pe-2">
                  <Button type="button" size="sm" variant="secondary" onClick={() => onSignIn(row.id)}>
                    Sign in
                  </Button>
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
