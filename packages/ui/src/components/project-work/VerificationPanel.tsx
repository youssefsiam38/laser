"use client";
/**
 * Verification, in the Task detail (M21-T19).
 *
 * A person starts a run here, watches it, and stops it. What they get back is
 * a report they can act on, not a verdict: the criteria that are satisfied,
 * the ones that failed, the ones only they can settle — a browser matrix
 * among them, which an agent never walks (`AGENTS.md`, D-342) — and the
 * deviations the run proposed against an approved upstream.
 *
 * The rules this surface keeps, all of them the host's:
 *
 * - **Nothing here approves anything.** A run that satisfies everything it
 *   could decide moves the Task to needs review, and that is the furthest any
 *   of this goes: `done` is yours.
 * - **Every run belongs to a conversation**, because a Command is watched and
 *   stopped in the fleet and a row needs a session to hang under. The run
 *   takes the conversation this Task is already being worked on in; when
 *   there is none, this hands the person to Start… rather than starting
 *   something invisible.
 * - **Progress is counts, in a live region.** Which command is running and how
 *   many there are — never a percentage and never an estimate.
 * - **A stored report is the one that is shown.** The panel reads the exact
 *   document the run wrote; it never re-derives a report from what it has on
 *   screen.
 * - **Native evidence is a person's, and it is recorded here.** A visual
 *   criterion is settled by a person who looked at the project's real build at
 *   an exact checkpoint; "Record my review…" is the door to saying so, and the
 *   host proves everything about it except the looking (D-353, D-361).
 */
import { Play, RefreshCw, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  VERIFICATION_NEEDS_SESSION,
  type ClientRequests,
  type ProjectWorkBody,
  type VerificationDeviation,
  type VerificationReport,
  type VerificationRunState,
} from "@lasercode/protocol";

import { Button } from "@/components/ui/button";
import { useLaserStable, useLaserState } from "@/runtime";
import type { ProjectWorkStore } from "@/project-work";

import { Section } from "./bodies/fields.js";
import { NativeAcceptanceButton, NativeAcceptanceDialog } from "./NativeAcceptance.js";
import { acceptanceCheckpoints, acceptanceObstacle, acceptanceSubjects } from "./native-acceptance.js";
import { WorkRefusal } from "./states.js";
import { VerificationReportView } from "./VerificationReport.js";
import { latestVerification, reportFrom, verificationSessionFor } from "./verification-model.js";

type Detail = ClientRequests["project/work/get"]["result"];

/** How often a running verification is asked where it has got to. */
export const VERIFICATION_POLL_MS = 1_500;

const TERMINAL = new Set(["done", "stopped", "failed"]);

export function VerificationPanel({
  store,
  detail,
  cwd,
  pollMs = VERIFICATION_POLL_MS,
}: {
  store: ProjectWorkStore | undefined;
  detail: Detail;
  /** The project's checkout, where a run executes the Task's own commands. */
  cwd: string | undefined;
  pollMs?: number;
}) {
  const { client } = useLaserStable();
  const sessions = useLaserState((state) => state.sessions);
  const [run, setRun] = useState<VerificationRunState | undefined>(undefined);
  const [report, setReport] = useState<VerificationReport | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const recorded = latestVerification(detail);
  const recordedBlob = recorded?.blobId;
  const live = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, []);

  // The stored report, read from the record the Task already carries. A run
  // that finished in another window, or before this one was opened, is still
  // the report this Task has.
  useEffect(() => {
    if (!store || recordedBlob === undefined) {
      setReport(undefined);
      return;
    }
    let cancelled = false;
    void store.readBlob({ blobId: recordedBlob }).then((outcome) => {
      if (cancelled || !outcome.ok) return;
      const parsed = reportFrom(outcome.value);
      if (parsed) setReport(parsed);
    });
    return () => {
      cancelled = true;
    };
  }, [recordedBlob, store]);

  // A window with no live connection (a replayed transcript, a narrow test)
  // has no way to run anything: the button says so rather than throwing.
  const request = typeof client?.request === "function" ? client.request.bind(client) : undefined;
  // The conversation this run would belong to. No session, no run: the panel
  // says which act gets one instead of starting something nobody can see.
  const owner = useMemo(() => verificationSessionFor(detail, sessions), [detail, sessions]);
  const canRun = cwd !== undefined && request !== undefined && owner !== undefined;

  // What a person's review of the build could be recorded against, and why it
  // could not. The reason is shown rather than the action being hidden: an
  // act that is missing says nothing about what to do to get it.
  const subjects = useMemo(() => acceptanceSubjects(report), [report]);
  const checkpoints = useMemo(() => acceptanceCheckpoints(detail, sessions), [detail, sessions]);
  const acceptanceBlocked = useMemo(
    () => acceptanceObstacle({ report, subjects, checkpoints }),
    [checkpoints, report, subjects],
  );

  const poll = useCallback(
    async (runId: string): Promise<void> => {
      if (!cwd || !request) return;
      // A window that has gone, or a host that answered nothing, ends the
      // follow rather than throwing into a timer nobody is waiting on.
      let answer: { runs?: VerificationRunState[] } | undefined;
      try {
        answer = await request("pi/project/verify/state", { cwd, runId });
      } catch {
        return;
      }
      const next = answer?.runs?.[0];
      if (!next || !live.current) return;
      setRun(next);
      if (next.report) setReport(next.report);
      if (!TERMINAL.has(next.phase)) {
        timer.current = setTimeout(() => void poll(runId), pollMs);
        return;
      }
      if (next.problem) setProblem(next.problem);
      // The run wrote its report into the project's own record; re-reading the
      // Task is what puts the evidence row on screen beside it.
      void store?.refresh();
    },
    [cwd, pollMs, request, store],
  );

  const start = async (): Promise<void> => {
    if (!cwd || !request || !owner) return;
    setProblem(undefined);
    setBusy(true);
    try {
      const answer = await request("pi/project/verify/start", {
        cwd,
        entityId: detail.entity.entityId,
        sessionPath: owner.path,
      });
      setRun(answer.run);
      void poll(answer.run.runId);
    } catch (error) {
      setProblem(
        error instanceof Error && error.message.trim() !== ""
          ? error.message
          : "This task could not be verified from here.",
      );
    } finally {
      setBusy(false);
    }
  };

  const stop = async (): Promise<void> => {
    if (!cwd || !run || !request) return;
    setBusy(true);
    try {
      const answer = await request("pi/project/verify/stop", { cwd, runId: run.runId, reason: "you stopped it" });
      if (answer.run) setRun(answer.run);
    } catch {
      // A run that has already ended is not an error to report; the next poll
      // says where it got to.
    } finally {
      setBusy(false);
    }
  };

  /**
   * Accepting a deviation is the ordinary revise path (leap): a new revision
   * of the exact upstream revision the proposal was written against, under
   * your name — which is what marks only the work reachable from it stale.
   */
  const accept = async (deviation: VerificationDeviation): Promise<void> => {
    if (!store || !deviation.proposedBody) return;
    setBusy(true);
    const outcome = await store.revise(
      { entityId: deviation.upstream.entityId, expectedRevisionId: deviation.upstream.revisionId },
      deviation.proposedBody as ProjectWorkBody,
      { note: `Accepted a verification deviation: ${deviation.reason}` },
    );
    setBusy(false);
    if (!outcome.ok) {
      setProblem(outcome.failure.message);
      return;
    }
    setProblem(undefined);
    void store.refresh();
  };

  const running = run !== undefined && !TERMINAL.has(run.phase);

  return (
    <Section title="Verification">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={!canRun || busy || running} onClick={() => void start()}>
          {report ? <RefreshCw /> : <Play />}
          {report ? "Verify again" : "Verify…"}
        </Button>
        {running ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void stop()}>
            <Square />
            Stop
          </Button>
        ) : null}
        <NativeAcceptanceButton disabled={acceptanceBlocked !== undefined || !store} onClick={() => setAccepting(true)} />
        {acceptanceBlocked ? (
          <span data-slot="verification-acceptance-blocked" className="max-w-(--measure-prose) text-xs leading-xs text-ink-3">
            {acceptanceBlocked.detail}
          </span>
        ) : null}
        {canRun ? null : (
          <span data-slot="verification-needs-session" className="max-w-(--measure-prose) text-xs leading-xs text-ink-3">
            {cwd === undefined || request === undefined
              ? "This project is not open at a folder in this window, so its commands cannot be run from here."
              : VERIFICATION_NEEDS_SESSION}
          </span>
        )}
      </div>

      {/* The one live region: what the run is doing now, in words. */}
      <p role="status" aria-live="polite" data-slot="verification-progress" className="min-h-5 text-sm leading-5 text-ink-2">
        {running ? run.line : ""}
      </p>

      {problem ? (
        <WorkRefusal
          message={problem}
          recovery="Nothing was recorded. Fix what it names and verify again."
          {...(canRun ? { onRetry: () => void start() } : {})}
        />
      ) : null}

      <NativeAcceptanceDialog
        store={store}
        detail={detail}
        report={report}
        sessions={sessions}
        cwd={cwd}
        request={request}
        open={accepting}
        onOpenChange={setAccepting}
      />

      {report ? (
        <VerificationReportView report={report} onAcceptDeviation={(deviation) => void accept(deviation)} busy={busy} />
      ) : running ? null : (
        <p className="max-w-(--measure-prose) text-sm leading-5 text-ink-2">
          Nothing has been verified yet.{" "}
          <span className="text-ink-3">
            A run checks this task against its spec, design and plan, runs the commands the task declares, and reports what is satisfied,
            what failed and what is left for you. It never marks a task done.
          </span>
        </p>
      )}
    </Section>
  );
}
