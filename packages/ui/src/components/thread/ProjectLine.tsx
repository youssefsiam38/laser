import type { ProjectGitStatus } from "@lasercode/protocol";
import { ArrowDown, ArrowUp, Check, Copy, ExternalLink, GitBranch, GitPullRequestArrow } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useCopy } from "@/hooks";
import { cn } from "@/lib/utils";
import { useLaserStable, useLaserState } from "@/runtime";
import { FILE_CHANGING_TOOLS, deltaParts, githubCompareUrl, pullRequestCommands } from "./project-git.js";
import { useSessionUpdates } from "./session-updates.js";

const POLL_MS = 30_000;

/**
 * `pi/project/git` for the session on screen. Re-read when the session
 * changes, after any turn that ran an edit/write/bash tool, and on a slow poll
 * while the tab is visible (a checkout in a terminal should show up without a
 * turn). The worker caches, so asking often is cheap.
 */
function useProjectGit(cwd: string | undefined, path: string | undefined): ProjectGitStatus | undefined {
  const { client } = useLaserStable();
  const connection = useLaserState((s) => s.connection);
  const [status, setStatus] = useState<ProjectGitStatus | undefined>(undefined);
  const generation = useRef(0);

  const refresh = useCallback(() => {
    if (!cwd || connection !== "open") return;
    const mine = ++generation.current;
    client
      .request("pi/project/git", { cwd, ...(path ? { path } : {}) })
      .then((result) => {
        if (mine === generation.current) setStatus(result);
      })
      .catch(() => {
        // An older host without this method, or git misbehaving: the line
        // simply stays hidden — it is a convenience, never a blocker.
        if (mine === generation.current) setStatus(undefined);
      });
  }, [client, connection, cwd, path]);

  useEffect(() => {
    setStatus(undefined);
    refresh();
  }, [refresh]);

  // After a turn that could have changed files.
  const touched = useRef(false);
  useSessionUpdates(
    path,
    useCallback(
      (p) => {
        const u = p.update;
        if (u.kind === "tool_execution_start" && FILE_CHANGING_TOOLS.has(u.toolName)) touched.current = true;
        if ((u.kind === "agent_end" || u.kind === "agent_settled") && touched.current) {
          touched.current = false;
          refresh();
        }
      },
      [refresh],
    ),
  );

  useEffect(() => {
    if (!cwd || typeof document === "undefined") return;
    const tick = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [cwd, refresh]);

  return status;
}

/**
 * The project line under the composer (DESIGN.md "Composer", M2-T6): branch,
 * `+added −removed` since the session opened, ahead/behind, and "Create PR"
 * when there is something to push. Tabular numerals, 12px, one line; hidden
 * entirely when the directory is not a repository.
 */
export function ProjectLine({ className }: { className?: string | undefined }) {
  const cwd = useLaserState((s) => (s.current ? s.open[s.current]?.state.cwd : undefined));
  const path = useLaserState((s) => s.current);
  const git = useProjectGit(cwd, path);
  const [prOpen, setPrOpen] = useState(false);

  if (!git || !git.isRepo) return null;
  const delta = deltaParts(git.added, git.removed);
  const canPr = git.ahead > 0 && !!git.upstream;
  const syncTitle = git.upstream
    ? `${git.ahead} ahead, ${git.behind} behind ${git.upstream}`
    : "No upstream branch yet";

  return (
    <div
      data-slot="project-line"
      className={cn("flex h-5 min-w-0 items-center gap-2 text-xs leading-4 whitespace-nowrap text-ink-3", className)}
    >
      <span className="flex min-w-0 items-center gap-1.5" title={`Branch ${git.branch}${git.dirty ? " · uncommitted changes" : ""}`}>
        <GitBranch aria-hidden="true" className="size-3 shrink-0" />
        <span className="typed min-w-0 truncate text-ink-2">{git.branch}</span>
        {git.dirty ? (
          <span aria-label="Uncommitted changes" role="img" className="size-1.5 shrink-0 rounded-full bg-attention" />
        ) : null}
      </span>
      {delta.length > 0 ? (
        <span className="typed flex shrink-0 items-center gap-1 tnum" title="Lines changed since this session opened">
          {delta.map((d) => (
            <span key={d.sign} className={d.sign === "+" ? "text-ok" : "text-danger"}>
              {d.sign}
              {d.value.toLocaleString("en-US")}
            </span>
          ))}
        </span>
      ) : null}
      {git.ahead > 0 || git.behind > 0 ? (
        <span className="typed flex shrink-0 items-center gap-0.5 tnum" title={syncTitle} aria-label={syncTitle}>
          {git.ahead > 0 ? (
            <>
              <ArrowUp aria-hidden="true" className="size-3" />
              {git.ahead}
            </>
          ) : null}
          {git.behind > 0 ? (
            <>
              <ArrowDown aria-hidden="true" className={cn("size-3", git.ahead > 0 && "ms-1")} />
              {git.behind}
            </>
          ) : null}
        </span>
      ) : null}
      {canPr ? (
        <>
          <Button variant="link" size="xs" className="h-4 shrink-0 gap-1 text-xs" onClick={() => setPrOpen(true)}>
            <GitPullRequestArrow aria-hidden="true" className="size-3" />
            Create PR
          </Button>
          <CreatePrDialog git={git} open={prOpen} onOpenChange={setPrOpen} />
        </>
      ) : null}
    </div>
  );
}

/**
 * Shows exactly what to run, rather than running it: `gh pr create` opens a
 * browser on the machine that runs it, which is the wrong machine from a
 * phone, and the push is the part that must not happen behind your back.
 */
function CreatePrDialog({ git, open, onOpenChange }: { git: ProjectGitStatus; open: boolean; onOpenChange(open: boolean): void }) {
  const { copy, copied } = useCopy();
  const commands = pullRequestCommands(git.branch, git.upstream);
  const compare = git.remoteUrl && git.upstream ? githubCompareUrl(git.remoteUrl, git.upstream, git.branch) : undefined;
  const script = commands.join("\n");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create a pull request</DialogTitle>
          <DialogDescription>
            <span className="typed text-ink">{git.branch}</span> is {git.ahead} commit{git.ahead === 1 ? "" : "s"} ahead of{" "}
            <span className="typed text-ink">{git.upstream}</span>
            {git.behind > 0 ? ` and ${git.behind} behind` : ""}.
            {git.dirty ? " Uncommitted changes in the working tree will not be part of it." : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="eyebrow">Run in the project</span>
            <TooltipIconButton tooltip={copied ? "Copied" : "Copy commands"} size="icon-xs" onClick={() => void copy(script)}>
              {copied ? <Check className="text-ok" /> : <Copy />}
            </TooltipIconButton>
          </div>
          <pre dir="ltr" className="terminal overflow-x-auto rounded-lg px-3 py-2">
            {commands.map((cmd) => (
              <div key={cmd} className="flex gap-2">
                <span aria-hidden="true" className="select-none text-terminal-ink-2">
                  $
                </span>
                <code dir="ltr">{cmd}</code>
              </div>
            ))}
          </pre>
          <p className="text-xs leading-4 text-ink-3">
            The second line needs the GitHub CLI; without it, push and open the compare page instead.
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {compare ? (
            <Button asChild>
              <a href={compare} target="_blank" rel="noreferrer noopener">
                <ExternalLink />
                Open compare on GitHub
              </a>
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
