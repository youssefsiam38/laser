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
import { PRODUCT_DISPLAY_NAME, type ClientRequests, type McpCatalogEntry, type McpImportSource, type McpScope, type McpServerConfig, type McpServerState } from "@lasercode/protocol";
import { FolderSearch, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { CapabilityNotice } from "@/components/capability-gate";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useLaserStable, type SettingsScopeView } from "@/runtime";

import { McpAddDialog } from "./McpAddDialog.js";
import { McpGallery } from "./McpGallery.js";
import { McpImportBanner, McpImportDialog } from "./McpImportDialog.js";
import { McpInspector } from "./McpInspector.js";
import { McpServerList } from "./McpServerList.js";
import { McpSignInDialog, McpSignOutDialog } from "./McpSignIn.js";
import { rowKey, serverTitle } from "./model.js";
import { ScopeDraftGuard, type ScopeDraft } from "../ScopeDraftGuard.js";

export function McpServersTab({ routeCwd, view, decision }: {
  routeCwd: string;
  view: SettingsScopeView;
  decision?: import("@/runtime/environment-capabilities").CapabilityDecision | undefined;
}) {
  const writable = view !== "effective" && (decision?.state === "available" || decision === undefined);
  const readOnlyExplanation = view === "effective"
    ? "Effective settings are a read-only preview. Choose Global or Project to change MCP servers."
    : decision?.state === "explained" ? decision.explanation : undefined;
  const mutationScope: McpScope = view === "project" ? "project" : "global";
  const { client, actions } = useLaserStable();
  const [servers, setServers] = useState<McpServerState[]>();
  const [conversations, setConversations] = useState<NonNullable<ClientRequests["mcp/list"]["result"]["conversations"]>>([]);
  const [sources, setSources] = useState<McpImportSource[]>([]);
  const [detectFailed, setDetectFailed] = useState(false);
  const [error, setError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [adding, setAdding] = useState<{ entry?: McpCatalogEntry; edit?: { scope: McpScope; config: McpServerConfig } }>();
  const [importing, setImporting] = useState(false);
  const [signIn, setSignIn] = useState<{ scope: McpScope; name: string; title: string }>();
  const [signOut, setSignOut] = useState<{ scope: McpScope; name: string; title: string }>();
  const [drafts, setDrafts] = useState<Record<string, ScopeDraft>>({});
  const generation = useRef(0);
  const reportDraft = useCallback((slot: string, draft: ScopeDraft | undefined) => {
    setDrafts((current) => {
      if (!draft && !(slot in current)) return current;
      const next = { ...current };
      if (draft) next[slot] = draft;
      else delete next[slot];
      return next;
    });
  }, []);
  const reportAddDraft = useCallback((draft: ScopeDraft | undefined) => reportDraft("add", draft), [reportDraft]);
  const reportImportDraft = useCallback((draft: ScopeDraft | undefined) => reportDraft("import", draft), [reportDraft]);
  const reportSignInDraft = useCallback((draft: ScopeDraft | undefined) => reportDraft("sign-in", draft), [reportDraft]);
  const activeDrafts = useMemo(() => Object.values(drafts), [drafts]);
  const targetKey = `${view}:${routeCwd}`;
  const targetRef = useRef(targetKey);
  targetRef.current = targetKey;

  const load = useCallback(async () => {
    const request = ++generation.current;
    setError(undefined);
    try {
      const list = await client.request("mcp/list", { cwd: routeCwd, view });
      if (request !== generation.current) return;
      setServers(list.servers);
      setConversations(list.conversations ?? []);
    } catch (failure) {
      if (request === generation.current) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    }
  }, [client, routeCwd, view]);
  const reloadProjected = useCallback(() => {
    if (targetRef.current === targetKey) void load();
  }, [load, targetKey]);

  /**
   * Looking for other tools' configurations reads nine places on disk, so it
   * happens when the page opens and when the person asks again — never on
   * every configuration write.
   */
  const detect = useCallback(async () => {
    if (view === "effective") {
      setSources([]);
      setDetectFailed(false);
      return;
    }
    const request = generation.current;
    try {
      const detected = await client.request("mcp/import/detect", { cwd: routeCwd, scope: mutationScope });
      if (request !== generation.current) return;
      setSources(detected.sources);
      setDetectFailed(false);
    } catch {
      // A host that cannot look must not take the page down with it, but the
      // person is told that the search did not run.
      if (request === generation.current) setDetectFailed(true);
    }
  }, [client, mutationScope, routeCwd, view]);

  useEffect(() => {
    setServers(undefined);
    setConversations([]);
    setSelectedId(undefined);
    void load();
    void detect();
    return () => {
      generation.current++;
    };
  }, [load, detect]);

  // The worker says when a configuration write or a status change happened.
  // Only the list is re-read: the open inspector reconnects on a status
  // change of its own row, and detection stays where the person put it.
  useEffect(() => {
    return client.subscribe((method, params) => {
      if (method !== "mcp/changed") return;
      if ((params as { cwd: string }).cwd !== routeCwd) return;
      void load();
    });
  }, [client, routeCwd, load]);

  const selected = useMemo(
    () => (selectedId ? servers?.find((entry) => rowKey(entry) === selectedId) : undefined),
    [servers, selectedId],
  );

  const shown = servers ?? [];

  const openSignIn = (id: string) => {
    const state = servers?.find((entry) => rowKey(entry) === id);
    if (state?.scope === mutationScope) setSignIn({ scope: state.scope, name: state.config.name, title: serverTitle(state.config) });
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

  const defaultScope: McpScope = mutationScope;
  const selectedWritable = writable && selected?.scope === mutationScope;

  return (
    <ScrollArea className="h-full">
      <ScopeDraftGuard drafts={activeDrafts} />
      <div className="mx-auto flex max-w-200 flex-col gap-5 px-4 py-5 md:px-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-140">
            <p className="typed uppercase tracking-eyebrow text-live">Tools from other programs</p>
            <h2 className="mt-1 text-lg font-semibold text-ink">MCP servers</h2>
            <p className="mt-1 text-sm leading-6 text-ink-2">
              A server brings tools {PRODUCT_DISPLAY_NAME} can use — a browser, a database, an issue tracker. New definitions apply to
              new conversations. Changing server settings or sign-in stops further calls from existing conversations; their tool definitions and history stay unchanged.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {writable ? <Button type="button" size="sm" onClick={() => setAdding({})}>
              <Plus aria-hidden="true" /> Add a server
            </Button> : null}
            <Button type="button" variant="ghost" size="sm" aria-label="Reload servers" onClick={() => void load()}>
              <RefreshCw aria-hidden="true" />
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => void detect()}>
              <FolderSearch aria-hidden="true" /> Look again
            </Button>
          </div>
        </header>

        {!writable && readOnlyExplanation ? <CapabilityNotice explanation={readOnlyExplanation} /> : null}

        {error && (
          <p role="alert" className="text-sm leading-6 text-danger">
            {error}
          </p>
        )}

        {detectFailed && (
          <p className="text-sm leading-6 text-ink-2">
            Could not look for servers other tools configured on this machine. Try “Look again”.
          </p>
        )}

        {writable ? <McpImportBanner sources={sources} onOpen={() => setImporting(true)} /> : null}

        {servers.length === 0 && writable ? (
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
            No server is saved for these {view === "global" ? "Global" : view === "project" ? "Project" : "Effective"} settings.
          </p>
        ) : (
          <McpServerList servers={shown} selectedId={selectedId} onSelect={setSelectedId} {...(writable ? { onSignIn: openSignIn } : {})} />
        )}

        {writable && servers.length > 0 && (
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

      {writable ? <McpAddDialog
        cwd={routeCwd}
        open={Boolean(adding)}
        onOpenChange={(open) => !open && setAdding(undefined)}
        {...(adding?.entry ? { entry: adding.entry } : {})}
        {...(adding?.edit ? { edit: adding.edit } : {})}
        defaultScope={defaultScope}
        allowProject={view === "project"}
        lockScope
        onDraftChange={reportAddDraft}
        onSaved={(next, saved) => {
          reloadProjected();
          setAdding(undefined);
          actions.toast("info", `${saved.name} is saved. Conversations you start from now on can use it.`);
          if (saved.needsAuth) {
            const state = next.find((entry) => entry.scope === saved.scope && entry.config.name === saved.name);
            if (state?.config.auth?.kind === "oauth") {
              setSignIn({ scope: saved.scope, name: saved.name, title: serverTitle(state.config) });
            }
          }
        }}
      /> : null}

      {writable ? <McpImportDialog
        cwd={routeCwd}
        open={importing}
        onOpenChange={setImporting}
        sources={sources}
        defaultScope={defaultScope}
        allowProject={view === "project"}
        lockScope
        onDraftChange={reportImportDraft}
        onImported={(_next, imported) => {
          setImporting(false);
          actions.toast("info", imported.length ? `Imported ${imported.join(", ")}.` : "Nothing was imported.");
          reloadProjected();
        }}
      /> : null}

      <McpInspector
        conversations={conversations}
        cwd={routeCwd}
        writable={Boolean(selectedWritable)}
        allowProjectOverride={Boolean(writable && view === "project" && selected?.scope === "global")}
        state={selected}
        onOpenChange={(open) => !open && setSelectedId(undefined)}
        onServers={reloadProjected}
        onError={(message) => actions.toast("error", message)}
        onNotice={(message) => actions.toast("info", message)}
        onEdit={(target) => setAdding({ edit: target })}
        onSignIn={() => {
          if (selected) setSignIn({ scope: selected.scope, name: selected.config.name, title: serverTitle(selected.config) });
        }}
        onSignOut={() => {
          if (selected) setSignOut({ scope: selected.scope, name: selected.config.name, title: serverTitle(selected.config) });
        }}
      />

      {writable ? <McpSignInDialog
        cwd={routeCwd}
        target={signIn}
        onOpenChange={(open) => !open && setSignIn(undefined)}
        onDone={reloadProjected}
        view={view}
        onDraftChange={reportSignInDraft}
      /> : null}
      {writable ? <McpSignOutDialog
        cwd={routeCwd}
        target={signOut}
        onOpenChange={(open) => !open && setSignOut(undefined)}
        onDone={() => {
          actions.toast("info", "Signed out. The server stays configured.");
          reloadProjected();
        }}
      /> : null}
    </ScrollArea>
  );
}
