import { FileCode2 } from "lucide-react";
import type { ChangedFile, ProjectChanges, RepoChanges } from "@lasercode/protocol";

import { DiffStat } from "@/components/assistant-ui/elements/code-diff";
import { ControlHint } from "@/components/ui/hint";
import { openChanges } from "@/source-control/store.js";
import { shortCwd } from "@/format";
import { suffixTruncate } from "@/fleet/truncate.js";
import { cn } from "@/lib/utils";

import { count, fileTotals, filesHeader } from "./format.js";
import { InstrumentCard, TelemetrySection } from "./section.js";

export type FilesStatus = "idle" | "loading" | "ready" | "error";

export function FilesSection({
  changes,
  status,
  message,
  sessionKey,
  open,
  onOpenChange,
}: {
  changes: ProjectChanges | undefined;
  status: FilesStatus;
  message?: string | undefined;
  sessionKey: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const totals = fileTotals(changes);
  return (
    <TelemetrySection id="files" title="Files" icon={FileCode2} number={filesHeader(totals)} open={open} onOpenChange={onOpenChange}>
      {status === "loading" ? (
        <p className="text-xs leading-4 text-ink-3">Reading changes…</p>
      ) : status === "error" ? (
        <p className="text-xs leading-4 text-ink-2">{message ?? "Could not read changes."}</p>
      ) : changes?.pruned ? (
        <p data-slot="telemetry-files-pruned" className="text-xs leading-4 text-ink-2">
          {changes.pruned.detail}
        </p>
      ) : totals.files === 0 ? (
        <p className="text-xs leading-4 text-ink-2">No changes in this workspace.</p>
      ) : (
        <>
          <InstrumentCard className="mb-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs leading-4 text-ink-3">{totals.files === 1 ? "1 file" : `${count(totals.files)} files`}</p>
              <DiffStat added={totals.added} removed={totals.removed} />
            </div>
          </InstrumentCard>
          <div className="flex flex-col gap-3">
            {changes!.repos.map((repo) => (
              <RepoGroup key={repo.repo} repo={repo} sessionKey={sessionKey} />
            ))}
          </div>
        </>
      )}
    </TelemetrySection>
  );
}

function RepoGroup({ repo, sessionKey }: { repo: RepoChanges; sessionKey: string | undefined }) {
  const added = repo.files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const removed = repo.files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  const name = shortCwd(repo.repo);
  const branch = suffixTruncate(repo.branch);
  return (
    <div data-slot="telemetry-repo" data-repo={repo.repo}>
      <div className="mb-1 flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-xs font-medium text-ink" title={repo.repo}>
          {name}
        </span>
        <span className="min-w-0 truncate font-mono text-xs text-ink-3" title={repo.branch}>
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
  const open = (): void => {
    openChanges({
      scope: { kind: "session" },
      repo,
      path: file.path,
      ...(sessionKey ? { sessionKey } : {}),
    });
  };
  return (
    <li>
      <ControlHint hint={file.path}>
        <button
          type="button"
          data-slot="telemetry-file-row"
          data-repo={repo}
          data-path={file.path}
          aria-label={`${file.path} ${churnLabel(file)}`}
          onClick={open}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            open();
          }}
          className={cn(
            "flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-1 text-start outline-none",
            "pointer-coarse:min-h-11",
            "hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
          )}
        >
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{file.path}</span>
          <FileChurn file={file} />
        </button>
      </ControlHint>
    </li>
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
