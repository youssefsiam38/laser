import { createHash } from "node:crypto";

/** Git-ref-safe identity of a session path. Stable across process restarts. */
export function checkpointSessionKey(sessionPath: string): string {
  return createHash("sha256").update(sessionPath).digest("hex").slice(0, 32);
}
