import { clientParamsSchemas, environmentOverlay } from "@lasercode/protocol";
import { extendRuntimePath } from "./runtime-env.js";

/** Runs synchronously before the next request on the host's ordered pipe. */
export function applyEnvironment(params: unknown): number {
  const parsed = clientParamsSchemas["pi/host/environment"].safeParse(params);
  if (!parsed.success) return 0; // Never print rejected environment payloads.
  const overlay = environmentOverlay(parsed.data.variables);
  Object.assign(process.env, overlay);
  extendRuntimePath();
  return Object.keys(overlay).length;
}
