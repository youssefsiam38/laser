import { describe, expect, it } from "vitest";
import {
  completeLeadingSlash,
  matchLeadingSlash,
  rankSlashCommandMatches,
  slashCommandMatchesQuery,
} from "../../src/components/thread/slash-completion.js";

describe("slash completion", () => {
  it("only matches a slash command at the beginning of the draft", () => {
    expect(matchLeadingSlash("/go keep this", "/", 3)).toEqual({ query: "go", offset: 0, endOffset: 3 });
    expect(matchLeadingSlash("before /go", "/", 10)).toBeNull();
    expect(matchLeadingSlash(" /go", "/", 4)).toBeNull();
    expect(matchLeadingSlash("/go keep this", "/", 13)).toBeNull();
  });

  it("completes the command without deleting the remaining draft", () => {
    expect(completeLeadingSlash("goal", "preserve every word")).toBe("/goal preserve every word");
    expect(completeLeadingSlash("/goal", "\nthen another line")).toBe("/goal\nthen another line");
    expect(completeLeadingSlash("goal", "")).toBe("/goal ");
  });

  it("filters on the command name, never words in its description", () => {
    expect(slashCommandMatchesQuery({ id: "compact", label: "/compact" }, "go")).toBe(false);
    expect(slashCommandMatchesQuery({ id: "agent:goal", label: "/goal" }, "go")).toBe(true);
    expect(slashCommandMatchesQuery({ id: "queue", label: "/clear-queue" }, "queue")).toBe(true);
  });

  it("uses Pi-style fuzzy command search and ranks the strongest identity first", () => {
    const commands = [
      { id: "agent:skill:brave-search", label: "/skill:brave-search" },
      { id: "agent:feature:subagents", label: "/subagents" },
      { id: "agent:skill:browser", label: "/skill:browser" },
    ];
    expect(rankSlashCommandMatches(commands, "skbr").map((item) => item.label)).toEqual([
      "/skill:brave-search",
      "/skill:browser",
    ]);
    expect(rankSlashCommandMatches(commands, "sub").map((item) => item.label)).toEqual(["/subagents"]);
  });
});
