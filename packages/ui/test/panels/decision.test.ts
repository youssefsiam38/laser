/**
 * The only judgement in the decision surfaces that is not the payload's:
 * which option changes the session's behaviour rather than answering once.
 * Wrong in either direction is a real cost — a missed warning before "always
 * allow", or a warning on a plain "Allow" that teaches people to ignore it.
 */
import { describe, expect, it } from "vitest";
import { decisionSummary, isModeChangingOption } from "../../src/panels/decision.js";

describe("isModeChangingOption", () => {
  it("flags broad-allow wording and leaves one-offs alone", () => {
    for (const option of [
      "Always allow",
      "Allow for this session",
      "Allow this session",
      "Don't ask again",
      "Yes, and remember",
      "Auto-approve",
      "Approve every time",
    ]) {
      expect(isModeChangingOption(option), option).toBe(true);
    }
    for (const option of ["Allow", "Allow once", "Alpha", "Yes", "Run it", "No"]) {
      expect(isModeChangingOption(option), option).toBe(false);
    }
  });
});

describe("decisionSummary", () => {
  it("collapses whitespace and never renders empty", () => {
    expect(decisionSummary("  Run   bash?\n")).toBe("Run bash?");
    expect(decisionSummary("   ")).toBe("Needs you");
  });
});
