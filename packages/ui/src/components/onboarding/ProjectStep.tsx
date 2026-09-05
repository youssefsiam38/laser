"use client";
/**
 * Step: open a project. A folder browser over `pi/project/browse` — the host
 * lists directories, so a person who has never typed a path picks one by
 * clicking, and someone who knows theirs types it (with `~`). Folders that
 * look like code projects carry a mark. "Use this folder" adds the current
 * directory as a project through the same `pi/project/add` the rail uses.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, ArrowUp, Check, Folder, FolderGit2, Home, Loader2 } from "lucide-react";

import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { shortCwd } from "@/format";
import { cn } from "@/lib/utils";
import { usePiorbitState, usePiorbitStable } from "@/runtime";
import type { DirectoryListing } from "@lasercode/protocol";

import { recentCwds } from "@/components/shell/model";

export interface ProjectStepProps {
  /** Called once the project is added and selected. */
  onAdded: (cwd: string) => void;
}

export function ProjectStep({ onAdded }: ProjectStepProps) {
  const { client, actions, setCurrentProject, projects } = usePiorbitStable();
  const sessions = usePiorbitState((s) => s.sessions);
  const [listing, setListing] = useState<DirectoryListing>();
  const [loading, setLoading] = useState(true);
  const [typed, setTyped] = useState("");
  const [adding, setAdding] = useState<string>();
  const [error, setError] = useState<string>();
  const recent = useMemo(() => recentCwds(sessions).filter((cwd) => !projects.includes(cwd)).slice(0, 4), [projects, sessions]);

  const browse = useCallback(
    async (path?: string) => {
      setLoading(true);
      setError(undefined);
      try {
        const next = await client.request("pi/project/browse", path ? { path } : {});
        setListing(next);
        setTyped(next.path);
      } catch (browseError) {
        setError(browseError instanceof Error ? browseError.message : String(browseError));
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void browse();
  }, [browse]);

  const add = async (cwd: string) => {
    setAdding(cwd);
    try {
      const project = await actions.addProject(cwd);
      if (project) {
        setCurrentProject(project.cwd);
        onAdded(project.cwd);
      }
    } finally {
      setAdding(undefined);
    }
  };

  const go = (event: FormEvent) => {
    event.preventDefault();
    const value = typed.trim();
    if (value !== "") void browse(value);
  };

  const here = listing?.path;
  const alreadyProject = here !== undefined && projects.includes(here);
  // The agent reads and writes inside a project, and indexes it. Pointing it at
  // a whole home directory or at `/` is almost never what someone meant, and
  // the cost of finding out is a very slow first session over every file the
  // account owns. Said as a warning, not a block: someone may mean it.
  const tooBig =
    here === undefined
      ? undefined
      : here === listing?.home
        ? "your whole home directory"
        : here === "/" || /^[A-Za-z]:[\\/]?$/.test(here)
          ? "the whole disk"
          : undefined;

  return (
    <div className="flex flex-col gap-2">
      <form className="flex items-center gap-2" onSubmit={go}>
        <Input
          aria-label="Folder path"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
          placeholder="~/code/your-app"
        />
        <Button type="submit" variant="secondary" size="sm" disabled={typed.trim() === "" || loading}>
          Go
        </Button>
      </form>

      {recent.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-ink-3">Recently used:</span>
          {recent.map((cwd) => (
            <Button key={cwd} variant="outline" size="xs" onClick={() => void browse(cwd)} title={cwd}>
              <Folder /> {shortCwd(cwd)}
            </Button>
          ))}
        </div>
      )}

      <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface">
        <div className="flex items-center gap-1 px-2 py-1.5 hairline-b">
          <Button variant="ghost" size="icon-sm" aria-label="Home folder" disabled={loading || !listing} onClick={() => void browse(listing?.home)}>
            <Home />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Up one folder" disabled={loading || !listing?.parent} onClick={() => void browse(listing?.parent)}>
            <ArrowUp />
          </Button>
          <span className="min-w-0 flex-1 truncate typed text-ink-2" title={here}>
            {here ? shortCwd(here) : "…"}
          </span>
          {loading && <GenerationLoader label="Reading folder" layout="inline" />}
        </div>

        {error && <ErrorState title="Could not open that folder" detail={error} onRetry={() => void browse(typed.trim() || undefined)} retryLabel="Try again" className="m-2" />}
        {listing?.error && !error && <p className="px-3 py-2 text-sm text-danger">{listing.error}</p>}

        <ul className="max-h-56 overflow-y-auto" aria-label="Folders">
          {listing?.entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                onClick={() => void browse(entry.path)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-start text-sm text-ink outline-none",
                  "hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none",
                )}
              >
                {entry.project ? <FolderGit2 aria-hidden="true" className="size-4 shrink-0 text-live" /> : <Folder aria-hidden="true" className="size-4 shrink-0 text-ink-3" />}
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.project && <Badge variant="live">project</Badge>}
              </button>
            </li>
          ))}
          {listing && listing.entries.length === 0 && !listing.error && (
            <li className="px-3 py-4 text-center text-sm text-ink-2">No folders inside. Use this one, or go up.</li>
          )}
          {listing?.truncated && <li className="px-3 py-2 text-xs text-ink-3">Showing the first {listing.entries.length} folders. Type a path to go deeper.</li>}
        </ul>
      </div>

      {tooBig && (
        <p className="flex items-start gap-2 rounded-lg bg-[color-mix(in_oklab,var(--attention)_12%,transparent)] px-3 py-2 text-xs leading-5 text-ink-2">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-attention" />
          <span>
            This is {tooBig}. The agent works inside the folder you choose, so a project this large makes every session
            slower and gives it far more of your files than it needs. Pick the folder your code is in instead.
          </span>
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        {alreadyProject && (
          <span className="flex items-center gap-1 text-xs text-ok">
            <Check aria-hidden="true" className="size-3.5" /> already a project
          </span>
        )}
        <Button size="sm" disabled={!here || loading || adding !== undefined} onClick={() => here && void add(here)}>
          {adding ? <Loader2 className="motion-safe:animate-busy" /> : <FolderGit2 />} {alreadyProject ? "Continue with this folder" : "Use this folder"}
        </Button>
      </div>
    </div>
  );
}
