import { expect, it } from "vitest";
import { HistorySnapshotAccumulator } from "../src/history-snapshot.js";

it("retains only the latest accepted partial output, independently of the replay buffer", () => {
  const tracker = new HistorySnapshotAccumulator();
  tracker.note({ kind: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "printf test" } });
  const partial = { content: [{ type: "text" as const, text: "first" }], details: {} };
  tracker.note({ kind: "tool_execution_update", toolCallId: "t", partial });
  const captured = tracker.snapshot();
  partial.content[0]!.text = "second";
  expect(captured.tools[0]?.partial).toMatchObject({ content: [{ text: "first" }] });
  expect(tracker.snapshot().tools[0]?.partial).toMatchObject({ content: [{ text: "first" }] });
  tracker.note({ kind: "tool_execution_update", toolCallId: "t", partial });
  expect(tracker.snapshot().tools[0]?.partial).toMatchObject({ content: [{ text: "second" }] });
  tracker.note({ kind: "tool_execution_end", toolCallId: "t", result: partial, isError: false });
  expect(tracker.snapshot().tools).toEqual([]);
  tracker.note({ kind: "tool_execution_start", toolCallId: "next", toolName: "read", args: {} });
  tracker.reset();
  expect(tracker.snapshot()).toEqual({ running: false, tools: [] });
});

it("keeps streaming identity and reasoning stable, and clears an ended or cancelled attempt", () => {
  const tracker = new HistorySnapshotAccumulator();
  tracker.note({ kind: "agent_start" });
  tracker.note({ kind: "message_start", role: "assistant" });
  tracker.note({ kind: "thinking_delta", delta: "Reason", contentIndex: 0 });
  const first = tracker.snapshot();
  tracker.note({ kind: "text_delta", delta: "Answer", contentIndex: 1 });
  expect(tracker.snapshot().message?.id).toBe(first.message?.id);
  expect(tracker.snapshot().message?.value).toMatchObject({ content: [{ type: "text", text: "Answer" }, { type: "thinking", thinking: "Reason" }] });
  tracker.note({ kind: "agent_end", willRetry: true });
  expect(tracker.snapshot()).toEqual({ running: true, tools: [] });
  tracker.note({ kind: "agent_settled" });
  expect(tracker.snapshot()).toEqual({ running: false, tools: [] });
});
