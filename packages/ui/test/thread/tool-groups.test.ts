import { describe, expect, it } from "vitest";
import { summarizeToolGroup, toolGroupDefaultOpen, type ToolGroupMember } from "../../src/components/thread/tool-groups.js";

const call = (toolName: string, args: unknown, over: Partial<ToolGroupMember> = {}): ToolGroupMember => ({
  toolCallId: `${toolName}-${JSON.stringify(args)}`,
  toolName,
  args,
  isError: false,
  running: false,
  awaiting: false,
  cancelled: false,
  ...over,
});

describe("summarizeToolGroup", () => {
  it("names homogeneous groups by family", () => {
    expect(summarizeToolGroup([call("bash", { command: "ls" }), call("bash", { command: "pwd" })]).label).toBe("Ran 2 commands");
    expect(summarizeToolGroup([call("read", { path: "/a" }), call("read", { path: "/b" }), call("read", { path: "/c" })]).label).toBe(
      "Read 3 files",
    );
    expect(summarizeToolGroup([call("grep", { pattern: "x" }), call("find", { pattern: "*.ts" })]).label).toBe("Searched 2 patterns");
    expect(summarizeToolGroup([call("ls", { path: "." })]).label).toBe("Listed 1 directory");
  });

  it("counts distinct files for edits and says how many edits when they differ", () => {
    const s = summarizeToolGroup([call("edit", { path: "/a.ts" }), call("edit", { path: "/a.ts" }), call("write", { path: "/b.ts" })]);
    expect(s.label).toBe("Edited 2 files");
    expect(s.detail).toBe("3 edits");
    expect(s.family).toBe("edit");
  });

  it("falls back to 'Used N tools' for mixed families", () => {
    const s = summarizeToolGroup([call("bash", { command: "ls" }), call("read", { path: "/a" })]);
    expect(s.label).toBe("Used 2 tools");
    expect(s.iconKind).toBe("other");
  });

  it("speaks in the present tense while live and shows the call in flight", () => {
    const s = summarizeToolGroup([call("bash", { command: "pnpm build" }), call("bash", { command: "pnpm test" }, { running: true })]);
    expect(s.label).toBe("Running 2 commands");
    expect(s.detail).toBe("pnpm test");
    expect(s.running).toBe(true);
  });

  it("opens by default only for an error or a pending decision", () => {
    const quiet = summarizeToolGroup([call("read", { path: "/a" }), call("read", { path: "/b" })]);
    const failed = summarizeToolGroup([call("bash", { command: "x" }, { isError: true }), call("bash", { command: "y" })]);
    const asking = summarizeToolGroup([call("bash", { command: "rm -rf" }, { awaiting: true }), call("bash", { command: "y" })]);
    expect(toolGroupDefaultOpen(quiet)).toBe(false);
    expect(toolGroupDefaultOpen(failed)).toBe(true);
    expect(toolGroupDefaultOpen(asking)).toBe(true);
    expect(failed.lines[0]).toMatch(/failed$/);
    expect(asking.lines[0]).toMatch(/waiting for you$/);
  });
});
