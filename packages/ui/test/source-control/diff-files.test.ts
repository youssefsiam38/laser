import { expect, it } from "vitest";
import { appendPatchPage, loadedDiffFiles } from "../../src/source-control/diff-files.js";
import type { FileDiffPage } from "../../src/source-control/contract.js";

const page = (patch: string, extra: Partial<FileDiffPage> = {}): FileDiffPage => ({
  repo: "app",
  path: "a.ts",
  status: "modified",
  added: 1,
  removed: 0,
  patch,
  ...extra,
});

it("appends a later patch page and keeps the truncated flag from the latest page", () => {
  const first = page("aaa", { offset: 0, bytes: 3, nextOffset: 3, truncated: true });
  const next = page("bbb", { offset: 3, bytes: 3, truncated: false });
  expect(appendPatchPage(first, next)).toMatchObject({
    patch: "aaabbb",
    bytes: 6,
    truncated: false,
  });
});

it("maps old and new sources for Pierre hydration", () => {
  expect(loadedDiffFiles(null, null, { path: "a.ts" })).toEqual({
    oldFile: null,
    newFile: { name: "a.ts", contents: "" },
  });
  expect(
    loadedDiffFiles(
      { repo: "app", path: "old.ts", ref: "old", contents: "a" },
      { repo: "app", path: "a.ts", ref: "new", contents: "b" },
      { path: "a.ts", oldPath: "old.ts" },
    ),
  ).toEqual({
    oldFile: { name: "old.ts", contents: "a" },
    newFile: { name: "a.ts", contents: "b" },
  });
});
