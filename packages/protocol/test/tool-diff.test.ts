import { describe, expect, it } from "vitest";

import { MAX_DIFF_LINES, diffStats, diffViewForTool } from "../src/tool-diff.js";

const lines = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);

describe("tool diff statistics", () => {
  it("retains full patch counts when the rendered preview is truncated", () => {
    const added = lines(MAX_DIFF_LINES + 37, "added");
    const removed = lines(9, "removed");
    const patch = [
      `@@ -1,${removed.length} +1,${added.length} @@`,
      ...removed.map((line) => `-${line}`),
      ...added.map((line) => `+${line}`),
    ].join("\n");

    const view = diffViewForTool("edit", { path: "src/large.ts" }, { patch });

    expect(view).toBeDefined();
    expect(view?.truncated).toBe(true);
    expect(view?.hunks.flatMap((hunk) => hunk.lines)).toHaveLength(MAX_DIFF_LINES);
    expect(view?.stats).toEqual({ added: added.length, removed: removed.length });
    expect(diffStats(view?.hunks ?? [])).not.toEqual(view?.stats);
  });

  it("counts the full edit source before bounding computed hunks", () => {
    const oldText = lines(MAX_DIFF_LINES + 21, "old").join("\n");
    const newText = lines(MAX_DIFF_LINES + 13, "new").join("\n");

    const view = diffViewForTool("edit", {
      path: "src/computed.ts",
      edits: [{ oldText, newText }],
    }, undefined);

    expect(view?.truncated).toBe(true);
    expect(view?.stats).toEqual({ added: MAX_DIFF_LINES + 13, removed: MAX_DIFF_LINES + 21 });
  });

  it("reports write content as additions without inventing removed lines", () => {
    const content = lines(MAX_DIFF_LINES + 5, "written").join("\n");
    const view = diffViewForTool("write", { path: "src/new.ts", content }, undefined);

    expect(view?.truncated).toBe(true);
    expect(view?.stats).toEqual({ added: MAX_DIFF_LINES + 5, removed: 0 });
    expect(diffViewForTool("write", { path: "src/cleared.ts", content: "" }, undefined)).toBeUndefined();
  });
});
