// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import {
  activityDetailLevel,
  activityDisclosureOverride,
  activityGroupDefaultOpen,
  setActivityDisclosureOverride,
  toolDetailsDefaultOpen,
} from "../../src/runtime/sessionPreferences.js";

describe("session activity detail", () => {
  beforeEach(() => localStorage.clear());

  it("starts new sessions with every activity disclosure collapsed", () => {
    expect(activityDetailLevel(undefined)).toBe("answers");
    expect(activityDetailLevel("/session/without-a-saved-preference.jsonl")).toBe("answers");
  });

  it("keeps aggregates closed at the middle level too; reasoning opens inside on request", () => {
    expect(activityGroupDefaultOpen("answers", true, false)).toBe(false);
    expect(activityGroupDefaultOpen("reasoning", false, false)).toBe(false);
    expect(activityGroupDefaultOpen("reasoning", true, false)).toBe(false);
  });

  it("opens untouched action bodies only for everything; errors and decisions stay quiet in Answers only", () => {
    expect(toolDetailsDefaultOpen("answers")).toBe(false);
    expect(toolDetailsDefaultOpen("reasoning")).toBe(false);
    expect(toolDetailsDefaultOpen("everything")).toBe(true);
    expect(activityGroupDefaultOpen("answers", false, true)).toBe(false);
    expect(activityGroupDefaultOpen("reasoning", true, true)).toBe(false);
    expect(activityGroupDefaultOpen("everything", false, false)).toBe(true);
  });

  it("scopes manual choices by session and row, retaining only a bounded recent set", () => {
    setActivityDisclosureOverride("/session/a", "group:same", true);
    expect(activityDisclosureOverride("/session/a", "group:same")).toBe(true);
    expect(activityDisclosureOverride("/session/b", "group:same")).toBeUndefined();
    expect(activityDisclosureOverride("/session/a", "group:other")).toBeUndefined();

    for (let index = 0; index < 401; index++) {
      setActivityDisclosureOverride("/session/a", `tool:${index}`, index % 2 === 0);
    }
    expect(activityDisclosureOverride("/session/a", "group:same")).toBeUndefined();
    expect(activityDisclosureOverride("/session/a", "tool:400")).toBe(true);

    // Updating the row the person just touched moves it to the retained tail;
    // another full window minus one cannot evict it.
    setActivityDisclosureOverride("/session/a", "group:same", false);
    for (let index = 0; index < 399; index++) {
      setActivityDisclosureOverride("/session/b", `new:${index}`, true);
    }
    expect(activityDisclosureOverride("/session/a", "group:same")).toBe(false);
  });
});
