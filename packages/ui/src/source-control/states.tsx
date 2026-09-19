import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { ControlHint } from "@/components/ui/hint";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { formatBytes } from "@/format";

import type { EmptyBody } from "./classify.js";
import { changeCount, modeWords } from "./classify.js";
import type { AgentChangesContext } from "./contract.js";
import { overlayWorkspaceEmptyCopy, type WorkspaceEmptyKind } from "./workspace-shape.js";

/**
 * Every state in the body has the same shape: what happened, then what it
 * means or what to do about it, and the act if there is one. Start-aligned on
 * the body's own ground at the body's own rhythm (`px-4`, the toolbar's step),
 * never a paragraph of grey text floating in the middle of the pane.
 */
export function ChangesNotice({
  title,
  children,
  action,
  className,
  ...rest
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
} & Omit<ComponentProps<"div">, "title" | "children">) {
  return (
    <div
      data-slot="changes-notice"
      className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-6", className)}
      {...rest}
    >
      <h2 className="text-md font-semibold text-ink">{title}</h2>
      <div className="flex max-w-(--measure-prose) flex-col gap-1 text-sm leading-sm text-ink-2">{children}</div>
      {action ? <div className="flex flex-wrap items-center gap-2 pt-2">{action}</div> : null}
    </div>
  );
}

/** A path inside a sentence: typed, isolated, and never the thing that wraps. */
function Typed({ children }: { children: ReactNode }) {
  return <span className="typed break-all text-ink">{children}</span>;
}

export function NoChangesState() {
  return (
    <ChangesNotice title="Nothing changed">
      <p>Nothing in this scope has changed yet.</p>
      <p>A file appears here the moment you or an agent edits it in this workspace.</p>
    </ChangesNotice>
  );
}

export function WorkspaceEmptyState({ kind }: { kind: Exclude<WorkspaceEmptyKind, "empty"> }) {
  const copy = overlayWorkspaceEmptyCopy(kind);
  return (
    <ChangesNotice title={copy.title}>
      <p data-slot="workspace-empty" data-kind={kind}>
        {copy.body}
      </p>
      <p>{workspaceEmptyNextLine(kind)}</p>
    </ChangesNotice>
  );
}

function workspaceEmptyNextLine(kind: Exclude<WorkspaceEmptyKind, "empty">): string {
  switch (kind) {
    case "no-git":
      return "Run git init in this folder, or open a project that is already a repository.";
    case "untouched":
      return "Pick another scope, or come back once a turn has edited something.";
    case "unsupported":
      return "Open the repository this one belongs to and the changes are all there.";
  }
}

export function RepoFailedState({ repo, message, onRetry }: { repo: string; message: string; onRetry?: () => void }) {
  return (
    <ChangesNotice
      title={`Could not read ${repo}`}
      action={
        onRetry ? (
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    >
      <p>{message}</p>
      <p>Try again, or pick another repository from the toolbar.</p>
    </ChangesNotice>
  );
}

export function AgentGoneState() {
  return (
    <ChangesNotice title="This agent's branch is gone">
      <p>The branch this agent worked on has been removed.</p>
      <p>There is nothing left to compare it against, so this scope stays empty.</p>
    </ChangesNotice>
  );
}

export function AgentCheckoutLine({ context, className }: { context: AgentChangesContext; className?: string }) {
  if (context.branchGone) return null;
  const line = (text: string, hint?: string) => {
    const paragraph = (
      <p data-slot="changes-agent-checkout" className={cn("min-w-0 truncate text-xs text-ink-3", className)}>
        {text}
      </p>
    );
    return hint ? <ControlHint hint={hint}>{paragraph}</ControlHint> : paragraph;
  };
  if (context.worktreeRemoved && context.branch) {
    return line(`This worktree was removed. Showing branch ${context.branch}, which still exists.`);
  }
  if (context.checkout === "shared") return line("This agent · shared checkout");
  return line(
    `This agent · worktree${context.worktreePath ? ` at ${context.worktreePath}` : ""}`,
    context.worktreePath,
  );
}

export function EmptyBodyState({ body }: { body: EmptyBody }) {
  if (body.kind === "binary") {
    const size = body.size !== undefined ? `, ${formatBytes(body.size)}` : "";
    return (
      <ChangesNotice title="Binary file">
        <p>
          <Typed>{body.path}</Typed> is a binary file{size}.
        </p>
        <p>A diff of its bytes would tell you nothing, so open it where it is meant to be read.</p>
      </ChangesNotice>
    );
  }
  if (body.kind === "rename-pure") {
    return (
      <ChangesNotice title="Renamed">
        <p>
          <Typed>{body.oldPath ?? body.path}</Typed> is now <Typed>{body.path}</Typed>.
        </p>
        <p>The contents did not change, so there is nothing to read here.</p>
      </ChangesNotice>
    );
  }
  return (
    <ChangesNotice title="Mode change">
      <p>
        <Typed>{body.path}</Typed> is now {modeWords(body.prevMode, body.mode)}.
      </p>
      <p>The contents did not change, so there is nothing to read here.</p>
    </ChangesNotice>
  );
}

export function DeletedFileState({ path }: { path: string }) {
  return (
    <ChangesNotice title="Deleted">
      <p>
        <Typed>{path}</Typed> was deleted in this scope.
      </p>
      <p>Its last contents are in the history of the branch this scope compares against.</p>
    </ChangesNotice>
  );
}

export function DiffErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <ChangesNotice
      title="Could not read this file"
      action={
        onRetry ? (
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    >
      <p>{message}</p>
      <p>Nothing was changed by trying; the file is still whatever it is on disk.</p>
    </ChangesNotice>
  );
}

export function LargeFileState({
  path,
  lines,
  onReveal,
}: {
  path: string;
  lines: number;
  onReveal: () => void;
}) {
  return (
    <ChangesNotice
      title="This file is large"
      action={<Button onClick={onReveal}>Show the changed hunks</Button>}
    >
      <p>
        <Typed>{path}</Typed> changed on <span className="tnum">{changeCount(lines)}</span> lines.
      </p>
      <p>It opens collapsed so the reader stays quick; the hunks expand one at a time.</p>
    </ChangesNotice>
  );
}

export function OverlayLoadingState() {
  return (
    <ChangesNotice data-slot="changes-loading" role="status" title="Opening the file">
      <p>The reader is loading. This only happens the first time.</p>
      <div className="flex flex-col gap-2 pt-2" aria-hidden="true">
        <SkeletonText width="80%" />
        <SkeletonText width="64%" />
        <SkeletonText width="72%" />
        <Skeleton className="mt-2 h-40 w-full" />
      </div>
    </ChangesNotice>
  );
}

export function DiffLoadingState({ path }: { path: string }) {
  return (
    <ChangesNotice data-slot="changes-diff-loading" role="status" title="Reading the file">
      <p>
        <Typed>{path}</Typed>
      </p>
      <div className="flex flex-col gap-2 pt-2" aria-hidden="true">
        <SkeletonText width="90%" />
        <SkeletonText width="70%" />
        <SkeletonText width="82%" />
      </div>
    </ChangesNotice>
  );
}

export function PickFileState() {
  return (
    <ChangesNotice title="Pick a file">
      <p>Open a changed file from the list to read what changed in it.</p>
      <p>The conversation stays exactly where you left it.</p>
    </ChangesNotice>
  );
}

export function UnifiedFallbackNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div data-slot="changes-unified-notice" className="flex items-center gap-3 hairline-b bg-surface-2 px-4 py-1.5 text-sm leading-sm text-ink-2">
      <p className="min-w-0 flex-1">Split needs two columns of code, so this view is unified.</p>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

export function TruncatedPatchState({ onMore, loading }: { onMore: () => void; loading: boolean }) {
  return (
    <div data-slot="changes-truncated" className="flex shrink-0 items-center gap-3 hairline-t bg-surface-2 px-4 py-1.5">
      <p className="min-w-0 flex-1 text-sm leading-sm text-ink-2">This patch is large, so only part of it is shown.</p>
      <Button variant="outline" onClick={onMore} disabled={loading}>
        {loading ? "Loading" : "Show more"}
      </Button>
    </div>
  );
}
