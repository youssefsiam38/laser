// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";

import { ActivityReasoning, ToolGroup } from "../../src/components/assistant-ui/elements/tool-group.aui.js";
import { ToolFallback } from "../../src/components/assistant-ui/elements/tool-fallback.aui.js";
import { AssistantMessage } from "../../src/components/thread/messages.js";
import { resetTiming } from "../../src/components/thread/timing.js";
import type { ActivityDetailLevel } from "../../src/runtime/sessionPreferences.js";

const preferences = vi.hoisted(() => ({ level: "answers" as ActivityDetailLevel, path: "/test/activity-span.jsonl" }));
vi.mock("@/runtime", async () => ({
  ...await import("../../src/runtime/sessionPreferences.js"),
  ...await import("../../src/runtime/projection.js"),
  useActivityDetailLevel: () => preferences.level,
  useLaserState: (select: (state: unknown) => unknown) => select({
    current: preferences.path,
    open: { [preferences.path]: { entries: [], leafId: null, namerLabels: {}, state: { model: null } } },
  }),
  useLaserStable: () => ({ actions: { answerDialog: vi.fn(), send: vi.fn(async () => {}) } }),
  useLaserView: () => ({ dialogs: [] }),
}));
vi.mock("@assistant-ui/react", async (original) => ({
  ...await original<typeof import("@assistant-ui/react")>(),
  useToolCallElapsed: () => undefined,
}));
vi.mock("@/agents/hooks", () => ({ useNamerLabel: () => undefined }));

type Part = Exclude<ThreadMessageLike["content"], string>[number];
type MessageStatus = NonNullable<ThreadMessageLike["status"]>;
type GroupKey = "group-activity";

const reasoning = (running = false): Part => ({
  type: "reasoning",
  text: "Consider the next step.",
  status: { type: running ? "running" : "complete" },
});

const tool = (id: string, running = false): Part => ({
  type: "tool-call",
  toolCallId: id,
  toolName: "bash",
  args: { command: id },
  argsText: JSON.stringify({ command: id }),
  ...(running ? {} : { result: `${id} done` }),
});

const awaitingTool = (id: string): Part => ({
  ...tool(id),
  approval: { id: `${id}-approval`, prompt: "Continue?" },
});

const text = (value: string): Part => ({ type: "text", text: value, status: { type: "running" } });

const groupBy = (part: { type: string }): readonly GroupKey[] =>
  part.type === "reasoning" || part.type === "tool-call" ? ["group-activity"] : [];

function TestParts() {
  return (
    <MessagePrimitive.Root>
      <MessagePrimitive.GroupedParts groupBy={groupBy} indicator="empty">
        {({ part, children }) => {
          if (part.type === "reasoning") return <ActivityReasoning running={part.status.type === "running"}>Reasoning body</ActivityReasoning>;
          if (part.type === "tool-call") return <ToolFallback {...part} />;
          if (part.type === "text") return <span>{part.text}</span>;
          if (part.type === "group-activity") {
            return <ToolGroup part={part} timingKey={`activity-message:activity:${part.indices[0] ?? 0}`}>{children}</ToolGroup>;
          }
          return null;
        }}
      </MessagePrimitive.GroupedParts>
    </MessagePrimitive.Root>
  );
}

function Fixture({ content, status, actualMessage }: { content: readonly Part[]; status: MessageStatus; actualMessage: boolean }) {
  const messages: readonly ThreadMessageLike[] = [{ id: "activity-message", role: "assistant", content, status, metadata: { custom: {} } }];
  const runtime = useExternalStoreRuntime({ messages, isRunning: status.type === "running" || status.type === "requires-action", onNew: async () => {} });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Messages>{() => actualMessage ? <AssistantMessage /> : <TestParts />}</ThreadPrimitive.Messages>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

let container: HTMLDivElement;
let root: Root;

const running: MessageStatus = { type: "running" };
const requiresAction: MessageStatus = { type: "requires-action", reason: "tool-calls" };
const cancelled: MessageStatus = { type: "incomplete", reason: "cancelled" };
const complete: MessageStatus = { type: "complete", reason: "stop" };

function aggregate(): HTMLElement {
  const row = container.querySelector<HTMLElement>('[data-slot="tool-group-root"][data-count]');
  if (!row) throw new Error("activity aggregate not rendered");
  return row;
}

function elapsedText(): string | undefined {
  const visible = aggregate().querySelector<HTMLButtonElement>(":scope > button")?.textContent ?? "";
  return [...visible.matchAll(/\d+(?:\.\d)?s\b/g)].at(-1)?.[0];
}

async function render(content: readonly Part[], status: MessageStatus = running, actualMessage = false): Promise<void> {
  await act(async () => root.render(<Fixture content={content} status={status} actualMessage={actualMessage} />));
}

async function advance(ms: number): Promise<void> {
  await act(async () => vi.advanceTimersByTime(ms));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-11T12:00:00.000Z"));
  resetTiming();
  preferences.level = "answers";
  globalThis.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetTiming();
  vi.useRealTimers();
});

describe("activity aggregate wall-clock timing", () => {
  it("covers reasoning, sequential gaps and parallel tools until answer text renders", async () => {
    // The future aggregate observes its first child without adding a redundant
    // parent row, so the reasoning time is already included when a tool arrives.
    await render([reasoning(true)], running, true);
    expect(container.querySelector('[data-slot="tool-group-root"][data-count]')).toBeNull();
    await advance(12_000);
    await render([reasoning(), tool("first", true)], running, true);
    expect(elapsedText()).toBe("12s");

    // A completed child is not the boundary. Idle time before the next step is
    // part of the same wall-clock span.
    await advance(8_000);
    await render([reasoning(), tool("first")], running, true);
    expect(elapsedText()).toBe("20s");
    await advance(5_000);
    expect(elapsedText()).toBe("25s");

    // Overlapping calls still advance one clock, never one duration per child.
    await render([reasoning(), tool("first"), tool("parallel-a", true), tool("parallel-b", true)], running, true);
    await advance(10_000);
    await render([reasoning(), tool("first"), tool("parallel-a"), tool("parallel-b")], running, true);
    expect(elapsedText()).toBe("35s");

    // The final call keeps ticking while it waits for a decision and through
    // the wait for the answer.
    await render([reasoning(), tool("first"), tool("parallel-a"), awaitingTool("parallel-b")], running, true);
    await advance(5_000);
    expect(elapsedText()).toBe("40s");
    await render([reasoning(), tool("first"), tool("parallel-a"), tool("parallel-b"), text("Answer starts")], running, true);
    expect(elapsedText()).toBe("40s");
    await advance(10_000);
    expect(elapsedText()).toBe("40s");
  });

  it("continues while a tail approval requires action", async () => {
    await render([tool("one"), awaitingTool("two")], requiresAction);
    await advance(4_000);
    expect(elapsedText()).toBe("4.0s");
    await render([tool("one"), tool("two"), text("Continued")], running);
    await advance(4_000);
    expect(elapsedText()).toBe("4.0s");
  });

  it.each([
    ["cancellation", cancelled],
    ["normal turn end", complete],
  ] as const)("freezes on %s without text and keeps the same value through disclosure and remount", async (_case, terminalStatus) => {
    await render([tool("one", true)]);
    await advance(4_000);
    await render([tool("one"), tool("two", true)]);
    expect(elapsedText()).toBe("4.0s");

    const trigger = aggregate().querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await advance(6_000);
    expect(elapsedText()).toBe("10s");
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await render([tool("one"), tool("two")], terminalStatus);
    expect(elapsedText()).toBe("10s");
    await advance(5_000);
    expect(elapsedText()).toBe("10s");

    await act(async () => root.render(<div>away</div>));
    await render([tool("one"), tool("two")], terminalStatus);
    expect(elapsedText()).toBe("10s");
  });

  it("does not invent a duration for settled history first seen after reload", async () => {
    await render([reasoning(), tool("historic")], complete);
    expect(elapsedText()).toBeUndefined();
  });
});
