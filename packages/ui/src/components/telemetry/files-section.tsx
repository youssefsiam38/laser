import { useState } from "react";
import { FileCode2, RefreshCw } from "lucide-react";
import type { ChangedFile, ProjectChanges, RepoChanges } from "@lasercode/protocol";

import { DiffStat } from "@/components/assistant-ui/elements/code-diff";
import { ControlHint } from "@/components/ui/hint";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useSessionMeta } from "@/runtime";
import { openChanges } from "@/source-control/store.js";
import { filesWorkspaceEmptyText, workspaceEmptyKind } from "@/source-control/workspace-shape.js";
import { suffixTruncate } from "@/fleet/truncate.js";
import { cn } from "@/lib/utils";

import {
  count,
  fileTotals,
  filesErrorText,
  filesHeader,
  filesIdleText,
  pathDisplay,
  repoLabel,
  type FilesStatus,
} from "./format.js";
import { useWorkspaceShape } from "./queries.js";
import { FigureNote, TelemetrySection } from "./section.js";

export type { FilesStatus };

export function FilesSection({
  changes,
  status,
  message,
  sessionKey,
  open,
  onOpenChange,
  onRefresh,
}: {
  changes: ProjectChanges | undefined;
  status: FilesStatus;
  message?: string | undefined;
  sessionKey: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRefresh?: (() => void) | undefined;
}) {
  const totals = fileTotals(changes);
  const meta = useSessionMeta();
  const [shapeRefresh, setShapeRefresh] = useState(0);
  const workspace = useWorkspaceShape(meta.session?.cwd, shapeRefresh);
  const refresh = onRefresh
    ? () => {
        setShapeRefresh((n) => n + 1);
        onRefresh();
      }
    : undefined;
  const emptyKind = workspaceEmptyKind(workspace.shape);
  return (
    <TelemetrySection
      id="files"
      title="Files"
      icon={FileCode2}
      number={filesHeader(totals, status)}
      open={open}
      onOpenChange={onOpenChange}
      action={
        refresh && status !== "idle" ? (
          <TooltipIconButton
            tooltip="Refresh files"
            size="icon-xs"
            className="text-ink-3"
            disabled={status === "loading"}
            onClick={refresh}
          >
            <RefreshCw />
          </TooltipIconButton>
        ) : null
      }
    >
      {status === "loading" ? (
        <FigureNote>Reading changes…</FigureNote>
      ) : status === "error" ? (
        <FigureNote slot="telemetry-files-error">{message ?? filesErrorText()}</FigureNote>
      ) : status === "idle" ? (
        <FigureNote slot="telemetry-files-idle">{filesIdleText()}</FigureNote>
      ) : changes?.pruned ? (
        <FigureNote slot="telemetry-files-pruned">{changes.pruned.detail}</FigureNote>
      ) : !changes || totals.files === 0 ? (
        workspace.status === "loading" ? (
          <FigureNote>Reading changes…</FigureNote>
        ) : (
          <FigureNote slot="telemetry-files-empty" kind={emptyKind}>
            {filesWorkspaceEmptyText(emptyKind)}
          </FigureNote>
        )
      ) : (
        <div className="flex flex-col gap-2">
          <p className="flex items-baseline justify-between gap-3 text-xs leading-xs text-ink-2">
            {totals.files === 1 ? "1 file" : `${count(totals.files)} files`}
            <DiffStat added={totals.added} removed={totals.removed} />
          </p>
          {changes.repos.map((repo) => (
            <RepoGroup key={repo.repo} repo={repo} sessionKey={sessionKey} />
          ))}
        </div>
      )}
    </TelemetrySection>
  );
}

function RepoGroup({ repo, sessionKey }: { repo: RepoChanges; sessionKey: string | undefined }) {
  const added = repo.files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const removed = repo.files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  const name = repoLabel(repo.repo);
  const branch = suffixTruncate(repo.branch);
  return (
    <div data-slot="telemetry-repo" data-repo={repo.repo}>
      <div className="flex min-w-0 items-baseline gap-2 py-1">
        <span className="min-w-0 truncate text-xs leading-xs font-medium text-ink" title={repo.repo}>
          {name}
        </span>
        <span data-slot="telemetry-repo-branch" className="min-w-0 shrink-0 truncate typed text-ink-3" title={repo.branch}>
          {branch}
        </span>
        <span className="ms-auto shrink-0">
          <DiffStat added={added} removed={removed} />
        </span>
      </div>
      <ul className="flex flex-col">
        {repo.files.map((file) => (
          <FileRow key={file.path} repo={repo.repo} file={file} sessionKey={sessionKey} />
        ))}
      </ul>
    </div>
  );
}

function FileRow({ repo, file, sessionKey }: { repo: string; file: ChangedFile; sessionKey: string | undefined }) {
  return (
    <li>
      <ControlHint hint={file.path}>
        <button
          type="button"
          data-slot="telemetry-file-row"
          data-repo={repo}
          data-path={file.path}
          aria-label={`${file.path} ${churnLabel(file)}`}
          onClick={() =>
            openChanges({
              scope: { kind: "session" },
              repo,
              path: file.path,
              ...(sessionKey ? { sessionKey } : {}),
            })
          }
          className={cn(
            "flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-1 text-start outline-none",
            "pointer-coarse:min-h-11",
            "hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
          )}
        >
          <FilePath path={file.path} />
          <FileChurn file={file} />
        </button>
      </ControlHint>
    </li>
  );
}

/**
 * The name identifies the row, so the name is never what gives way: the
 * directory middle-truncates around it and the full path stays in the hint
 * and the accessible name.
 */
function FilePath({ path }: { path: string }) {
  const { dir, name } = pathDisplay(path);
  return (
    <span data-slot="telemetry-file-path" className="min-w-0 flex-1 typed">
      {dir ? <span className="text-ink-3">{dir}</span> : null}
      <span className="text-ink">{name}</span>
    </span>
  );
}

function FileChurn({ file }: { file: ChangedFile }) {
  if (file.added === null || file.removed === null) {
    return <span className="shrink-0 font-mono text-xs text-ink-3">binary</span>;
  }
  return <DiffStat added={file.added} removed={file.removed} />;
}

function churnLabel(file: ChangedFile): string {
  if (file.added === null || file.removed === null) return "binary";
  return `+${file.added} −${file.removed}`;
}
