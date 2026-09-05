"use client";
/**
 * Settings → Extensions (M10-T5). Browse, install, update and remove without a
 * terminal, on a machine that has nothing but laser on it.
 *
 * Every verb is an RPC to the host, which pins the exact version, hands the
 * install to the agent's own package manager running on the runtime laser
 * ships, verifies what landed, and records it. This screen shows the work
 * while it runs (`pi/packages/progress` → the `job-progress` element) and a
 * failure as one sentence with a Retry (`error-state`). It never prints a
 * path, a package-manager name or a command in the ordinary course of things;
 * the "Technical details" disclosure at the bottom is where those live.
 *
 * Replaces `settings/PackagesTab.tsx`; same props, so the settings screen
 * swaps it in with one import.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Loader2, Package, RefreshCw, Search as SearchIcon, Trash2 } from "lucide-react";

import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { SpecSheet, type SpecRow } from "@/components/assistant-ui/elements/spec-sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import type {
  PackageCatalogEntry,
  PackageEntry,
  PackageProgress,
  PackageRuntimeInfo,
  PackageScope,
  SettingsSnapshot,
} from "@lasercode/protocol";

import { SearchInput } from "../SettingsScreen.js";
import { CatalogList } from "./CatalogList.js";
import { InstalledTable } from "./InstalledTable.js";
import {
  SEARCH_DEBOUNCE_MS,
  SEARCH_MIN_LENGTH,
  describeProgress,
  displayName,
  filterCatalog,
  filterInstalled,
  type BusyKey,
  type ProgressPhase,
} from "./model.js";
import { ProgressStrip } from "./ProgressStrip.js";

export interface PackagesScreenProps {
  cwd: string;
  snapshot: SettingsSnapshot | undefined;
  /** Installing writes to a settings file, so the settings tab must re-read. */
  onSettingsChanged: () => void | Promise<void>;
}

type View = "installed" | "find";

interface Failure {
  message: string;
  retry?: (() => void) | undefined;
}

export function PackagesScreen({ cwd, snapshot, onSettingsChanged }: PackagesScreenProps) {
  const { client, actions } = useLaserStable();
  const [view, setView] = useState<View>("installed");
  const [installed, setInstalled] = useState<PackageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<PackageCatalogEntry[]>([]);
  const [catalogSource, setCatalogSource] = useState<"curated" | "search">("curated");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogNotice, setCatalogNotice] = useState<string>();
  const [runtime, setRuntime] = useState<PackageRuntimeInfo>();
  const [busy, setBusy] = useState<BusyKey>();
  const [phase, setPhase] = useState<ProgressPhase>();
  const [failure, setFailure] = useState<Failure>();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<PackageScope>("user");
  const [confirmRemove, setConfirmRemove] = useState<PackageEntry>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const phaseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // --- data -----------------------------------------------------------------

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { packages } = await client.request("pi/packages/list", { cwd });
      setInstalled(packages);
      setFailure(undefined);
    } catch (loadError) {
      setFailure({ message: errorText(loadError), retry: () => void load() });
    } finally {
      setLoading(false);
    }
  }, [client, cwd]);

  const loadCatalog = useCallback(
    async (search: string) => {
      setCatalogLoading(true);
      try {
        const result = await client.request("pi/packages/catalog", {
          cwd,
          ...(search.trim().length >= SEARCH_MIN_LENGTH ? { query: search.trim() } : {}),
          limit: 60,
        });
        setCatalog(result.entries);
        setCatalogSource(result.source);
        setCatalogNotice(result.error);
      } catch (catalogError) {
        setCatalogNotice(errorText(catalogError));
      } finally {
        setCatalogLoading(false);
      }
    },
    [client, cwd],
  );

  useEffect(() => {
    void load();
    client
      .request("pi/packages/runtime", {})
      .then(setRuntime)
      .catch(() => setRuntime(undefined));
  }, [client, load]);

  // The curated list loads once; a typed query re-asks the registry after a pause.
  const searched = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (view !== "find") return undefined;
    const term = query.trim().length >= SEARCH_MIN_LENGTH ? query.trim() : "";
    if (searched.current === term) return undefined;
    const handle = setTimeout(
      () => {
        searched.current = term;
        void loadCatalog(term);
      },
      term === "" ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(handle);
  }, [view, query, loadCatalog]);

  // Progress for this project only; another project installing at the same
  // time has its own screen.
  useEffect(
    () =>
      client.subscribe((method, params) => {
        if (method !== "pi/packages/progress") return;
        const event = params as PackageProgress;
        if (event.cwd !== cwd) return;
        const next = describeProgress(event);
        setPhase(next);
        clearTimeout(phaseTimer.current);
        if (next.tone !== "working") {
          phaseTimer.current = setTimeout(() => setPhase((current) => (current === next ? undefined : current)), 3200);
        }
      }),
    [client, cwd],
  );
  useEffect(() => () => clearTimeout(phaseTimer.current), []);

  // --- verbs ------------------------------------------------------------------

  const run = useCallback(
    async (key: BusyKey, work: () => Promise<PackageEntry[] | undefined>, retry: () => void) => {
      setBusy(key);
      setFailure(undefined);
      try {
        const next = await work();
        if (next) setInstalled(next);
        await onSettingsChanged();
        // Installed marks on the catalog cards come from the host; ask again.
        if (searched.current !== undefined) void loadCatalog(searched.current);
      } catch (runError) {
        setFailure({ message: errorText(runError), retry });
      } finally {
        setBusy(undefined);
      }
    },
    [loadCatalog, onSettingsChanged],
  );

  const install = useCallback(
    (entry: PackageCatalogEntry) => {
      const go = () =>
        void run(
          `install:${entry.name}`,
          async () => {
            const result = await client.request("pi/packages/install", {
              cwd,
              source: `npm:${entry.name}`,
              scope,
              ...(entry.version ? { version: entry.version } : {}),
            });
            actions.toast("info", `Installed ${entry.name}${result.record ? ` ${result.record.version}` : ""}. It loads in the next session you start.`);
            return result.packages;
          },
          go,
        );
      go();
    },
    [actions, client, cwd, run, scope],
  );

  const update = useCallback(
    (entry?: PackageEntry) => {
      const key: BusyKey = entry ? `update:${entry.source}` : "update:all";
      const go = () =>
        void run(
          key,
          async () => (await client.request("pi/packages/update", { cwd, ...(entry ? { source: entry.source } : {}) })).packages,
          go,
        );
      go();
    },
    [client, cwd, run],
  );

  const checkUpdates = useCallback(() => {
    const go = () =>
      void run(
        "check",
        async () => {
          const { updates } = await client.request("pi/packages/check_updates", { cwd });
          const { packages } = await client.request("pi/packages/list", { cwd });
          actions.toast(
            "info",
            updates.length === 0
              ? "Every extension is up to date."
              : `${updates.length} ${updates.length === 1 ? "extension has" : "extensions have"} an update: ${updates
                  .map((u) => (u.latestVersion ? `${u.displayName} ${u.latestVersion}` : u.displayName))
                  .join(", ")}`,
          );
          return packages;
        },
        go,
      );
    go();
  }, [actions, client, cwd, run]);

  const remove = useCallback(
    (entry: PackageEntry) => {
      const go = () =>
        void run(
          `remove:${entry.source}`,
          async () => {
            const result = await client.request("pi/packages/remove", { cwd, source: entry.source, scope: entry.scope });
            if (!result.removed) {
              actions.toast("warning", `${displayName(entry)} was removed from disk, but its settings entry was already gone.`);
            }
            return result.packages;
          },
          go,
        );
      go();
    },
    [actions, client, cwd, run],
  );

  // --- derived ------------------------------------------------------------------

  const projectWritable = snapshot?.projectTrust.writable ?? false;
  const canInstall = runtime?.ready ?? true; // unknown until the host answers: keep the verbs; the host refuses with a reason
  const shownInstalled = useMemo(() => filterInstalled(installed, view === "installed" ? query : ""), [installed, query, view]);
  const shownCatalog = useMemo(
    () => (catalogSource === "curated" ? filterCatalog(catalog, query) : catalog),
    [catalog, catalogSource, query],
  );
  const descriptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of catalog) if (entry.description) map.set(entry.name, entry.description);
    return map;
  }, [catalog]);
  const updatesAvailable = installed.filter((e) => e.updateAvailable).length;

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-200 flex-col gap-4 px-4 py-4">
        {/* Header: which list, the search, and the two list-wide verbs. */}
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Extensions" className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
            <ViewTab active={view === "installed"} onClick={() => setView("installed")}>
              Installed
              {installed.length > 0 && <Badge variant={updatesAvailable > 0 ? "attention" : "outline"}>{updatesAvailable > 0 ? `${updatesAvailable} to update` : installed.length}</Badge>}
            </ViewTab>
            <ViewTab active={view === "find"} onClick={() => setView("find")}>
              Find more
            </ViewTab>
          </div>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={view === "find" ? "Search extensions" : "Filter installed"}
            className="min-w-40 flex-1 sm:max-w-72"
          />
          {view === "installed" && (
            <div className="ms-auto flex items-center gap-1">
              <Button variant="secondary" size="sm" disabled={busy !== undefined || installed.length === 0} onClick={checkUpdates}>
                {busy === "check" ? <Loader2 className="motion-safe:animate-busy" /> : <RefreshCw />} Check for updates
              </Button>
              {updatesAvailable > 0 && (
                <Button size="sm" disabled={busy !== undefined} onClick={() => update()}>
                  {busy === "update:all" ? <Loader2 className="motion-safe:animate-busy" /> : null} Update all
                </Button>
              )}
            </div>
          )}
          {view === "find" && (
            <label className="ms-auto flex items-center gap-2 text-xs text-ink-2">
              Install for
              <select
                value={scope}
                onChange={(event) => setScope(event.target.value as PackageScope)}
                className="h-7 rounded-md border border-line bg-surface px-1.5 text-xs text-ink outline-none focus-visible:border-live"
              >
                <option value="user">every project</option>
                <option value="project" disabled={!projectWritable}>
                  this project only
                </option>
              </select>
            </label>
          )}
        </div>

        {/* This machine cannot install: say it once, at the top, and hide the verb (R2). */}
        {runtime && !runtime.ready && <ErrorState title={`Extensions cannot be installed on this copy of ${PRODUCT_NAME}`} detail={runtime.reason} />}

        {phase && <ProgressStrip phase={phase} />}

        {failure && <ErrorState title={failure.message} onRetry={failure.retry} retryLabel="Try again" />}

        {view === "installed" ? (
          <section className="flex flex-col gap-2" aria-label="Installed extensions">
            {loading && installed.length === 0 && (
              <div className="flex items-center justify-center rounded-xl border border-line px-3 py-8">
                <GenerationLoader label="Reading this project’s extensions" layout="inline" />
              </div>
            )}
            {!loading && installed.length === 0 && !failure && (
              <div className="flex flex-col items-start gap-3 rounded-xl border border-line px-4 py-6">
                <Package aria-hidden="true" className="size-5 text-ink-3" />
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium text-ink">No extensions yet</p>
                  <p className="max-w-prose text-sm leading-6 text-ink-2">
                    The agent’s built-in tools work without any. Extensions add web access, subagents, memory, dictation and
                    more — each one is a small download that loads in your next session.
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => setView("find")}>
                  <SearchIcon /> Find extensions
                </Button>
              </div>
            )}
            {(loading || installed.length > 0) && (
              <InstalledTable
                rows={shownInstalled}
                busy={busy}
                descriptions={descriptions}
                onUpdate={(entry) => update(entry)}
                onRemove={setConfirmRemove}
                emptyMessage={installed.length > 0 ? "No extension matches the filter." : undefined}
              />
            )}
            {installed.length > 0 && (
              <p className="text-xs leading-4 text-ink-3">
                Versions are exact: an extension stays at the version shown until you update it here.
              </p>
            )}
          </section>
        ) : (
          <section className="flex flex-col gap-2" aria-label="Extensions you can install">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-ink">
                {catalogSource === "search" && query.trim().length >= SEARCH_MIN_LENGTH ? `Results for “${query.trim()}”` : "Recommended"}
              </h2>
              {catalogLoading && <GenerationLoader label="Asking the registry" layout="inline" />}
              {!catalogLoading && catalogSource === "search" && <Badge variant="outline">{shownCatalog.length}</Badge>}
            </div>
            {catalogNotice && (
              <p role="status" className="rounded-lg bg-[color-mix(in_oklab,var(--attention)_12%,transparent)] px-3 py-2 text-xs leading-5 text-attention">
                {catalogNotice}
              </p>
            )}
            {!catalogLoading && shownCatalog.length === 0 && (
              <p className="rounded-xl border border-line px-3 py-6 text-center text-sm text-ink-2">
                {query.trim().length >= SEARCH_MIN_LENGTH
                  ? `Nothing matches “${query.trim()}”. Try a different word — extensions are usually named after what they do.`
                  : "The list could not be loaded."}
              </p>
            )}
            {shownCatalog.length > 0 && <CatalogList entries={shownCatalog} busy={busy} canInstall={canInstall} onInstall={install} />}
            <p className="text-xs leading-4 text-ink-3">
              Installing pins the version shown. An installed extension loads when the next session starts.
            </p>
          </section>
        )}

        {/* Diagnostics. The one place a path is allowed to appear. */}
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen} className="flex flex-col gap-2">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="self-start" aria-expanded={detailsOpen}>
              <ChevronRight className={cn("transition-transform duration-(--motion-fast) motion-reduce:transition-none", detailsOpen && "rotate-90")} />
              Technical details
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <SpecSheet title="How extensions are installed" rows={diagnosticRows(runtime, installed, snapshot)} />
          </CollapsibleContent>
        </Collapsible>
      </div>

      {/* Removing uninstalls from disk and edits a settings file. One click,
          during a live run, is not the right gesture for that. */}
      <Dialog open={confirmRemove !== undefined} onOpenChange={(next) => !next && setConfirmRemove(undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove {confirmRemove ? displayName(confirmRemove) : ""}?</DialogTitle>
            <DialogDescription>
              It is deleted from this computer and no longer loads for{" "}
              {confirmRemove?.scope === "project" ? "this project" : "any project"}. Sessions already running keep what they
              loaded until they restart. You can install it again any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" autoFocus onClick={() => setConfirmRemove(undefined)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                const entry = confirmRemove;
                setConfirmRemove(undefined);
                if (entry) remove(entry);
              }}
            >
              <Trash2 /> Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollArea>
  );
}

function ViewTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium outline-none",
        "transition-[background-color,color] duration-(--motion-instant) motion-reduce:transition-none",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
        active ? "bg-surface text-ink shadow-float-sm" : "text-ink-2 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function diagnosticRows(runtime: PackageRuntimeInfo | undefined, installed: readonly PackageEntry[], snapshot: SettingsSnapshot | undefined): SpecRow[] {
  const rows: SpecRow[] = [];
  if (runtime) {
    rows.push({ label: "Runtime", value: `${runtime.node.version} · ${runtime.node.path}`, typed: true });
    rows.push(
      runtime.npm
        ? { label: "Installer", value: `${runtime.npm.source} · ${runtime.npm.path}`, typed: true }
        : { label: "Installer", value: "none found", emphasis: true },
    );
  }
  if (snapshot) rows.push({ label: "Agent directory", value: snapshot.agentDir, typed: true });
  for (const entry of installed) {
    rows.push({
      label: displayName(entry),
      value: [entry.source, entry.installedPath, entry.integrity].filter((v): v is string => typeof v === "string" && v.length > 0).join(" · "),
      typed: true,
    });
  }
  if (rows.length === 0) rows.push({ label: "Status", value: "Waiting for the host to answer." });
  return rows;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
