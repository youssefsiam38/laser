// @vitest-environment happy-dom
/**
 * The agents leap in the transcript: a child's `complete_agent_run` becomes
 * its final message block, a parent's `lasercode/agent-event` becomes the
 * handoff card, a `lasercode/task-event` becomes a quiet notice, and Namer's
 * label names a running call until it ends.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { AGENT_EVENT_MESSAGE_TYPE, TASK_EVENT_MESSAGE_TYPE } from "@lasercode/protocol";

import { AgentCompletion } from "../../src/components/thread/AgentCompletion.js";
import { AgentEventMessage } from "../../src/components/thread/AgentEventMessage.js";
import { TaskEventNotice, taskElapsed, taskOutcome } from "../../src/components/thread/TaskEventNotice.js";
import { ToolRow } from "../../src/components/thread/ToolRow.js";
import { partSearchContent } from "../../src/components/thread/search-text.js";
import { ToolGroup } from "../../src/components/assistant-ui/elements/tool-group.aui.js";
import { agentEventSentence } from "../../src/components/assistant-ui/elements/agent-handoff.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { LaserStoreProvider, createStateStore, type StateStore } from "../../src/runtime/LaserProvider.js";
import {
  AGENT_COMPLETION_DATA_PART,
  AGENT_EVENT_DATA_PART,
  TASK_EVENT_DATA_PART,
  projectMessages,
  type AgentCompletionData,
} from "../../src/runtime/projection.js";
import { applyUpdate, blocksFromEntries, initialState, reduce, type Block } from "../../src/store.js";
import { run, sessionState, view } from "../agents/fixtures.js";

const stable = vi.hoisted(() => ({ actions: { openSession: vi.fn(async () => undefined), toast: vi.fn(), send: vi.fn() } }));
const fleet = vi.hoisted(() => ({ reveal: vi.fn() }));
vi.mock("@/runtime", async (importActual) => ({ ...(await importActual<typeof import("../../src/runtime/index.js")>()), useLaserStable: () => stable }));
vi.mock("@/dialogs", () => ({
  ToolRowDialog: () => null,
  useRegisterToolRow: () => {},
  DialogBody: () => null,
  dialogFormOf: () => ({}),
  uiResponseFor: () => ({}),
}));
vi.mock("@/fleet", () => ({ revealInFleet: fleet.reveal }));
vi.mock("@/components/preview/MarkdownPreview", () => ({ MarkdownPreview: ({ text }: { text: string }) => <p data-slot="markdown">{text}</p> }));
vi.mock("@assistant-ui/react", async (original) => ({ ...(await original<typeof import("@assistant-ui/react")>()), useToolCallElapsed: () => undefined }));

const PATH = "/p/root.jsonl";
const event = {
  type: "agent.cancelled" as const,
  agentName: "reviewer",
  subagentName: "explorer",
  sessionId: "child",
  runId: "r1",
  message: "Stopped after the second file.\n\nNothing was committed.",
  endedBy: { initiator: "user" as const, reason: "Wrong direction" },
  run: run({ runId: "r1", sessionPath: "/p/child.jsonl", status: "cancelled" }),
};
const taskSummary = { taskId: "t1", command: "pnpm test --filter ui", status: "completed", exitCode: 0, startedAt: "2026-09-08T10:00:00.000Z", endedAt: "2026-09-08T10:02:14.000Z", outputBytes: 1200, background: false, promoted: true };

describe("projection", () => {
  it("draws complete_agent_run as the child's final message and hides its tool row, except when it was refused", () => {
    const blocks: Block[] = [
      { kind: "assistant", id: "a1", text: "Done looking.", thinking: "", streaming: false },
      { kind: "tool", id: "t1", at: "2026-09-08T10:00:00.000Z", name: "complete_agent_run", args: { status: "completed", message: "Counted 3 files." }, result: "Run r1 ended", done: true },
    ];
    const { messages } = projectMessages({ blocks, running: false, dialogs: [] });
    const parts = messages[0]!.content as Array<{ type: string; name?: string; data?: AgentCompletionData }>;
    expect(parts.map((p) => p.type)).toEqual(["text", "data"]);
    expect(parts[1]).toMatchObject({ name: AGENT_COMPLETION_DATA_PART, data: { toolCallId: "t1", status: "completed", message: "Counted 3 files.", at: "2026-09-08T10:00:00.000Z", done: true } });
    expect(partSearchContent(parts[1] as { type: string })).toEqual(["Counted 3 files."]);

    const refused = projectMessages({ blocks: [{ ...blocks[1]!, isError: true, result: "No active run" } as Block], running: false, dialogs: [] });
    expect((refused.messages[0]!.content as Array<{ type: string }>)[0]!.type).toBe("tool-call");

    const pending = projectMessages({ blocks: [{ ...blocks[1]!, done: false, result: undefined } as Block], running: true, dialogs: [] });
    expect((pending.messages[0]!.content as Array<{ data?: AgentCompletionData }>)[0]!.data?.done).toBe(false);
  });

  it("keeps agent-event and task-event custom messages as blocks, live and from disk, and projects them as their own messages", () => {
    const live = applyUpdate(view({ path: PATH }), {
      kind: "message_end",
      role: "custom",
      message: { role: "custom", customType: AGENT_EVENT_MESSAGE_TYPE, content: "agent.cancelled\n…", display: true, details: event },
    });
    expect(live.blocks).toHaveLength(1);
    expect(live.blocks[0]).toMatchObject({ kind: "custom", customType: AGENT_EVENT_MESSAGE_TYPE, details: event });
    const ignored = applyUpdate(view({ path: PATH }), { kind: "message_end", role: "custom", message: { role: "custom", customType: "someone/else", content: "x", details: {} } });
    expect(ignored.blocks).toHaveLength(0);

    // On disk a custom message is its own entry type (`custom_message`), the
    // message fields at the top level, as the engine writes it.
    const hydrated = blocksFromEntries([
      { type: "custom_message", timestamp: "2026-09-08T10:02:14.000Z", customType: TASK_EVENT_MESSAGE_TYPE, content: "Background task t1 exited", display: true, details: taskSummary },
      { type: "custom_message", customType: "goal-state", content: "hidden", details: {} },
      { type: "message", message: { role: "custom", customType: "someone/else", content: "x", details: {} } },
    ]);
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]).toMatchObject({ kind: "custom", customType: TASK_EVENT_MESSAGE_TYPE, at: "2026-09-08T10:02:14.000Z" });

    const { messages } = projectMessages({ blocks: [...live.blocks, ...hydrated], running: false, dialogs: [] });
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toEqual([{ type: "data", name: AGENT_EVENT_DATA_PART, data: event }]);
    expect(messages[1]!.content).toEqual([{ type: "data", name: TASK_EVENT_DATA_PART, data: taskSummary }]);
    expect(partSearchContent({ type: "data", name: AGENT_EVENT_DATA_PART, data: event })).toEqual(["Wrong direction", event.message]);
    expect(partSearchContent({ type: "data", name: TASK_EVENT_DATA_PART, data: taskSummary })).toEqual(["pnpm test --filter ui"]);
  });

  it("words the event and the task exit for a person", () => {
    expect(agentEventSentence("explorer", "agent.cancelled", "user")).toBe("explorer was ended by you");
    expect(agentEventSentence("explorer", "agent.cancelled", "parent")).toBe("explorer was ended by its parent");
    expect(agentEventSentence("explorer", "agent.blocked", undefined)).toBe("explorer was blocked");
    expect(taskOutcome({ status: "completed", exitCode: 0 })).toEqual({ text: "exited with code 0", failed: false });
    expect(taskOutcome({ status: "failed", exitCode: 2 })).toEqual({ text: "exited with code 2", failed: true });
    expect(taskOutcome({ status: "stopped", exitCode: null })).toEqual({ text: "was stopped", failed: false });
    expect(taskElapsed(taskSummary)).toBe(134_000);
  });
});

describe("rendering", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: StateStore;
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    stable.actions.openSession.mockClear();
    fleet.reveal.mockClear();
    let state = reduce(initialState, { type: "opened", state: sessionState({ path: PATH }) });
    state = reduce(state, { type: "agents/run", run: event.run });
    store = createStateStore(state);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const mount = (node: ReactNode) => act(async () => root.render(<LaserStoreProvider store={store}><TooltipProvider>{node}</TooltipProvider></LaserStoreProvider>));

  it("shows the final message as a badge, prose and a clock, with only the message searchable", async () => {
    await mount(<AgentCompletion data={{ toolCallId: "t1", status: "blocked", message: "Need the API key.", at: "2026-09-08T10:00:00.000Z", done: true }} />);
    const block = container.querySelector<HTMLElement>('[data-slot="agent-completion"]')!;
    expect(block.hasAttribute("data-search-tool")).toBe(true);
    expect(block.querySelector('[data-slot="agent-completion-status"]')?.textContent).toBe("Blocked");
    expect(block.querySelector('[data-search-content="message"]')?.textContent).toBe("Need the API key.");
    expect(block.querySelector("time")).not.toBeNull();
    await mount(<AgentCompletion data={{ toolCallId: "t1", status: "completed", message: "All green.", done: false }} />);
    expect(container.querySelector('[data-slot="agent-completion-status"]')?.textContent).toBe("Completed");
    expect(container.textContent).toContain("Ending the run");
  });

  it("draws the parent's event card with the reason and opens the child's chat", async () => {
    function Fixture() {
      const { messages } = projectMessages({ blocks: [{ kind: "custom", id: "c1", at: "2026-09-08T10:00:00.000Z", customType: AGENT_EVENT_MESSAGE_TYPE, text: "", details: event }], running: false, dialogs: [] });
      const runtime = useExternalStoreRuntime({ messages, isRunning: false, onNew: async () => {} });
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadPrimitive.Root><ThreadPrimitive.Messages>{() => (
            <MessagePrimitive.Root><MessagePrimitive.GroupedParts groupBy={() => []} indicator="empty">{({ part }) => (part.type === "data" ? <AgentEventMessage data={part.data} /> : null)}</MessagePrimitive.GroupedParts></MessagePrimitive.Root>
          )}</ThreadPrimitive.Messages></ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
      );
    }
    await mount(<Fixture />);
    const card = container.querySelector<HTMLElement>('[data-slot="agent-event-card"]')!;
    expect(card.getAttribute("data-kind")).toBe("agent.cancelled");
    expect(card.textContent).toContain("explorer");
    expect(card.querySelector('[data-slot="agent-event-sentence"]')?.textContent).toBe("was ended by you");
    expect(card.querySelector('[data-search-content="reason"]')?.textContent).toBe("Wrong direction");
    expect(card.querySelector('[data-search-content="message"]')?.textContent).toContain("Nothing was committed.");
    await act(async () => card.querySelector<HTMLButtonElement>('[data-slot="agent-event-open"]')!.click());
    expect(stable.actions.openSession).toHaveBeenCalledWith("/p/child.jsonl");
  });

  it("reports a task exit in one line and reveals its fleet row from the Output action", async () => {
    // The button exists only while the host still holds the task; once the
    // register has forgotten it there is no row to lead to.
    await act(async () =>
      store.dispatch({
        type: "tasks/update",
        task: {
          id: "t1",
          sessionPath: PATH,
          command: "pnpm test --filter ui",
          title: "pnpm test --filter ui",
          status: "completed",
          origin: "background",
          startedAt: "2026-09-08T10:00:00.000Z",
          outputBytes: 12,
        },
      }),
    );
    await mount(<TaskEventNotice data={taskSummary} />);
    const line = container.querySelector<HTMLElement>('[data-slot="task-event"]')!;
    expect(line.textContent).toContain("Background task");
    expect(line.querySelector('[data-search-content="command"]')?.textContent).toBe("pnpm test --filter ui");
    expect(line.textContent).toContain("exited with code 0");
    expect(line.textContent).toContain("2m 14s");
    await act(async () => line.querySelector<HTMLButtonElement>('[data-slot="task-event-output"]')!.click());
    expect(fleet.reveal).toHaveBeenCalledWith("task:t1", { sheet: true });

    await act(async () => store.dispatch({ type: "tasks/loaded", tasks: [], path: PATH }));
    await mount(<TaskEventNotice data={{ ...taskSummary, status: "failed", exitCode: 1 }} />);
    expect(container.querySelector('[data-slot="task-event"]')?.getAttribute("data-failed")).toBe("true");
    expect(container.querySelector('[data-slot="task-event-output"]')).toBeNull();
  });

  it("says where a started agent is working: its branch, or this session's own checkout", async () => {
    const call = (result: Record<string, unknown>, args: Record<string, unknown> = { agent_name: "reviewer", subagent_name: "explorer" }) => ({
      toolCallId: "start-1",
      toolName: "start_agent",
      args,
      argsText: JSON.stringify(args),
      status: { type: "complete" as const, reason: "stop" as const },
      result: JSON.stringify(result, null, 2),
      addResult: vi.fn(),
      resume: vi.fn(),
      respondToApproval: vi.fn(async () => {}),
    });
    const where = () => container.querySelector<HTMLElement>('[data-slot="start-agent-where"]');

    // A hydrated row has only the model's JSON view: `working_directory`.
    await mount(<ToolRow {...call({ working_directory: "/p/.worktrees/explorer-1", branch: "agents/explorer-1" })} type="tool-call" />);
    expect(where()?.textContent).toContain("agents/explorer-1");
    expect(where()?.getAttribute("title")).toBe("/p/.worktrees/explorer-1");
    expect(where()?.textContent).not.toContain("checkout");

    // A live row has the harness's own details, which say `cwd`.
    const live = { ...call({}), result: { content: [{ type: "text", text: "{}" }], details: { sessionId: "child", runId: "r9", cwd: "/p/.worktrees/explorer-1", branch: "agents/explorer-1" } } };
    await mount(<ToolRow {...live} type="tool-call" />);
    expect(where()?.textContent).toContain("agents/explorer-1");
    expect(where()?.getAttribute("title")).toBe("/p/.worktrees/explorer-1");

    // No branch is the signal that the child is not isolated.
    await mount(<ToolRow {...call({ working_directory: "/p" })} type="tool-call" />);
    expect(where()?.textContent).toContain("/p");
    expect(where()?.textContent).toContain("this session’s checkout");

    // A row from before the result carried it shows no line at all.
    await mount(<ToolRow {...call({ sessionId: "child", runId: "r9" })} type="tool-call" />);
    expect(where()).toBeNull();
  });

  it("names a running call with Namer's label in its row and in the aggregate, then falls back to the summary", async () => {
    const running = { toolCallId: "bash-1", toolName: "bash", args: { command: "pnpm test" }, argsText: '{"command":"pnpm test"}', status: { type: "running" as const }, addResult: vi.fn(), resume: vi.fn(), respondToApproval: vi.fn(async () => {}) };
    await act(async () => store.dispatch({ type: "notification", method: "pi/extension/message", params: { path: PATH, message: { type: "lasercode/namer/label", toolCallId: "bash-1", label: "Checking the test suite" } } as never }));
    await mount(<ToolRow {...running} type="tool-call" />);
    const trigger = () => container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(trigger().textContent).toContain("Checking the test suite");
    expect(trigger().getAttribute("aria-label")).toBe("Checking the test suite");
    await mount(<ToolRow {...running} type="tool-call" status={{ type: "complete", reason: "stop" }} result="ok" />);
    expect(trigger().textContent).not.toContain("Checking the test suite");
    expect(trigger().textContent).toContain("Run");
    expect(trigger().textContent).toContain("pnpm test");

    function Aggregate({ done }: { done: boolean }) {
      const blocks: Block[] = [
        { kind: "assistant", id: "a", text: "", thinking: "Think", streaming: false },
        { kind: "tool", id: "bash-1", name: "bash", args: { command: "pnpm test" }, done, ...(done ? { result: "ok" } : {}) },
      ];
      const projected = projectMessages({ blocks, running: !done, dialogs: [] });
      const runtime = useExternalStoreRuntime({ messages: projected.messages, isRunning: !done, onNew: async () => {} });
      return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root><ThreadPrimitive.Messages>{() =>
        <MessagePrimitive.Root><MessagePrimitive.GroupedParts groupBy={() => ["group-activity"]} indicator="empty">{({ part, children }) => {
          if (part.type === "group-activity") return <ToolGroup part={part} timingKey="namer-test">{children}</ToolGroup>;
          return null;
        }}</MessagePrimitive.GroupedParts></MessagePrimitive.Root>
      }</ThreadPrimitive.Messages></ThreadPrimitive.Root></AssistantRuntimeProvider>;
    }
    await mount(<Aggregate done={false} />);
    const aggregate = () => container.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!;
    expect(aggregate().textContent).toContain("Checking the test suite");
    await mount(<Aggregate done />);
    expect(aggregate().textContent).not.toContain("Checking the test suite");
    expect(aggregate().textContent).toContain("Completed 2 steps");
  });
});
