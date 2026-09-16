import { describe, expect, it } from "vitest";
import { METHOD_POLICY, methodStartsWork } from "../src/method-policy.js";

describe("update activation admission policy", () => {
  it("derives every new work root from the typed method table", () => {
    const roots = Object.entries(METHOD_POLICY)
      .filter(([, policy]) => policy.startsWork)
      .map(([method]) => method)
      .sort();
    expect(roots).toEqual([
      "pi/session/compact",
      "pi/session/follow_up",
      "pi/session/steer",
      "pi/transcribe/begin",
      "session/goal/action",
      "session/new",
      "session/pending/add",
      "session/pending/edit",
      "session/pending/steer",
      "session/prompt",
    ]);
    expect(roots.every(methodStartsWork)).toBe(true);
    expect(methodStartsWork("pi/worker/activation/status")).toBe(false);
    expect(methodStartsWork("unknown/method")).toBe(false);
  });
});
