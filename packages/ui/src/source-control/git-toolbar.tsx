import { useEffect, useMemo, useState } from "react";
import type { GitHostStatus } from "@lasercode/protocol";
import { ChevronDown, GitBranch, GitPullRequestArrow } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import type { ChangedRepo } from "./contract.js";
import { getChangesAdapter } from "./data.js";
import { personFacingChangesError } from "./errors.js";
import {
  GIT_HOSTS_FAILED,
  actionTitle,
  hostFor,
  hostStatusSentence,
  repoLeafName,
  targetRepo,
  type GitActionKind,
} from "./git-model.js";
import { requestGitAction } from "./store.js";

const MENU_KINDS: GitActionKind[] = ["commit", "push", "branch", "pull-request-create", "pull-request-read"];

/** What the toolbar knows about the git host behind the repository in view. */
export type GitToolbarState = {
  /** Whether the host offers git actions at all. */
  available: boolean;
  repo: string | null;
  host: GitHostStatus | undefined;
  /** One sentence: what is wrong and what to do about it. */
  status: string | undefined;
  neighbourUsable: boolean;
};

/**
 * One `gitHosts` read for the whole toolbar. The controls and the sentence
 * that explains why they cannot act are two places in the chrome, so the
 * question is asked once, here, and both read the answer.
 */
export function useGitToolbarState({
  repos,
  repoFilter,
  activeRepo,
}: {
  repos: readonly ChangedRepo[];
  repoFilter: string | null;
  activeRepo?: string;
}): GitToolbarState {
  const adapter = getChangesAdapter();
  const [hosts, setHosts] = useState<GitHostStatus[]>([]);
  const [hostsError, setHostsError] = useState<string | null>(null);
  const repoKey = repos.map((repo) => repo.repo).join("\n");

  useEffect(() => {
    if (!adapter.gitHosts) return;
    let cancelled = false;
    const names = repoKey ? repoKey.split("\n").filter(Boolean) : [];
    void adapter.gitHosts(names.length ? names : undefined).then(
      (result) => {
        if (cancelled) return;
        setHosts(result.hosts);
        setHostsError(null);
      },
      (error: unknown) => {
        if (cancelled) return;
        setHosts([]);
        setHostsError(personFacingChangesError(error, GIT_HOSTS_FAILED));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [adapter, repoKey]);

  const repo = useMemo(
    () => targetRepo({ repos, repoFilter, ...(activeRepo ? { activeRepo } : {}) }),
    [repos, repoFilter, activeRepo],
  );
  const host = hostFor(hosts, repo);
  const status = hostsError ?? hostStatusSentence(host);
  const neighbourUsable = hosts.some((row) => row.usable && row.repo !== repo);
  return { available: Boolean(adapter.gitHosts), repo, host, status: status ?? undefined, neighbourUsable };
}

/**
 * The sentence a person needs when the git controls cannot act lives in the
 * menu below (`git-menu-status`), beside the actions it is about. It used to
 * sit permanently under the toolbar in attention colour, which made "Add a
 * GitHub or Bitbucket remote" the second thing anyone read on a screen they
 * opened to read a diff.
 */
export function ChangesGitActions({
  state,
  git = "label",
  commit = true,
}: {
  state: GitToolbarState;
  /** "icon" drops the word "Git"; the menu keeps every action either way. */
  git?: "icon" | "label";
  /** Whether the row has space for Commit outside the menu. */
  commit?: boolean;
}) {
  const { available, repo, host, status, neighbourUsable } = state;
  if (!available) {
    return <div data-slot="changes-git-actions" />;
  }

  const run = (kind: GitActionKind) => {
    if (!repo) return;
    requestGitAction({ kind, repo });
  };

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={git === "icon" ? "icon" : "default"}
          className={cn("pointer-coarse:min-h-11", git === "label" && "gap-1")}
          aria-label={commit ? "More git actions" : "Git actions"}
        >
          {git === "label" ? "Git" : null}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {repo ? (
          <p className="px-2 py-1.5 text-xs text-ink-3">
            <span className="typed text-ink">{repoLeafName(repo)}</span>
            {host?.branch ? (
              <>
                <span> · </span>
                <span className="typed">{host.branch}</span>
              </>
            ) : null}
          </p>
        ) : (
          <p className="px-2 py-1.5 text-xs text-ink-3">No repository in this scope.</p>
        )}
        <DropdownMenuSeparator />
        {MENU_KINDS.map((kind) => (
          <DropdownMenuItem key={kind} disabled={!repo} onSelect={() => run(kind)}>
            {kind === "pull-request-create" || kind === "pull-request-read" ? <GitPullRequestArrow /> : <GitBranch />}
            {actionTitle(kind)}
          </DropdownMenuItem>
        ))}
        {status ? (
          <>
            <DropdownMenuSeparator />
            <p data-slot="git-menu-status" className="max-w-64 px-2 py-1.5 text-xs text-ink-2">
              {status}
              {neighbourUsable ? " Other repositories still work." : ""}
            </p>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div data-slot="changes-git-actions" className="flex min-w-0 items-center gap-1">
      {commit ? (
        <Button variant="ghost" className="pointer-coarse:min-h-11" disabled={!repo} onClick={() => run("commit")}>
          Commit
        </Button>
      ) : null}
      {menu}
    </div>
  );
}
