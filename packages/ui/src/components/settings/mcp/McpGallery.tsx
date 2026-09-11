"use client";
/**
 * The gallery (docs/mcp.md "Adding" → *From the gallery*): the curated
 * catalog the protocol ships, Playwright first. One card per entry, what it
 * does, what the machine needs and whether it will ask you to sign in. A card
 * is one click into the add dialog with that definition already composed.
 */
import { MCP_KNOWN_SERVERS, type McpCatalogEntry } from "@lasercode/protocol";
import { ExternalLink, KeyRound, Plug } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function McpGallery({ onChoose, className }: { onChoose: (entry: McpCatalogEntry) => void; className?: string }) {
  return (
    <section aria-label="Servers you can add" className={cn("flex flex-col gap-3", className)}>
      <div className="grid gap-3 md:grid-cols-2">
        {MCP_KNOWN_SERVERS.map((entry) => (
          <article
            key={entry.id}
            data-slot="mcp-gallery-card"
            data-entry={entry.id}
            className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-[color-mix(in_oklab,var(--live)_12%,var(--surface))] text-live">
                <Plug aria-hidden="true" className="size-4.5" />
              </div>
              {entry.auth === "oauth" && (
                <Badge variant="outline" title="You will sign in to your account when you first use it.">
                  <KeyRound aria-hidden="true" /> Sign-in
                </Badge>
              )}
            </div>
            <h3 className="mt-3 text-base font-semibold text-ink">{entry.name}</h3>
            <p className="mt-1 text-sm leading-6 text-ink-2">{entry.description}</p>
            {entry.requires && <p className="mt-2 text-xs leading-5 text-ink-3">Needs: {entry.requires}</p>}
            <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
              <Button type="button" size="sm" onClick={() => onChoose(entry)}>
                Add {entry.name}
              </Button>
              <Button asChild variant="ghost" size="sm">
                <a href={entry.homepage} target="_blank" rel="noreferrer noopener">
                  <ExternalLink aria-hidden="true" /> What it does
                </a>
              </Button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
