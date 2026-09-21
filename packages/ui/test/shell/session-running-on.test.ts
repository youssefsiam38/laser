/**
 * M22-T8: what a session row says about the profile it runs on.
 *
 * The row itself keeps its name and its one activity mark (DESIGN.md: status
 * words belong to the fleet), so this line is the row's tooltip — intent and
 * evidence, in that order. A conversation this client has never opened gets it
 * from the catalog row, which is why it works for the whole list and not only
 * for the one on screen.
 */
import { describe, expect, it } from "vitest";

import { runningOnText } from "../../src/components/assistant-ui/elements/thread-list.aui.js";

const names = new Map([["mp_balanced0000000000", "Balanced"]]);

describe("what a session row runs on", () => {
  it("names the profile and the model that answered", () => {
    expect(runningOnText({ profileId: "mp_balanced0000000000", model: "Sonnet 4.5" }, names)).toBe("Balanced · Sonnet 4.5");
  });

  it("says a conversation with no profile is pinned to the one model it has", () => {
    expect(runningOnText({ profileId: undefined, model: "Sonnet 4.5" }, names)).toBe("Pinned · Sonnet 4.5");
  });

  it("never prints a profile id: a profile since deleted is said in words", () => {
    expect(runningOnText({ profileId: "mp_gone000000000000", model: "Sonnet 4.5" }, names)).toBe("a profile that is gone · Sonnet 4.5");
  });

  it("says nothing at all when nothing is known", () => {
    expect(runningOnText({ profileId: undefined, model: undefined }, names)).toBeUndefined();
    // A profile with no model recorded yet is still the intent, and says so.
    expect(runningOnText({ profileId: "mp_balanced0000000000", model: undefined }, names)).toBe("Balanced");
  });
});
