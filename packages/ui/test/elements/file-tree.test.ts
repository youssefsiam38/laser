import { describe, expect, it } from "vitest";

import { fileChangesFromParts, fileTreeFromChanges } from "../../src/components/assistant-ui/elements/file-tree.js";

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

describe("fileChangesFromParts", () => {
  it("uses full-source counts when the displayed diff is truncated", () => {
    const patch = [
      "@@ -1,9 +1,427 @@",
      ...Array.from({ length: 9 }, (_, index) => `-const old${index + 1} = true;`),
      ...Array.from({ length: 427 }, (_, index) => `+const item${index + 1} = ${index + 1};`),
    ].join("\n");

    const changes = fileChangesFromParts([{
      parts: [{
        type: "tool-call",
        toolCallId: "edit-large",
        toolName: "edit",
        args: { path: "src/large.ts" },
        result: { content: [{ type: "text", text: "Edited" }], details: { patch } },
        status: { type: "complete", reason: "stop" },
      }],
    }]);

    expect(changes).toEqual([{ path: "src/large.ts", additions: 427, deletions: 9 }]);
  });
});
