import { expect, it } from "vitest";
import { nextHunkIndex } from "../../src/source-control/hunk.js";

it("steps to the hunk at or after the viewport midpoint", () => {
  const tops = [10, 40, 90];
  expect(nextHunkIndex(tops, 45, 1)).toBe(2);
  expect(nextHunkIndex(tops, 45, -1)).toBe(1);
  expect(nextHunkIndex(tops, 5, 1)).toBe(1);
  expect(nextHunkIndex(tops, 200, -1)).toBe(2);
  expect(nextHunkIndex([], 10, 1)).toBeUndefined();
});
