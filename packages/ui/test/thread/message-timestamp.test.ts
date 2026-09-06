import { describe, expect, it } from "vitest";

import { messageTimeDescription, messageTimeLabel } from "../../src/components/assistant-ui/elements/day-separator.js";

describe("message timestamps", () => {
  const message = new Date(2026, 8, 6, 16, 5);

  it("uses the person's local clock rather than a machine timestamp", () => {
    expect(messageTimeLabel(message, "en-US")).toBe("4:05 PM");
  });

  it("describes recent dates in natural language", () => {
    expect(messageTimeDescription(message, new Date(2026, 8, 6, 18), "en-US")).toBe("Today at 4:05 PM");
    expect(messageTimeDescription(message, new Date(2026, 8, 7, 18), "en-US")).toBe("Yesterday at 4:05 PM");
  });
});
