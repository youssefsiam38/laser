/**
 * The worker process's last line of defence.
 *
 * One worker serves one project directory and every conversation, agent run
 * and background command in it (AGENTS.md invariant 5). Node ends a process
 * on an unhandled promise rejection, so a single floated promise that nobody
 * caught — a session being named, an extension's stop request, any of the
 * fire-and-forget work a live session does — would take all of them down at
 * once, mid-turn, with nothing written anywhere a person could read.
 *
 * Each of those promises is caught at its own call site, and that stays the
 * rule: this guard exists so that the *next* one that is not does not cost a
 * person their work. It says what happened on the worker's log stream and
 * lets the process carry on.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";

/** Just enough of `process` to install and remove the handler, so a test can pass its own. */
export interface RejectionGuardTarget {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  off(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
}

export const UNHANDLED_REJECTION_MESSAGE = `${PRODUCT_NAME} worker: an internal task failed and nothing was waiting for it. The worker is still running.`;

/**
 * Keep the process alive through an unhandled rejection, and log the reason.
 * Returns a function that removes the handler again (tests; the real worker
 * keeps it for the life of the process).
 */
export function installUnhandledRejectionGuard(
  target: RejectionGuardTarget = process,
  log: (message: string, detail: unknown) => void = (message, detail) => console.error(message, detail),
): () => void {
  const listener = (reason: unknown): void => {
    log(UNHANDLED_REJECTION_MESSAGE, reason instanceof Error ? (reason.stack ?? reason.message) : reason);
  };
  target.on("unhandledRejection", listener);
  return () => {
    target.off("unhandledRejection", listener);
  };
}
