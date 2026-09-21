"use client";
/**
 * "Record my review…" — a person's word about a real build (M21-T19, D-353).
 *
 * **What this records, said plainly.** Native evidence is the project's own
 * build, rendered at an exact checkpoint, looked at by a person. Laser renders
 * nothing here: it does not run design code, does not open a browser and has
 * no preview runner (`AGENTS.md`, D-342). The checkpoint list in this Task is
 * identity, and the changes overlay shows files, not a running app. So this
 * dialog asks for exactly one thing — *you opened the build at this checkpoint
 * and compared it with this revision* — names the tuple it will write, and
 * takes a typed confirmation for it.
 *
 * What the host does with it is the proof: it checks that the caller is a
 * person, that the subject is still the revision it says, that the checkpoint
 * ref is one git really holds **and resolves to the commit named**, and it
 * stores a bounded capture of that state before anything is accepted. A
 * refusal from there is shown as it was written.
 *
 * Rules this surface keeps:
 *
 * - **Nothing is derived.** The repository id, object format, checkpoint ref
 *   and commit all come from the attempt records the host wrote from git. Two
 *   repositories are two rows with two commits; there is no workspace-wide
 *   "commit of this turn".
 * - **Enter never confirms.** The typed field swallows it, and the cancelling
 *   control takes focus when the dialog opens.
 * - **Changing what is being accepted invalidates the confirmation.** Pick a
 *   different checkpoint or a different revision and the attestation and the
 *   typed word are cleared, because they were about something else.
 * - **The last answer wins.** Checkpoint liveness is asked per selection and
 *   fenced by sequence: an answer about a checkpoint you are no longer looking
 *   at is dropped rather than shown.
 */
import { CheckCheck, FileDiff, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientRequests, VerificationReport } from "@lasercode/protocol";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { selectClass } from "@/components/settings/fields";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { dateTime, relativeTime } from "@/format";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import { closeWorkspace, type ProjectWorkStore } from "@/project-work";
import { openChanges } from "@/source-control/store.js";

import { KeyTag } from "./KindBadge.js";
import { WorkRefusal } from "./states.js";
import {
  acceptanceCheckpoints,
  acceptanceConfirmWord,
  acceptanceLink,
  acceptanceObstacle,
  acceptanceRepositories,
  acceptanceSubjects,
  checkpointLiveness,
  ACCEPTANCE_AMBIGUOUS_ATTEMPT,
  type AcceptanceCheckpoint,
  type AcceptanceSubject,
  type CheckpointLiveness,
} from "./native-acceptance.js";

type Detail = ClientRequests["project/work/get"]["result"];
type CheckpointList = ClientRequests["pi/project/checkpoint/list"]["result"];
/** The one thing this dialog asks the host directly: is that checkpoint still there? */
type Request =
  | ((method: "pi/project/checkpoint/list", params: ClientRequests["pi/project/checkpoint/list"]["params"]) => Promise<CheckpointList>)
  | undefined;

/** What a person is told this action is, wherever it is offered. */
export const NATIVE_ACCEPTANCE_TITLE = "Record my review…";

export function NativeAcceptanceDialog({
  store,
  detail,
  report,
  sessions,
  cwd,
  request,
  open,
  onOpenChange,
}: {
  store: ProjectWorkStore | undefined;
  detail: Detail;
  report: VerificationReport | undefined;
  sessions: ReadonlyArray<{ id: string; path: string }>;
  cwd: string | undefined;
  request: Request;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { actions } = useLaserStable();
  const subjects = useMemo(() => acceptanceSubjects(report), [report]);
  const checkpoints = useMemo(() => acceptanceCheckpoints(detail, sessions), [detail, sessions]);
  const repositories = useMemo(() => acceptanceRepositories(checkpoints), [checkpoints]);

  const [subjectId, setSubjectId] = useState<string | undefined>(undefined);
  const [repositoryId, setRepositoryId] = useState<string | undefined>(undefined);
  const [checkpointId, setCheckpointId] = useState<string | undefined>(undefined);
  const [attested, setAttested] = useState(false);
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [liveness, setLiveness] = useState<CheckpointLiveness>({ state: "unknown" });
  const cancelRef = useRef<HTMLButtonElement>(null);
  const fence = useRef(0);
  // The host connection is re-bound on every render of the panel above, so it
  // is read through a ref: an effect that depended on its identity would ask
  // again for every answer it got, forever.
  const asking = useRef<Request>(request);
  asking.current = request;

  const subject: AcceptanceSubject | undefined = subjects.find((row) => key(row) === subjectId) ?? subjects[0];
  const repository = repositories.find((row) => row.repositoryId === repositoryId) ?? repositories[0];
  const inRepository = checkpoints.filter((row) => row.repositoryId === repository?.repositoryId);
  const checkpoint: AcceptanceCheckpoint | undefined = inRepository.find((row) => row.id === checkpointId) ?? inRepository[0];

  const obstacle = acceptanceObstacle({ report, subjects, checkpoints });

  // A confirmation is about one exact pair. Change either half and it is no
  // longer the thing that was confirmed, so it is taken back.
  useEffect(() => {
    setAttested(false);
    setTyped("");
    setError(undefined);
  }, [subject?.entityId, subject?.revisionId, checkpoint?.id]);

  // Is that checkpoint still there? The conversation's own list answers, and
  // only the newest answer is kept.
  useEffect(() => {
    const ask = asking.current;
    if (!open || !checkpoint || !cwd || !ask || !checkpoint.sessionPath) {
      setLiveness({ state: "unknown" });
      return;
    }
    const ticket = ++fence.current;
    setLiveness({ state: "unknown" });
    void ask("pi/project/checkpoint/list", { cwd, path: checkpoint.sessionPath })
      .then((answer: CheckpointList) => {
        if (ticket !== fence.current) return;
        setLiveness(checkpointLiveness(checkpoint, answer));
      })
      .catch(() => {
        // The host could not say. The write is still validated there, so the
        // action stays available rather than being blocked by a failed probe.
        if (ticket === fence.current) setLiveness({ state: "unknown" });
      });
  }, [checkpoint, cwd, open]);

  useEffect(() => {
    if (!open) {
      setError(undefined);
      setNote("");
      setTyped("");
      setAttested(false);
    }
  }, [open]);

  const word = subject ? acceptanceConfirmWord(subject) : "";
  const gone = liveness.state === "pruned" || liveness.state === "moved";
  // Which attempt's work this checkpoint is has to be one answer. When two
  // attempts recorded it, the row says so and the action stays unavailable:
  // the sources a review rests on are that attempt's, and picking one would be
  // the guess this record exists to replace (M21-T19).
  const ambiguous = checkpoint !== undefined && checkpoint.executionLinkId === undefined;
  const ready = Boolean(store && subject && checkpoint) && attested && typed.trim() === word && !gone && !ambiguous;

  const record = async (): Promise<void> => {
    if (!store || !subject || !checkpoint || !ready) return;
    setBusy(true);
    const outcome = await store.link(acceptanceLink({ subject, checkpoint, ...(note.trim() ? { note: note.trim() } : {}) }), subject.revisionId);
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.failure.message);
      return;
    }
    actions.toast("info", `Your review of the build at ${checkpoint.commitObjectId.slice(0, 10)} is recorded against ${subject.key}`);
    onOpenChange(false);
    void store.refresh();
  };

  const seeChanges = (): void => {
    if (!checkpoint?.sessionPath || checkpoint.turn < 1) return;
    onOpenChange(false);
    closeWorkspace();
    openChanges({ scope: { kind: "turn", turnId: String(checkpoint.turn) }, sessionKey: checkpoint.sessionPath });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton={false}
        data-slot="native-acceptance"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Record your review of the build</DialogTitle>
          <DialogDescription>
            This records that <strong>you</strong> looked at this project&rsquo;s own build at an exact checkpoint and compared it with the revision
            below. Nothing here renders your app, and a file diff is not a running one — what makes this evidence is your word plus the exact state,
            which is kept where it can still be read.
          </DialogDescription>
        </DialogHeader>

        {obstacle ? (
          <p data-slot="native-acceptance-obstacle" className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">
            {obstacle.detail}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {subjects.length > 1 ? (
              <div className="flex flex-col gap-1.5">
                <span className="eyebrow">What you compared it with</span>
                <div role="radiogroup" aria-label="What the build was compared with" className="flex flex-col gap-1">
                  {subjects.map((row) => (
                    <button
                      key={key(row)}
                      type="button"
                      role="radio"
                      aria-checked={key(row) === key(subject!)}
                      onClick={() => setSubjectId(key(row))}
                      className={cn(
                        "flex min-w-0 flex-col items-start gap-0.5 rounded-lg border p-2 text-start outline-none",
                        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11",
                        key(row) === key(subject!) ? "border-transparent bg-surface-2" : "border-line hover:bg-surface-2",
                      )}
                    >
                      <span className="flex items-center gap-1.5">
                        <KeyTag workKey={row.key} />
                        <Badge variant="outline">{row.authority === "design" ? "design" : "task"}</Badge>
                        <span className="typed text-ink-3">{row.revisionId}</span>
                      </span>
                      <span className="min-w-0 text-xs leading-xs text-ink-2">{row.asks[0]}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {repositories.length > 1 ? (
              <label className="flex flex-col gap-1.5">
                <span className="eyebrow">Repository</span>
                <select
                  aria-label="Repository"
                  value={repository?.repositoryId ?? ""}
                  onChange={(event) => {
                    setRepositoryId(event.target.value);
                    setCheckpointId(undefined);
                  }}
                  className={cn(selectClass, "pointer-coarse:min-h-11")}
                >
                  {repositories.map((row) => (
                    <option key={row.repositoryId} value={row.repositoryId}>
                      {row.name}
                    </option>
                  ))}
                </select>
                <span className="text-xs leading-xs text-ink-3">
                  Each repository has its own checkpoint commit. A review names one of them, never one commit for all of them.
                </span>
              </label>
            ) : null}

            <label className="flex flex-col gap-1.5">
              <span className="eyebrow">Checkpoint you looked at</span>
              <select
                aria-label="Checkpoint you looked at"
                value={checkpoint?.id ?? ""}
                onChange={(event) => setCheckpointId(event.target.value)}
                className={cn(selectClass, "pointer-coarse:min-h-11")}
              >
                {inRepository.map((row) => (
                  <option key={row.id} value={row.id}>
                    {`Attempt ${String(row.attempt)} · checkpoint ${String(row.turn)} · ${row.commitObjectId.slice(0, 10)}`}
                    {row.createdAt ? ` · ${relativeTime(row.createdAt)}` : ""}
                  </option>
                ))}
              </select>
            </label>

            {subject && checkpoint ? (
              <dl data-slot="native-acceptance-tuple" className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-2.5 text-xs leading-xs">
                <Row label="Repository" value={checkpoint.repositoryName} />
                <Row label="Checkpoint" value={checkpoint.checkpointId} mono />
                <Row label="Commit" value={checkpoint.commitObjectId} mono />
                <Row
                  label="Compared with"
                  value={`${subject.key} at ${subject.revisionId}`}
                  {...(checkpoint.createdAt ? { title: dateTime(checkpoint.createdAt) } : {})}
                />
              </dl>
            ) : null}

            {liveness.state === "pruned" || liveness.state === "moved" ? <WorkRefusal message={liveness.detail} /> : null}
            {ambiguous ? <WorkRefusal message={ACCEPTANCE_AMBIGUOUS_ATTEMPT} /> : null}

            {checkpoint?.sessionPath && checkpoint.turn >= 1 ? (
              <Button size="sm" variant="ghost" className="self-start" onClick={seeChanges}>
                <FileDiff />
                See the files that changed at it
              </Button>
            ) : null}

            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                aria-label="I opened the build at this checkpoint and compared it with this revision"
                checked={attested}
                onChange={(event) => setAttested(event.target.checked)}
                className="mt-0.5 size-3.5 shrink-0 accent-live outline-none"
              />
              <span className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">
                I ran or opened this project&rsquo;s build at this checkpoint myself, and compared what it rendered with {subject?.key ?? "this revision"}
                . Laser did not show me the running app.
              </span>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm leading-5 text-ink-2">What you saw, in your own words (optional)</span>
              <Input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.preventDefault();
                }}
                placeholder="The empty state matches, spacing and both themes checked"
                aria-label="What you saw"
                autoComplete="off"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm leading-5 text-ink-2">
                Type <span className="typed text-ink">{word}</span> to confirm this review.
              </span>
              <Input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                // Enter confirms nothing here: this is a person's attestation.
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.preventDefault();
                }}
                placeholder={word}
                aria-label={`Type ${word} to confirm this review`}
                autoComplete="off"
              />
            </label>
          </div>
        )}

        {error ? <WorkRefusal message={error} recovery="Nothing was recorded." /> : null}

        <DialogFooter>
          <Button ref={cancelRef} variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button data-slot="native-acceptance-confirm" disabled={!ready || busy || obstacle !== undefined} onClick={() => void record()}>
            <CheckCheck />
            Record my review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The action itself, where the Task's verification lives. */
export function NativeAcceptanceButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <Button size="sm" variant="outline" data-slot="native-acceptance-open" disabled={disabled} onClick={onClick}>
      <ShieldCheck />
      {NATIVE_ACCEPTANCE_TITLE}
    </Button>
  );
}

function Row({ label, value, mono, title }: { label: string; value: string; mono?: boolean; title?: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="shrink-0 text-ink-3">{label}</dt>
      <dd className={cn("min-w-0 break-all text-ink-2", mono && "typed")} {...(title ? { title } : {})}>
        {value}
      </dd>
    </div>
  );
}

const key = (subject: AcceptanceSubject): string => `${subject.entityId}:${subject.revisionId}`;
