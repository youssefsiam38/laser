import { describe, expect, it } from "vitest";
import { TOOL_LABEL_MAX, clampToolLabel, toolCallLabel, toolSearchContent, withoutToolLabel } from "../src/index.js";

describe("activity labels (D-277)", () => {
  it("clamps at the limit, never refuses, never returns empty", () => {
    expect(clampToolLabel("Reading build config")).toBe("Reading build config");
    expect(clampToolLabel("  Reading   the build config.  ")).toBe("Reading the build config");
    const long = clampToolLabel("Reading the very long build configuration file");
    expect(long!.length).toBeLessThanOrEqual(TOOL_LABEL_MAX);
    expect(long).toMatch(/…$/);
    expect(clampToolLabel("   ")).toBeUndefined();
    expect(clampToolLabel(42)).toBeUndefined();
  });

  it("reads activity_label and leaves start_agent's full identity to its row", () => {
    expect(toolCallLabel("bash", { command: "ls", activity_label: "Listing files" })).toBe("Listing files");
    expect(toolCallLabel("bash", { command: "ls" })).toBeUndefined();
    expect(toolCallLabel("start_agent", { subagent_name: "a-very-long-subagent-identity", agent_name: "worker" })).toBeUndefined();
    expect(toolCallLabel("inspect_fleet", { activity_label: "Looking" })).toBeUndefined();
    expect(toolCallLabel("complete_agent_run", { activity_label: "Done" })).toBeUndefined();
  });

  it("strips only the injected activity label and keeps it out of search content", () => {
    expect(withoutToolLabel({ command: "ls", activity_label: "Listing" })).toEqual({ command: "ls" });
    const same = { command: "ls" };
    expect(withoutToolLabel(same)).toBe(same);
    const params = { mcp_tool: "activity_label_2" };
    const colliding = { activity_label: "tool-owned", activity_label_2: "Calling server", query: "kept" };
    expect(toolCallLabel("mcp_tool", colliding, params)).toBe("Calling server");
    expect(withoutToolLabel(colliding, "mcp_tool", params)).toEqual({ activity_label: "tool-owned", query: "kept" });
    const content = toolSearchContent({ name: "mcp_tool", args: colliding, result: "ok" }, params);
    expect(content.join("\n")).not.toContain("Calling server");
    expect(content.join("\n")).toContain("tool-owned");
    expect(content.join("\n")).toContain("kept");
  });
});
