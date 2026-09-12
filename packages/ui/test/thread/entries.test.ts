import { describe, expect, it } from "vitest";

import { splitLeadingQuote } from "../../src/components/assistant-ui/elements/quote-reply.js";
import { activePathIds, continuationsOf, laterUserMessages, leafOf, userEntryAt, userEntryIds, versionsOf } from "../../src/components/thread/entries.js";

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
  it("lists the user entries on the branch in play, not every branch in the file", () => {
    // Nothing said which leaf: the engine reads the last entry, so the branch
    // through u3 is live and u2 — which lives on the abandoned one — is not
    // on screen and must not take an ordinal.
    expect(userEntryIds(tree)).toEqual(["u1", "u3"]);
    expect(userEntryAt(tree, 0)).toBe("u1");
    expect(userEntryAt(tree, 1)).toBe("u3");
    // Sitting on the other branch answers with the other prompt.
    expect(userEntryIds(tree, "a2")).toEqual(["u1", "u2"]);
    expect(userEntryAt(tree, 1, "a2")).toBe("u2");
  });
  it("keeps a plain list of messages a plain list, parents or no parents", () => {
    const flat = [
      { id: "x1", type: "message", message: { role: "user" } },
      { id: "x2", type: "message", message: { role: "assistant" } },
      { id: "x3", type: "message", message: { role: "user" } },
    ];
    expect(activePathIds(flat)).toBeUndefined();
    expect(userEntryIds(flat)).toEqual(["x1", "x3"]);
    const linear = [msg("v1", null, "user"), msg("b1", "v1", "assistant"), msg("v2", "b1", "user")];
    expect(activePathIds(linear)).toBeUndefined();
    expect(userEntryIds(linear)).toEqual(["v1", "v2"]);
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

  it("walks the live branch from the leaf back to the root", () => {
    expect([...activePathIds(tree, "t")!]).toEqual(["t", "a3", "u3", "u1"]);
    expect([...activePathIds(tree, "a2")!]).toEqual(["a2", "u2", "a1", "u1"]);
    // A leaf reset to before the first entry: nothing in the file is live.
    expect([...activePathIds(tree, null)!]).toEqual([]);
  });
});

/**
 * Two versions of one prompt. Editing a message in place moves the session to
 * before it and sends the new text there, so the versions are SIBLINGS —
 * children of the same parent — not children of the message itself.
 *
 *   (root) ─ e1 ─ b1
 *          └─ e2 ─ b2
 */
const versions = [
  msg("e1", null, "user"),
  msg("b1", "e1", "assistant"),
  msg("e2", null, "user"),
  msg("b2", "e2", "assistant"),
];

describe("entries: versions of one message", () => {
  it("counts the siblings of a prompt, oldest first, itself included", () => {
    expect(versionsOf(versions, "e1")).toEqual(["e1", "e2"]);
    expect(versionsOf(versions, "e2")).toEqual(["e1", "e2"]);
    // Deeper in the tree, an edited middle message is a sibling under its reply.
    expect(versionsOf(tree, "u2")).toEqual(["u2"]);
    expect(versionsOf(tree, "u1")).toEqual(["u1"]);
  });
  it("says nothing for an entry the file no longer holds, or one with no place in the tree", () => {
    expect(versionsOf(versions, "gone")).toEqual([]);
    expect(versionsOf([{ id: "x1", type: "message", message: { role: "user" } }], "x1")).toEqual([]);
  });
  it("switches versions through the version's own last entry, never the prompt", () => {
    // Navigating onto a prompt puts the session BEFORE it; its leaf is the reply.
    expect(leafOf(versions, "e1")).toBe("b1");
    expect(leafOf(versions, "e2")).toBe("b2");
    expect(userEntryIds(versions, leafOf(versions, "e1"))).toEqual(["e1"]);
    expect(userEntryIds(versions, leafOf(versions, "e2"))).toEqual(["e2"]);
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

it("caches per entries identity and distinguishes every leaf key", () => {
  const latest = userEntryIds(tree);
  expect(latest).toEqual(["u1", "u3"]);
  expect(userEntryIds(tree)).toBe(latest);
  expect(userEntryIds(tree, null)).toEqual([]);
  expect(userEntryIds(tree, "a2")).toEqual(["u1", "u2"]);
  expect(userEntryIds(tree, "a3")).toEqual(["u1", "u3"]);
  expect(userEntryIds([...tree])).not.toBe(latest);
  expect(activePathIds(tree, "a2")).toBe(activePathIds(tree, "a2"));
  expect(activePathIds(tree, null)).not.toBe(activePathIds(tree));
});
