/**
 * Processes this worker starts, told to the host's process inventory (RP-1).
 *
 * The host discovers processes itself and measures them itself; what it cannot
 * do is know what one *is*. A pid the worker spawned on purpose — a project's
 * environment helper, a worktree setup program, the shell of a background
 * command — is an `unknown_descendant` until its owner says otherwise, and
 * only the owner can say it.
 *
 * This is deliberately a process-wide observer rather than a parameter
 * threaded through every helper: what it reports is a fact about *this
 * process's children*, not about any one session, and a helper two calls deep
 * should not have to be handed a bridge to state the obvious. The observer is
 * set once by the worker server and is a no-op in a test or a tool that never
 * sets one.
 *
 * Nothing here reads argv, an environment or a path: a label is a short,
 * already-sanitized word chosen by the caller, and the host validates identity
 * `(pid, startToken)` and ancestry before it believes any of it.
 */
import type { ResourceProcessRegistration } from "@lasercode/protocol";

export interface WorkerProcessObserver {
  started(registration: ResourceProcessRegistration): void;
  exited(pid: number): void;
}

let observer: WorkerProcessObserver | undefined;

/** The worker server publishes registrations; anything else leaves this unset. */
export function setWorkerProcessObserver(next: WorkerProcessObserver | undefined): void {
  observer = next;
}

/** A process this worker started, with what it is for. Never throws into the caller. */
export function noteWorkerProcess(registration: ResourceProcessRegistration): void {
  if (!observer) return;
  if (!Number.isInteger(registration.pid) || registration.pid <= 0) return;
  try {
    observer.started(registration);
  } catch {
    // Diagnostics must never affect the work that produced them.
  }
}

/** It ended: a record must not outlive the process it describes. */
export function noteWorkerProcessExit(pid: number | undefined): void {
  if (!observer || pid === undefined || !Number.isInteger(pid) || pid <= 0) return;
  try {
    observer.exited(pid);
  } catch {
    // As above.
  }
}
