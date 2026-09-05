import { describe, expect, it } from "vitest";
import { elideText, ELISION_HEAD_LINES, ELISION_TAIL_LINES } from "../../src/components/thread/tool-summary.js";

/**
 * A tool result reaches the DOM as a single text node, so `max-h-80` bounds the
 * painted box but not the layout cost. These guard the cap.
 */
describe("elideText", () => {
  it("leaves ordinary output untouched", () => {
    const text = "line one\nline two\n";
    const result = elideText(text);
    expect(result).toEqual({ text, truncated: false, note: "" });
  });

  it("keeps the head and the tail of a very long output", () => {
    const lines = Array.from({ length: ELISION_HEAD_LINES + ELISION_TAIL_LINES + 500 }, (_, i) => `line ${i}`);
    const result = elideText(lines.join("\n"));
    expect(result.truncated).toBe(true);
    expect(result.note).toBe("500 lines");
    expect(result.text).toContain("line 0");
    expect(result.text).toContain(`line ${lines.length - 1}`);
    expect(result.text).not.toContain(`line ${ELISION_HEAD_LINES + 10}\n`);
    expect(result.text).toContain("elided");
    expect(result.text.split("\n").length).toBeLessThan(ELISION_HEAD_LINES + ELISION_TAIL_LINES + 10);
  });

  it("caps by characters when a single line is enormous", () => {
    const text = "x".repeat(1_000_000);
    const result = elideText(text);
    expect(result.truncated).toBe(true);
    expect(result.note).toContain("characters");
    expect(result.text.length).toBeLessThan(210_000);
  });

  it("honours explicit budgets", () => {
    const result = elideText("a\nb\nc\nd\ne", { headLines: 1, tailLines: 1 });
    expect(result.text).toBe("a\n\n…  3 lines elided  …\n\ne");
  });
});
