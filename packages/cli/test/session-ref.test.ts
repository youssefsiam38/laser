/**
 * Matching a typed reference to a session is where a wrong answer silently
 * prompts the wrong agent, so the matching order is pinned here.
 */
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@lasercode/protocol";
import { matchSessions } from "../src/session-ref.js";

const session = (id: string, path: string, cwd = "/w"): SessionSummary => ({
  id,
  path,
  cwd,
  createdAt: "2026-09-05T00:00:00.000Z",
  modifiedAt: "2026-09-05T00:00:00.000Z",
  messageCount: 0,
});

const sessions = [
  session("01a06fd7-69f0", "/home/u/.pi/agent/sessions/2026-09-05T04-33_01a06fd7.jsonl"),
  session("01a06fd8-aedc", "/home/u/.pi/agent/sessions/2026-09-05T04-34_01a06fd8.jsonl"),
  session("01a06fd8-bbbb", "/home/u/.pi/agent/sessions/other/2026-09-05T04-35_01a06fd8b.jsonl"),
];

describe("matchSessions", () => {
  it("takes an exact path over anything else", () => {
    expect(matchSessions(sessions, sessions[1]!.path).map((s) => s.id)).toEqual(["01a06fd8-aedc"]);
  });

  it("takes an exact id", () => {
    expect(matchSessions(sessions, "01a06fd7-69f0").map((s) => s.id)).toEqual(["01a06fd7-69f0"]);
  });

  it("accepts an id prefix, which is what the tables print", () => {
    expect(matchSessions(sessions, "01a06fd7").map((s) => s.id)).toEqual(["01a06fd7-69f0"]);
  });

  it("returns every candidate when a prefix is ambiguous, so the caller can refuse", () => {
    expect(matchSessions(sessions, "01a06fd8")).toHaveLength(2);
  });

  it("accepts a path suffix", () => {
    expect(matchSessions(sessions, "2026-09-05T04-34_01a06fd8.jsonl").map((s) => s.id)).toEqual(["01a06fd8-aedc"]);
  });

  it("returns nothing for a reference that matches nothing", () => {
    expect(matchSessions(sessions, "nope")).toEqual([]);
  });
});
