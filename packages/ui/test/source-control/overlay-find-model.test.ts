import { expect, it } from "vitest";
import {
  dedupeDiffLineMatches,
  hiddenMatchCount,
  overlayFindStatus,
} from "../../src/source-control/overlay-find-model.js";

it("dedupes split-view context matches that share an excerpt", () => {
  const twice = [
    { before: "export ", match: "const", after: " a" },
    { before: "export ", match: "const", after: " a" },
    { before: "return ", match: "const", after: " b" },
  ];
  expect(dedupeDiffLineMatches(twice)).toHaveLength(2);
});

it("counts hidden matches as model minus rendered, never negative", () => {
  expect(hiddenMatchCount(5, 3)).toBe(2);
  expect(hiddenMatchCount(3, 6)).toBe(0);
});

it("builds the find status string from current matches", () => {
  expect(overlayFindStatus("", 0, 0, 0)).toBe("0 / 0");
  expect(overlayFindStatus("const", 0, 2, 4)).toBe("1 / 2 · 2 in collapsed context");
  expect(overlayFindStatus("const", 1, 2, 2)).toBe("2 / 2");
  expect(overlayFindStatus("const", 0, 0, 4)).toBe("Collapsed · 4 in this file");
  expect(overlayFindStatus("nope", 0, 0, 0)).toBe("No matches");
});
