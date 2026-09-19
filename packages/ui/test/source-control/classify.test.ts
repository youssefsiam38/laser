import { expect, it } from "vitest";
import {
  LARGE_DIFF_LINE_LIMIT,
  classifyEmptyBody,
  fileLineCount,
  listTotals,
  modeWords,
  overlayChromeLayout,
  patchValueMatches,
  shouldBoundExpansion,
  splitColumnsFit,
  statusMark,
} from "../../src/source-control/classify.js";
import type { ChangedRepo } from "../../src/source-control/contract.js";

it("classifies binary, mode-only and pure-rename empty bodies from authority metadata", () => {
  expect(classifyEmptyBody({ status: "binary", added: 0, removed: 0, path: "logo.png", size: 100 }).kind).toBe("binary");
  expect(classifyEmptyBody({ status: "mode", added: 0, removed: 0, path: "script.sh", mode: "100755", prevMode: "100644" }).kind).toBe("mode");
  expect(classifyEmptyBody({ status: "renamed", added: 0, removed: 0, path: "new.ts", oldPath: "old.ts" }).kind).toBe("rename-pure");
  expect(classifyEmptyBody({ status: "modified", added: 2, removed: 1, path: "a.ts" })).toBeNull();
});

it("uses Pierre type and empty hunks when the patch parsed that way", () => {
  expect(classifyEmptyBody({ status: "modified", added: 0, removed: 0, path: "moved.ts", pierreType: "rename-pure", hunkCount: 0 })?.kind).toBe("rename-pure");
  expect(classifyEmptyBody({ status: "modified", added: 0, removed: 0, path: "script.sh", mode: "100755", prevMode: "100644", hunkCount: 0 })?.kind).toBe("mode");
});

it("falls back to unified when two code columns do not fit, and keeps split when unmeasured", () => {
  expect(splitColumnsFit(320, 12)).toBe(false);
  expect(splitColumnsFit(900, 12)).toBe(true);
  expect(splitColumnsFit(0, 12)).toBe(true);
  expect(overlayChromeLayout(320, 16)).toBe("phone");
  expect(overlayChromeLayout(1280, 16)).toBe("desktop");
  expect(overlayChromeLayout(0, 16)).toBe("desktop");
});

it("bounds expansion on files over the stated line count", () => {
  expect(shouldBoundExpansion(LARGE_DIFF_LINE_LIMIT)).toBe(false);
  expect(shouldBoundExpansion(LARGE_DIFF_LINE_LIMIT + 1)).toBe(true);
  expect(fileLineCount({ added: 5000, removed: 20 })).toBe(5020);
  expect(shouldBoundExpansion(5020)).toBe(true);
});

it("names a mode change in words and totals a repo list", () => {
  expect(modeWords("100644", "100755")).toBe("executable");
  expect(modeWords("100755", "100644")).toBe("not executable");
  expect(statusMark("added")).toBe("A");
  const repos: ChangedRepo[] = [
    { repo: "app", branch: "main", files: [{ path: "a.ts", status: "modified", added: 2, removed: 1 }] },
    { repo: "broken", branch: "", files: [], error: "missing" },
  ];
  expect(listTotals(repos)).toEqual({ added: 2, removed: 1, files: 1 });
});

it("counts patch value matches and skips hunk chrome", () => {
  const patch = `diff --git a/a.ts b/a.ts
@@ -1,2 +1,3 @@
 export const a = 1;
+export const b = 2;
`;
  expect(patchValueMatches(patch, "export const")).toBe(2);
  expect(patchValueMatches(patch, "diff --git")).toBe(0);
  expect(patchValueMatches(patch, "@@")).toBe(0);
});
