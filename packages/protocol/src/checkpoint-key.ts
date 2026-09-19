/**
 * Node-only session key. Kept off the barrel so the UI never reaches `node:crypto`.
 *
 * Import from `@lasercode/protocol/checkpoint-key`. The derivation must stay
 * identical in the worker (capture) and the host (session-delete cleanup), or
 * deleting a session silently orphans refs.
 */
import { createHash } from "node:crypto";

/** Git-ref-safe identity of a session path. Stable across process restarts. */
export function checkpointSessionKey(sessionPath: string): string {
  return createHash("sha256").update(sessionPath).digest("hex").slice(0, 32);
}
