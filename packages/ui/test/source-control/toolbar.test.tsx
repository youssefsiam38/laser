import { expect, it } from "vitest";
import { committedRange } from "../../src/source-control/toolbar.js";

it("commits a range only when both ends are new and non-empty", () => {
  expect(committedRange("abc", "def", "HEAD", "")).toEqual({ from: "abc", to: "def" });
  expect(committedRange("HEAD", "HEAD", "HEAD", "HEAD")).toBeNull();
  expect(committedRange("abc", "", "HEAD", "")).toBeNull();
  expect(committedRange("  abc  ", " def ", "HEAD", "HEAD")).toEqual({ from: "abc", to: "def" });
});
