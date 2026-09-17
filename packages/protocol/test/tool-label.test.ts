import { describe, expect, it } from "vitest";
import { TOOL_LABEL_MAX, clampToolLabel, toolCallLabel, toolSearchContent, withoutToolLabel } from "../src/index.js";

describe("activity labels (D-277)", () => {
  it("clamps at the limit, never refuses, never returns empty", () => {
    expect(clampToolLabel("Reading build config")).toBe("Reading build config");
    expect(clampToolLabel("  Reading   the build config.  ")).toBe("Reading the build config");
    const long = clampToolLabel("Reading the very long build configuration file");
    expect(long!.length).toBeLessThanOrEqual(TOOL_LABEL_MAX + 1);
    expect(long).toMatch(/…$/);
    expect(clampToolLabel("   ")).toBeUndefined();
    expect(clampToolLabel(42)).toBeUndefined();
  });

  it("reads the label from args, subagent_name for start_agent, nothing for exempt tools", () => {
    expect(toolCallLabel("bash", { command: "ls", label: "Listing files" })).toBe("Listing files");
    expect(toolCallLabel("bash", { command: "ls" })).toBeUndefined();
    expect(toolCallLabel("start_agent", { subagent_name: "host-fixes", label: "ignored" })).toBe("host-fixes");
    expect(toolCallLabel("inspect_fleet", { label: "Looking" })).toBeUndefined();
    expect(toolCallLabel("complete_agent_run", { label: "Done" })).toBeUndefined();
  });

  it("strips the label from args and keeps it out of search content", () => {
    expect(withoutToolLabel({ command: "ls", label: "Listing" })).toEqual({ command: "ls" });
    const same = { command: "ls" };
    expect(withoutToolLabel(same)).toBe(same);
    const content = toolSearchContent({ name: "bash", args: { command: "ls -la", label: "Listing files" }, result: "ok" });
    expect(content.join("\n")).not.toContain("Listing files");
    expect(content.join("\n")).toContain("ls -la");
  });
});
