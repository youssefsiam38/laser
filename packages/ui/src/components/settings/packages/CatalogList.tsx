"use client";
/**
 * "Find more": the extensions a person can install, as cards. The curated
 * list when nothing is typed, a live registry search otherwise. A card shows
 * the name, one sentence, the newest version — which is exactly what an
 * install will pin — and one verb. Installed ones say so instead of offering
 * a second install (R2).
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { Check, Download, ExternalLink, Loader2, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/format";
import { cn } from "@/lib/utils";
import type { PackageCatalogEntry } from "@lasercode/protocol";

import type { BusyKey } from "./model.js";

export interface CatalogListProps {
  entries: readonly PackageCatalogEntry[];
  busy: BusyKey | undefined;
  /** Installing is hidden, not disabled, when this machine cannot install (R2). */
  canInstall: boolean;
  onInstall: (entry: PackageCatalogEntry) => void;
}

export function CatalogList({ entries, busy, canInstall, onInstall }: CatalogListProps) {
  return (
    <ul className="grid gap-2 sm:grid-cols-2" aria-label="Extensions you can install">
      {entries.map((entry) => {
        const installing = busy === `install:${entry.name}`;
        const installed = entry.installed;
        return (
          <li key={entry.name} className="flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-surface px-3 py-2.5">
            <div className="flex min-w-0 items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="typed truncate text-ink" title={entry.name}>
                    {entry.name}
                  </span>
                  {entry.curated && (
                    <Badge variant="outline" className="gap-1" title={`Recommended by ${PRODUCT_NAME}`}>
                      <Sparkles /> recommended
                    </Badge>
                  )}
                </div>
                {entry.description && <p className="mt-0.5 line-clamp-3 text-xs leading-4 text-ink-2">{entry.description}</p>}
              </div>
              {entry.homepage && (
                <a
                  href={entry.homepage}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={`About ${entry.name}`}
                  className={cn(
                    "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 outline-none",
                    "hover:bg-surface-2 hover:text-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
                  )}
                >
                  <ExternalLink className="size-3.5" />
                </a>
              )}
            </div>
            <div className="mt-auto flex flex-wrap items-center gap-2">
              {entry.version ? (
                <Badge variant="mono" title="The version that will be installed">
                  {entry.version}
                </Badge>
              ) : (
                <span className="text-xs text-ink-3">version unknown until the registry answers</span>
              )}
              {entry.publishedAt && <span className="tnum text-xs text-ink-3">updated {relativeTime(entry.publishedAt)}</span>}
              <span className="ms-auto">
                {installed ? (
                  <Badge variant="ok" className="gap-1" title={installed.version ? `Installed ${installed.version}` : "Installed"}>
                    <Check /> installed{installed.version ? ` ${installed.version}` : ""}
                  </Badge>
                ) : canInstall ? (
                  <Button size="sm" disabled={busy !== undefined || !entry.version} onClick={() => onInstall(entry)}>
                    {installing ? <Loader2 className="motion-safe:animate-busy" /> : <Download />} Install
                  </Button>
                ) : null}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
