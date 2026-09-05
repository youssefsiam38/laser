"use client";
/**
 * Package manager (M4-T3) over Pi's `DefaultPackageManager` in the worker.
 * Nothing here shells out to `pi install`: install, remove and update are RPC
 * calls, and the manager's progress callback arrives as `pi/packages/progress`
 * so a slow `npm install` shows its work instead of freezing a button.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowUpCircle, Check, Loader2, Package, RefreshCw, Trash2 } from "lucide-react";

import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { StatusDot } from "@/components/status";
import { DataTable, type DataTableColumn } from "@/components/assistant-ui/elements/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePiorbitStable } from "@/runtime";
import type { PackageEntry, PackageProgress, PackageScope, SettingsSnapshot } from "@piorbit/protocol";

import { SearchInput } from "./SettingsScreen.js";

export interface PackagesTabProps {
  cwd: string;
  snapshot: SettingsSnapshot | undefined;
  /** Installing writes to a settings file, so the settings tab must re-read. */
  onSettingsChanged: () => void | Promise<void>;
}

export function PackagesTab({ cwd, snapshot, onSettingsChanged }: PackagesTabProps) {
  const { client, actions } = usePiorbitStable();
  const [packages, setPackages] = useState<PackageEntry[]>([]);
  const [busy, setBusy] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<PackageProgress>();
  const [source, setSource] = useState("");
  const [scope, setScope] = useState<PackageScope>("user");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [confirmRemove, setConfirmRemove] = useState<PackageEntry>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { packages: list } = await client.request("pi/packages/list", { cwd });
      setPackages(list);
      setError(undefined);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [client, cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  // Progress for this project only; a second project installing at the same
  // time has its own screen.
  useEffect(
    () =>
      client.subscribe((method, params) => {
        if (method !== "pi/packages/progress") return;
        const event = params as PackageProgress;
        if (event.cwd !== cwd) return;
        setProgress(event);
        if (event.type === "complete" || event.type === "error") {
          setTimeout(() => setProgress((current) => (current === event ? undefined : current)), 2500);
        }
      }),
    [client, cwd],
  );

  const run = useCallback(
    async (label: string, work: () => Promise<PackageEntry[]>) => {
      setBusy(label);
      setError(undefined);
      try {
        setPackages(await work());
        await onSettingsChanged();
      } catch (runError) {
        const message = runError instanceof Error ? runError.message : String(runError);
        setError(message);
        actions.toast("error", message);
      } finally {
        setBusy(undefined);
      }
    },
    [actions, onSettingsChanged],
  );

  const install = () => {
    const trimmed = source.trim();
    if (trimmed === "") return;
    void run(`install:${trimmed}`, async () => {
      const { packages: list } = await client.request("pi/packages/install", { cwd, source: trimmed, scope });
      setSource("");
      return list;
    });
  };

  const checkUpdates = async () => {
    setChecking(true);
    setError(undefined);
    try {
      const { updates } = await client.request("pi/packages/check_updates", { cwd });
      await load();
      actions.toast(
        "info",
        updates.length === 0
          ? "Every configured package is up to date."
          : `${updates.length} package${updates.length === 1 ? " has" : "s have"} an update: ${updates
              .map((u) => u.displayName)
              .join(", ")}`,
      );
    } catch (checkError) {
      const message = checkError instanceof Error ? checkError.message : String(checkError);
      setError(message);
      actions.toast("error", message);
    } finally {
      setChecking(false);
    }
  };

  const projectWritable = snapshot?.projectTrust.writable ?? false;
  const shown = packages.filter((pkg) => pkg.source.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-200 flex-col gap-4 px-4 py-4">
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-ink">Add a package</h2>
          <p className="text-xs leading-5 text-ink-2">
            An npm package name or a git URL, exactly as you would give it to <code className="font-mono">pi install</code>.
            User packages install under <code className="font-mono">~/.pi/agent/npm</code>; project packages under{" "}
            <code className="font-mono">.pi/npm</code> and only load in this directory.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={source}
              placeholder="pi-web-access"
              onChange={(event) => setSource(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && install()}
              className={cn(
                "h-8 min-w-64 flex-1 rounded-lg border border-line bg-surface px-2.5 font-mono text-sm text-ink",
                "placeholder:text-ink-3 outline-none focus-visible:border-live focus-visible:ring-2 focus-visible:ring-live/25",
              )}
            />
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value as PackageScope)}
              className="h-8 rounded-lg border border-line bg-surface px-2 text-sm text-ink outline-none focus-visible:border-live"
            >
              <option value="user">for my user</option>
              <option value="project" disabled={!projectWritable}>
                for this project
              </option>
            </select>
            <Button disabled={source.trim() === "" || busy !== undefined} onClick={install}>
              {busy?.startsWith("install:") ? <Loader2 className="motion-safe:animate-busy" /> : <Package />} Install
            </Button>
          </div>
          {!projectWritable && snapshot && (
            <p className="text-xs leading-4 text-ink-3">
              Project scope is unavailable: {snapshot.projectTrust.reason}
            </p>
          )}
        </section>

        {progress && <ProgressStrip progress={progress} />}

        {error && (
          <p className="rounded-lg bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-3 py-2 text-xs leading-5 text-danger">
            {error}
          </p>
        )}

        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">Configured packages</h2>
            <Badge variant="outline">{packages.length}</Badge>
            <SearchInput value={filter} onChange={setFilter} placeholder="Filter" className="ms-auto w-44" />
            <Button variant="secondary" size="sm" disabled={checking} onClick={() => void checkUpdates()}>
              {checking ? <Loader2 className="motion-safe:animate-busy" /> : <RefreshCw />} Check for updates
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== undefined || packages.length === 0}
              onClick={() =>
                void run("update:all", async () => (await client.request("pi/packages/update", { cwd })).packages)
              }
            >
              Update all
            </Button>
          </div>

          {/* An empty state that flashes on every open is a lie about the data;
              this project's worker may still be starting Pi. */}
          {loading && packages.length === 0 && (
            <div className="flex items-center justify-center rounded-lg border border-line px-3 py-6">
              <GenerationLoader label="Reading this project’s packages" layout="inline" />
            </div>
          )}
          {!loading && packages.length === 0 && (
            <p className="rounded-lg border border-line px-3 py-6 text-center text-sm text-ink-2">
              No packages are configured for this project. Pi's built-in tools work without any; packages add
              extensions, skills, prompts and themes.
            </p>
          )}

          {(loading || packages.length > 0) && (
            <DataTable
              caption="Packages configured for this project"
              columns={packageColumns({
                busy,
                update: (pkg) =>
                  void run(`update:${pkg.source}`, async () => (await client.request("pi/packages/update", { cwd, source: pkg.source })).packages),
                remove: setConfirmRemove,
              })}
              rows={shown}
              rowKey={(pkg) => `${pkg.scope}:${pkg.source}`}
              minWidth="36rem"
              emptyMessage={packages.length > 0 ? "No package matches the filter." : undefined}
            />
          )}
        </section>

        <p className="text-xs leading-4 text-ink-3">
          A newly installed package's extensions load when a session starts. Open a new session, or restart the worker
          for this project, to use it.
        </p>
      </div>

      {/* Removing uninstalls from disk and edits a settings file. One click,
          during a live run, is not the right gesture for that. */}
      <Dialog open={confirmRemove !== undefined} onOpenChange={(next) => !next && setConfirmRemove(undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove {confirmRemove?.source}?</DialogTitle>
            <DialogDescription>
              It will be uninstalled from disk and its entry removed from the{" "}
              {confirmRemove?.scope === "project" ? "project" : "user"} settings file. Sessions already running keep
              what they loaded until they restart.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" autoFocus onClick={() => setConfirmRemove(undefined)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="gap-1.5"
              onClick={() => {
                const pkg = confirmRemove;
                setConfirmRemove(undefined);
                if (!pkg) return;
                void run(`remove:${pkg.source}`, async () => {
                  const result = await client.request("pi/packages/remove", {
                    cwd,
                    source: pkg.source,
                    scope: pkg.scope,
                  });
                  if (!result.removed) {
                    actions.toast(
                      "warning",
                      `${pkg.source} was uninstalled, but nothing referenced it in the ${pkg.scope} settings file.`,
                    );
                  }
                  return result.packages;
                });
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

function ProgressStrip({ progress }: { progress: PackageProgress }) {
  const done = progress.type === "complete";
  const failed = progress.type === "error";
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-2 rounded-lg px-3 py-2 text-xs",
        failed
          ? "bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] text-danger"
          : done
            ? "bg-[color-mix(in_oklab,var(--ok)_10%,transparent)] text-ok"
            : "bg-surface-2 text-ink-2",
      )}
    >
      {done ? <Check className="size-3.5" /> : failed ? null : <StatusDot status="working" size="sm" label="In progress" />}
      <span className="font-medium">{progress.action}</span>
      <span className="font-mono text-xs">{progress.source}</span>
      {progress.message && <span className="min-w-0 truncate opacity-90">{progress.message}</span>}
    </div>
  );
}

function packageColumns({
  busy,
  update,
  remove,
}: {
  busy: string | undefined;
  update: (pkg: PackageEntry) => void;
  remove: (pkg: PackageEntry) => void;
}): DataTableColumn<PackageEntry>[] {
  return [
    {
      key: "source",
      label: "Package",
      render: (pkg) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="typed text-ink">{pkg.source}</span>
            {pkg.type && <Badge variant="default">{pkg.type}</Badge>}
            {pkg.filtered && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="default">filtered</Badge>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-72">
                  Its settings entry lists which extensions, skills, prompts or themes to load, instead of loading
                  everything the package ships.
                </TooltipContent>
              </Tooltip>
            )}
            {pkg.updateAvailable && (
              <Badge variant="attention" className="gap-1">
                <ArrowUpCircle /> update
              </Badge>
            )}
          </div>
          {pkg.installedPath && (
            <p className="truncate typed text-ink-3" title={pkg.installedPath}>
              {pkg.installedPath}
            </p>
          )}
        </div>
      ),
    },
    {
      key: "scope",
      label: "Scope",
      width: "6rem",
      render: (pkg) => <Badge variant={pkg.scope === "project" ? "live" : "outline"}>{pkg.scope}</Badge>,
    },
    {
      key: "actions",
      label: "Actions",
      align: "end",
      width: "11rem",
      render: (pkg) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={() => update(pkg)}>
            {busy === `update:${pkg.source}` ? <Loader2 className="motion-safe:animate-busy" /> : null} Update
          </Button>
          <Button variant="destructive-ghost" size="sm" disabled={busy !== undefined} onClick={() => remove(pkg)}>
            {busy === `remove:${pkg.source}` ? <Loader2 className="motion-safe:animate-busy" /> : <Trash2 />} Remove
          </Button>
        </div>
      ),
    },
  ];
}
