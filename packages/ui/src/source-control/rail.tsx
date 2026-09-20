/**
 * The changed files, as a tree.
 *
 * Depth is drawn with hairline rails rather than blank padding, so the eye
 * can follow a nested path back to its folder; folder chains that hold one
 * child are already collapsed by `fileTreeFromChanges`, so `packages/ui/src`
 * is one row. The file name is the one thing that never gets truncated away:
 * the row ellipsizes the stem and keeps the extension (`truncatableParts`).
 * `+/−` are tabular and end the row; the viewed tick stays invisible until it
 * is on or the row is under the pointer or focus.
 */
import { useMemo } from "react";
import { Check, ChevronRight, Folder } from "lucide-react";

import { fileTreeFromChanges } from "@/components/assistant-ui/elements/file-tree.js";
import { ControlHint } from "@/components/ui/hint";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

import { fileName, fileKey, repoTotals, statusLabel, statusMark, truncatableParts } from "./classify.js";
import type { ChangedFile, ChangedRepo } from "./contract.js";
import { repoLeafName } from "./git-model.js";
import type { OpenFile } from "./store.js";
import { ChangeTotals } from "./totals.js";

/** One hairline per level of depth, drawn where the indent would have been. */
function TreeRails({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <>
      {Array.from({ length: depth }, (_, level) => (
        <span key={level} aria-hidden="true" className="w-3 shrink-0 self-stretch hairline-s" />
      ))}
    </>
  );
}

/** A label that ellipsizes its head and keeps its tail (extension, last folder). */
function MiddleTruncated({ label, kind, className }: { label: string; kind: "file" | "path"; className?: string }) {
  const parts = truncatableParts(label, kind);
  return (
    <span className={cn("flex min-w-0 items-baseline", className)}>
      <span className="min-w-0 truncate">{parts.head}</span>
      {parts.tail ? <span className="shrink-0">{parts.tail}</span> : null}
    </span>
  );
}

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
      <div className="flex shrink-0 flex-col gap-0.5 hairline-b px-3 py-2">
        <p className="text-sm leading-sm text-ink-2">
          <span className="tnum text-ink">{viewedTotal}</span>
          <span> of </span>
          <span className="tnum text-ink">{files.length}</span>
          <span> viewed</span>
        </p>
        {pullRequest ? (
          viewedNote ? <p className="text-sm leading-sm text-ink-3">{viewedNote}</p> : null
        ) : (
          <p className="text-sm leading-sm text-ink-3">Viewed on this device.</p>
        )}
      </div>
      <div
        data-slot="changes-rail-scroll"
        role="region"
        aria-label="File list"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live"
      >
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
    <Collapsible defaultOpen className="hairline-b">
      <ControlHint hint={repo.branch ? `${repo.repo} · ${repo.branch}` : repo.repo}>
        <CollapsibleTrigger className="flex min-h-8 w-full items-center gap-2 px-3 py-2 text-start outline-none hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live pointer-coarse:min-h-11">
          <ChevronRight className="size-4 shrink-0 text-ink-3 transition-transform duration-(--motion-fast) motion-reduce:transition-none [[data-state=open]_&]:rotate-90 rtl:-scale-x-100 rtl:[[data-state=open]_&]:-rotate-90" />
          {/* A repository is a name, so it is prose at the body size; the
              branch beside it is a git ref, so it stays typed. */}
          <span className="min-w-0 flex-1 truncate text-sm leading-sm font-medium text-ink">{repoLeafName(repo.repo)}</span>
          {repo.branch ? <span className="typed max-w-24 shrink truncate text-ink-3">{repo.branch}</span> : null}
          <ChangeTotals added={totals.added} removed={totals.removed} empty="—" />
        </CollapsibleTrigger>
      </ControlHint>
      <CollapsibleContent>
        {repo.error ? (
          <p className="px-3 py-2 text-sm text-ink-2">
            <span className="text-danger">{repo.error}</span>
          </p>
        ) : (
          <ul role="tree" aria-label={`${repoLeafName(repo.repo)} files`} className="flex flex-col pb-2">
            {nodes.map((node) => {
              if (node.kind === "folder") {
                return (
                  <li key={`folder:${node.path}`} role="treeitem" aria-level={node.depth + 1}>
                    <div className="flex min-h-7 w-full min-w-0 items-stretch ps-2">
                      <TreeRails depth={node.depth} />
                      <span className="flex min-w-0 flex-1 items-center gap-1.5 pe-3 ps-1">
                        <Folder aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
                        <MiddleTruncated label={node.name} kind="path" className="typed text-ink-2" />
                      </span>
                    </div>
                  </li>
                );
              }
              const file = byPath.get(node.path);
              if (!file) return null;
              const selected = active?.repo === repo.repo && active.path === file.path;
              const tick = viewed.has(fileKey(repo.repo, file.path));
              return (
                <li
                  key={file.path}
                  role="treeitem"
                  aria-level={node.depth + 1}
                  aria-selected={selected}
                  className={cn("group/row flex min-w-0 items-stretch", selected && "bg-surface-2")}
                >
                  <ControlHint hint={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
                    <button
                      type="button"
                      onClick={() => onOpen(repo.repo, file)}
                      className={cn(
                        "flex min-h-8 min-w-0 flex-1 items-stretch ps-2 text-start outline-none",
                        "pointer-coarse:min-h-11",
                        "hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
                      )}
                    >
                      <TreeRails depth={node.depth} />
                      <span className="flex min-w-0 flex-1 items-center gap-1.5 ps-1">
                        <span aria-hidden="true" className="typed w-3 shrink-0 text-ink-3">
                          {statusMark(file.status)}
                        </span>
                        <span className="sr-only">{statusLabel(file.status)}</span>
                        <MiddleTruncated
                          label={node.name}
                          kind="file"
                          className={cn("typed flex-1", selected ? "text-ink" : "text-ink-2")}
                        />
                        <ChangeTotals added={file.added} removed={file.removed} empty="—" />
                      </span>
                    </button>
                  </ControlHint>
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
                      "pointer-coarse:size-11 pointer-coarse:opacity-100",
                      "transition-opacity duration-(--motion-instant) motion-reduce:transition-none",
                      "hover:bg-surface-2 hover:text-ink",
                      "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live focus-visible:opacity-100",
                      "group-hover/row:opacity-100",
                      tick ? "text-ok opacity-100" : "opacity-0",
                    )}
                  >
                    <Check className="size-4" />
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
