import { describe, expect, it } from "vitest";

import {
  activityGroupDefaultOpen,
  toolDetailsDefaultOpen,
} from "../../src/runtime/sessionPreferences.js";

describe("session activity detail", () => {
  it("keeps the aggregate quiet for answers and opens only reasoning at the middle level", () => {
    expect(activityGroupDefaultOpen("answers", true, false)).toBe(false);
    expect(activityGroupDefaultOpen("reasoning", false, false)).toBe(false);
    expect(activityGroupDefaultOpen("reasoning", true, false)).toBe(true);
  });

  it("opens action bodies only for everything while attention always wins", () => {
    expect(toolDetailsDefaultOpen("answers")).toBe(false);
    expect(toolDetailsDefaultOpen("reasoning")).toBe(false);
    expect(toolDetailsDefaultOpen("everything")).toBe(true);
    expect(activityGroupDefaultOpen("answers", false, true)).toBe(true);
  });
});
