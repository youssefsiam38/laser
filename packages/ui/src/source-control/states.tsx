import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { formatBytes } from "@/format";

import type { EmptyBody } from "./classify.js";
import { modeWords } from "./classify.js";
import type { AgentChangesContext } from "./contract.js";

export function ChangesNotice({
  title,
  children,
  action,
  className,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="changes-notice" className={cn("flex min-h-0 flex-1 flex-col justify-center gap-3 px-6 py-10", className)}>
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <div className="max-w-(--measure-prose) text-md text-ink-2">{children}</div>
      {action}
    </div>
  );
}

export function NoChangesState() {
  return (
    <ChangesNotice title="Nothing changed">
      <p>Nothing changed in this scope. These are the changes inside this workspace.</p>
    </ChangesNotice>
  );
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
      <p>{message} Try again, or pick another repository.</p>
    </ChangesNotice>
  );
}

export function AgentGoneState() {
  return (
    <ChangesNotice title="This agent's branch is gone">
      <p>The branch for this agent is gone, so there is nothing to show.</p>
    </ChangesNotice>
  );
}

export function AgentCheckoutLine({ context }: { context: AgentChangesContext }) {
  if (context.branchGone) return null;
  if (context.worktreeRemoved && context.branch) {
    return (
      <p data-slot="changes-agent-checkout" className="min-w-0 truncate text-xs text-ink-3">
        This worktree was removed. Showing branch {context.branch}, which still exists.
      </p>
    );
  }
  if (context.checkout === "shared") {
    return (
      <p data-slot="changes-agent-checkout" className="min-w-0 truncate text-xs text-ink-3">
        This agent · shared checkout
      </p>
    );
  }
  return (
    <p data-slot="changes-agent-checkout" className="min-w-0 truncate text-xs text-ink-3" title={context.worktreePath}>
      This agent · worktree{context.worktreePath ? ` at ${context.worktreePath}` : ""}
    </p>
  );
}

export function EmptyBodyState({ body }: { body: EmptyBody }) {
  if (body.kind === "binary") {
    const size = body.size !== undefined ? `, ${formatBytes(body.size)}` : "";
    return (
      <ChangesNotice title="Binary file">
        <p>
          <span className="typed text-ink">{body.path}</span> is a binary file{size}. A diff of its bytes would not help.
        </p>
      </ChangesNotice>
    );
  }
  if (body.kind === "rename-pure") {
    return (
      <ChangesNotice title="Renamed">
        <p>
          <span className="typed text-ink">{body.oldPath ?? body.path}</span> is now{" "}
          <span className="typed text-ink">{body.path}</span>. The contents did not change.
        </p>
      </ChangesNotice>
    );
  }
  return (
    <ChangesNotice title="Mode change">
      <p>
        <span className="typed text-ink">{body.path}</span> is now {modeWords(body.prevMode, body.mode)}. The contents did
        not change.
      </p>
    </ChangesNotice>
  );
}

export function DeletedFileState({ path }: { path: string }) {
  return (
    <ChangesNotice title="Deleted">
      <p>
        <span className="typed text-ink">{path}</span> was deleted.
      </p>
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
      action={
        <Button onClick={onReveal}>
          Show the changed hunks
        </Button>
      }
    >
      <p>
        <span className="typed text-ink">{path}</span> is {lines.toLocaleString().replace(/,/g, "\u00a0")} lines.
        It opens collapsed so the reader stays light. Expansion is by hunk.
      </p>
    </ChangesNotice>
  );
}

export function OverlayLoadingState() {
  return (
    <div data-slot="changes-loading" className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-8" role="status">
      <h2 className="text-lg font-semibold text-ink">Opening the file</h2>
      <p className="max-w-(--measure-prose) text-md text-ink-2">The reader is loading. This only happens the first time.</p>
      <div className="flex flex-col gap-2" aria-hidden="true">
        <Skeleton className="h-8 w-full" />
        <SkeletonText width="80%" />
        <SkeletonText width="64%" />
        <SkeletonText width="72%" />
        <Skeleton className="mt-4 h-40 w-full" />
      </div>
    </div>
  );
}

export function DiffLoadingState({ path }: { path: string }) {
  return (
    <div data-slot="changes-diff-loading" className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-8" role="status">
      <h2 className="text-lg font-semibold text-ink">Reading the file</h2>
      <p className="typed text-ink-2">{path}</p>
      <div className="flex flex-col gap-2" aria-hidden="true">
        <SkeletonText width="90%" />
        <SkeletonText width="70%" />
        <SkeletonText width="82%" />
      </div>
    </div>
  );
}

export function PickFileState() {
  return (
    <ChangesNotice title="Pick a file">
      <p>Open a changed file from the list. The conversation stays where you left it.</p>
    </ChangesNotice>
  );
}

export function UnifiedFallbackNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div data-slot="changes-unified-notice" className="flex items-center gap-3 border-b border-line bg-surface-2 px-4 py-2 text-xs text-ink-2">
      <p className="min-w-0 flex-1">Split needs two columns of code, so this view is unified.</p>
      <Button variant="ghost" size="xs" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

export function TruncatedPatchState({ onMore, loading }: { onMore: () => void; loading: boolean }) {
  return (
    <div data-slot="changes-truncated" className="flex shrink-0 items-center gap-3 border-t border-line bg-surface-2 px-4 py-2">
      <p className="min-w-0 flex-1 text-xs text-ink-2">This patch is large, so only part of it is shown.</p>
      <Button variant="outline" size="sm" onClick={onMore} disabled={loading}>
        {loading ? "Loading" : "Show more"}
      </Button>
    </div>
  );
}
