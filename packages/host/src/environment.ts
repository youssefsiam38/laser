import type { HostEnvironmentParams } from "@lasercode/protocol";
import type { WorkerPool } from "./worker-pool.js";

export const HOST_ENVIRONMENT_METHOD = "pi/host/environment";

/**
 * The private variable overlay a local shell or terminal hands down.
 *
 * Who may call this is no longer decided here: `METHOD_POLICY` in
 * `@lasercode/protocol` gives this method reach `native`, and the Router
 * refuses it for a browser page or a paired device before the request is even
 * parsed (RP-13). The refusal sentence moved with it, unchanged.
 */
export function applyHostEnvironment(pool: WorkerPool, params: HostEnvironmentParams): { applied: number } {
  return { applied: pool.applyEnvironment(params.variables) };
}
