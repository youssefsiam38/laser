import type { RuntimeFailure, WorkerInfo, WorkerMode } from "@lasercode/protocol";
import type { RuntimeRepairLedger } from "./runtime-repair.js";

export interface WorkerRecoveryDecision {
  retry: boolean;
  attempt: number;
  delayMs?: number;
  repair: WorkerInfo["repair"];
}

/** The one automatic-recovery policy used by production and focused pool tests. */
export class WorkerRecoveryPolicy {
  constructor(
    private readonly ledger: RuntimeRepairLedger,
    private readonly backoffMs = 1_000,
  ) {}

  mode(cwd: string): WorkerMode {
    return this.ledger.mode(cwd);
  }

  status(cwd: string, mode: WorkerMode, failure?: RuntimeFailure): WorkerInfo["repair"] {
    return this.ledger.status(cwd, mode, failure);
  }

  authorize(cwd: string, mode: WorkerMode, failure?: RuntimeFailure): void {
    this.ledger.authorize(cwd, mode, failure);
  }

  markHealthy(cwd: string): void {
    this.ledger.markHealthy(cwd);
  }

  failure(input: {
    cwd: string;
    mode: WorkerMode;
    failure: RuntimeFailure;
    hasOpenSessions: boolean;
    spawnError: boolean;
  }): WorkerRecoveryDecision {
    if (input.spawnError || !input.hasOpenSessions) {
      this.ledger.noteFailure(input.cwd, input.mode, input.failure);
      return {
        retry: false,
        attempt: 0,
        repair: this.ledger.status(input.cwd, input.mode, input.failure),
      };
    }

    const decision = this.ledger.automaticRetry(input.cwd, input.mode, input.failure);
    return {
      retry: decision.allowed,
      attempt: decision.attempts,
      ...(decision.allowed ? { delayMs: this.backoffMs * 2 ** Math.max(0, decision.attempts - 1) } : {}),
      repair: this.ledger.status(input.cwd, input.mode, input.failure),
    };
  }
}
