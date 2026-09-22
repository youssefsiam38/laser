import { ErrorCodes, ProtocolError, toolError, type ToolError } from "@lasercode/protocol";

/**
 * What a refusal knows about itself beyond its sentence (D-350): a stable
 * code, whether anything was persisted before it failed, and the next valid
 * call. A refusal that says nothing here takes the calling tool's declared
 * defaults in `registerLaserTool`; one that knows better — because it already
 * changed something, or because the way forward is a different tool — says so
 * at the throw site.
 *
 * The mutating tools' own sites use it (`harness.ts`): `start_agent` when a
 * worktree or a child session survives a failed start, `stop_agent` before
 * and after the abort is signalled, `remove_agent_worktree` for a removal git
 * only half did, and `send_agent_message` for an agent that is not there or
 * no longer open. Those are the paths where `committed` is a fact rather than
 * a default, and where one `*_failed` code for every failure of a tool would
 * tell a model nothing. Read-only tools never set it: the helper forces their
 * `committed` to false whatever a refusal claims.
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
