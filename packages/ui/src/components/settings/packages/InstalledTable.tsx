"use client";
/**
 * The installed extensions, as the `data-table` element (docs/ux-elements.md
 * "Data table": "the model catalog and the package list"). One row per
 * configured package: name, the exact version on disk (or pinned), where it
 * applies, and its two verbs. The install path is deliberately not here — it
 * belongs to the diagnostics disclosure on the screen, not to a row a person
 * scans for "which version do I have".
 */
import { ArrowUpCircle, Loader2, Trash2 } from "lucide-react";

import { DataTable, type DataTableColumn } from "@/components/assistant-ui/elements/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { PackageEntry } from "@lasercode/protocol";

import { displayName, originLabel, versionLabel, type BusyKey } from "./model.js";

export interface InstalledTableProps {
  rows: readonly PackageEntry[];
  busy: BusyKey | undefined;
  /** Descriptions for names the catalog knows, so an installed row can say what it does. */
  descriptions: ReadonlyMap<string, string>;
  onUpdate: (entry: PackageEntry) => void;
  onRemove: (entry: PackageEntry) => void;
  emptyMessage: string | undefined;
}

export function InstalledTable({ rows, busy, descriptions, onUpdate, onRemove, emptyMessage }: InstalledTableProps) {
  const anyBusy = busy !== undefined;
  const columns: DataTableColumn<PackageEntry>[] = [
    {
      key: "name",
      label: "Extension",
      render: (entry) => {
        const name = displayName(entry);
        const description = descriptions.get(name);
        return (
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="typed text-ink" title={entry.source}>
                {name}
              </span>
              {entry.filtered && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="default">partly loaded</Badge>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-72">
                    Its settings entry lists which of its tools, skills, prompts or themes to load, instead of everything it
                    ships.
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            {description && <p className="line-clamp-2 text-xs leading-4 text-ink-2">{description}</p>}
          </div>
        );
      },
    },
    {
      key: "version",
      label: "Version",
      width: "10rem",
      render: (entry) => {
        const version = versionLabel(entry);
        const update = entry.updateAvailable ? entry.latestVersion : undefined;
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            {version ? (
              <Badge variant="mono" title={entry.pinnedVersion ? `Pinned to ${entry.pinnedVersion}` : undefined}>
                {version}
              </Badge>
            ) : (
              <span className="text-xs text-ink-3">{originLabel(entry) === "registry" ? "not installed yet" : originLabel(entry)}</span>
            )}
            {update && (
              <Badge variant="attention" className="gap-1" title={`${update} is available`}>
                <ArrowUpCircle /> {update}
              </Badge>
            )}
            {!update && entry.updateAvailable && (
              <Badge variant="attention" className="gap-1">
                <ArrowUpCircle /> update
              </Badge>
            )}
          </div>
        );
      },
    },
    {
      key: "scope",
      label: "Applies to",
      width: "8rem",
      optional: true,
      render: (entry) => (
        <Badge variant={entry.scope === "project" ? "live" : "outline"}>{entry.scope === "project" ? "this project" : "every project"}</Badge>
      ),
    },
    {
      key: "actions",
      label: "Actions",
      align: "end",
      width: "11rem",
      render: (entry) => {
        const updating = busy === `update:${entry.source}` || busy === "update:all";
        const removing = busy === `remove:${entry.source}`;
        return (
          <div className="flex justify-end gap-1">
            <Button variant="ghost" size="sm" disabled={anyBusy} onClick={() => onUpdate(entry)} aria-label={`Update ${displayName(entry)}`}>
              {updating ? <Loader2 className="motion-safe:animate-busy" /> : null} Update
            </Button>
            <Button
              variant="destructive-ghost"
              size="sm"
              disabled={anyBusy}
              onClick={() => onRemove(entry)}
              aria-label={`Remove ${displayName(entry)}`}
            >
              {removing ? <Loader2 className="motion-safe:animate-busy" /> : <Trash2 />} Remove
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <DataTable
      caption="Extensions installed for this project"
      columns={columns}
      rows={rows}
      rowKey={(entry) => `${entry.scope}:${entry.source}`}
      minWidth="36rem"
      emptyMessage={emptyMessage}
    />
  );
}
