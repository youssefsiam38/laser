"use client";
/**
 * Settings → MCP servers (docs/mcp.md "The experience"). The page answers the
 * four questions a person has about a server they added: is it running, what
 * can it do, exactly which of those things the model will see, and what
 * happens when a tool is called.
 *
 * Everything here goes through `mcp/*` on the project's worker. The list is
 * the truth; `mcp/changed` says when to read it again.
 */
import { PRODUCT_DISPLAY_NAME, type McpCatalogEntry, type McpImportSource, type McpScope, type McpServerConfig, type McpServerState } from "@lasercode/protocol";
import { Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";

import { McpAddDialog } from "./McpAddDialog.js";
import { McpGallery } from "./McpGallery.js";
import { McpImportBanner, McpImportDialog } from "./McpImportDialog.js";
import { McpInspector } from "./McpInspector.js";
import { McpServerList } from "./McpServerList.js";
import { McpSignInDialog, McpSignOutDialog } from "./McpSignIn.js";
import { rowKey, serverTitle } from "./model.js";

type ScopeFilter = McpScope | "all";

export function McpServersTab({ cwd }: { cwd: string }) {
  const { client, actions } = useLaserStable();
  const [servers, setServers] = useState<McpServerState[]>();
  const [sources, setSources] = useState<McpImportSource[]>([]);
  const [error, setError] = useState<string>();
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [selectedId, setSelectedId] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);
  const [adding, setAdding] = useState<{ entry?: McpCatalogEntry; edit?: { scope: McpScope; config: McpServerConfig } }>();
  const [importing, setImporting] = useState(false);
  const [signIn, setSignIn] = useState<{ scope: McpScope; name: string; title: string }>();
  const [signOut, setSignOut] = useState<{ scope: McpScope; name: string; title: string }>();
  const generation = useRef(0);

  const load = useCallback(async () => {
    const request = ++generation.current;
    setError(undefined);
    try {
      const list = await client.request("mcp/list", { cwd });
      if (request !== generation.current) return;
      setServers(list.servers);
      // Detection is a convenience; a host that cannot do it must not take
      // the page down with it.
      const detected = await client.request("mcp/import/detect", { cwd }).catch(() => ({ sources: [] as McpImportSource[] }));
      if (request !== generation.current) return;
      setSources(detected.sources);
    } catch (failure) {
      if (request === generation.current) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    }
  }, [client, cwd]);

  useEffect(() => {
    setServers(undefined);
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);

  // The worker says when a configuration write or a status change happened.
  useEffect(() => {
    return client.subscribe((method, params) => {
      if (method !== "mcp/changed") return;
      if ((params as { cwd: string }).cwd !== cwd) return;
      setReloadToken((token) => token + 1);
      void load();
    });
  }, [client, cwd, load]);

  const selected = useMemo(
    () => (selectedId ? servers?.find((entry) => rowKey(entry) === selectedId) : undefined),
    [servers, selectedId],
  );

  const shown = useMemo(
    () => (servers ?? []).filter((entry) => scopeFilter === "all" || entry.scope === scopeFilter),
    [servers, scopeFilter],
  );

  const openSignIn = (id: string) => {
    const state = servers?.find((entry) => rowKey(entry) === id);
    if (state) setSignIn({ scope: state.scope, name: state.config.name, title: serverTitle(state.config) });
  };

  if (!servers) {
    return (
      <div className="p-4">
        {error ? (
          <ErrorState title="Could not read this project’s servers" detail={error} onRetry={() => void load()} />
        ) : (
          <GenerationLoader label="Loading servers" />
        )}
      </div>
    );
  }

  const defaultScope: McpScope = scopeFilter === "project" ? "project" : "global";

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-200 flex-col gap-5 px-4 py-5 md:px-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-140">
            <p className="eyebrow text-live">Tools from other programs</p>
            <h2 className="mt-1 text-lg font-semibold text-ink">MCP servers</h2>
            <p className="mt-1 text-sm leading-6 text-ink-2">
              A server brings tools {PRODUCT_DISPLAY_NAME} can use — a browser, a database, an issue tracker. What you change here
              reaches conversations you start afterwards; the one you are in keeps the tools it started with.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={() => setAdding({})}>
              <Plus aria-hidden="true" /> Add a server
            </Button>
            <Button type="button" variant="ghost" size="sm" aria-label="Reload servers" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" />
            </Button>
          </div>
        </header>

        {error && (
          <p role="alert" className="text-sm leading-6 text-danger">
            {error}
          </p>
        )}

        <McpImportBanner sources={sources} onOpen={() => setImporting(true)} />

        {servers.length > 0 && (
          <div role="tablist" aria-label="Which servers to show" className="flex w-fit items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
            {(
              [
                { id: "all" as const, label: "All" },
                { id: "global" as const, label: "Every project" },
                { id: "project" as const, label: "This project" },
              ]
            ).map((option) => (
              <Button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={scopeFilter === option.id}
                variant="ghost"
                size="sm"
                onClick={() => setScopeFilter(option.id)}
                className={cn(scopeFilter === option.id && "bg-surface text-ink")}
              >
                {option.label}
              </Button>
            ))}
          </div>
        )}

        {servers.length === 0 ? (
          <section className="flex flex-col gap-4">
            <div>
              <h3 className="text-base font-semibold text-ink">Nothing yet — start with one of these</h3>
              <p className="mt-1 text-sm leading-6 text-ink-2">
                Each one is a tested definition. Pick it, test it, and it is yours; or set one up yourself.
              </p>
            </div>
            <McpGallery onChoose={(entry) => setAdding({ entry })} />
          </section>
        ) : shown.length === 0 ? (
          <p className="text-sm leading-6 text-ink-2">
            No server is saved for {scopeFilter === "project" ? "this project" : "every project"}. Add one, or look at All.
          </p>
        ) : (
          <McpServerList servers={shown} selectedId={selectedId} onSelect={setSelectedId} onSignIn={openSignIn} />
        )}

        {servers.length > 0 && (
          <Collapsible className="mt-2">
            <CollapsibleTrigger className="text-start text-sm text-live underline-offset-4 hover:underline">
              Add another from the gallery
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-4">
              <McpGallery onChoose={(entry) => setAdding({ entry })} />
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>

      <McpAddDialog
        cwd={cwd}
        open={Boolean(adding)}
        onOpenChange={(open) => !open && setAdding(undefined)}
        {...(adding?.entry ? { entry: adding.entry } : {})}
        {...(adding?.edit ? { edit: adding.edit } : {})}
        defaultScope={defaultScope}
        onSaved={(next, saved) => {
          setServers(next);
          setAdding(undefined);
          actions.toast("info", `${saved.name} is saved. Conversations you start from now on can use it.`);
          if (saved.needsAuth) {
            const state = next.find((entry) => entry.scope === saved.scope && entry.config.name === saved.name);
            if (state?.config.auth?.kind === "oauth") {
              setSignIn({ scope: saved.scope, name: saved.name, title: serverTitle(state.config) });
            }
          }
        }}
      />

      <McpImportDialog
        cwd={cwd}
        open={importing}
        onOpenChange={setImporting}
        sources={sources}
        defaultScope={defaultScope}
        onImported={(next, imported) => {
          setServers(next);
          setImporting(false);
          actions.toast("info", imported.length ? `Imported ${imported.join(", ")}.` : "Nothing was imported.");
          void load();
        }}
      />

      <McpInspector
        cwd={cwd}
        state={selected}
        reloadToken={reloadToken}
        scopeFilter={scopeFilter}
        onOpenChange={(open) => !open && setSelectedId(undefined)}
        onServers={setServers}
        onError={(message) => actions.toast("error", message)}
        onEdit={() => {
          if (selected) setAdding({ edit: { scope: selected.scope, config: selected.config } });
        }}
        onSignIn={() => {
          if (selected) setSignIn({ scope: selected.scope, name: selected.config.name, title: serverTitle(selected.config) });
        }}
        onSignOut={() => {
          if (selected) setSignOut({ scope: selected.scope, name: selected.config.name, title: serverTitle(selected.config) });
        }}
      />

      <McpSignInDialog
        cwd={cwd}
        target={signIn}
        onOpenChange={(open) => !open && setSignIn(undefined)}
        onDone={() => void load()}
      />
      <McpSignOutDialog
        cwd={cwd}
        target={signOut}
        onOpenChange={(open) => !open && setSignOut(undefined)}
        onDone={() => {
          actions.toast("info", "Signed out. The server stays configured.");
          void load();
        }}
      />
    </ScrollArea>
  );
}
