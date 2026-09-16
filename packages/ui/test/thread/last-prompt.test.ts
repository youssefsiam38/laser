/**
 * Finding the last prompt without reading the whole conversation (RP-8).
 *
 * Three surfaces fork from the last prompt, and they used to ask for every
 * branch of the session file to find one entry id. They ask for the tail now,
 * with one wider look when the tail did not reach a prompt, and they keep the
 * three outcomes apart: found, genuinely no prompt, and further back than we
 * looked.
 */
import { describe, expect, it } from "vitest";
import type { ClientRequests, HistoryWindow } from "@lasercode/protocol";

import { BODY_EXCERPT_MAX_BYTES } from "../../src/runtime/body-excerpt.js";
import {
  LAST_PROMPT_TAIL,
  LAST_PROMPT_TAIL_EXPANDED,
  lastPromptEntry,
  lastPromptMessage,
} from "../../src/components/thread/last-prompt.js";

type Params = ClientRequests["pi/session/entries"]["params"];
type Result = ClientRequests["pi/session/entries"]["result"];

const user = (id: string, parentId: string | null) => ({ id, parentId, type: "message", message: { role: "user", content: "hi" } });
const assistant = (id: string, parentId: string | null) => ({ id, parentId, type: "message", message: { role: "assistant", content: "ok" } });

const window = (complete: boolean): HistoryWindow => ({
  epoch: "e", seq: 1, revision: "r", environmentKey: "k", userOffset: 0,
  complete, branchesUnloaded: false, hasHistory: true, context: [], priorGoalIds: [],
});

function recorder(...pages: Result[]): { request: (params: Params) => Promise<Result>; calls: Params[] } {
  const calls: Params[] = [];
  let index = 0;
  return {
    calls,
    request: async (params: Params) => {
      calls.push(params);
      return pages[Math.min(index++, pages.length - 1)]!;
    },
  };
}

describe("the last prompt", () => {
  it("asks for a bounded tail with a body limit, and stops when it finds one", async () => {
    const page: Result = { entries: [user("u1", null), assistant("a1", "u1")], leafId: "a1", window: window(false) };
    const reader = recorder(page);
    await expect(lastPromptEntry(reader.request, "/p/s.jsonl")).resolves.toEqual({ entryId: "u1" });
    expect(reader.calls).toEqual([{ path: "/p/s.jsonl", window: { tail: LAST_PROMPT_TAIL }, bodyLimit: BODY_EXCERPT_MAX_BYTES }]);
  });

  it("never reads the whole tree", async () => {
    const reader = recorder({ entries: [], leafId: null, window: window(false) });
    await lastPromptEntry(reader.request, "/p/s.jsonl");
    for (const call of reader.calls) expect(call.window).not.toHaveProperty("all");
  });

  it("takes one wider look when the tail held no prompt and history continues", async () => {
    const reader = recorder(
      { entries: [assistant("a9", "u5")], leafId: "a9", window: window(false) },
      { entries: [user("u5", null), assistant("a9", "u5")], leafId: "a9", window: window(true) },
    );
    await expect(lastPromptEntry(reader.request, "/p/s.jsonl")).resolves.toEqual({ entryId: "u5" });
    expect(reader.calls.map((call) => call.window)).toEqual([{ tail: LAST_PROMPT_TAIL }, { tail: LAST_PROMPT_TAIL_EXPANDED }]);
  });

  it("says a complete conversation has no prompt, and stops looking", async () => {
    const reader = recorder({ entries: [assistant("a1", null)], leafId: "a1", window: window(true) });
    await expect(lastPromptEntry(reader.request, "/p/s.jsonl")).resolves.toEqual({ reason: "no-prompt" });
    expect(reader.calls).toHaveLength(1);
    expect(lastPromptMessage({ reason: "no-prompt" })).toBe("Nothing to fork yet: this session has no prompt.");
  });

  it("does not claim there is no prompt when it only looked at the recent part", async () => {
    const reader = recorder({ entries: [assistant("a1", "x")], leafId: "a1", window: window(false) });
    const outcome = await lastPromptEntry(reader.request, "/p/s.jsonl");
    expect(outcome).toEqual({ reason: "not-found" });
    expect(lastPromptMessage(outcome)).toBe("Could not find the last prompt in this conversation’s recent history.");
    expect(reader.calls).toHaveLength(2);
  });

  it("reads the live branch, not a sibling version", async () => {
    const entries = [user("u1", null), assistant("a1", "u1"), user("u2a", "a1"), user("u2b", "a1"), assistant("a2b", "u2b")];
    const reader = recorder({ entries, leafId: "a2b", window: window(true) });
    await expect(lastPromptEntry(reader.request, "/p/s.jsonl")).resolves.toEqual({ entryId: "u2b" });
  });

  it("has nothing to say when it found a prompt", () => {
    expect(lastPromptMessage({ entryId: "u1" })).toBeUndefined();
  });
});
