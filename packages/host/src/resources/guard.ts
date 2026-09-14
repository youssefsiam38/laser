/**
 * `resource/report` is a local capability, refused before validation.
 *
 * The desktop shell is the only party that can see Electron's own metrics, and
 * it reaches the host over a local socket. A relayed phone is an arbitrary
 * remote peer: it must not be able to describe this machine's processes at all,
 * even though everything the report can do is be compared against what the host
 * measured itself. The socket boundary grants the capability; nothing else does.
 *
 * This mirrors `environment.ts`, deliberately: same shape, same refusal point,
 * one sentence a person can act on.
 */
import { ErrorCodes, ProtocolError } from "@lasercode/protocol";

export const RESOURCE_REPORT_METHOD = "resource/report";

export function guardResourceReport(raw: unknown, localEnvironment = false): void {
  if ((raw as { method?: unknown } | null)?.method === RESOURCE_REPORT_METHOD && !localEnvironment) {
    throw new ProtocolError(ErrorCodes.Unsupported, "Process metrics are only accepted from the app running on this machine.");
  }
}
