/**
 * A fork is a top-level session (M13-T65, D-166). The engine's `parentSession`
 * header is lineage — `forkedFrom` — and only an agent record nests a session.
 */
import { describe, expect, it } from "vitest";
import { isChildSession, sessionGroups } from "../../src/components/shell/session-groups.js";
import { parentPathOf } from "../../src/runtime/threadList.js";
import { summary } from "../agents/fixtures.js";

describe("a forked session", () => {
  const origin = summary({ path: "/s/origin.jsonl", name: "Fix the login form" });
  const fork = summary({ path: "/s/fork.jsonl", name: "Fix the login form (2)", forkedFrom: "/s/origin.jsonl" });
  const child = summary({ path: "/s/child.jsonl", agent: { agentName: "default", kind: "child", subagentName: "explorer", parentPath: "/s/origin.jsonl", rootPath: "/s/origin.jsonl" } });

  it("is nobody's child: only an agent record nests a session", () => {
    expect(isChildSession(fork)).toBe(false);
    expect(parentPathOf(fork)).toBeUndefined();
    expect(isChildSession(child)).toBe(true);
    expect(parentPathOf(child)).toBe("/s/origin.jsonl");
  });

  it("is listed beside its origin in the project group", () => {
    const groups = sessionGroups(["/p"], [origin, fork, child], {});
    expect(groups.map((g) => g.kind)).toEqual(["project"]);
    expect(groups[0]!.rows.map((r) => r.path)).toEqual(expect.arrayContaining(["/s/origin.jsonl", "/s/fork.jsonl"]));
    expect(groups[0]!.rows.find((r) => r.path === "/s/fork.jsonl")?.summary.forkedFrom).toBe("/s/origin.jsonl");
  });
});
