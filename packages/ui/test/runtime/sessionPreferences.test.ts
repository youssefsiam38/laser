import { describe, expect, it } from "vitest";

import {
  activityDetailLevel,
  activityGroupDefaultOpen,
  toolDetailsDefaultOpen,
} from "../../src/runtime/sessionPreferences.js";

describe("session activity detail", () => {
  it("starts new sessions with every activity disclosure collapsed", () => {
    expect(activityDetailLevel(undefined)).toBe("answers");
    expect(activityDetailLevel("/session/without-a-saved-preference.jsonl")).toBe("answers");
  });

  it("keeps aggregates closed at the middle level too; reasoning opens inside on request", () => {
    expect(activityGroupDefaultOpen("answers", true, false)).toBe(false);
    expect(activityGroupDefaultOpen("reasoning", false, false)).toBe(false);
    expect(activityGroupDefaultOpen("reasoning", true, false)).toBe(false);
  });

  it("opens action bodies only for everything while attention always wins", () => {
    expect(toolDetailsDefaultOpen("answers")).toBe(false);
    expect(toolDetailsDefaultOpen("reasoning")).toBe(false);
    expect(toolDetailsDefaultOpen("everything")).toBe(true);
    expect(activityGroupDefaultOpen("answers", false, true)).toBe(true);
  });
});
