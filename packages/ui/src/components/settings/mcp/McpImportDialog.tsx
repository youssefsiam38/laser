"use client";
/**
 * Importing (docs/mcp.md "Importing"): the servers other tools left on this
 * machine, listed per source with the file they came from. Nothing is read
 * without the person choosing it, and nothing is ever written back to those
 * files.
 */
import type { McpImportSource, McpScope, McpServerState } from "@lasercode/protocol";
import { Download, FolderInput } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SettingsSwitch } from "@/components/assistant-ui/elements/settings-panel";
import { useLaserStable } from "@/runtime";

import { ScopeChoice } from "./McpServerForm.js";
import { scopeLabel, transportSummary } from "./model.js";

/** How many servers were found, and where, in one sentence. */
export function importSummary(sources: readonly McpImportSource[]): string | undefined {
  const found = sources.filter((source) => source.servers.length > 0);
  if (!found.length) return undefined;
  const count = found.reduce((total, source) => total + source.servers.length, 0);
  const names = found.map((source) => source.label);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
  return `Found ${count} ${count === 1 ? "server" : "servers"} configured for ${list}.`;
}

export function McpImportBanner({ sources, onOpen }: { sources: readonly McpImportSource[]; onOpen: () => void }) {
  const summary = importSummary(sources);
  if (!summary) return null;
  return (
    <section
      data-slot="mcp-import-banner"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3"
    >
      <p className="flex min-w-0 items-center gap-2 text-sm leading-6 text-ink-2">
        <FolderInput aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
        {summary}
      </p>
      <Button type="button" size="sm" variant="secondary" onClick={onOpen}>
        Import
      </Button>
    </section>
  );
}

export function McpImportDialog({
  cwd,
  open,
  onOpenChange,
  sources,
  defaultScope = "global",
  allowProject = true,
  onImported,
}: {
  cwd: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: readonly McpImportSource[];
  defaultScope?: McpScope;
  allowProject?: boolean;
  onImported: (servers: McpServerState[], imported: string[]) => void;
}) {
  const { client } = useLaserStable();
  const available = useMemo(() => sources.filter((source) => source.servers.length > 0), [sources]);
  const [sourceId, setSourceId] = useState<string>();
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [scope, setScope] = useState<McpScope>(defaultScope);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setSourceId(available[0]?.id);
    setChosen(new Set());
    setScope(defaultScope);
    setReplace(false);
    setError(undefined);
  }, [open, available, defaultScope]);

  const source = available.find((entry) => entry.id === sourceId) ?? available[0];
  const importable = (source?.servers ?? []).filter((server) => !server.unsupported);
  const conflicting = importable.some((server) => chosen.has(server.name) && server.conflicts.includes(scope));

  const toggle = (name: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(name);
    else next.delete(name);
    setChosen(next);
  };

  const apply = async () => {
    if (!source || !chosen.size) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await client.request("mcp/import/apply", {
        cwd,
        source: source.id,
        names: [...chosen],
        scope,
        ...(replace ? { replace: true } : {}),
      });
      onImported(result.servers, result.imported);
      onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };


  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* One bounded, scrolling body: the source picker, the list, the scope
          and the replace switch all live inside it, so nothing is stranded
          above the fold on a short screen. */}
      <DialogContent data-slot="mcp-import-dialog" className="flex max-h-[90dvh] min-h-0 flex-col sm:max-w-160">
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex min-w-0 flex-col gap-4 pe-3">
            <DialogHeader>
              <DialogTitle>Import servers</DialogTitle>
              <DialogDescription>
                Copied into your own configuration. The files they came from are left exactly as they are.
              </DialogDescription>
            </DialogHeader>

            {available.length > 1 && (
              <div role="group" aria-label="Where they came from" className="flex flex-wrap items-center gap-1 rounded-lg bg-surface-2 p-0.5">
                {available.map((entry) => (
                  <Button
                    key={entry.id}
                    type="button"
                    aria-pressed={entry.id === source?.id}
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSourceId(entry.id);
                      setChosen(new Set());
                    }}
                    className={entry.id === source?.id ? "bg-surface text-ink" : undefined}
                  >
                    {entry.label}
                  </Button>
                ))}
              </div>
            )}

            {source && (
              <>
                <p className="typed truncate text-ink-3" title={source.path}>
                  {source.path}
                </p>
                <ul className="flex flex-col gap-2">
                    {source.servers.map((server) => {
                      const transport = transportSummary(server.config.transport);
                      const summary = transport ? `${transport.text} · ${transport.kind}` : "Switches the server off";
                      const disabled = Boolean(server.unsupported);
                      return (
                        <li
                          key={server.name}
                          data-slot="mcp-import-row"
                          data-server={server.name}
                          className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3"
                        >
                          <span className="flex min-w-0 flex-1 flex-col gap-1">
                            <span className="flex min-w-0 flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium text-ink">{server.name}</span>
                              {server.conflicts.map((conflict) => (
                                <Badge key={conflict} variant="attention">
                                  already in {scopeLabel(conflict)}
                                </Badge>
                              ))}
                              {server.inlineSecrets.length > 0 && <Badge variant="outline">secret moved</Badge>}
                            </span>
                            <span className="typed truncate text-ink-2" title={transport?.full ?? summary}>
                              {summary}
                            </span>
                            {server.inlineSecrets.length > 0 && (
                              <span className="text-xs leading-5 text-ink-3">
                                Its {server.inlineSecrets.join(", ")} will be kept in the app’s secret store, out of the configuration file.
                              </span>
                            )}
                            {server.unsupported && <span className="text-xs leading-5 text-attention">Cannot be imported: {server.unsupported}</span>}
                          </span>
                          <input
                            type="checkbox"
                            aria-label={`Import ${server.name}`}
                            disabled={disabled}
                            checked={chosen.has(server.name)}
                            onChange={(event) => toggle(server.name, event.currentTarget.checked)}
                            className="mt-1 size-4 shrink-0 accent-(--live) outline-none disabled:opacity-45"
                          />
                        </li>
                      );
                    })}
                </ul>
              </>
            )}

            <ScopeChoice scope={scope} onChange={setScope} allowProject={allowProject} label="Import into" />

            {conflicting && (
              <div className="flex items-start gap-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm text-ink">Replace the servers of the same name</span>
                  <span className="text-xs leading-5 text-ink-3">Off means those are skipped and the rest are imported.</span>
                </span>
                <SettingsSwitch checked={replace} aria-label="Replace the servers of the same name" onCheckedChange={setReplace} />
              </div>
            )}

            {error && (
              <p role="alert" className="text-sm leading-6 text-danger">
                {error}
              </p>
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={busy || !chosen.size} onClick={() => void apply()}>
            <Download aria-hidden="true" /> Import {chosen.size ? `${chosen.size} ` : ""}
            {chosen.size === 1 ? "server" : "servers"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
