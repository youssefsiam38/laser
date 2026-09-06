// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityReasoning, ToolGroupRoot, ToolGroupTrigger, ToolGroupContent, ToolGroupSummaryRow } from "../../src/components/assistant-ui/elements/tool-group.aui.js";
import { ToolFallback, ToolFallbackRoot, ToolFallbackTrigger, ToolFallbackContent } from "../../src/components/assistant-ui/elements/tool-fallback.aui.js";
import type { ActivityDetailLevel } from "../../src/runtime/sessionPreferences.js";

const preferences = vi.hoisted(() => ({ level: "answers" as ActivityDetailLevel }));
vi.mock("@/runtime", async () => ({
  ...await import("../../src/runtime/sessionPreferences.js"),
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
