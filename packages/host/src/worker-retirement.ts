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

export type RetirementOutcome =
  | { retired: true }
  | { retired: false; reason: string; pins?: SessionSafety[] };

export interface RetirementTarget {
  cwd: string;
  client: WorkerClient;
  /** Ends the pipe and waits for the process; called only after an acknowledgement. */
  stop(): Promise<void>;
  timeoutMs?: number;
}

/** Bound the wait without leaving the promise dangling on the timer's side. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: `it did not answer within ${ms} ms` }), ms);
    timer.unref?.();
    work.then(
      (value) => { clearTimeout(timer); resolve({ ok: true, value }); },
      (error) => { clearTimeout(timer); resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) }); },
    );
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
