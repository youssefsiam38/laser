import { expect, it } from "vitest";
import { appendPatchPage, expandableSides } from "../../src/source-control/diff-files.js";
import type { FileDiffPage, FileSource } from "../../src/source-control/contract.js";

const source = (extra: Partial<FileSource> = {}): FileSource => ({
  repo: "app",
  path: "a.ts",
  ref: "new",
  contents: "one\ntwo\n",
  ...extra,
});

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

it("opens context only for a two-sided change with both whole sides", () => {
  expect(expandableSides("change", { old: source({ ref: "old" }), next: source() })).toBe("ready");
  expect(expandableSides("rename-changed", { old: source({ ref: "old" }), next: source() })).toBe("ready");
});

it("never hydrates from a file the authority could only send in part", () => {
  // A prefix would renumber every line past the cut. Refusing is the
  // bounded-expansion rule at its source.
  expect(expandableSides("change", { old: source({ ref: "old", truncated: true }), next: source() })).toBe("too-large");
  expect(expandableSides("change", { old: source({ ref: "old" }), next: source({ truncated: true }) })).toBe("too-large");
});

it("separates waiting, refusal and a file that never had surrounding lines", () => {
  expect(expandableSides("change", undefined)).toBe("loading");
  expect(expandableSides("change", { old: null, next: source() })).toBe("unavailable");
  expect(expandableSides("new", undefined)).toBe("unsupported");
  expect(expandableSides("deleted", undefined)).toBe("unsupported");
  expect(expandableSides("rename-pure", undefined)).toBe("unsupported");
  expect(expandableSides(undefined, undefined)).toBe("unsupported");
});
