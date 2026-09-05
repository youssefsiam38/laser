import { describe, expect, it } from "vitest";

import { fileTreeFromChanges } from "../../src/components/assistant-ui/elements/file-tree.js";

describe("fileTreeFromChanges", () => {
  it("collapses single-child folder chains, sorts folders first, merges repeat paths", () => {
    const nodes = fileTreeFromChanges([
      { path: "packages/ui/src/b.ts", additions: 1, deletions: 0 },
      { path: "packages/ui/src/a.ts", additions: 2, deletions: 3 },
      { path: "packages/ui/src/a.ts", additions: 1, deletions: 1 },
      { path: "README.md", additions: 5, deletions: 0 },
      { path: "packages/ui/test/x.test.ts", additions: 4, deletions: 0 },
    ]);
    expect(nodes.map((n) => `${"  ".repeat(n.depth)}${n.kind === "folder" ? n.name + "/" : n.name}`)).toEqual([
      "packages/ui/",
      "  src/",
      "    a.ts",
      "    b.ts",
      "  test/",
      "    x.test.ts",
      "README.md",
    ]);
    const a = nodes.find((n) => n.name === "a.ts");
    expect(a).toMatchObject({ path: "packages/ui/src/a.ts", additions: 3, deletions: 4 });
  });

  it("handles an empty list and absolute paths", () => {
    expect(fileTreeFromChanges([])).toEqual([]);
    const nodes = fileTreeFromChanges([{ path: "/home/x/y.ts", additions: 0, deletions: 1 }]);
    expect(nodes.map((n) => n.name)).toEqual(["home/x", "y.ts"]);
  });
});
