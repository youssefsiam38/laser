/**
 * M15-T3: what a model fallback leaves in the transcript, live and on reload.
 *
 * One durable line per switch, nothing for the steps that lead to one (they
 * are transient control state, like a provider retry — D-180), and the same
 * sentence whether it just happened or is being read back from the session
 * file a week later.
 */
import { describe, expect, it } from "vitest";
import { SESSION_FALLBACK_ENTRY_TYPE, type SessionState, type SessionUpdate } from "@lasercode/protocol";

import { applyUpdate, blocksFromEntries, type SessionView } from "../../src/store.js";

const state: SessionState = {
  path: "/s.jsonl", id: "s", cwd: "/p", model: null, thinkingLevel: "medium", isStreaming: false, isCompacting: false,
  steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0,
};

const view = (): SessionView => ({
  path: "/s.jsonl", state, blocks: [], lastSeq: 0, running: false, queue: { steering: [], followUp: [] },
  dialogs: [], statuses: {}, widgets: {}, openedAt: "2026-09-11T00:00:00.000Z", hydrated: true, entries: [],
});

const run = (updates: SessionUpdate[]) => updates.reduce(applyUpdate, view());
const notices = (v: SessionView) => v.blocks.filter((block) => block.kind === "notice");

const sonnet = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet 4.5" };
const deepseek = { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek V3" };

describe("a switch, as it happens", () => {
  it("records the model that took over and why, once", () => {
    const v = run([
      { kind: "model_fallback", phase: "switching", from: sonnet, reason: "rate_limit", detail: "Sonnet 4.5 is being rate-limited.", position: 0 },
      { kind: "model_fallback", phase: "switched", from: sonnet, to: deepseek, reason: "rate_limit", detail: "Sonnet 4.5 is being rate-limited.", position: 1 },
    ]);
    expect(notices(v)).toHaveLength(1);
    expect(notices(v)[0]).toMatchObject({ level: "info", text: "Continued on DeepSeek V3 · Sonnet 4.5 is being rate-limited." });
  });

  it("says nothing in the conversation while it is still trying", () => {
    // Switching and a candidate that did not work are the status line's job.
    // A transcript that gained a line per attempt would be a log, not a record.
    const v = run([
      { kind: "model_fallback", phase: "switching", from: sonnet, reason: "provider_down", detail: "Sonnet 4.5 is not answering.", position: 0 },
      { kind: "model_fallback", phase: "attempt_failed", to: deepseek, reason: "credits", detail: "DeepSeek V3 has no credit left.", position: 1 },
    ]);
    expect(notices(v)).toEqual([]);
  });

  it("turns a spent chain into one attention-toned line, with no provider payload in it", () => {
    const v = run([
      {
        kind: "model_fallback",
        phase: "exhausted",
        from: deepseek,
        reason: "provider_down",
        detail: "DeepSeek V3 is not answering. Fallback could not help: Sonnet 4.5 tried too recently.",
        position: 1,
      },
    ]);
    expect(notices(v)).toHaveLength(1);
    expect(notices(v)[0]).toMatchObject({ level: "warning" });
    expect(notices(v)[0]!.text).toContain("Fallback could not help");
    expect(notices(v)[0]!.text).not.toContain("{");
  });
});

describe("the same switch, read back from the session file", () => {
  const entry = (event: string, extra: Record<string, unknown> = {}) => ({
    type: "custom",
    customType: SESSION_FALLBACK_ENTRY_TYPE,
    timestamp: "2026-09-11T12:00:00.000Z",
    data: { version: 1, event, at: "2026-09-11T12:00:00.000Z", activation: null, models: {}, ...extra },
  });

  it("draws the switch, and nothing for the records that are only state", () => {
    const blocks = blocksFromEntries([
      entry("activated", { to: { provider: "anthropic", id: "claude-sonnet-4-5" } }),
      entry("attempt_failed", { from: { provider: "anthropic", id: "claude-sonnet-4-5" }, failure: { class: "rate_limit", at: "2026-09-11T12:00:00.000Z" } }),
      entry("switched", {
        from: { provider: "anthropic", id: "claude-sonnet-4-5" },
        to: { provider: "deepseek", id: "deepseek-chat" },
        failure: { class: "rate_limit", at: "2026-09-11T12:00:00.000Z" },
      }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "notice",
      level: "info",
      text: "Continued on deepseek-chat · claude-sonnet-4-5 is being rate-limited.",
      at: "2026-09-11T12:00:00.000Z",
    });
  });

  it("draws an exhausted chain as the same warning it was live", () => {
    const blocks = blocksFromEntries([
      entry("exhausted", { from: { provider: "deepseek", id: "deepseek-chat" }, failure: { class: "credits", at: "2026-09-11T12:00:00.000Z" } }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "notice", level: "warning" });
    expect((blocks[0] as { text: string }).text).toBe("deepseek-chat has no credit left. No other model in this chain could take over.");
  });

  it("ignores a record it cannot read rather than drawing half a sentence", () => {
    expect(blocksFromEntries([entry("switched", { to: { provider: "x" } })])).toHaveLength(1);
    expect(blocksFromEntries([{ type: "custom", customType: "something/else", data: { event: "switched" } }])).toEqual([]);
    expect(blocksFromEntries([{ type: "custom", customType: SESSION_FALLBACK_ENTRY_TYPE }])).toEqual([]);
  });
});
