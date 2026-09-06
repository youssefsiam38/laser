import { describe, expect, it } from "vitest";
import {
  summarizeActivityGroup,
  summarizeToolGroup,
  toolGroupDefaultOpen,
  toolGroupKey,
  type ToolGroupMember,
} from "../../src/components/thread/tool-groups.js";

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

  it("summarizes mixed activity with counted families in first-seen order", () => {
    const s = summarizeToolGroup([
      call("read", { path: "/a" }),
      call("bash", { command: "ls" }),
      call("edit", { path: "/a" }),
      call("read", { path: "/b" }),
      call("write", { path: "/c" }),
    ]);
    expect(s.label).toBe("Completed 5 actions");
    expect(s.iconKind).toBe("other");
    expect(s.breakdown).toEqual([
      expect.objectContaining({ family: "read", label: "Read 2 files", iconKind: "read" }),
      expect.objectContaining({ family: "command", label: "Ran 1 command", iconKind: "bash" }),
      expect.objectContaining({ family: "edit", label: "Edited 2 files", iconKind: "edit" }),
    ]);
  });

  it("puts every tool family in the same chronological activity group", () => {
    expect(toolGroupKey("read")).toBe("activity");
    expect(toolGroupKey("bash")).toBe("activity");
    expect(toolGroupKey("unknown-extension-tool")).toBe("activity");
  });

  it("speaks in the present tense while live and shows the call in flight", () => {
    const s = summarizeToolGroup([call("bash", { command: "pnpm build" }), call("bash", { command: "pnpm test" }, { running: true })]);
    expect(s.label).toBe("Running 2 commands");
    expect(s.detail).toBe("pnpm test");
    expect(s.activeLabel).toBe("Running pnpm test");
    expect(s.running).toBe(true);
  });

  it("summarizes reasoning beside every settled tool family", () => {
    const s = summarizeActivityGroup(
      [call("read", { path: "/a" }), call("edit", { path: "/b" }), call("bash", { command: "pnpm test" })],
      { count: 2, running: false },
    );
    expect(s.label).toBe("Completed 4 steps");
    expect(s.breakdown).toEqual([
      expect.objectContaining({ family: "reasoning", label: "Reasoned", iconKind: "reasoning" }),
      expect.objectContaining({ family: "read", label: "Read 1 file" }),
      expect.objectContaining({ family: "edit", label: "Edited 1 file" }),
      expect.objectContaining({ family: "command", label: "Ran 1 command" }),
    ]);
    expect(s.lines[0]).toBe("Reasoned");
  });

  it("uses the thinking indicator label until a concrete tool action takes over", () => {
    expect(summarizeActivityGroup([], { count: 1, running: true }).activeLabel).toBe("Thinking");
    expect(
      summarizeActivityGroup([call("edit", { path: "/workspace/src/index.html" }, { running: true })], {
        count: 1,
        running: false,
      }).activeLabel,
    ).toBe("Editing src/index.html");
  });

  it("names the exact target of a live file action", () => {
    const s = summarizeToolGroup([
      call("read", { path: "/workspace/src/old.ts" }),
      call("edit", { path: "/workspace/src/index.html" }, { running: true }),
    ]);
    expect(s.activeLabel).toBe("Editing src/index.html");
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
