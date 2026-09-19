// @vitest-environment node
/**
 * The dead row, reproduced and then gone — against the real renderer.
 *
 * `@pierre/diffs` can render a diff to HTML without a browser
 * (`preloadFileDiff`, the SSR entry the React component also consumes as
 * `prerenderedHTML`). That makes the defect testable at the boundary that
 * actually produced it, rather than through a mock that would agree with
 * whatever we wrote.
 *
 * The first case is what the overlay used to hand over: a patch-parsed
 * (`isPartial`) diff plus a `loadDiffFiles` loader. The renderer writes "More
 * unchanged context may be available" — a sentence about a promise, with the
 * real lines still unfetched. The second case is what it hands over now: a
 * hydrated, non-partial diff. Same patch, same options; real gap sizes and no
 * promise.
 */
import { expect, it } from "vitest";

import { EXPANSION_LINE_COUNT } from "../../src/source-control/diff-expand.js";

const DEAD_ROW = "More unchanged context may be available";

const LINES = Array.from({ length: 60 }, (_, index) => `const line${index + 1} = ${index + 1};`);
const OLD_TEXT = `${LINES.join("\n")}\n`;
const NEW_LINES = LINES.with(29, "const line30 = 300;");
const NEW_TEXT = `${NEW_LINES.join("\n")}\n`;

/** One hunk with three lines of context either side, 26 lines into the file. */
const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -27,7 +27,7 @@",
  ...LINES.slice(26, 29).map((line) => ` ${line}`),
  `-${LINES[29]}`,
  `+${NEW_LINES[29]}`,
  ...LINES.slice(30, 33).map((line) => ` ${line}`),
  "",
].join("\n");

const OPTIONS = {
  diffStyle: "unified" as const,
  hunkSeparators: "line-info" as const,
  disableFileHeader: true,
  expandUnchanged: false,
  expansionLineCount: EXPANSION_LINE_COUNT,
};

const SIDES = {
  oldFile: { name: "src/a.ts", contents: OLD_TEXT },
  newFile: { name: "src/a.ts", contents: NEW_TEXT },
};

async function parseOne() {
  const { parsePatchFiles } = await import("@pierre/diffs");
  const file = parsePatchFiles(PATCH).flatMap((patch) => patch.files)[0]!;
  expect(file.type).toBe("change");
  expect(file.isPartial).toBe(true);
  return file;
}

/**
 * The rendered markup only. `prerenderedHTML` also embeds Pierre's core
 * stylesheet, which names every selector in the library — including the ones
 * under test — so the sheet has to come off before anything is counted.
 */
async function render(fileDiff: Awaited<ReturnType<typeof parseOne>>, options: Record<string, unknown>) {
  const { preloadFileDiff } = await import("@pierre/diffs/ssr");
  const { prerenderedHTML } = await preloadFileDiff({ fileDiff, options });
  const markup = prerenderedHTML.slice(prerenderedHTML.lastIndexOf("</style>") + "</style>".length);
  expect(markup).toContain("data-line=");
  return markup;
}

it("reproduces the dead row: a patch plus a loader promises context it has not got", async () => {
  const html = await render(await parseOne(), { ...OPTIONS, loadDiffFiles: async () => SIDES });
  // The trailing gap has no size, because the renderer has not got the file:
  // 27 real lines follow the hunk and it can only say "may be available".
  expect(html).toContain(DEAD_ROW);
  expect(html).not.toContain("27 unmodified lines");
});

it("hands over a hydrated diff instead: real gap sizes, real expanders, no promise", async () => {
  const { hydratePartialDiff } = await import("@pierre/diffs");
  const partial = await parseOne();
  const hydrated = hydratePartialDiff("clone", partial, SIDES);

  expect(hydrated.isPartial).toBe(false);
  // Hydration clones: the parsed patch the overlay keeps is untouched, so a
  // later render of the same page is not quietly a different model.
  expect(partial.isPartial).toBe(true);
  expect(hydrated.additionLines).toHaveLength(LINES.length);
  expect(hydrated.deletionLines).toHaveLength(LINES.length);

  const html = await render(hydrated, OPTIONS);
  expect(html).not.toContain(DEAD_ROW);
  // 26 lines before the hunk, 27 after: the sizes a person can act on.
  expect(html).toContain("26 unmodified lines");
  expect(html).toContain("27 unmodified lines");
  expect(html).toContain("data-expand-button");
  expect(html).toContain("data-expand-index");
});

it("draws no expander at all when there is nothing behind it", async () => {
  // A patch with no loader and no hydration: Pierre knows it cannot open the
  // gap, so it says nothing about one. The overlay supplies its own sentence.
  const html = await render(await parseOne(), OPTIONS);
  expect(html).not.toContain(DEAD_ROW);
  expect(html).not.toContain("data-expand-index");
  // It still names the gap it can measure from the hunk header; what it does
  // not do is offer to open something it cannot reach.
  expect(html).toContain("26 unmodified lines");
});
