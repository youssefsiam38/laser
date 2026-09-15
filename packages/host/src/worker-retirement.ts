/**
 * Retiring a worker, atomically (RP-4).
 *
 * The host used to ask a worker whether it was idle, believe the answer, and
 * then end its pipe. Between those two acts a request could be written, and the
 * worker would be killed with that request's work inside it. This file removes
 * the gap: the decision and the transition belong to the worker, and the host's
 * whole job is to stop writing before it asks, and to keep its promise after.
 *
 * ```
 * closeAdmission()          nothing more is written to this worker
 *   → pi/worker/retire      the worker fences itself, drains, re-checks
 *      refused → reopenAdmission(), the worker keeps serving
 *      agreed  → stop(): the pipe ends, the process exits
 * ```
 *
 * Every other answer — a timeout, a transport failure, an older worker that
 * does not know the method, a shape this does not recognise — is a refusal.
 * Fail closed: a worker that cannot prove it is idle keeps running.
 */
import { ErrorCodes, ProtocolError, type ClientRequests, type SessionSafety, type WorkerRetireMode } from "@lasercode/protocol";
import { WorkerRetiredError, type WorkerClient } from "./worker-client.js";

/** Longest the host waits for a worker to answer the retirement question. */
export const RETIRE_TIMEOUT_MS = 10_000;

/**
 * How long the host keeps a timed-out worker's admission closed (RP-4).
 *
 * A silence is ambiguous: the worker may have agreed and fenced itself, with
 * its answer still in flight or lost. Reopening admission immediately would
 * start writing to a worker that is refusing everything, so the host waits out
 * the worker's own retirement lease — `DEFAULT_RETIRE_LEASE_MS` in
 * `packages/worker/src/session-runtimes.ts`, which is where the worker gives up
 * and goes back to work — plus a margin for the request's own travel. Only a
 * silence waits: an error, an unknown method or a refusal reopens at once,
 * because each of those proves the worker is not fenced.
 */
export const RETIRE_LEASE_MS = 15_000;
export const RETIRE_LEASE_MARGIN_MS = 1_000;

export type RetirementOutcome =
  | { retired: true }
  | { retired: false; reason: string; pins?: SessionSafety[] };

export interface RetirementTarget {
  cwd: string;
  client: WorkerClient;
  /** Ends the pipe and waits for the process; called only after an acknowledgement. */
  stop(): Promise<void>;
  timeoutMs?: number;
  /** How long a silence keeps admission closed. Defaults to the worker's lease. */
  leaseMs?: number;
  /** Test seam for that wait. */
  wait?: (ms: number) => Promise<void>;
}

/** Bound the wait without leaving the promise dangling on the timer's side. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; reason: string; timedOut?: true }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: `it did not answer within ${ms} ms`, timedOut: true }), ms);
    timer.unref?.();
    work.then(
      (value) => { clearTimeout(timer); resolve({ ok: true, value }); },
      // A failure is an answer: this worker is not fenced, so admission may
      // reopen at once.
      (error) => { clearTimeout(timer); resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) }); },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
  });
}

/**
 * Ask one worker to retire, and end it only if it agreed.
 *
 * `mode` reaches the worker unchanged: `automatic` (the idle sweep) refuses on
 * any pin at all, `explicit` (a person, or a Feature toggle) refuses on work in
 * flight. The host does not classify pins — there is one predicate and it lives
 * where the work does.
 */
export async function retireWorker(target: RetirementTarget, mode: WorkerRetireMode): Promise<RetirementOutcome> {
  const { client } = target;
  if (!client.alive) return { retired: false, reason: "this worker is not running" };
  // Nothing may be written from here until the answer is in.
  client.closeAdmission();
  const answered = await withTimeout(
    client.requestPrivileged<ClientRequests["pi/worker/retire"]["result"]>("pi/worker/retire", { mode }),
    target.timeoutMs ?? RETIRE_TIMEOUT_MS,
  );
  if (!answered.ok) {
    if (answered.timedOut) {
      // Ambiguous by construction: this worker may be fenced right now with its
      // answer lost. Wait until its own lease has certainly expired — the point
      // at which it gives up and admits work again — and only then write to it.
      // A late acknowledgement cannot act on anything: this decision is already
      // made, and nothing stops a worker the host did not hear agree.
      const lease = target.leaseMs ?? RETIRE_LEASE_MS;
      await (target.wait ?? sleep)(lease + RETIRE_LEASE_MARGIN_MS);
    }
    client.reopenAdmission();
    return { retired: false, reason: answered.reason };
  }
  const answer = answered.value as Partial<ClientRequests["pi/worker/retire"]["result"]> | null;
  if (!answer || typeof answer.retiring !== "boolean") {
    // An older worker answers an unknown method rather than refusing it; a
    // shape this does not recognise is not permission to kill a process.
    client.reopenAdmission();
    return { retired: false, reason: "this worker does not report whether it may be stopped" };
  }
  if (!answer.retiring) {
    client.reopenAdmission();
    const refusal = answer as { reason?: string; pins?: SessionSafety[] };
    return {
      retired: false,
      reason: refusalSentence(refusal.reason, refusal.pins),
      ...(refusal.pins ? { pins: refusal.pins } : {}),
    };
  }
  // It agreed, and its admission never reopens: the pipe may end.
  await target.stop();
  return { retired: true };
}

/** The sentence a person reads when a worker refuses to stop. */
export function refusalSentence(reason: string | undefined, pins: SessionSafety[] | undefined): string {
  const first = pins?.find((session) => session.pins.length > 0)?.pins[0];
  if (reason === "pinned" && first) return `one of its conversations is holding work (${first.detail ?? first.kind})`;
  if (reason === "arrived") return "something asked for it while it was stopping";
  if (reason === "incomplete") return "it could not say what all of its conversations are holding";
  return reason ?? "it refused";
}

/** The refusal an explicit stop or restart reports to a person. */
export function retirementRefused(cwd: string, reason: string): ProtocolError {
  return new ProtocolError(ErrorCodes.SessionBusy, `The worker for ${cwd} could not be stopped: ${reason}.`);
}

export { WorkerRetiredError };
