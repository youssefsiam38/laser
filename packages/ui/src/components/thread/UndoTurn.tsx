"use client";
/**
 * A turn's own undo control in the transcript (leap §7.4).
 *
 * Lives on the prompt footer beside Fork and Jump. Offers files, conversation,
 * or both — hiding a target the engine's preview says would do nothing — behind
 * one confirmation that names the repositories and the uncommitted work at
 * risk. Enter on the row never confirms (the fleet Answer rule). Restore is
 * refused with the engine's sentence while a turn runs.
 */
import type { CheckpointInfo, RestorePreview, RestoreResult, RestoreTarget } from "@lasercode/protocol";
import { LoaderCircle, Undo2 } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { useCapability, useLaserStable, useLaserState } from "@/runtime";

import { requestProjectGitRefresh } from "./project-git.js";
import {
  defaultRestoreTarget,
  previewHasWork,
  refusedRepos,
  repoLeafName,
  repoRefusalSentence,
  reposAffectedByFiles,
  restoreErrorText,
  restoreIncludesConversation,
  restoreIncludesFiles,
  restoreSuccessCopy,
  restoreTargetLabel,
  restoreWhatCopy,
  turnCheckpoint,
  visibleRestoreTargets,
} from "./undo-turn.js";

export function UndoTurn({ turn, className }: { turn: number; className?: string }) {
  const restore = useCapability("pi/project/restore");
  const path = useLaserState((s) => s.current);
  const cwd = useLaserState((s) => {
    if (!s.current) return undefined;
    return s.open[s.current]?.state.cwd ?? s.sessions.find((row) => row.path === s.current)?.cwd;
  });
  const checkpoints = useSessionCheckpoints(path, cwd, restore.state === "available");
  if (restore.state !== "available" || !path || !cwd) return null;
  if (!turnCheckpoint(checkpoints, turn)) return null;
  return <UndoTurnControl turn={turn} path={path} cwd={cwd} className={className} />;
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
  className,
}: {
  turn: number;
  path: string;
  cwd: string;
  className?: string | undefined;
}) {
  const { client, actions } = useLaserStable();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<RestorePreview | undefined>(undefined);
  const [target, setTarget] = useState<RestoreTarget | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [refusals, setRefusals] = useState<string[]>([]);
  const [busy, setBusy] = useState<"preview" | "confirm" | undefined>(undefined);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirming = useRef(false);

  const reset = useCallback(() => {
    setPreview(undefined);
    setTarget(undefined);
    setError(undefined);
    setRefusals([]);
    setBusy(undefined);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    reset();
  }, [reset]);

  const loadPreview = useCallback(async () => {
    setBusy("preview");
    setError(undefined);
    setRefusals([]);
    setPreview(undefined);
    try {
      const result = await client.request("pi/project/restore", { cwd, path, turn, restore: "both" });
      const next = result.preview;
      const visible = visibleRestoreTargets(next.hidden);
      setPreview(next);
      setTarget(defaultRestoreTarget(visible));
    } catch (failure) {
      setError(restoreErrorText(failure));
    } finally {
      setBusy(undefined);
    }
  }, [client, cwd, path, turn]);

  const openDialog = useCallback(() => {
    setOpen(true);
    reset();
    void loadPreview();
  }, [loadPreview, reset]);

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
            <UndoTurnPreview preview={preview} target={chosen} visible={visible} onTarget={setTarget} />
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
  target,
  visible,
  onTarget,
}: {
  preview: RestorePreview;
  target: RestoreTarget | undefined;
  visible: readonly RestoreTarget[];
  onTarget: (target: RestoreTarget) => void;
}) {
  const files = target ? restoreIncludesFiles(target) : false;
  const conversation = target ? restoreIncludesConversation(target) : false;
  const repos = files ? reposAffectedByFiles(preview.repos) : [];

  return (
    <div className="flex flex-col gap-3">
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
        <ul className="flex flex-col gap-3">
          {repos.map((row) => (
            <li key={row.repo} data-slot="undo-turn-repo" className="flex min-w-0 flex-col gap-1">
              <p className="text-sm text-ink">
                <span className="typed font-medium">{repoLeafName(row.repo)}</span>
                <span className="text-ink-3"> · {row.branch}</span>
              </p>
              <PathList label="Restored files" paths={row.files} />
              {row.uncommittedLost.length > 0 ? (
                <PathList label="Uncommitted work that would be lost" paths={row.uncommittedLost} lost />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {files && preview.staging === "not_restored" && preview.detail ? (
        <p data-slot="undo-turn-staging" className="text-sm text-ink-2">
          {preview.detail}
        </p>
      ) : null}
    </div>
  );
}

function PathList({ label, paths, lost = false }: { label: string; paths: readonly string[]; lost?: boolean }) {
  return (
    <div data-slot={lost ? "undo-turn-lost" : "undo-turn-files"} className="flex min-w-0 flex-col gap-1">
      <span className="eyebrow">{label}</span>
      <ul className="max-h-32 overflow-y-auto rounded-lg bg-surface-2 px-3 py-2">
        {paths.map((path) => (
          <li key={path} className="typed wrap-break-word text-xs leading-xs text-ink">
            {path}
          </li>
        ))}
      </ul>
    </div>
  );
}
