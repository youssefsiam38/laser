import { ErrorCodes, ProtocolError, type HostEnvironmentParams } from "@lasercode/protocol";
import type { WorkerPool } from "./worker-pool.js";

export const HOST_ENVIRONMENT_METHOD = "pi/host/environment";

/** Refuse before validation; only the socket boundary grants this capability. */
export function guardHostEnvironment(raw: unknown, localEnvironment = false): void {
  if ((raw as { method?: unknown } | null)?.method === HOST_ENVIRONMENT_METHOD && !localEnvironment) {
    throw new ProtocolError(ErrorCodes.Unsupported, "Environment updates are only accepted from a local app or terminal.");
  }
}

export function applyHostEnvironment(pool: WorkerPool, params: HostEnvironmentParams): { applied: number } {
  return { applied: pool.applyEnvironment(params.variables) };
}
