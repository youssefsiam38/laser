/**
 * The id a research run takes in the fleet (M21-T26).
 *
 * `docs/research-phase.md` asks for the budget to be visible "in the fleet row
 * and the Research header", so a research loop is a Command: one row, one
 * Stop. The worker routes that Stop by the id's own prefix, which makes these
 * three functions the whole of the contract between the row and the run — and
 * makes a collision with another Command's id a real bug, not a tidiness
 * question.
 */
import { describe, expect, it } from "vitest";
import {
  isResearchFleetTaskId,
  isVerificationFleetTaskId,
  researchFleetTaskId,
  researchRunIdOf,
  verificationFleetTaskId,
} from "../src/index.js";

describe("a research run's fleet task id", () => {
  it("round-trips the run id", () => {
    const id = researchFleetTaskId("res_0007");
    expect(id).toBe("research-res_0007");
    expect(isResearchFleetTaskId(id)).toBe(true);
    expect(researchRunIdOf(id)).toBe("res_0007");
  });

  it("cannot be confused with another Command's row, in either direction", () => {
    // Stop is routed by prefix, so a verification run's row and an index
    // build's row must never answer to the research branch.
    expect(isResearchFleetTaskId(verificationFleetTaskId("ver_0001"))).toBe(false);
    expect(isResearchFleetTaskId("design-index-cmd_1")).toBe(false);
    // A shell command's id is a plain id, and never this.
    expect(isResearchFleetTaskId("task_12")).toBe(false);
    expect(isResearchFleetTaskId("")).toBe(false);
    // And the research row is not answered by anybody else's branch either.
    expect(isVerificationFleetTaskId(researchFleetTaskId("res_0001"))).toBe(false);
  });
});
