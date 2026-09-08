import { ErrorCodes, ProtocolError } from "@lasercode/protocol";

/**
 * A refusal written for a person (and, through `start_agent`, for the parent
 * model). Carries the InvalidParams code so a request that caused it gets a
 * proper JSON-RPC error instead of an internal one.
 */
export class HarnessError extends ProtocolError {
  constructor(message: string, code: number = ErrorCodes.InvalidParams) {
    super(code, message);
  }
}
