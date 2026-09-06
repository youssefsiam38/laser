import { describe, expect, it } from "vitest";

import { messageTimeDescription, messageTimeLabel } from "../../src/components/assistant-ui/elements/message-timestamp.js";
import { hoverReveal } from "../../src/components/assistant-ui/elements/message-pair.js";

describe("message timestamps", () => {
  const message = new Date(2026, 8, 6, 16, 5);

  it("uses the person's local clock rather than a machine timestamp", () => {
    expect(messageTimeLabel(message, "en-US")).toBe("4:05 PM");
  });

  it("describes recent dates in natural language", () => {
    expect(messageTimeDescription(message, new Date(2026, 8, 6, 18), "en-US")).toBe("Today at 4:05 PM");
    expect(messageTimeDescription(message, new Date(2026, 8, 7, 18), "en-US")).toBe("Yesterday at 4:05 PM");
    expect(messageTimeDescription(message, new Date(2027, 8, 7, 18), "en-US")).toContain("Sep 6, 2026 at 4:05 PM");
  });

  it("reveals row details for pointer, keyboard and touch users", () => {
    expect(hoverReveal).toContain("group-hover/message:opacity-100");
    expect(hoverReveal).toContain("group-focus-within/message:opacity-100");
    expect(hoverReveal).toContain("[@media(pointer:coarse)]:opacity-100");
  });
});
