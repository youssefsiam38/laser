"use client";
/**
 * `elements-file-tree` (assistant-ui registry), de-demoed and restyled:
 * everything a session touched, as a tree, with the churn per file
 * (docs/ux-elements.md "File tree"). Also the shape for a project browser.
 *
 * The registry copy takes pre-flattened nodes and a `visibleCount`. Here
 * `fileTreeFromChanges` builds the nodes from `{path, additions, deletions}`
 * — collapsing single-child folder chains so `packages/ui/src/…` reads as
 * one line — and `useSessionFileChanges` collects those changes from the
 * thread's edit and write calls. Folders are structure, not controls: the
 * tree is short (what one session touched), so nothing collapses.
 */
import { useAuiState, type ToolCallMessagePart, type ToolCallMessagePartStatus } from "@assistant-ui/react";
import { File, Folder } from "lucide-react";
import { useMemo, type ComponentProps } from "react";

import { diffStats, diffViewForTool } from "@/components/thread/diff";
import { resultDetails, toolKind } from "@/components/thread/tool-summary";
import { cn } from "@/lib/utils";

import { DiffStat } from "./code-diff.js";
import { mono } from "./surfaces.js";

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
}

export interface FileTreeNode {
  path: string;
  name: string;
  depth: number;
  kind: "folder" | "file";
  additions?: number | undefined;
  deletions?: number | undefined;
}

interface Dir {
  dirs: Map<string, Dir>;
  files: Map<string, FileChange>;
}

/** Depth-first nodes, folders first, single-child folder chains joined with `/`. */
export function fileTreeFromChanges(changes: readonly FileChange[]): FileTreeNode[] {
  const root: Dir = { dirs: new Map(), files: new Map() };
  for (const change of changes) {
    const parts = change.path.split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) continue;
    let dir = root;
    for (const part of parts) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: new Map() };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    const prev = dir.files.get(name);
    dir.files.set(name, {
      path: change.path,
      additions: (prev?.additions ?? 0) + change.additions,
      deletions: (prev?.deletions ?? 0) + change.deletions,
    });
  }

  const out: FileTreeNode[] = [];
  const emit = (dir: Dir, prefix: string, depth: number): void => {
    for (const [name, sub] of [...dir.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      // Collapse a chain of folders that each hold exactly one folder and nothing else.
      let label = name;
      let inner = sub;
      while (inner.dirs.size === 1 && inner.files.size === 0) {
        const [[childName, child]] = [...inner.dirs] as [[string, Dir]];
        label = `${label}/${childName}`;
        inner = child;
      }
      const path = prefix ? `${prefix}/${label}` : label;
      out.push({ path, name: label, depth, kind: "folder" });
      emit(inner, path, depth + 1);
    }
    for (const [name, file] of [...dir.files].sort(([a], [b]) => a.localeCompare(b))) {
      out.push({ path: file.path, name, depth, kind: "file", additions: file.additions, deletions: file.deletions });
    }
  };
  emit(root, "", 0);
  return out;
}

/** The shape both `thread.messages` and a projected message satisfy; parts are narrowed by `type`. */
export type MessageLike = { readonly id?: string; readonly parts: readonly { readonly type: string }[] };
type ToolPart = ToolCallMessagePart & { readonly status: ToolCallMessagePartStatus };

/** Per-file churn from every settled edit/write in `messages`. */
export function fileChangesFromParts(messages: readonly MessageLike[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-call") continue;
      const p = part as ToolPart;
      const kind = toolKind(p.toolName);
      if (kind !== "edit" && kind !== "write") continue;
      if (p.isError === true || p.status.type !== "complete") continue;
      const view = diffViewForTool(kind, p.args, resultDetails(p.result));
      if (!view?.path) continue;
      const { added, removed } = diffStats(view.hunks);
      const prev = byPath.get(view.path);
      byPath.set(view.path, { path: view.path, additions: (prev?.additions ?? 0) + added, deletions: (prev?.deletions ?? 0) + removed });
    }
  }
  return [...byPath.values()];
}

export function useSessionFileChanges(): FileChange[] {
  const messages = useAuiState((s) => s.thread.messages) as readonly MessageLike[];
  return useMemo(() => fileChangesFromParts(messages), [messages]);
}

export interface FileTreeProps extends Omit<ComponentProps<"div">, "children"> {
  changes: readonly FileChange[];
  /** Open a file, when the surface can (a document panel, the editor). */
  onOpen?: ((path: string) => void) | undefined;
}

export function FileTree({ changes, onOpen, className, ...props }: FileTreeProps) {
  const nodes = useMemo(() => fileTreeFromChanges(changes), [changes]);
  const files = changes.length;
  const added = changes.reduce((n, c) => n + c.additions, 0);
  const removed = changes.reduce((n, c) => n + c.deletions, 0);

  if (files === 0) {
    return (
      <p data-slot="file-tree" className={cn("text-sm text-ink-3", className)}>
        No files changed in this session.
      </p>
    );
  }

  return (
    <div data-slot="file-tree" className={cn("flex w-full min-w-0 flex-col gap-1.5", className)} {...props}>
      <div className="flex items-baseline justify-between gap-3 px-1">
        <span className="text-sm font-medium text-ink">
          {files} {files === 1 ? "file" : "files"} changed
        </span>
        <DiffStat added={added} removed={removed} />
      </div>
      <ul role="tree" className="flex flex-col">
        {nodes.map((node) => {
          const Row = node.kind === "file" && onOpen ? "button" : "div";
          return (
            <li key={node.path} role="treeitem" aria-level={node.depth + 1} aria-selected={false}>
              <Row
                {...(Row === "button" ? { type: "button" as const, onClick: () => onOpen?.(node.path) } : {})}
                className={cn(
                  "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1 text-start text-sm outline-none",
                  Row === "button" &&
                    "transition-colors duration-(--motion-instant) hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-live",
                )}
                style={{ paddingInlineStart: `calc(var(--spacing) * ${1 + node.depth * 4})` }}
                title={node.path}
              >
                {node.kind === "folder" ? (
                  <>
                    <Folder aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
                    <span className={cn(mono, "min-w-0 truncate text-ink-2")}>{node.name}</span>
                  </>
                ) : (
                  <>
                    <File aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" />
                    <span className={cn(mono, "min-w-0 flex-1 truncate text-ink")}>{node.name}</span>
                    <DiffStat added={node.additions ?? 0} removed={node.deletions ?? 0} />
                  </>
                )}
              </Row>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
