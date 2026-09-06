import { describe, expect, it } from "vitest";

import { splitLeadingQuote } from "../../src/components/assistant-ui/elements/quote-reply.js";
import { continuationsOf, laterUserMessages, leafOf, userEntryAt, userEntryIds } from "../../src/components/thread/entries.js";

const msg = (id: string, parentId: string | null, role: string) => ({ id, parentId, type: "message", message: { role } });

/**
 * A session that was jumped back to u1 and continued: u1 has two
 * continuations, the original reply a1 (whose branch runs to a2) and the new
 * prompt u3.
 *
 *   u1 ─ a1 ─ u2 ─ a2
 *     └─ u3 ─ a3
 */
const tree = [
  { id: "h", type: "session_info", parentId: null, name: "x" },
  msg("u1", null, "user"),
  msg("a1", "u1", "assistant"),
  msg("u2", "a1", "user"),
  msg("a2", "u2", "assistant"),
  { id: "lbl", parentId: "u1", type: "label", targetId: "u1", label: "start" },
  msg("u3", "u1", "user"),
  msg("a3", "u3", "assistant"),
  { id: "t", parentId: "a3", type: "message", message: { role: "toolResult" } },
];

describe("entries: ordinals", () => {
  it("lists user entries in file order, the same walk the store makes", () => {
    expect(userEntryIds(tree)).toEqual(["u1", "u2", "u3"]);
    expect(userEntryAt(tree, 0)).toBe("u1");
    expect(userEntryAt(tree, 2)).toBe("u3");
  });
  it("has no entry for a prompt that is not persisted yet", () => {
    expect(userEntryAt(tree, 3)).toBeUndefined();
    expect(userEntryAt(tree, -1)).toBeUndefined();
    expect(userEntryAt([], 0)).toBeUndefined();
  });
  it("counts what an edit-and-resend leaves behind", () => {
    expect(laterUserMessages(3, 0)).toBe(2);
    expect(laterUserMessages(3, 2)).toBe(0);
    expect(laterUserMessages(0, 5)).toBe(0);
  });
});

describe("entries: branches", () => {
  it("finds continuations, ignoring labels", () => {
    expect(continuationsOf(tree, "u1")).toEqual(["a1", "u3"]);
    expect(continuationsOf(tree, "a1")).toEqual(["u2"]);
    expect(continuationsOf(tree, "a2")).toEqual([]);
  });
  it("follows the last child down to a leaf", () => {
    expect(leafOf(tree, "a1")).toBe("a2");
    expect(leafOf(tree, "u3")).toBe("t");
    expect(leafOf(tree, "a2")).toBe("a2");
  });
});

describe("quote-reply: splitLeadingQuote", () => {
  it("lifts a leading blockquote off a prompt", () => {
    expect(splitLeadingQuote("> a\n> b\n\nfix it")).toEqual({ quote: "a\nb", rest: "fix it" });
  });
  it("leaves a prompt without one alone", () => {
    expect(splitLeadingQuote("plain")).toEqual({ quote: undefined, rest: "plain" });
    expect(splitLeadingQuote("x\n> not leading")).toEqual({ quote: undefined, rest: "x\n> not leading" });
  });
});
