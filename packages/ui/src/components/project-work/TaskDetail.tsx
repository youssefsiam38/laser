"use client";
/**
 * The Project Task detail (M21-T16; D-355 "Detail, by kind" → Task).
 *
 * The compact bar is `Start… · attempts`, and underneath it everything a
 * person needs to decide whether this Task can move: what it is for, what is
 * standing in the way *by key*, what has been tried, what was proved, and
 * which exact repository states proved it.
 *
 * Three rules, all of them the host's (M21-T15):
 *
 * 1. **A run ending never completes a Task.** An attempt records evidence and
 *    leaves the Task where it was; `done` needs a passing **acceptance**
 *    record, and this surface refuses the move with that sentence rather than
 *    sending a request whose answer it already knows.
 * 2. **A stale upstream pauses it.** `readiness.stalePausedBy` and the
 *    refusal's own `data: { refused: "stale_upstream", upstream }` are the
 *    same fact from two directions; both are shown with the upstream named and
 *    reachable.
 * 3. **A conflict is shown before another write.** Two active Tasks writing in
 *    the same place is on the answer, always; accepting the shared-checkout
 *    risk is a **person's** act and is recorded in the body
 *    (`scope.sharedWith`), in a revision that says who wrote it.
 */
import { CheckCircle2, ExternalLink, GitBranch, MoreHorizontal, Play, TriangleAlert, User } from "lucide-react";
import { useMemo, useState } from "react";
import {
  taskTransition,
  type ClientRequests,
  type ProjectTaskBody,
  type ProjectTaskState,
  type ProjectWorkListItem,
  type StaleUpstreamRef,
  type TaskConflict,
} from "@lasercode/protocol";

import { CheckpointTrail } from "@/components/assistant-ui/elements/checkpoint-history";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { dateTime, relativeTime } from "@/format";
import { cn } from "@/lib/utils";
import { useCapability, useLaserStable, useLaserState } from "@/runtime";
import { closeWorkspace, selectWork, type ProjectWorkStore } from "@/project-work";
import { actionForDrop } from "@/project-work/board";
import {
  ATTEMPT_OUTCOME_LABEL,
  EVIDENCE_KIND_LABEL,
  EXECUTION_KIND_LABEL,
  assignmentOptions,
  assignmentValue,
  attemptsOf,
  blockedSentence,
  checkpointsOf,
  conflictSentence,
  nextAttempt,
  repositoryRelationLabel,
  revisionOfEvidence,
  staleUpstreamOf,
  NO_ACCEPTANCE_EVIDENCE,
} from "@/project-work/task-model";
import { BOARD_COLUMNS, BOARD_EXTRA_COLUMN, boardColumnLabel } from "@/project-work/vocabulary";

import { KeyTag, TypeBadge } from "./KindBadge.js";
import { TaskCancelDialog } from "./TaskCancel.js";
import { TaskStartDialog } from "./TaskStart.js";
import { Labelled, ListSection, Prose, Section, Tags } from "./bodies/fields.js";
import { WorkRefusal } from "./states.js";

type Detail = ClientRequests["project/work/get"]["result"];

export function TaskDetail({
  store,
  detail,
  body,
  items,
}: {
  store: ProjectWorkStore | undefined;
  detail: Detail;
  body: ProjectTaskBody;
  items: readonly ProjectWorkListItem[];
}) {
  const { actions } = useLaserStable();
  const canAct = useCapability("project/task/action", { presentation: "explained" });
  const agents = useLaserState((state) => state.agents.snapshot?.agents ?? EMPTY_AGENTS);
  const sessions = useLaserState((state) => state.sessions);

  const [refusal, setRefusal] = useState<{ message: string; upstream?: StaleUpstreamRef } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState<{ open: boolean; error?: string }>({ open: false });

  const readiness = detail.readiness;
  const conflicts = detail.conflicts ?? [];
  const state = detail.entity.state as ProjectTaskState;
  const { attempts, unattributed } = useMemo(
    () => attemptsOf(detail.executionLinks, detail.evidence),
    [detail.evidence, detail.executionLinks],
  );
  const checkpoints = useMemo(
    () => checkpointsOf(detail.repositoryLinks).map((row) => ({ ...row, relation: repositoryRelationLabel(row.relation) })),
    [detail.repositoryLinks],
  );
  const blocked = blockedSentence(readiness);
  const stale = readiness?.stalePausedBy ?? refusal?.upstream;
  const plan = body.planKey ? items.find((item) => item.key === body.planKey) : undefined;
  const acceptance = detail.evidence.filter((record) => record.role === "acceptance");

  const fence = { entityId: detail.entity.entityId, expectedRevisionId: detail.entity.currentRevisionId };

  /** Move the Task, refusing here only what this window can already prove. */
  const move = async (to: ProjectTaskState, note?: string): Promise<void> => {
    if (!store) return;
    const outcome = taskTransition({
      from: state,
      to,
      trigger: "person",
      unmetDependencies: readiness?.unmetDependencies ?? [],
      // Unlike a board row, this surface has read the readiness: a completion
      // nothing has accepted is refused here, with the reason, rather than
      // being sent for the host to refuse.
      hasAcceptanceEvidence: readiness?.hasAcceptanceEvidence ?? true,
    });
    if (!outcome.ok) {
      setRefusal({ message: to === "done" && readiness?.hasAcceptanceEvidence === false ? NO_ACCEPTANCE_EVIDENCE : outcome.reason });
      return;
    }
    const action = actionForDrop(state, to);
    // The engine refuses a cancellation that says nothing, and writes the
    // reason as durable evidence (M21-T15). So it is asked for first.
    if (action === "cancel" && !note) {
      setRefusal(undefined);
      setCancelling({ open: true });
      return;
    }
    setRefusal(undefined);
    setBusy(true);
    const result = await store.taskAction(fence, action, note ? { note } : {});
    setBusy(false);
    if (!result.ok) {
      const upstream = result.failure.kind === "refused" ? staleUpstreamOf(result.failure.data) : undefined;
      if (cancelling.open) setCancelling({ open: true, error: result.failure.message });
      else setRefusal({ message: result.failure.message, ...(upstream ? { upstream } : {}) });
      return;
    }
    setCancelling({ open: false });
    const cascaded = result.value.cascaded ?? [];
    actions.toast(
      "info",
      cascaded.length === 0
        ? `${detail.entity.key} · ${boardColumnLabel(to).toLocaleLowerCase()}`
        : `${detail.entity.key} · ${boardColumnLabel(to).toLocaleLowerCase()} — ${cascaded.map((row) => `${row.key} is now ${boardColumnLabel(row.to).toLocaleLowerCase()}`).join(", ")}`,
    );
  };

  const setAssignment = async (value: string): Promise<void> => {
    if (!store) return;
    const assignment =
      value === "unassigned"
        ? ({ policy: "unassigned" } as const)
        : value === "person"
          ? ({ policy: "person" } as const)
          : ({ policy: "agent", agentName: value.slice("agent:".length) } as const);
    setBusy(true);
    const outcome = await store.revise(fence, { kind: "task", task: { ...body, assignment } });
    setBusy(false);
    if (!outcome.ok) setRefusal({ message: outcome.failure.message });
    else setRefusal(undefined);
  };

  /** The person accepting shared-checkout risk, recorded in the body (M21-T15). */
  const acceptSharedCheckout = async (conflict: TaskConflict): Promise<void> => {
    if (!store) return;
    const sharedWith = [...new Set([...(body.scope.sharedWith ?? []), conflict.key])];
    setBusy(true);
    const outcome = await store.revise(fence, { kind: "task", task: { ...body, scope: { ...body.scope, sharedWith } } });
    setBusy(false);
    if (!outcome.ok) setRefusal({ message: outcome.failure.message });
    else {
      setRefusal(undefined);
      actions.toast("info", `Recorded: ${detail.entity.key} may run beside ${conflict.key}`);
    }
  };

  const scope = [
    ...body.scope.packages.map((value) => `package ${value}`),
    ...body.scope.repositories.map((value) => `repository ${value}`),
    ...body.scope.paths,
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* --- the compact bar: Start…, attempts, assignment, the move menu --- */}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!store} onClick={() => setStarting(true)}>
          <Play />
          Start…
        </Button>
        <Badge variant="outline">
          {attempts.length === 0 ? "no attempts yet" : `${attempts.length} attempt${attempts.length === 1 ? "" : "s"}`}
        </Badge>
        {plan ? (
          <button
            type="button"
            onClick={() => selectWork({ entityId: plan.ref.entityId, kind: plan.kind })}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-1.5 py-0.5 outline-none",
              "hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11",
            )}
          >
            <span className="text-xs leading-xs text-ink-3">in</span>
            <TypeBadge kind="plan" />
            <KeyTag workKey={plan.key} />
          </button>
        ) : body.planKey ? (
          <span className="flex items-center gap-1.5 text-xs leading-xs text-ink-3">
            in <KeyTag workKey={body.planKey} />
          </span>
        ) : null}

        <div className="ms-auto flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="xs" variant="outline" disabled={busy || !store || canAct.state !== "available"}>
                <User />
                {body.assignment.policy === "agent" ? body.assignment.agentName : body.assignment.policy === "person" ? "You" : "Nobody yet"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 min-w-56 overflow-y-auto">
              <DropdownMenuLabel>Who does this</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={assignmentValue(body.assignment)} onValueChange={(value) => void setAssignment(value)}>
                {assignmentOptions(agents, body.assignment).map((option) => (
                  <DropdownMenuRadioItem key={option.value} value={option.value} className="items-start">
                    <span>
                      <span className="block">{option.label}</span>
                      {option.detail ? <span className="mt-0.5 block text-xs leading-4 text-ink-3">{option.detail}</span> : null}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-xs" variant="ghost" aria-label={`Move ${detail.entity.key}`} disabled={busy || !store || canAct.state !== "available"}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Move to</DropdownMenuLabel>
              {[...BOARD_COLUMNS, BOARD_EXTRA_COLUMN]
                .filter((candidate) => candidate !== state)
                .map((candidate) => (
                  <DropdownMenuItem key={candidate} onSelect={() => void move(candidate)}>
                    {boardColumnLabel(candidate)}
                  </DropdownMenuItem>
                ))}
              <DropdownMenuSeparator />
              {/* Not an action: the one fact that decides whether Done is
                  reachable, said where the move is chosen. */}
              <DropdownMenuLabel className="font-normal text-ink-3">
                {readiness?.hasAcceptanceEvidence ? "Acceptance evidence is recorded." : "No acceptance evidence yet."}
              </DropdownMenuLabel>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {canAct.state === "explained" ? <p className="text-xs leading-xs text-ink-3">{canAct.explanation}</p> : null}

      {/* --- the banners: blocked, stale, refusal, conflicts --- */}
      {blocked ? (
        <p role="status" data-slot="task-blocked" className="flex flex-wrap items-center gap-1.5 rounded-lg bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] px-2.5 py-2 text-sm leading-5 text-ink-2">
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-attention" />
          {blocked}
          {(readiness?.unmetDependencies ?? []).map((key) => {
            const row = items.find((item) => item.key === key);
            return row ? (
              <button
                key={key}
                type="button"
                onClick={() => selectWork({ entityId: row.ref.entityId, kind: row.kind })}
                className="rounded px-1 outline-none hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
              >
                <KeyTag workKey={key} className="text-attention" />
              </button>
            ) : (
              <KeyTag key={key} workKey={key} className="text-attention" />
            );
          })}
        </p>
      ) : null}

      {stale ? (
        <p role="status" data-slot="task-stale" className="flex flex-wrap items-center gap-1.5 rounded-lg bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] px-2.5 py-2 text-sm leading-5 text-ink-2">
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-attention" />
          {stale.key} changed after this task was planned. Reconcile it before starting this task.
          <button
            type="button"
            onClick={() => selectWork({ entityId: stale.entityId, kind: stale.kind })}
            className="text-live underline-offset-4 outline-none hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
          >
            Open {stale.key}
          </button>
        </p>
      ) : null}

      {refusal ? <WorkRefusal message={refusal.message} recovery="Nothing moved." /> : null}

      {conflicts.length > 0 ? (
        <Section title="Writing in the same place">
          <ul role="list" data-slot="task-conflicts" className="flex flex-col gap-2">
            {conflicts.map((conflict) => (
              <li key={conflict.entityId} className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-2.5">
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <TypeBadge kind="task" />
                  <KeyTag workKey={conflict.key} />
                  <span className="min-w-0 truncate text-sm leading-5 text-ink">{conflict.title}</span>
                  <Badge variant={conflict.observed ? "danger" : "attention"} className="ms-auto">
                    {conflict.observed ? "already written" : "declared"}
                  </Badge>
                  {conflict.accepted ? <Badge variant="ok">risk accepted</Badge> : null}
                </span>
                <span className="text-sm leading-5 text-ink-2">{conflictSentence(conflict)}</span>
                <span className="flex flex-wrap items-center gap-2">
                  <Button size="xs" variant="outline" onClick={() => selectWork({ entityId: conflict.entityId, kind: "task" })}>
                    Open {conflict.key}
                  </Button>
                  {conflict.accepted ? null : (
                    <Button size="xs" variant="ghost" disabled={busy || !store} onClick={() => void acceptSharedCheckout(conflict)}>
                      Accept shared-checkout risk
                    </Button>
                  )}
                </span>
                {conflict.accepted ? null : (
                  <span className="text-xs leading-xs text-ink-3">
                    Accepting is recorded in this task's own revision, under your name. Only you can accept it — an agent's revision that adds
                    one is refused.
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/* --- the body --- */}
      <Section title="Outcome">
        <Prose text={body.outcome} />
      </Section>

      <div className="flex flex-wrap gap-4">
        <Labelled label="Visual evidence">{body.visualEvidenceRequired ? "required" : "not required"}</Labelled>
        <Labelled label="Dependencies">
          {body.dependencies.length === 0 ? (
            "none"
          ) : (
            <span className="flex flex-wrap items-center gap-1.5">
              {body.dependencies.map((key) => (
                <KeyTag key={key} workKey={key} />
              ))}
            </span>
          )}
        </Labelled>
        {body.scope.sharedWith && body.scope.sharedWith.length > 0 ? (
          <Labelled label="Shared checkout accepted with">
            <span className="flex flex-wrap items-center gap-1.5">
              {body.scope.sharedWith.map((key) => (
                <KeyTag key={key} workKey={key} />
              ))}
            </span>
          </Labelled>
        ) : null}
      </div>

      <ListSection title="Non-goals" items={body.nonGoals} />
      {scope.length > 0 ? <ListSection title="Scope" items={scope} mono /> : null}
      <Tags values={body.scope.capabilities} />

      <Section title="Acceptance">
        {body.acceptance.length === 0 ? (
          <p className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">
            No acceptance criteria are written down yet.{" "}
            <span className="text-ink-3">A task can still be worked on; what makes it done is then a person's judgement, recorded as evidence.</span>
          </p>
        ) : (
          <ul role="list" className="flex flex-col gap-1.5">
            {body.acceptance.map((criterion) => (
              <li key={criterion.id} className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-start gap-2">
                  <Badge variant={criterion.machineVerifiable ? "live" : "outline"}>{criterion.machineVerifiable ? "checkable" : "by a person"}</Badge>
                  <span className="min-w-0 text-sm leading-5 text-ink-2">{criterion.text}</span>
                </span>
                {criterion.command ? <span className="typed break-all text-ink-3">{criterion.command}</span> : null}
              </li>
            ))}
          </ul>
        )}
        <p className={cn("flex items-center gap-1.5 text-xs leading-xs", acceptance.length > 0 ? "text-ok" : "text-ink-3")}>
          <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0" />
          {acceptance.length > 0
            ? `${acceptance.length} acceptance record${acceptance.length === 1 ? "" : "s"} — this task can be completed.`
            : NO_ACCEPTANCE_EVIDENCE}
        </p>
      </Section>

      <ListSection title="Verification" items={body.verificationCommands} mono />

      {/* --- attempts --- */}
      <Section title="Attempts">
        {attempts.length === 0 ? (
          <p className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">
            Nothing has been tried yet. <span className="text-ink-3">Start… joins this task to the conversation the work happens in, before any of it starts.</span>
          </p>
        ) : (
          <ol role="list" data-slot="task-attempts" className="flex flex-col gap-2">
            {attempts.map((attempt) => (
              <li key={attempt.attempt} className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-2.5">
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="text-sm leading-5 font-medium text-ink">Attempt {attempt.attempt}</span>
                  {attempt.outcome ? (
                    <Badge variant={attempt.outcome === "completed" ? "ok" : attempt.outcome === "failed" ? "danger" : "attention"}>
                      {ATTEMPT_OUTCOME_LABEL[attempt.outcome]}
                    </Badge>
                  ) : (
                    <Badge variant="live">running</Badge>
                  )}
                  <span className="ms-auto text-xs leading-xs text-ink-3" title={dateTime(attempt.startedAt)}>
                    {relativeTime(attempt.startedAt)}
                  </span>
                </span>
                <ul role="list" className="flex flex-col gap-1">
                  {attempt.links.map((link) => {
                    const session = sessions.find((candidate) => candidate.id === link.targetId);
                    return (
                      <li key={link.linkId} className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs leading-xs text-ink-3">
                        <Badge variant="outline">{EXECUTION_KIND_LABEL[link.kind]}</Badge>
                        {link.branch ? (
                          <span className="typed flex items-center gap-1 text-ink-2">
                            <GitBranch aria-hidden="true" className="size-3" />
                            {link.branch}
                          </span>
                        ) : null}
                        {link.baseCommitObjectId ? <span className="typed text-ink-3">from {link.baseCommitObjectId.slice(0, 10)}</span> : null}
                        {link.profileId ? <span>on {link.profileId}</span> : null}
                        {link.targetUnavailable || !session ? (
                          <span>{link.targetUnavailable ? "no longer on this device" : "not in this device's list"}</span>
                        ) : (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => {
                              closeWorkspace();
                              void actions.openSession(session.path);
                            }}
                          >
                            <ExternalLink />
                            Open the conversation
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {attempt.evidence.length > 0 ? <EvidenceList detail={detail} records={attempt.evidence} /> : null}
              </li>
            ))}
          </ol>
        )}
      </Section>

      {/* --- evidence --- */}
      <Section title="Evidence">
        {unattributed.length === 0 && attempts.every((attempt) => attempt.evidence.length === 0) ? (
          <p className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">
            Nothing has been recorded yet.{" "}
            <span className="text-ink-3">Evidence is a test run, a diff, a screenshot, a commit or your own acceptance — each one kept with the exact revision it ran against.</span>
          </p>
        ) : (
          <EvidenceList detail={detail} records={unattributed} />
        )}
      </Section>

      {/* --- checkpoints, from git --- */}
      <Section title="Checkpoints">
        <CheckpointTrail
          rows={checkpoints}
          empty="No repository states are recorded against this task yet. Checkpoints and git are what determine changed files — never a tool call."
        />
      </Section>

      {body.notes ? (
        <Section title="Notes">
          <Prose text={body.notes} />
        </Section>
      ) : null}

      <TaskStartDialog
        store={store}
        detail={detail}
        open={starting}
        onOpenChange={setStarting}
        attempt={nextAttempt(detail.executionLinks)}
      />

      <TaskCancelDialog
        workKey={detail.entity.key}
        title={detail.entity.title}
        open={cancelling.open}
        busy={busy}
        error={cancelling.error}
        onOpenChange={(open) => setCancelling({ open })}
        onCancelTask={(note) => void move("cancelled", note)}
      />
    </div>
  );
}

function EvidenceList({ detail, records }: { detail: Detail; records: Detail["evidence"] }) {
  if (records.length === 0) return null;
  return (
    <ul role="list" data-slot="task-evidence" className="flex flex-col gap-1.5">
      {records.map((record) => {
        const repository = revisionOfEvidence(record, detail.repositoryLinks);
        const state = repository ? ("state" in repository.target ? repository.target.state : repository.target.change.head) : undefined;
        return (
          <li key={record.evidenceId} className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Badge variant={record.outcome === "passed" ? "ok" : record.outcome === "failed" ? "danger" : "outline"}>{record.outcome}</Badge>
              <Badge variant={record.role === "acceptance" ? "live" : "outline"}>{record.role}</Badge>
              <span className="text-xs leading-xs text-ink-3">{EVIDENCE_KIND_LABEL[record.kind]}</span>
              <span className="ms-auto text-xs leading-xs text-ink-3" title={dateTime(record.at)}>
                {relativeTime(record.at)}
              </span>
            </span>
            <span className="min-w-0 text-sm leading-5 text-ink-2">{record.summary}</span>
            {record.detail ? <span className="typed break-all text-ink-3">{record.detail}</span> : null}
            {state ? (
              <span className="typed flex flex-wrap items-center gap-1.5 text-ink-3">
                {repositoryRelationLabel(repository!.relation)} {state.commitObjectId.slice(0, 10)}
                {state.checkpointId ? <Badge variant="outline">checkpoint</Badge> : null}
                {repository!.sourceUnavailable ? <span className="text-attention">no longer on this machine</span> : null}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

const EMPTY_AGENTS: ReadonlyArray<{ name: string; description: string }> = [];
