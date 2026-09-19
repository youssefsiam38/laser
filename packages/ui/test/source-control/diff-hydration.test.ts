// @vitest-environment node
/**
 * The crash, reproduced against the real renderer, and then refused.
 *
 * Measured in the running app: opening `src/index.ts` from the Files section
 * took the whole window into the app's error boundary with
 *
 *   computeEstimatedDiffHeights: trailing context mismatch (additions=1, deletions=2) for src/index.ts
 *
 * The file is a one-line insertion. The numbers are the tell: the renderer
 * counted one line of file after the last hunk on the new side and two on the
 * old side, which can only happen if the two sides it was given are not the
 * two ends the patch was computed from. They were not: every scope but
 * `range` asked `pi/project/file_source` for the old side with no ref, and a
 * missing ref means the working tree — so both sides came back as the file on
 * disk.
 *
 * `hydratePartialDiff` accepts that pair without a word. The renderer
 * discovers it later, mid-render, and throws; React unmounts everything above
 * it. So the check has to happen before hydration, which is what
 * `hydrationMismatch` is.
 */
import { expect, it } from "vitest";

import { hydrationMismatch, splitSideLines } from "../../src/source-control/diff-files.js";
import { EXPANSION_LINE_COUNT } from "../../src/source-control/diff-expand.js";

/** The person's file, byte for byte: checkpoint 0 on the left, the working tree on the right. */
const OLD_SIDE = [
  "export function greet(name: string, loud = false) {",
  "  const line = `hi ${name}`;",
  "  return loud ? line.toUpperCase() : line;",
  "}",
  "",
].join("\n");

const NEW_SIDE = [
  "/** Greets somebody. */",
  "export function greet(name: string, loud = false) {",
  "  const line = `hi ${name}`;",
  "  return loud ? line.toUpperCase() : line;",
  "}",
  "",
].join("\n");

/** Exactly what `git diff` writes for that edit: three lines of context, so the closing brace is past the hunk. */
const PATCH = [
  "diff --git a/src/index.ts b/src/index.ts",
  "index 48cf2f6..f658e36 100644",
  "--- a/src/index.ts",
  "+++ b/src/index.ts",
  "@@ -1,3 +1,4 @@",
  "+/** Greets somebody. */",
  " export function greet(name: string, loud = false) {",
  "   const line = `hi ${name}`;",
  "   return loud ? line.toUpperCase() : line;",
  "",
].join("\n");

const OPTIONS = {
  diffStyle: "split" as const,
  hunkSeparators: "line-info" as const,
  disableFileHeader: true,
  expandUnchanged: false,
  expansionLineCount: EXPANSION_LINE_COUNT,
};

async function parseOne() {
  const { parsePatchFiles } = await import("@pierre/diffs");
  const file = parsePatchFiles(PATCH).flatMap((patch) => patch.files)[0]!;
  expect(file.type).toBe("change");
  expect(file.isPartial).toBe(true);
  return file;
}

async function hydrate(oldContents: string, newContents: string) {
  const { hydratePartialDiff } = await import("@pierre/diffs");
  return hydratePartialDiff("clone", await parseOne(), {
    oldFile: { name: "src/index.ts", contents: oldContents },
    newFile: { name: "src/index.ts", contents: newContents },
  });
}

async function render(fileDiff: Awaited<ReturnType<typeof hydrate>>) {
  const { preloadFileDiff } = await import("@pierre/diffs/ssr");
  const { prerenderedHTML } = await preloadFileDiff({ fileDiff, options: OPTIONS });
  return prerenderedHTML;
}

it("splits a file exactly the way the renderer does", () => {
  expect(splitSideLines(OLD_SIDE)).toHaveLength(4);
  expect(splitSideLines(NEW_SIDE)).toHaveLength(5);
  expect(splitSideLines("")).toEqual([]);
  // A file with no newline at the end keeps its last line, unterminated —
  // which is how the patch stores it too, so the two compare equal.
  expect(splitSideLines("a\nb")).toEqual(["a\n", "b"]);
});

it("reproduces the crash: the working tree on both sides throws inside the renderer", async () => {
  const wrong = await hydrate(NEW_SIDE, NEW_SIDE);
  await expect(render(wrong)).rejects.toThrow(/trailing context mismatch \(additions=1, deletions=2\)/);
});

it("refuses that pair before it can be hydrated, and names the disagreement", async () => {
  const partial = await parseOne();
  // The working tree on the old side disagrees at its very first line: the
  // patch expects the function signature there and finds the doc comment the
  // turn added. We never get as far as the arithmetic the renderer trips on.
  expect(hydrationMismatch(partial, NEW_SIDE, NEW_SIDE)).toBe(
    "line 1 of the old side is not the line hunk 1 expects",
  );
});

it("states the renderer's own trailing-context assertion in our words, before it can throw", async () => {
  // Same text through the hunk, one extra line of file after it: the shape
  // that produces `additions=1, deletions=2` inside the virtualizer.
  const partial = await parseOne();
  expect(hydrationMismatch(partial, `${OLD_SIDE}export const extra = 1;\n`, NEW_SIDE)).toBe(
    "the last hunk is followed by 1 line on the new side and 2 lines on the old side",
  );
});

it("accepts the two ends the patch really spans, and the renderer draws them", async () => {
  const partial = await parseOne();
  expect(hydrationMismatch(partial, OLD_SIDE, NEW_SIDE)).toBeUndefined();
  const html = await render(await hydrate(OLD_SIDE, NEW_SIDE));
  expect(html).toContain("data-line=");
  expect(html).not.toContain("More unchanged context may be available");
});

it("catches a stale side whose length still adds up but whose text does not", async () => {
  // The same file one edit earlier: same number of lines, different content.
  // The trailing arithmetic passes; the text does not, and a hydration on
  // this pair would draw the wrong lines under the right numbers.
  const stale = OLD_SIDE.replace("loud ? line.toUpperCase() : line", "line");
  const partial = await parseOne();
  expect(hydrationMismatch(partial, stale, NEW_SIDE)).toMatch(/old side is not the line hunk 1 expects/);
});

it("catches a side from another file entirely", async () => {
  const partial = await parseOne();
  expect(hydrationMismatch(partial, "unrelated\n", NEW_SIDE)).toMatch(/runs past the end of the file it names/);
});

it("refuses a patch it cannot verify rather than hydrating on trust", () => {
  expect(hydrationMismatch({ hunks: [], additionLines: [], deletionLines: [] }, OLD_SIDE, NEW_SIDE)).toBe(
    "the patch has no hunks to place",
  );
});
