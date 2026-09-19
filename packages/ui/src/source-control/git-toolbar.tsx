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

export function ChangesGitActions({
  repos,
  repoFilter,
  activeRepo,
  chrome,
}: {
  repos: readonly ChangedRepo[];
  repoFilter: string | null;
  activeRepo?: string;
  chrome: "phone" | "desktop";
}) {
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

  if (!adapter.gitHosts) {
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
          size="sm"
          className="gap-1 [@media(pointer:coarse)]:min-h-11"
          aria-label={chrome === "phone" ? "Git actions" : "More git actions"}
        >
          Git
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
            <p data-slot="git-host-status" className="max-w-64 px-2 py-1.5 text-xs text-ink-2">
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
      {chrome === "desktop" ? (
        <Button
          variant="ghost"
          size="sm"
          className="[@media(pointer:coarse)]:min-h-11"
          disabled={!repo}
          onClick={() => run("commit")}
        >
          Commit
        </Button>
      ) : null}
      {menu}
      {status ? (
        <p
          data-slot="git-host-status"
          title={status}
          className={cn("hidden min-w-0 max-w-48 truncate text-xs text-ink-2 sm:block", chrome === "phone" && "hidden")}
        >
          {status}
        </p>
      ) : null}
    </div>
  );
}
