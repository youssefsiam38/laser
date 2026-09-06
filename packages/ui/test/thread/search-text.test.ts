import { describe, expect, it } from "vitest";
import { matchExcerpt, partSearchText, textMatches } from "../../src/components/thread/search-text.js";
import { rankSearchThreads, type SearchableThread } from "../../src/components/assistant-ui/elements/thread-search.js";
import { searchPeriod } from "../../src/components/shell/use-session-search.js";

describe("conversation search semantics", () => {
  it("treats punctuation, escaped characters and Unicode as literal text", () => {
    expect(textMatches(String.raw`Apple APPLE a.*b \n`, "apple")).toHaveLength(2);
    expect(textMatches("a.*b aaab", "a.*b")).toEqual([{ start: 0, end: 4 }]);
    expect(textMatches(String.raw`a\nb`, String.raw`\n`)).toEqual([{ start: 1, end: 3 }]);
    expect(textMatches("تفاح تفاح", "تفاح")).toHaveLength(2);
    expect(textMatches("anything", " ")).toEqual([]);
  });
  it("retains exact matching text in a bounded excerpt", () => {
    const text = "x".repeat(200) + "Apple" + "y".repeat(200);
    expect(matchExcerpt(text, textMatches(text, "apple")[0]!)).toEqual({ before: "…" + "x".repeat(55), match: "Apple", after: "y".repeat(90) + "…" });
  });
  it("includes folded reasoning and partial tool output, excluding image payloads", () => {
    expect(partSearchText({ type: "reasoning", text: "Apple" })).toBe("Apple");
    expect(partSearchText({ type: "tool-call", toolName: "read", args: { path: "Apple" }, artifact: { partialOutput: "pear" } })).toContain("pear");
    expect(partSearchText({ type: "image", image: "private-image" })).toBe("");
  });
  it("ranks user messages ahead of replies, then reasoning/tools; newest breaks ties", () => {
    const row = (id: string, source?: SearchableThread["matchSource"], modifiedAt = "2026-09-01"): SearchableThread => ({ id, title: id, preview: "", group: "", status: "idle", matchSource: source, modifiedAt });
    expect([row("tool", "tool"), row("new-user", "user", "2026-09-07"), row("assistant", "assistant"), row("old-user", "user"), row("title")].sort(rankSearchThreads).map(r => r.id)).toEqual(["new-user", "old-user", "assistant", "tool", "title"]);
  });
  it("searches disjoint older intervals only on expansion", () => {
    const now = Date.parse("2026-09-07T00:00:00Z");
    const periods = [0, 1, 2, 3].map(p => searchPeriod(now, p));
    expect(periods[0]!.before).toBeUndefined();
    expect(periods[3]!.after).toBeUndefined();
    for (let i = 1; i < periods.length; i++) expect(periods[i]!.before).toBe(periods[i - 1]!.after);
  });
});
