import { describe, expect, it } from "vitest";

import { MAX_DIFF_LINES, diffLines, diffStats, diffViewForTool } from "../src/tool-diff.js";

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


describe("shared diff reuse", () => {
  it("short-circuits identical large text without a replace-all fallback", () => {
    const text = lines(10_000, "same").join("\n");
    expect(diffLines(text, text)).toEqual([]);
    expect(diffViewForTool("edit", { edits: [{ oldText: text, newText: text }] }, undefined)).toBeUndefined();
  });
  it("preserves duplicate-line deletion tie-breaking and original line numbers", () => {
    expect(diffLines("a\nb\na", "a\na\nb")).toEqual([{ header: "@@ -1,3 +1,3 @@", lines: [
      { kind: "ctx", text: "a", oldNo: 1, newNo: 1 },
      { kind: "del", text: "b", oldNo: 2 },
      { kind: "ctx", text: "a", oldNo: 3, newNo: 2 },
      { kind: "add", text: "b", newNo: 3 },
    ] }]);
  });
  it("reuses presentation/search projections and invalidates source/patch changes without mutating old results", () => {
    const args = { path: "a.ts", edits: [{ oldText: "a\nb\na", newText: "a\na\nb" }] };
    const first = diffViewForTool("edit", args, undefined)!;
    const saved = structuredClone(first);
    expect(diffViewForTool("edit", args, {})).toBe(first);
    expect(diffViewForTool("edit", args, { ignored: "new result wrapper" })).toBe(first);
    args.edits[0]!.newText = "other";
    const revised = diffViewForTool("edit", args, undefined);
    expect(revised).not.toBe(first);
    expect(revised).toEqual(diffViewForTool("edit", structuredClone(args), undefined));
    expect(first).toEqual(saved);
    const details = { patch: "@@ -8 +8 @@\n-old\n+new" };
    const patch = diffViewForTool("edit", args, details);
    expect(diffViewForTool("edit", args, { ...details })).toBe(patch);
    details.patch = "@@ -9 +9 @@\n-before\n+after";
    expect(diffViewForTool("edit", args, details)).not.toBe(patch);
    args.path = "b.ts";
    expect(diffViewForTool("edit", args, details)?.path).toBe("b.ts");
  });
  it("measures repeated disclosure/search computation separately from cache misses", () => {
    const oldText = lines(1_998, "row").join("\n");
    const args = { edits: [{ oldText, newText: oldText.replace("row 999\n", "changed\n") }] };
    const miss: number[] = [], hit: number[] = [];
    const cached = diffViewForTool("edit", args, undefined);
    for (let i = 0; i < 20; i++) {
      let start = performance.now();
      expect(diffViewForTool("edit", { ...args }, undefined)).toEqual(cached);
      miss.push(performance.now() - start);
      start = performance.now();
      expect(diffViewForTool("edit", args, undefined)).toBe(cached);
      hit.push(performance.now() - start);
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[10];
    console.log(JSON.stringify({ finding: "F16", samples: 20, missMedianMs: median(miss), hitMedianMs: median(hit), miss, hit }));
  });
});
