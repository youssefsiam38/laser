import { ErrorCodes, ProtocolError, toolError, type ToolError } from "@lasercode/protocol";

/**
 * What a refusal knows about itself beyond its sentence (D-350): a stable
 * code, whether anything was persisted before it failed, and the next valid
 * call. A refusal that says nothing here takes the calling tool's declared
 * defaults in `registerLaserTool`; one that knows better — because it already
 * changed something, or because the way forward is a different tool — says so
 * at the throw site.
 */
export interface HarnessErrorRecovery {
  code: string;
  next: string;
  /** Default false: a refusal that changed nothing says so, and means it. */
  committed?: boolean;
}

/**
 * A refusal written for a person (and, through `start_agent`, for the parent
 * model). Carries the InvalidParams code so a request that caused it gets a
 * proper JSON-RPC error instead of an internal one.
 *
 * `toolError` is the tool contract's shape, read by the companion extension's
 * registration helper when this error crosses into a tool result.
 */
export class HarnessError extends ProtocolError {
  readonly toolError?: ToolError;
  constructor(message: string, code: number = ErrorCodes.InvalidParams, recovery?: HarnessErrorRecovery) {
    super(code, message);
    if (recovery) {
      this.toolError = toolError({ code: recovery.code, message, committed: recovery.committed ?? false, next: recovery.next });
    }
  }
}
