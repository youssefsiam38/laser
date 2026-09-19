"use client";
/**
 * A turn's own undo control in the transcript (leap §7.4).
 *
 * Lives on the prompt footer beside Fork and Jump. Offers files, conversation,
 * or both — hiding a target the engine's preview says would do nothing — behind
 * one confirmation that shows, per repository, what the checkpoint puts back
 * and what it destroys: every path with its status and its `+added −removed`,
 * every row a way into that file's diff. Enter on the row never confirms (the
 * fleet Answer rule). Restore is refused with the engine's sentence while a
 * turn runs.
 *
 * Closing it is the shared dialog's business: Radix keeps a closed dialog in
 * the document until its exit animation reports `animationend`, and with
 * motion reduced there is no animation to report one — so the confirmation
 * used to stay on screen for good. The fix is in the token and in
 * `components/ui/exit-presence.ts`, and every dialog inherits it.
 */
import type {
  CheckpointInfo,
  ProjectChanges,
  ProjectChangesParams,
  RestorePreview,
  RestoreResult,
  RestoreTarget,
} from "@lasercode/protocol";
import { LoaderCircle, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { DiffStat } from "@/components/assistant-ui/elements/code-diff";
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
import { cn } from "@/lib/utils";
import { useCapability, useLaserStable, useLaserState } from "@/runtime";
// The store only, never the barrel: the barrel pulls the diff renderer into
// the startup chunk (D-317).
import { openChanges } from "@/source-control/store.js";

import { requestProjectGitRefresh } from "./project-git.js";
import {
  boundedRows,
  changesTurnForUndo,
  defaultRestoreTarget,
  fileRowDescription,
  fileStatusLabel,
  isBinaryRow,
  lostFileCount,
  lostWorkSentence,
  moreRowsLabel,
  previewHasWork,
  refusedRepos,
  repoLeafName,
  repoRefusalSentence,
  repoTotalLabel,
  restoreErrorText,
  restoreIncludesConversation,
  restoreIncludesFiles,
  restoreSuccessCopy,
  restoreTargetLabel,
  restoreWhatCopy,
  turnCheckpoint,
  undoRepoRows,
  undoSummaryLine,
  visibleRestoreTargets,
  type UndoFileRow,
  type UndoRepoRows,
} from "./undo-turn.js";

export function UndoTurn({ turn, at, className }: { turn: number; at?: string | undefined; className?: string }) {
  const restore = useCapability("pi/project/restore");
  const path = useLaserState((s) => s.current);
  const cwd = useLaserState((s) => {
    if (!s.current) return undefined;
    return s.open[s.current]?.state.cwd ?? s.sessions.find((row) => row.path === s.current)?.cwd;
  });
  const checkpoints = useSessionCheckpoints(path, cwd, restore.state === "available");
  if (restore.state !== "available" || !path || !cwd) return null;
  const checkpoint = turnCheckpoint(checkpoints, turn);
  if (!checkpoint) return null;
  return (
    <UndoTurnControl
      turn={turn}
      path={path}
      cwd={cwd}
      at={at ?? checkpoint.createdAt}
      className={className}
    />
  );
}

function useSessionCheckpoints(
  path: string | undefined,
  cwd: string | undefined,
  enabled: boolean,
): CheckpointInfo[] | undefined {
  const { client } = useLaserStable();
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[] | undefined>(undefined);

  useEffect(() => {
    if (!enabled || !path || !cwd) {
      setCheckpoints(undefined);
      return;
    }
    if (typeof client.request !== "function") {
      setCheckpoints([]);
      return;
    }
    let cancelled = false;
    void client.request("pi/project/checkpoint/list", { cwd, path }).then(
      (result) => {
        if (!cancelled) setCheckpoints(result.checkpoints ?? []);
      },
      () => {
        if (!cancelled) setCheckpoints([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, cwd, enabled, path]);
  return checkpoints;
}

function UndoTurnControl({
  turn,
  path,
  cwd,
  at,
  className,
}: {
  turn: number;
  path: string;
  cwd: string;
  at?: string | undefined;
  className?: string | undefined;
}) {
  const { client, actions } = useLaserStable();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<RestorePreview | undefined>(undefined);
  const [changes, setChanges] = useState<{ turn?: ProjectChanges; uncommitted?: ProjectChanges }>({});
  const [target, setTarget] = useState<RestoreTarget | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [refusals, setRefusals] = useState<string[]>([]);
  const [busy, setBusy] = useState<"preview" | "confirm" | undefined>(undefined);
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirming = useRef(false);
  const generation = useRef(0);

  const reset = useCallback(() => {
    setPreview(undefined);
    setChanges({});
    setTarget(undefined);
    setError(undefined);
    setRefusals([]);
    setExpanded([]);
    setBusy(undefined);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    reset();
    // Anything still in flight for the closed dialog is no longer wanted.
    generation.current += 1;
  }, [reset]);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setBusy("preview");
    setError(undefined);
    setRefusals([]);
    setPreview(undefined);
    setChanges({});
    // Numbers come from the change lists, never from the preview: the turn
    // scope for the work this takes back, the uncommitted scope for the work
    // it destroys. Either may be refused (a pruned or baseline range); the
    // paths still show, without invented numbers.
    const numbers = async (params: ProjectChangesParams): Promise<ProjectChanges | undefined> => {
      try {
        return await client.request("pi/project/changes", params);
      } catch {
        return undefined;
      }
    };
    const turnScope = numbers({ cwd, path, scope: "turn", turn: changesTurnForUndo(turn) });
    const uncommittedScope = numbers({ cwd, path, scope: "uncommitted" });
    try {
      const result = await client.request("pi/project/restore", { cwd, path, turn, restore: "both" });
      if (generation.current !== mine) return;
      const next = result.preview;
      const visible = visibleRestoreTargets(next.hidden);
      setPreview(next);
      setTarget(defaultRestoreTarget(visible));
    } catch (failure) {
      if (generation.current !== mine) return;
      setError(restoreErrorText(failure));
    } finally {
      if (generation.current === mine) setBusy(undefined);
    }
    const [turnChanges, uncommittedChanges] = await Promise.all([turnScope, uncommittedScope]);
    if (generation.current !== mine) return;
    setChanges({
      ...(turnChanges ? { turn: turnChanges } : {}),
      ...(uncommittedChanges ? { uncommitted: uncommittedChanges } : {}),
    });
  }, [client, cwd, path, turn]);

  const openDialog = useCallback(() => {
    setOpen(true);
    reset();
    void load();
  }, [load, reset]);

  const confirm = useCallback(async () => {
    if (!preview || !target || busy || confirming.current) return;
    confirming.current = true;
    setBusy("confirm");
    setError(undefined);
    setRefusals([]);
    try {
      const result: RestoreResult = await client.request("pi/project/restore", {
        cwd,
        path,
        turn,
        restore: target,
        confirm: true,
      });
      const failed = refusedRepos(result.restored?.repos).map(repoRefusalSentence);
      if (result.restored?.conversation) await actions.rereadHistory();
      if (result.restored?.files) requestProjectGitRefresh();
      if (failed.length > 0) {
        setRefusals(failed);
        setBusy(undefined);
        return;
      }
      if (result.restored && (result.restored.files || result.restored.conversation)) {
        actions.toast("info", restoreSuccessCopy(preview, target, result.restored));
      }
      close();
    } catch (failure) {
      setError(restoreErrorText(failure));
      setBusy(undefined);
    } finally {
      confirming.current = false;
    }
  }, [actions, busy, client, close, cwd, path, preview, target, turn]);

  // A modal dialog hides the rest of the document from a screen reader and
  // traps focus, so the diff overlay cannot open behind it: the confirmation
  // steps aside and the person re-opens it after reading the change.
  const openDiff = useCallback(
    (repo: string, file: string) => {
      close();
      openChanges({
        scope: { kind: "turn", turnId: String(changesTurnForUndo(turn)) },
        repo,
        path: file,
        sessionKey: path,
      });
    },
    [close, path, turn],
  );

  const visible = preview ? visibleRestoreTargets(preview.hidden) : [];
  const chosen = target && visible.includes(target) ? target : undefined;
  const canConfirm = Boolean(preview && chosen && previewHasWork(preview, chosen) && busy !== "preview");

  return (
    <>
      <TooltipIconButton
        tooltip="Undo this turn"
        size="icon-xs"
        className={cn("text-ink-3", className)}
        data-slot="undo-turn"
        aria-haspopup="dialog"
        aria-expanded={open || undefined}
        onClick={openDialog}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        <Undo2 />
      </TooltipIconButton>
      <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
          showCloseButton={false}
          data-slot="undo-turn-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Undo this turn?</DialogTitle>
            <DialogDescription>
              {busy === "preview"
                ? "Checking what this would restore…"
                : chosen
                  ? `This restores ${restoreWhatCopy(chosen)}.`
                  : preview
                    ? "Nothing in this turn would change."
                    : "One confirmation before any files or the conversation move."}
            </DialogDescription>
          </DialogHeader>

          {preview && !error ? (
            <UndoTurnPreview
              preview={preview}
              changes={changes}
              target={chosen}
              visible={visible}
              turn={turn}
              at={at}
              expanded={expanded}
              onExpand={(key) => setExpanded((keys) => (keys.includes(key) ? keys : [...keys, key]))}
              onTarget={setTarget}
              onOpenDiff={openDiff}
            />
          ) : null}

          {error ? (
            <p role="alert" data-slot="undo-turn-error" className="border-s-2 border-danger ps-3 text-sm leading-sm text-ink">
              {error}
            </p>
          ) : null}

          {refusals.length > 0 ? (
            <div role="alert" data-slot="undo-turn-refusals" className="flex flex-col gap-2 border-s-2 border-danger ps-3 text-sm leading-sm text-ink">
              {refusals.map((sentence) => (
                <p key={sentence}>{sentence}</p>
              ))}
            </div>
          ) : null}

          <DialogFooter>
            <Button
              ref={cancelRef}
              type="button"
              variant="ghost"
              autoFocus
              onClick={close}
              disabled={busy === "confirm"}
              className="pointer-coarse:min-h-11"
            >
              {refusals.length > 0 ? "Close" : "Cancel"}
            </Button>
            {refusals.length === 0 && (canConfirm || busy === "confirm") ? (
              <Button
                type="button"
                variant="destructive"
                onClick={() => void confirm()}
                disabled={!canConfirm || busy === "confirm"}
                aria-busy={busy === "confirm" || undefined}
                data-slot="undo-turn-confirm"
                className="pointer-coarse:min-h-11"
              >
                {busy === "confirm" ? <LoaderCircle className="motion-safe:animate-sweep" aria-hidden="true" /> : null}
                {busy === "confirm" ? "Restoring…" : "Undo this turn"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function UndoTurnPreview({
  preview,
  changes,
  target,
  visible,
  turn,
  at,
  expanded,
  onExpand,
  onTarget,
  onOpenDiff,
}: {
  preview: RestorePreview;
  changes: { turn?: ProjectChanges; uncommitted?: ProjectChanges };
  target: RestoreTarget | undefined;
  visible: readonly RestoreTarget[];
  turn: number;
  at?: string | undefined;
  expanded: readonly string[];
  onExpand: (key: string) => void;
  onTarget: (target: RestoreTarget) => void;
  onOpenDiff: (repo: string, file: string) => void;
}) {
  const files = target ? restoreIncludesFiles(target) : false;
  const conversation = target ? restoreIncludesConversation(target) : false;
  const repos = files ? undoRepoRows(preview, changes.turn, changes.uncommitted) : [];
  const lost = lostFileCount(repos);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p data-slot="undo-turn-summary" className="tnum text-xs leading-xs text-ink-2">
        {undoSummaryLine({ rows: repos, files, turn, at })}
      </p>

      {visible.length > 1 ? (
        <div role="radiogroup" aria-label="What to restore" className="flex flex-col gap-1.5">
          {visible.map((option) => {
            const checked = option === target;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={checked}
                data-slot="undo-turn-target"
                data-target={option}
                onClick={() => onTarget(option)}
                className={cn(
                  "rounded-lg border px-3 py-2 text-start text-sm outline-none pointer-coarse:min-h-11",
                  "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
                  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
                  checked
                    ? "border-live bg-[color-mix(in_oklab,var(--live)_12%,transparent)] text-ink"
                    : "border-line bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink",
                )}
              >
                {restoreTargetLabel(option)}
              </button>
            );
          })}
        </div>
      ) : null}

      {conversation && preview.conversation ? (
        <p data-slot="undo-turn-conversation" className="text-sm text-ink-2">
          The conversation moves back to this turn.
        </p>
      ) : null}

      {repos.length > 0 ? (
        <div data-slot="undo-turn-lists" className="flex max-h-64 min-w-0 flex-col overscroll-contain overflow-y-auto">
          {repos.map((row, index) => (
            <RepoSection
              key={row.repo}
              row={row}
              first={index === 0}
              expanded={expanded}
              onExpand={onExpand}
              onOpenDiff={onOpenDiff}
            />
          ))}
        </div>
      ) : null}

      {lost > 0 ? (
        <p data-slot="undo-turn-lost-summary" className="border-s-2 border-danger ps-3 text-sm leading-sm text-ink">
          {lostWorkSentence(lost)}
        </p>
      ) : null}

      {files && preview.staging === "not_restored" && preview.detail ? (
        <p data-slot="undo-turn-staging" className="text-sm text-ink-2">
          {preview.detail}
        </p>
      ) : null}
    </div>
  );
}

function RepoSection({
  row,
  first,
  expanded,
  onExpand,
  onOpenDiff,
}: {
  row: UndoRepoRows;
  first: boolean;
  expanded: readonly string[];
  onExpand: (key: string) => void;
  onOpenDiff: (repo: string, file: string) => void;
}) {
  return (
    <section
      data-slot="undo-turn-repo"
      data-repo={row.repo}
      className={cn("flex min-w-0 flex-col gap-2 py-3", first ? "pt-0" : "hairline-t")}
    >
      <p className="flex min-w-0 items-baseline gap-2">
        <span className="typed min-w-0 truncate font-medium text-ink">{repoLeafName(row.repo)}</span>
        <span className="typed min-w-0 truncate text-ink-3">{row.branch}</span>
        <span data-slot="undo-turn-repo-total" className="typed ms-auto shrink-0 text-ink-2">
          {repoTotalLabel(row.totals)}
        </span>
      </p>
      <FileSection
        kind="files"
        label="Restored files"
        repo={row.repo}
        rows={row.restored}
        expanded={expanded}
        onExpand={onExpand}
        onOpenDiff={onOpenDiff}
      />
      {row.lost.length > 0 ? (
        <FileSection
          kind="lost"
          label="Uncommitted work that would be lost"
          repo={row.repo}
          rows={row.lost}
          expanded={expanded}
          onExpand={onExpand}
          onOpenDiff={onOpenDiff}
        />
      ) : null}
    </section>
  );
}

function FileSection({
  kind,
  label,
  repo,
  rows,
  expanded,
  onExpand,
  onOpenDiff,
}: {
  kind: "files" | "lost";
  label: string;
  repo: string;
  rows: readonly UndoFileRow[];
  expanded: readonly string[];
  onExpand: (key: string) => void;
  onOpenDiff: (repo: string, file: string) => void;
}) {
  const key = `${kind}:${repo}`;
  const { shown, hidden } = boundedRows(rows, expanded.includes(key));
  return (
    <div data-slot={kind === "lost" ? "undo-turn-lost" : "undo-turn-files"} className="flex min-w-0 flex-col gap-0.5">
      <span className={cn("eyebrow", kind === "lost" && "text-danger")}>{label}</span>
      <ul className="flex min-w-0 flex-col">
        {shown.map((row) => (
          <FileRow key={row.path} repo={repo} row={row} onOpenDiff={onOpenDiff} />
        ))}
        {hidden > 0 ? (
          <li>
            <button
              type="button"
              data-slot="undo-turn-more"
              onClick={() => onExpand(key)}
              className={cn(
                "min-h-8 rounded-md px-1 text-start text-xs leading-xs text-ink-2 outline-none pointer-coarse:min-h-11",
                "hover:text-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
              )}
            >
              {moreRowsLabel(hidden)}
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function FileRow({
  repo,
  row,
  onOpenDiff,
}: {
  repo: string;
  row: UndoFileRow;
  onOpenDiff: (repo: string, file: string) => void;
}) {
  const status = fileStatusLabel(row);
  return (
    <li>
      <button
        type="button"
        data-slot="undo-turn-file"
        data-repo={repo}
        data-path={row.path}
        aria-label={fileRowDescription(row)}
        onClick={() => onOpenDiff(repo, row.path)}
        className={cn(
          "flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-1 text-start outline-none pointer-coarse:min-h-11",
          "hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
        )}
      >
        <span className="typed min-w-0 flex-1 truncate text-ink">{row.path}</span>
        {status ? <span className="eyebrow shrink-0">{status}</span> : null}
        <FileChurn row={row} />
      </button>
    </li>
  );
}

function FileChurn({ row }: { row: UndoFileRow }) {
  if (isBinaryRow(row)) return null;
  if (typeof row.added !== "number" || typeof row.removed !== "number") return null;
  return <DiffStat added={row.added} removed={row.removed} />;
}
