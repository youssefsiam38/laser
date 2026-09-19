import { useMemo } from "react";
import { Check, ChevronRight, File, Folder } from "lucide-react";

import { DiffStat } from "@/components/assistant-ui/elements/code-diff.js";
import { fileTreeFromChanges } from "@/components/assistant-ui/elements/file-tree.js";
import { mono } from "@/components/assistant-ui/elements/surfaces.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

import { fileName, fileKey, repoTotals, statusLabel, statusMark } from "./classify.js";
import type { ChangedFile, ChangedRepo } from "./contract.js";
import type { OpenFile } from "./store.js";

export function ChangesRail({
  repos,
  active,
  viewed,
  pullRequest,
  viewedNote,
  onOpen,
  onToggleViewed,
}: {
  repos: readonly ChangedRepo[];
  active: OpenFile | undefined;
  viewed: ReadonlySet<string>;
  /** When set, ticks call the host; otherwise they stay on this device. */
  pullRequest: { repo: string; number: number } | null;
  viewedNote: string | null;
  onOpen: (repo: string, file: ChangedFile) => void;
  onToggleViewed: (repo: string, file: ChangedFile) => void;
}) {
  const files = repos.flatMap((repo) => repo.files);
  const viewedTotal = repos.reduce(
    (sum, repo) => sum + repo.files.filter((file) => viewed.has(fileKey(repo.repo, file.path))).length,
    0,
  );

  return (
    <nav data-slot="changes-rail" aria-label="Changed files" className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <p className="text-xs text-ink-2">
            <span className="tnum text-ink">{viewedTotal}</span>
            <span> of </span>
            <span className="tnum text-ink">{files.length}</span>
            <span> viewed</span>
          </p>
          {pullRequest ? (
            viewedNote ? <p className="text-xs text-ink-3">{viewedNote}</p> : null
          ) : (
            <p className="text-xs text-ink-3">Viewed on this device.</p>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {repos.map((repo) => (
          <RepoGroup
            key={repo.repo || "unknown"}
            repo={repo}
            active={active}
            viewed={viewed}
            pullRequest={pullRequest}
            onOpen={onOpen}
            onToggleViewed={onToggleViewed}
          />
        ))}
      </div>
    </nav>
  );
}

function RepoGroup({
  repo,
  active,
  viewed,
  pullRequest,
  onOpen,
  onToggleViewed,
}: {
  repo: ChangedRepo;
  active: OpenFile | undefined;
  viewed: ReadonlySet<string>;
  pullRequest: { repo: string; number: number } | null;
  onOpen: (repo: string, file: ChangedFile) => void;
  onToggleViewed: (repo: string, file: ChangedFile) => void;
}) {
  const totals = repoTotals(repo);
  const nodes = useMemo(
    () => fileTreeFromChanges(repo.files.map((file) => ({ path: file.path, additions: file.added, deletions: file.removed }))),
    [repo.files],
  );
  const byPath = useMemo(() => new Map(repo.files.map((file) => [file.path, file])), [repo.files]);
  return (
    <Collapsible defaultOpen className="border-b border-line">
      <CollapsibleTrigger className="flex w-full min-h-8 items-center gap-2 px-3 py-2 text-start outline-none hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live [@media(pointer:coarse)]:min-h-11">
        <ChevronRight className="size-3.5 shrink-0 text-ink-3 [[data-state=open]_&]:rotate-90" />
        <span className="typed min-w-0 flex-1 truncate text-sm text-ink">{repo.repo}</span>
        {repo.branch ? <span className="typed max-w-24 truncate text-xs text-ink-3">{repo.branch}</span> : null}
        <DiffStat added={totals.added} removed={totals.removed} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        {repo.error ? (
          <p className="px-3 py-2 text-sm text-danger">{repo.error}</p>
        ) : (
          <ul role="tree" className="flex flex-col pb-2">
            {nodes.map((node) => {
              if (node.kind === "folder") {
                return (
                  <li key={`folder:${node.path}`} role="treeitem" aria-level={node.depth + 1}>
                    <div
                      className="flex min-h-8 w-full min-w-0 items-center gap-2 px-3 py-1 text-sm text-ink-2"
                      style={{ paddingInlineStart: `calc(var(--spacing) * ${3 + node.depth * 4})` }}
                      title={node.path}
                    >
                      <Folder aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
                      <span className={cn(mono, "min-w-0 truncate")}>{node.name}</span>
                    </div>
                  </li>
                );
              }
              const file = byPath.get(node.path);
              if (!file) return null;
              const selected = active?.repo === repo.repo && active.path === file.path;
              const tick = viewed.has(fileKey(repo.repo, file.path));
              return (
                <li key={file.path} role="treeitem" aria-level={node.depth + 1} aria-selected={selected} className="flex min-w-0 items-stretch">
                  <button
                    type="button"
                    onClick={() => onOpen(repo.repo, file)}
                    title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                    style={{ paddingInlineStart: `calc(var(--spacing) * ${3 + node.depth * 4})` }}
                    className={cn(
                      "flex min-h-8 min-w-0 flex-1 items-center gap-2 py-1 pe-3 text-start outline-none",
                      "[@media(pointer:coarse)]:min-h-11",
                      "hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
                      selected && "bg-surface-2",
                    )}
                  >
                    <span className="typed w-3 shrink-0 text-xs text-ink-3" title={statusLabel(file.status)}>
                      {statusMark(file.status)}
                    </span>
                    <File aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
                    <span className={cn(mono, "min-w-0 flex-1 truncate text-ink")}>{node.name}</span>
                    <DiffStat added={file.added} removed={file.removed} />
                  </button>
                  <button
                    type="button"
                    aria-pressed={tick}
                    aria-label={
                      tick
                        ? `Mark ${fileName(file.path)} as unread`
                        : pullRequest
                          ? `Mark ${fileName(file.path)} as viewed`
                          : `Mark ${fileName(file.path)} as viewed on this device`
                    }
                    onClick={() => onToggleViewed(repo.repo, file)}
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center text-ink-3 outline-none",
                      "[@media(pointer:coarse)]:size-11",
                      "hover:bg-surface-2 hover:text-ink",
                      "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
                      tick && "text-ok",
                    )}
                  >
                    <Check className="size-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
