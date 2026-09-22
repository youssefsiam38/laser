import { describe, expect, it } from "vitest";
import { ErrorCodes, carriedToolError } from "@lasercode/protocol";
import { HarnessError } from "../../src/agents/errors.js";

describe("HarnessError", () => {
  it("stays a JSON-RPC InvalidParams refusal with the person's sentence", () => {
    const error = new HarnessError("No agent is called \"reviewer\".");
    expect(error.code).toBe(ErrorCodes.InvalidParams);
    expect(error.message).toBe("No agent is called \"reviewer\".");
    expect(error.toolError).toBeUndefined();
  });

  it("carries the tool contract's shape when the refusal knows its own recovery", () => {
    const error = new HarnessError("No run called \"run_9\" was started by this session.", ErrorCodes.InvalidParams, {
      code: "no_such_run",
      next: "call inspect_fleet to list the agents under you with their runIds",
    });
    expect(carriedToolError(error)).toEqual({
      code: "no_such_run",
      message: "No run called \"run_9\" was started by this session.",
      committed: false,
      next: "call inspect_fleet to list the agents under you with their runIds",
    });
  });

  it("reports a refusal that already changed something as committed", () => {
    const error = new HarnessError("The branch went; the directory did not.", ErrorCodes.InvalidParams, {
      code: "worktree_partially_removed",
      next: "remove the directory yourself, then carry on",
      committed: true,
    });
    expect(error.toolError?.committed).toBe(true);
  });
});
