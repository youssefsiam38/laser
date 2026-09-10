// @vitest-environment happy-dom
import { act } from "react";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityReasoning, ToolGroupRoot, ToolGroupTrigger, ToolGroupContent, ToolGroupSummaryRow } from "../../src/components/assistant-ui/elements/tool-group.aui.js";
import { ToolFallback, ToolFallbackRoot, ToolFallbackTrigger, ToolFallbackContent } from "../../src/components/assistant-ui/elements/tool-fallback.aui.js";
import type { ActivityDetailLevel } from "../../src/runtime/sessionPreferences.js";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { ToolGroup } from "../../src/components/assistant-ui/elements/tool-group.aui.js";
import { projectMessages } from "../../src/runtime/projection.js";
import type { Block } from "../../src/store.js";
import { activityRow, activityTrigger } from "../../src/components/assistant-ui/elements/surfaces.js";

const preferences = vi.hoisted(() => ({ level: "answers" as ActivityDetailLevel }));
vi.mock("@/runtime", async () => ({
  ...await import("../../src/runtime/sessionPreferences.js"),
  ...await import("../../src/runtime/projection.js"),
  useActivityDetailLevel: () => preferences.level,
  useLaserState: () => "/test/session",
}));
vi.mock("@assistant-ui/react", async (original) => ({
  ...await original<typeof import("@assistant-ui/react")>(),
  useToolCallElapsed: () => undefined,
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  preferences.level = "answers";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("activity disclosures", () => {
  it("pads the trigger contents, not the outer row, so the beam reaches both edges", () => {
    expect(activityRow).not.toMatch(/\bp[xslr]-/);
    expect(activityTrigger).toContain("px-2");
    expect(activityTrigger).toContain("w-full");
  });
  it("does not synthesize thinking after a tool call in the real transcript", () => {
    const source = readFileSync(new NodeURL("../../src/components/thread/messages.tsx", import.meta.url), "utf8");
    expect(source).toContain('<MessagePrimitive.GroupedParts groupBy={groupBy} indicator="empty">');
    expect(source).toContain('label="Waiting for response"');
  });
  it("keeps the aggregate and child live through partial output, then stops both", async () => {
    function LiveFixture({ done }: { done: boolean }) {
      const blocks: Block[] = [
        { kind: "assistant", id: "a", text: "", thinking: "Inspect the command", streaming: false },
        { kind: "tool", id: "cmd", name: "bash", args: { command: "check-project" }, partial: "still working", done,
          ...(done ? { result: "finished" } : {}) },
      ];
      const projected = projectMessages({ blocks, running: !done, dialogs: [] });
      const runtime = useExternalStoreRuntime({ messages: projected.messages, isRunning: !done, onNew: async () => {} });
      return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root><ThreadPrimitive.Messages>{() =>
        <MessagePrimitive.Root><MessagePrimitive.GroupedParts groupBy={() => ["group-activity"]} indicator="empty">{({ part, children }) => {
          if (part.type === "reasoning") return <ActivityReasoning running={part.status.type === "running"}>Inspect the command</ActivityReasoning>;
          if (part.type === "tool-call") return <ToolFallback {...part} />;
          if (part.type === "group-activity") return <ToolGroup part={part} timingKey="live-test">{children}</ToolGroup>;
          return <span>Unexpected thinking</span>;
        }}</MessagePrimitive.GroupedParts></MessagePrimitive.Root>
      }</ThreadPrimitive.Messages></ThreadPrimitive.Root></AssistantRuntimeProvider>;
    }
    preferences.level = "everything";
    await act(async () => root.render(<LiveFixture done={false} />));
    expect(container.querySelectorAll('[data-slot="activity-beam"]')).toHaveLength(2);
    expect(container.querySelector('[data-slot="activity-reasoning"] [data-slot="activity-beam"]')).toBeNull();
    expect(container.textContent).toContain("still working");
    expect(container.textContent).toContain("Running check-project");
    expect(container.textContent).not.toContain("Unexpected thinking");
    await act(async () => root.render(<LiveFixture done />));
    expect(container.querySelectorAll('[data-slot="activity-beam"]')).toHaveLength(0);
    expect(container.textContent).toContain("finished");
  });
  it("allows a waiting tool's details to collapse without hiding its approval", async () => {
    await act(async () => root.render(<ToolFallback toolCallId="waiting" toolName="review" args={{}} argsText="{}"
      status={{type:"requires-action",reason:"tool-calls"}} approval={{id:"approval"}}
      addResult={vi.fn()} resume={vi.fn()} respondToApproval={vi.fn()} />));
    const button = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-slot="tool-fallback-content"]')?.hasAttribute("hidden")).toBe(true);
    expect(container.textContent).toContain("Allow");
    expect(container.textContent).toContain("Deny");
  });
  it("keeps mixed summaries readable instead of squeezing every family into the status line", async () => {
    const breakdown = [
      { family: "reasoning", iconKind: "reasoning", label: "Reasoned" },
      { family: "read", iconKind: "read", label: "Read 20 files" },
      { family: "edit", iconKind: "edit", label: "Edited 8 files" },
      { family: "bash", iconKind: "bash", label: "Ran 5 commands" },
    ] as const;
    await act(async () => root.render(<ToolGroupRoot><ToolGroupTrigger label="Completed 40 steps" breakdown={breakdown} /><ToolGroupContent>All 40 steps</ToolGroupContent></ToolGroupRoot>));
    const trigger = container.querySelector('button')!;
    expect(trigger.textContent).toContain('Completed 40 steps');
    expect(container.querySelectorAll('[data-slot="tool-group-breakdown-item"]')).toHaveLength(2);
    expect(container.querySelector('[data-slot="tool-group-breakdown-more"]')?.textContent).toBe('+2 types');
    expect(trigger.getAttribute('aria-label')).toContain('Edited 8 files, Ran 5 commands');
    expect(container.querySelector('[data-slot="tool-group-trigger-label"]')?.classList.contains('truncate')).toBe(false);
    await act(async () => trigger.click()); expect(container.textContent).toContain('All 40 steps');
    await act(async () => trigger.click()); expect(container.textContent).not.toContain('All 40 steps');
  });

  it("opens and closes the aggregate through its actual button", async () => {
    await act(async () => root.render(
      <ToolGroupRoot>
        <ToolGroupTrigger label="Reasoned" />
        <ToolGroupContent>Full reasoning</ToolGroupContent>
      </ToolGroupRoot>,
    ));
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Full reasoning");
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Full reasoning");
  });

  it.each(["answers", "reasoning", "everything"] as const)("lets the reader override %s and keeps that choice through live updates", async (level) => {
    preferences.level = level;
    const render = (running: boolean) => <ActivityReasoning running={running}>Complete reasoning, including its final line.</ActivityReasoning>;
    await act(async () => root.render(render(false)));
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-expanded")).toBe(String(level !== "answers"));
    if (level === "answers") await act(async () => button.click());
    expect(container.textContent).toContain("including its final line");
    await act(async () => button.click());
    await act(async () => root.render(render(true)));
    expect(button.isConnected).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-slot="thinking-indicator"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="activity-beam"]')?.getAttribute("aria-hidden")).toBe("true");
    expect(container.textContent).not.toContain("including its final line");
    await act(async () => root.render(render(false)));
    expect(container.querySelector('[data-slot="activity-beam"]')).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => button.click());
    expect(container.textContent).toContain("including its final line");
  });

  it.each(["answers", "reasoning", "everything"] as const)("keeps the aggregate and each child independent in %s", async (level) => {
    preferences.level = level;
    await act(async () => root.render(
      <ToolGroupSummaryRow members={[{toolCallId:"read-test",toolName:"read",args:{path:"README.md"},running:false,awaiting:false,isError:false,cancelled:false}]}
        reasoning={{count:1,running:false}} activityLevel={level} timingKey="group-test" groupStatus={{type:"complete"}}>
        <ActivityReasoning>Reasoning body</ActivityReasoning>
        <ToolFallbackRoot>
          <ToolFallbackTrigger verb="Read" summary="README.md" />
          <ToolFallbackContent>Tool body</ToolFallbackContent>
        </ToolFallbackRoot>
      </ToolGroupSummaryRow>,
    ));
    const parent = container.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!;
    expect(parent.getAttribute("aria-expanded")).toBe(String(level === "everything"));
    if (level !== "everything") await act(async () => parent.click());
    const reasoning = container.querySelector<HTMLButtonElement>('[data-slot="activity-reasoning"] button')!;
    const tool = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    const priorReasoning = reasoning.getAttribute("aria-expanded");
    await act(async () => tool.click());
    expect(container.textContent).toContain("Tool body");
    expect(reasoning.getAttribute("aria-expanded")).toBe(priorReasoning);
    await act(async () => reasoning.click());
    expect(reasoning.getAttribute("aria-expanded")).not.toBe(priorReasoning);
    expect(tool.getAttribute("aria-expanded")).toBe("true");
    await act(async () => parent.click());
    expect(parent.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Tool body");
    expect(container.querySelector('[data-slot="activity-reasoning"]')).toBeNull();
  });
});
