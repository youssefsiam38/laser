/**
 * The three things wave 3 built and could not render, now that the wire
 * carries them: why a turn stopped, what it cost, and who said it.
 *
 * Everything here goes through `applyUpdate` rather than hand-built blocks, so
 * the test proves the whole path — the reducer folding `message_end` and the
 * projection turning it into the status and metadata the components read.
 */
import { MESSAGE_METADATA_NS } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import type { SessionState, SessionUpdate } from "@lasercode/protocol";
import { applyUpdate, type SessionView } from "../../src/store.js";
import { incompleteReason, projectSessionView } from "../../src/runtime/projection.js";

const sessionState: SessionState = {
  path: "/s.jsonl",
  id: "sess1234",
  cwd: "/p",
  model: null,
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
};

const view = (): SessionView => ({
  path: "/s.jsonl",
  state: sessionState,
  blocks: [],
  lastSeq: 0,
  running: false,
  queue: { steering: [], followUp: [] },
  dialogs: [],
  statuses: {},
  widgets: {},
  openedAt: "2026-09-05T00:00:00.000Z",
  hydrated: true,
  entries: [],
  capabilities: [],
});

const run = (updates: SessionUpdate[]): SessionView => updates.reduce(applyUpdate, view());

const turn = (
  text: string,
  end: Partial<Extract<SessionUpdate, { kind: "message_end" }>> = {},
): SessionUpdate[] => [
  { kind: "message_start", role: "assistant" },
  { kind: "text_delta", delta: text, contentIndex: 0 },
  { kind: "message_end", message: { role: "assistant", content: [{ type: "text", text }] }, role: "assistant", ...end },
];

const meta = (message: { metadata?: unknown }): Record<string, unknown> =>
  ((message.metadata as { custom?: Record<string, unknown> }).custom?.[MESSAGE_METADATA_NS] as Record<string, unknown>) ?? {};

describe("stop reason", () => {
  it("maps the agent's vocabulary onto the transcript's, and only for a turn that ended short", () => {
    expect(incompleteReason("stop")).toBeUndefined();
    expect(incompleteReason("toolUse")).toBeUndefined();
    expect(incompleteReason("pending")).toBeUndefined();
    expect(incompleteReason(undefined)).toBeUndefined();
    expect(incompleteReason("aborted")).toBe("cancelled");
    expect(incompleteReason("length")).toBe("length");
    expect(incompleteReason("error")).toBe("error");
    expect(incompleteReason("deferred")).toBe("other");
  });

  it("a finished reply is complete and draws no stopped row", () => {
    const { messages } = projectSessionView(run(turn("all done", { stopReason: "stop" })));
    expect(messages[0]?.status).toEqual({ type: "complete", reason: "stop" });
  });

  it("a cancelled turn is incomplete, so the stopped row has its reason", () => {
    const { messages } = projectSessionView(run(turn("half a th", { stopReason: "aborted" })));
    expect(messages[0]?.status).toEqual({ type: "incomplete", reason: "cancelled" });
  });

  it("a provider error carries the provider's own words along with the reason", () => {
    const { messages } = projectSessionView(
      run(turn("", { stopReason: "error", errorMessage: "overloaded_error: try again" })),
    );
    expect(messages[0]?.status).toEqual({
      type: "incomplete",
      reason: "error",
      error: "overloaded_error: try again",
    });
  });

  it("keeps automatic recovery silent and never projects the failed attempt", () => {
    const recovered = run([
      { kind: "agent_start" },
      ...turn("", { stopReason: "error", errorMessage: "WebSocket error" }),
      { kind: "agent_end", willRetry: true },
      { kind: "auto_retry_start", attempt: 1, maxAttempts: 4 },
      ...turn("recovered", { stopReason: "stop" }),
      { kind: "auto_retry_end", ok: true },
      { kind: "agent_end", willRetry: false },
      { kind: "agent_settled" },
    ]);
    expect(recovered.blocks.some((block) => block.kind === "notice")).toBe(false);
    expect(recovered.blocks.some((block) => block.kind === "assistant" && block.stopReason === "error")).toBe(false);
    expect(projectSessionView(recovered).messages).toEqual([
      expect.objectContaining({ content: [expect.objectContaining({ type: "text", text: "recovered" })] }),
    ]);
  });

  it("a steer leaves no stop notice, while a real stop still does (M13-T28)", () => {
    // Steering does not abort: the engine delivers the steering message at the
    // next turn boundary, so the turn it interrupted ends the ordinary way and
    // the transcript is the person's message and the reply, nothing else.
    const steered = run([
      ...turn("working on it", { stopReason: "toolUse" }),
      { kind: "queue_update", steering: ["use the other file"], followUp: [] },
      { kind: "message_start", role: "user" },
      { kind: "message_end", message: { role: "user", content: [{ type: "text", text: "use the other file" }] }, role: "user" },
      ...turn("on it", { stopReason: "stop" }),
    ]);
    const { messages } = projectSessionView(steered);
    expect(messages.map((message) => message.status?.type)).not.toContain("incomplete");

    // Pressing Stop is a different act and keeps its row: a turn that ended
    // short with nothing to show is worse than one that says why.
    const stopped = projectSessionView(run(turn("half a th", { stopReason: "aborted" })));
    expect(stopped.messages.at(-1)?.status).toEqual({ type: "incomplete", reason: "cancelled" });
  });

  it("a turn still streaming is running, whatever the last message said", () => {
    const streaming = { ...run(turn("part", { stopReason: "aborted" })), running: true };
    // The tail is live again (a retry), so the stopped row must not appear over
    // a turn that is still producing text.
    const { messages } = projectSessionView({
      ...streaming,
      blocks: streaming.blocks.map((b) => (b.kind === "assistant" ? { ...b, streaming: true } : b)),
    });
    expect(messages[0]?.status).toEqual({ type: "running" });
  });
});

describe("per-turn usage", () => {
  it("rides on the metadata `message-timing` reads, summed across one turn's messages", () => {
    const usage = { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, totalTokens: 126 };
    const v = run([
      ...turn("first", { stopReason: "toolUse", usage }),
      ...turn("second", { stopReason: "stop", usage: { ...usage, output: 30, totalTokens: 136 } }),
    ]);
    const { messages } = projectSessionView(v);
    // Two of Pi's messages, one turn on screen: the counts add up.
    expect(messages).toHaveLength(1);
    expect(meta(messages[0]!)["usage"]).toEqual({ input: 200, output: 50, cacheRead: 10, cacheWrite: 2 });
  });

  it("is absent, not zero, when the provider reported nothing", () => {
    const { messages } = projectSessionView(run(turn("no numbers", { stopReason: "stop" })));
    expect(meta(messages[0]!)["usage"]).toBeUndefined();
  });
});

describe("child-run speaker", () => {
  it("names the subagent that spoke, and leaves the session's own replies unnamed", () => {
    const speaker = { kind: "subagent" as const, name: "@auth-audit", detail: "claude-sonnet" };
    const v = run([
      ...turn("the parent's own reply", { stopReason: "stop" }),
      { kind: "message_start", role: "custom", speaker },
      {
        kind: "message_end",
        message: { role: "custom", content: [{ type: "text", text: "found three issues" }] },
        role: "custom",
        speaker,
      },
    ]);
    const { messages } = projectSessionView(v);
    expect(messages).toHaveLength(2);
    expect(meta(messages[0]!)["speaker"]).toBeUndefined();
    expect(meta(messages[1]!)["speaker"]).toEqual(speaker);
    expect(messages[1]?.content).toEqual([{ type: "text", text: "found three issues", status: { type: "complete" } }]);
  });

  it("ignores a custom message with no speaker, the way it always did", () => {
    const v = run([
      { kind: "message_start", role: "custom" },
      { kind: "message_end", message: { role: "custom", content: "internal bookkeeping" }, role: "custom" },
    ]);
    expect(projectSessionView(v).messages).toHaveLength(0);
  });
});
