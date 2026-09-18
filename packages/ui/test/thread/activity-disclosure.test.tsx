// @vitest-environment happy-dom
import { act } from "react";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { createRoot, type Root } from "react-dom/client";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityReasoning, ToolGroupRoot, ToolGroupTrigger, ToolGroupContent, ToolGroupSummaryRow } from "../../src/components/assistant-ui/elements/tool-group.aui.js";
import { ToolFallback, ToolFallbackRoot, ToolFallbackTrigger, ToolFallbackContent } from "../../src/components/assistant-ui/elements/tool-fallback.aui.js";
import type { ActivityDetailLevel } from "../../src/runtime/sessionPreferences.js";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";
import { ToolGroup } from "../../src/components/assistant-ui/elements/tool-group.aui.js";
import { ReasoningContent, ReasoningRoot, ReasoningTrigger } from "../../src/components/assistant-ui/elements/reasoning.js";
import { projectMessages } from "../../src/runtime/projection.js";
import type { Block } from "../../src/store.js";
import { activityDisclosure, activityRow, activityRowLayout, activityTrigger } from "../../src/components/assistant-ui/elements/surfaces.js";
import { FindQueryContext, SearchMessageContext } from "../../src/components/thread/search-state.js";
import { createConversationSearch } from "../../src/components/thread/conversation-search-cache.js";
import { findTextRanges } from "../../src/components/thread/use-conversation-find.js";
import { ToolRow } from "../../src/components/thread/ToolRow.js";
import { activateTestEnvironment } from "../../test/runtime/environment-fixture.js";

const preferences = vi.hoisted(() => ({ level: "answers" as ActivityDetailLevel, path: "/test/session" }));
vi.mock("@/runtime", async () => ({
  ...await import("../../src/runtime/sessionPreferences.js"),
  ...await import("../../src/runtime/projection.js"),
  useActivityDetailLevel: () => preferences.level,
  useCapability: () => ({ state: "available" }),
  useLaserState: () => preferences.path,
  useLaserStable: () => ({ actions: { answerDialog: vi.fn(), send: vi.fn(async () => {}) } }),
  useLaserView: () => ({ dialogs: [] }),
}));
vi.mock("@assistant-ui/react", async (original) => ({
  ...await original<typeof import("@assistant-ui/react")>(),
  useToolCallElapsed: () => undefined,
}));
vi.mock("@/agents/hooks", () => ({ useSessionMcpServers: () => [] }));

let container: HTMLDivElement;
let root: Root;
/**
 * Everything here mounts real transcript rows, and a real row carries the
 * app's tooltip (the shell mounts one provider; this is that provider).
 */
const render = (node: React.ReactNode) => root.render(<TooltipProvider>{node}</TooltipProvider>);

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  preferences.level = "answers";
  preferences.path = "/test/session";
  globalThis.localStorage.clear();
  activateTestEnvironment();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("activity disclosures", () => {
  it("keeps row layout passive and puts pointer affordances on the disclosure button", () => {
    expect(activityRow).not.toMatch(/\bp[xslr]-/);
    expect(activityRowLayout).toContain("px-2");
    expect(activityRowLayout).toContain("w-full");
    expect(activityRowLayout).not.toContain("cursor-pointer");
    expect(activityRowLayout).not.toContain("active:bg-");
    expect(activityTrigger).toContain("group/trigger");
    expect(activityTrigger).toContain("focus-visible:outline-live");
    expect(activityDisclosure).toContain("cursor-pointer");
    expect(activityDisclosure).toContain("pointer-coarse:size-11");
    expect(activityDisclosure).toContain("focus-visible:outline-live");
  });
  it("does not reserve a touch-sized invisible disclosure on a non-expandable row", async () => {
    await act(async () => render(
      <ToolFallbackRoot>
        <ToolFallbackTrigger verb="Finished" expandable={false} />
      </ToolFallbackRoot>,
    ));
    const row = container.querySelector<HTMLElement>('[data-slot="tool-fallback-trigger-row"]')!;
    expect(row.textContent).toContain("Finished");
    expect(row.querySelector('[data-slot="tool-fallback-trigger"]')).toBeNull();
    expect(row.querySelector('[aria-hidden="true"].pointer-coarse\\:size-11')).toBeNull();
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
    await act(async () => render(<LiveFixture done={false} />));
    expect(container.querySelectorAll('[data-slot="activity-beam"]')).toHaveLength(2);
    expect(container.querySelector('[data-slot="activity-reasoning"] [data-slot="activity-beam"]')).toBeNull();
    expect(container.textContent).toContain("still working");
    expect(container.textContent).toContain("Running check-project");
    expect(container.textContent).not.toContain("Unexpected thinking");
    await act(async () => render(<LiveFixture done />));
    expect(container.querySelectorAll('[data-slot="activity-beam"]')).toHaveLength(0);
    expect(container.textContent).toContain("finished");
  });
  it("allows a waiting tool's details to collapse without hiding its approval", async () => {
    await act(async () => render(<ToolFallback toolCallId="waiting" toolName="review" args={{}} argsText="{}"
      status={{type:"requires-action",reason:"tool-calls"}} approval={{id:"approval"}}
      addResult={vi.fn()} resume={vi.fn()} respondToApproval={vi.fn()} />));
    const button = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-slot="tool-fallback-content"]')?.hasAttribute("hidden")).toBe(true);
    expect(container.textContent).toContain("Allow");
    expect(container.textContent).toContain("Deny");
  });
  it("keeps an individual tool choice through result, preference and navigation restoration without session bleed", async () => {
    const fixture = (done: boolean) => (
      <ToolFallback toolCallId="stable-tool" toolName="review" args={{ target: "release" }} argsText='{"target":"release"}'
        status={done ? { type: "complete" } : { type: "running" }} result={done ? "Reviewed" : undefined}
        addResult={vi.fn()} resume={vi.fn()} respondToApproval={vi.fn()} />
    );
    preferences.level = "everything";
    await act(async () => render(fixture(false)));
    let button = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await act(async () => button.click());
    preferences.level = "answers";
    await act(async () => render(fixture(true)));
    expect(button.getAttribute("aria-expanded")).toBe("false");

    await act(async () => render(<div>away</div>));
    await act(async () => render(fixture(true)));
    button = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(button.getAttribute("aria-expanded")).toBe("false");

    preferences.path = "/test/other-session";
    preferences.level = "everything";
    await act(async () => render(fixture(true)));
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps mixed summaries readable instead of squeezing every family into the status line", async () => {
    const breakdown = [
      { family: "reasoning", iconKind: "reasoning", label: "Reasoned" },
      { family: "read", iconKind: "read", label: "Read 20 files" },
      { family: "edit", iconKind: "edit", label: "Edited 8 files" },
      { family: "bash", iconKind: "bash", label: "Ran 5 commands" },
    ] as const;
    await act(async () => render(<ToolGroupRoot><ToolGroupTrigger label="Completed 40 steps" breakdown={breakdown} /><ToolGroupContent>All 40 steps</ToolGroupContent></ToolGroupRoot>));
    const trigger = container.querySelector('button')!;
    const row = trigger.closest<HTMLElement>('[data-slot="tool-group-trigger-row"]')!;
    expect(row.textContent).toContain('Completed 40 steps');
    expect(container.querySelectorAll('[data-slot="tool-group-breakdown-item"]')).toHaveLength(2);
    expect(container.querySelector('[data-slot="tool-group-breakdown-more"]')?.textContent).toBe('+2 types');
    expect(trigger.getAttribute('aria-label')).toContain('Edited 8 files, Ran 5 commands');
    expect(row.querySelector('[data-slot="tool-group-trigger-label"]')?.closest('button')).toBeNull();
    expect(container.querySelector('[data-slot="tool-group-trigger-label"]')?.classList.contains('truncate')).toBe(false);
    await act(async () => trigger.click()); expect(container.textContent).toContain('All 40 steps');
    await act(async () => trigger.click()); expect(container.textContent).not.toContain('All 40 steps');
  });

  it("opens and closes the aggregate through its actual button", async () => {
    await act(async () => render(
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
    const reasoningFixture = (running: boolean) => <ActivityReasoning disclosureId="reasoning:test" running={running}>Complete reasoning, including its final line.</ActivityReasoning>;
    await act(async () => render(reasoningFixture(false)));
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-expanded")).toBe(String(level !== "answers"));
    if (level === "answers") await act(async () => button.click());
    expect(container.textContent).toContain("including its final line");
    await act(async () => button.click());
    await act(async () => render(reasoningFixture(true)));
    expect(button.isConnected).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-slot="thinking-indicator"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="activity-beam"]')?.getAttribute("aria-hidden")).toBe("true");
    expect(container.textContent).not.toContain("including its final line");
    await act(async () => render(reasoningFixture(false)));
    expect(container.querySelector('[data-slot="activity-beam"]')).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => button.click());
    expect(container.textContent).toContain("including its final line");
  });

  it("remembers a known tool child through aggregate unmount, detail-mode changes and restored message identity", async () => {
    function Fixture() {
      const blocks: Block[] = [
        { kind: "assistant", id: "known-a", text: "", thinking: "Inspect known tool", streaming: false },
        { kind: "tool", id: "known-read", name: "read", args: { path: "README.md" }, result: "Known tool body", done: true },
      ];
      const projected = projectMessages({ blocks, running: false, dialogs: [] });
      const runtime = useExternalStoreRuntime({ messages: projected.messages, isRunning: false, onNew: async () => {} });
      return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root><ThreadPrimitive.Messages>{() =>
        <MessagePrimitive.Root><MessagePrimitive.GroupedParts groupBy={() => ["group-activity"]} indicator="empty">{({ part, children }) => {
          if (part.type === "reasoning") return <ActivityReasoning running={false}>Inspect known tool</ActivityReasoning>;
          if (part.type === "tool-call") return <ToolRow {...part} />;
          if (part.type === "group-activity") return <ToolGroup part={part} timingKey="known-message:activity:0">{children}</ToolGroup>;
          return null;
        }}</MessagePrimitive.GroupedParts></MessagePrimitive.Root>
      }</ThreadPrimitive.Messages></ThreadPrimitive.Root></AssistantRuntimeProvider>;
    }

    preferences.level = "everything";
    await act(async () => render(<Fixture />));
    let aggregate = container.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!;
    let tool = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(tool.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Known tool body");
    await act(async () => tool.click());
    expect(tool.getAttribute("aria-expanded")).toBe("false");

    await act(async () => aggregate.click());
    expect(container.querySelector('[data-tool="read"]')).toBeNull();
    preferences.level = "answers";
    await act(async () => render(<Fixture />));
    aggregate = container.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!;
    expect(aggregate.getAttribute("aria-expanded")).toBe("false");
    await act(async () => aggregate.click());
    tool = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(tool.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Known tool body");

    await act(async () => render(<div>Navigate away</div>));
    await act(async () => render(<Fixture />));
    aggregate = container.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!;
    expect(aggregate.getAttribute("aria-expanded")).toBe("true");
    tool = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(tool.getAttribute("aria-expanded")).toBe("false");

    preferences.path = "/test/other-known-session";
    preferences.level = "everything";
    await act(async () => render(<Fixture />));
    tool = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(tool.getAttribute("aria-expanded")).toBe("true");
    preferences.path = "/test/session";
    await act(async () => render(<Fixture />));
    tool = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(tool.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps a known waiting tool body closed while its approval footer stays actionable", async () => {
    function Fixture() {
      const runtime = useExternalStoreRuntime({ messages: [], isRunning: true, onNew: async () => {} });
      return <AssistantRuntimeProvider runtime={runtime}>
        <ToolRow toolCallId="known-waiting" toolName="read" args={{ path: "protected.txt" }} argsText='{"path":"protected.txt"}'
          status={{ type: "requires-action", reason: "tool-calls" }} approval={{ id: "known-approval" }}
          addResult={vi.fn()} resume={vi.fn()} respondToApproval={vi.fn()} />
      </AssistantRuntimeProvider>;
    }
    await act(async () => render(<Fixture />));
    const tool = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(tool.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-slot="tool-fallback-content"]')?.hasAttribute("hidden")).toBe(true);
    const actions = [...container.querySelectorAll<HTMLButtonElement>("button")];
    expect(actions.find((button) => button.textContent?.includes("Allow"))?.disabled).toBe(false);
    expect(actions.find((button) => button.textContent?.includes("Deny"))?.disabled).toBe(false);
  });

  it("keeps Answers only closed for partial output and a settled tool error in the real grouped-parts pipeline", async () => {
    function Fixture({ done }: { done: boolean }) {
      const blocks: Block[] = [
        { kind: "assistant", id: "quiet-a", text: "", thinking: "Inspect quietly", streaming: false },
        {
          kind: "tool",
          id: "quiet-tool",
          name: "read",
          args: { path: "missing.txt" },
          partial: "partial output must stay folded",
          done,
          ...(done ? { result: "No such file", isError: true } : {}),
        },
      ];
      const projected = projectMessages({ blocks, running: !done, dialogs: [] });
      const runtime = useExternalStoreRuntime({ messages: projected.messages, isRunning: !done, onNew: async () => {} });
      return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root><ThreadPrimitive.Messages>{() =>
        <MessagePrimitive.Root><MessagePrimitive.GroupedParts groupBy={() => ["group-activity"]} indicator="empty">{({ part, children }) => {
          if (part.type === "reasoning") return <ActivityReasoning running={part.status.type === "running"}>Inspect quietly</ActivityReasoning>;
          if (part.type === "tool-call") return <ToolFallback {...part} />;
          if (part.type === "group-activity") return <ToolGroup part={part} timingKey="quiet-message:activity:0">{children}</ToolGroup>;
          return null;
        }}</MessagePrimitive.GroupedParts></MessagePrimitive.Root>
      }</ThreadPrimitive.Messages></ThreadPrimitive.Root></AssistantRuntimeProvider>;
    }

    await act(async () => render(<Fixture done={false} />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("partial output must stay folded");
    await act(async () => render(<Fixture done />));
    expect(trigger.isConnected).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("No such file");
  });

  it("keeps a manual aggregate choice through preference changes, member updates, remount and restoration", async () => {
    const member = (running: boolean) => ({ toolCallId: "durable-read", toolName: "read", args: { path: "README.md" }, running, awaiting: false, isError: false, cancelled: false });
    const fixture = (level: ActivityDetailLevel, running = false) => (
      <ToolGroupSummaryRow members={[member(running)]} reasoning={{ count: 1, running: false }} activityLevel={level}
        timingKey="stable-message:activity:0" groupStatus={{ type: running ? "running" : "complete" }}>
        <div>Durable children</div>
      </ToolGroupSummaryRow>
    );

    await act(async () => render(fixture("answers")));
    let trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => render(fixture("reasoning", true)));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => render(fixture("everything")));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    await act(async () => render(<div>Another session is being viewed</div>));
    await act(async () => render(fixture("answers")));
    trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => trigger.click());
    await act(async () => render(fixture("everything", true)));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("lets find reveal temporarily open a manually closed aggregate, then restores it", async () => {
    const fixture = (reveal: boolean) => (
      <SearchMessageContext value={reveal}>
        <ToolGroupSummaryRow members={[{ toolCallId: "find-read", toolName: "read", args: {}, running: false, awaiting: false, isError: false, cancelled: false }]}
          reasoning={{ count: 1, running: false }} activityLevel="everything" timingKey="find-message:activity:0" groupStatus={{ type: "complete" }}>
          <div>Find-only body</div>
        </ToolGroupSummaryRow>
      </SearchMessageContext>
    );
    await act(async () => render(fixture(false)));
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!;
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => render(fixture(true)));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Find-only body");
    await act(async () => render(fixture(false)));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Find-only body");
  });

  // AGENTS.md: "Search disclosure is transient. Closing find restores the
  // user's detail preference." The chevron a person reaches for *while find
  // holds a row open* folds that row for this reveal only — it must not write
  // the durable override, which would apply after find closes and never before.
  it("lets the chevron fold a revealed aggregate for that reveal only, writing no preference", async () => {
    preferences.level = "everything";
    const fixture = (reveal: boolean) => (
      <SearchMessageContext value={reveal}>
        <ToolGroupSummaryRow members={[{ toolCallId: "transient-read", toolName: "read", args: {}, running: false, awaiting: false, isError: false, cancelled: false }]}
          reasoning={{ count: 1, running: false }} activityLevel="everything" timingKey="transient-message:activity:0" groupStatus={{ type: "complete" }}>
          <div>Transient body</div>
        </ToolGroupSummaryRow>
      </SearchMessageContext>
    );
    // Open by preference, then find reveals it.
    await act(async () => render(fixture(false)));
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => render(fixture(true)));

    // Folding during the reveal really folds it — and hides the body.
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Transient body");
    expect(globalThis.localStorage.getItem("lasercode-activity-disclosure-overrides")).toBeNull();

    // Find closes: their preference is what comes back.
    await act(async () => render(fixture(false)));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Transient body");

    // And a second reveal starts from the reveal again, not from that fold.
    await act(async () => render(fixture(true)));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps a body folded when find matches the already-visible humanised label", async () => {
    const fixture = (reveal: boolean, query = "Reading build config") => (
      <FindQueryContext value={query}>
        <SearchMessageContext value={reveal}>
          <ToolFallbackRoot visibleSearchText="Reading build config" bodySearchText={() => ["Unrelated hidden request and output"]}>
            <ToolFallbackTrigger verb="Read" label="Reading build config" summary="build.config.ts" />
            <ToolFallbackContent>Unrelated hidden request and output</ToolFallbackContent>
          </ToolFallbackRoot>
        </SearchMessageContext>
      </FindQueryContext>
    );
    await act(async () => render(fixture(false)));
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => render(fixture(true)));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Unrelated hidden request and output");
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => render(fixture(true, "Reading")));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => render(fixture(false, "Reading")));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("reveals a folded body when the query matches both its humanised label and output", async () => {
    const fixture = (reveal: boolean) => (
      <FindQueryContext value="build config">
        <SearchMessageContext value={reveal}>
          <ToolFallback toolCallId="mixed-find" toolName="read"
            args={{ path: "build.config.ts", activity_label: "reading-build-config" }}
            argsText='{"path":"build.config.ts","activity_label":"reading-build-config"}'
            status={{ type: "complete" }} result="build config output" />
        </SearchMessageContext>
      </FindQueryContext>
    );
    await act(async () => render(fixture(false)));
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => render(fixture(true)));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("build config output");
  });

  it("uses the canonical Unicode matcher when deciding whether a hidden body must mount", async () => {
    const fixture = (reveal: boolean) => (
      <FindQueryContext value="source">
        <SearchMessageContext value={reveal}>
          <ToolFallbackRoot visibleSearchText="source label" bodySearchText={() => ["ſource body"]}>
            <ToolFallbackTrigger verb="Read" summary="unicode.txt" />
            <ToolFallbackContent><span data-search-content>ſource body</span></ToolFallbackContent>
          </ToolFallbackRoot>
        </SearchMessageContext>
      </FindQueryContext>
    );
    await act(async () => render(fixture(false)));
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => render(fixture(true)));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(findTextRanges(container, "source").map((range) => range.toString())).toEqual(["ſource"]);
  });

  it("resets transient aggregate and reasoning folds when the Find query changes", async () => {
    const fixture = (query: string) => (
      <FindQueryContext value={query}>
        <SearchMessageContext value>
          <ToolGroupRoot>
            <ToolGroupTrigger label="Aggregate" />
            <ToolGroupContent>Aggregate body</ToolGroupContent>
          </ToolGroupRoot>
          <ReasoningRoot>
            <ReasoningTrigger />
            <ReasoningContent>Reasoning body</ReasoningContent>
          </ReasoningRoot>
        </SearchMessageContext>
      </FindQueryContext>
    );
    await act(async () => render(fixture("query A")));
    const aggregate = container.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!;
    const reasoning = container.querySelector<HTMLButtonElement>('[data-slot="reasoning-trigger"]')!;
    await act(async () => { aggregate.click(); reasoning.click(); });
    expect(aggregate.getAttribute("aria-expanded")).toBe("false");
    expect(reasoning.getAttribute("aria-expanded")).toBe("false");
    await act(async () => render(fixture("query B")));
    expect(aggregate.getAttribute("aria-expanded")).toBe("true");
    expect(reasoning.getAttribute("aria-expanded")).toBe("true");
  });

  it("excludes real aggregate and reasoning chrome so indexed ordinals reach the real child bodies", async () => {
    preferences.level = "everything";
    const message = {
      id: "activity-search", role: "assistant",
      content: [
        { type: "reasoning", text: "shared match thought" },
        { type: "tool-call", toolName: "bash", toolCallId: "search-command", args: { command: "shared match" }, result: "shared match output" },
      ],
    } as never;
    await act(async () => render(
      <div data-message-id="activity-search">
        <ToolGroupRoot defaultOpen>
          <ToolGroupTrigger label="Ran one command" detail="shared match" />
          <ToolGroupContent>
            <ActivityReasoning disclosureId="search-reasoning">shared match thought</ActivityReasoning>
            <ToolRow toolName="bash" toolCallId="search-command" args={{ command: "shared match" }} argsText='{"command":"shared match"}'
              result="shared match output" status={{ type: "complete" }} addResult={vi.fn()} resume={vi.fn()} respondToApproval={vi.fn()} />
          </ToolGroupContent>
        </ToolGroupRoot>
      </div>,
    ));
    const hits = createConversationSearch()([message], "shared match");
    const ranges = findTextRanges(container, "shared match");
    expect(hits.map((hit) => hit.occurrence)).toEqual([0, 1, 2]);
    expect(ranges).toHaveLength(hits.length);
    expect(ranges.every((range) => !range.startContainer.parentElement?.closest('[data-slot="tool-group-trigger-row"], [data-slot="reasoning-trigger-row"]'))).toBe(true);
    expect(ranges[0]?.startContainer.parentElement?.closest('[data-slot="activity-reasoning"]')).not.toBeNull();
    expect(ranges.slice(1).every((range) => range.startContainer.parentElement?.closest('[data-tool="bash"]'))).toBe(true);
    expect(createConversationSearch()([message], "Reasoning")).toHaveLength(0);
    expect(findTextRanges(container, "Reasoning")).toHaveLength(0);
  });

  // The row a person actually clicks in a find pass is a tool row, and it goes
  // through the same Root: the rule cannot hold for the aggregate alone.
  it("folds a revealed tool row for that reveal only, writing no preference", async () => {
    const fixture = (reveal: boolean) => (
      <SearchMessageContext value={reveal}>
        <ToolFallbackRoot>
          <ToolFallbackTrigger verb="Read" summary="README.md" />
          <ToolFallbackContent>Transient tool body</ToolFallbackContent>
        </ToolFallbackRoot>
      </SearchMessageContext>
    );
    await act(async () => render(fixture(false)));
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await act(async () => render(fixture(true)));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Transient tool body");

    // Out of find, the row is exactly where the person left it before find.
    await act(async () => render(fixture(false)));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(globalThis.localStorage.getItem("lasercode-activity-disclosure-overrides")).toBeNull();
  });

  it("folds a revealed reasoning row for that reveal only, writing no preference", async () => {
    preferences.level = "everything";
    const fixture = (reveal: boolean) => (
      <SearchMessageContext value={reveal}>
        <ActivityReasoning disclosureId="transient-message:reasoning:0">Transient reasoning body</ActivityReasoning>
      </SearchMessageContext>
    );
    await act(async () => render(fixture(false)));
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="activity-reasoning"] button')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    await act(async () => render(fixture(true)));
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Transient reasoning body");
    expect(globalThis.localStorage.getItem("lasercode-activity-disclosure-overrides")).toBeNull();

    await act(async () => render(fixture(false)));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the composable reasoning root's find reveal out of the person's preference", async () => {
    const fixture = (reveal: boolean) => (
      <SearchMessageContext value={reveal}>
        <ReasoningRoot sessionPath="/test/session" disclosureId="standalone:reasoning:0">
          <ReasoningTrigger />
          <ReasoningContent>Standalone reasoning body</ReasoningContent>
        </ReasoningRoot>
      </SearchMessageContext>
    );
    await act(async () => render(fixture(false)));
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="reasoning-trigger"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await act(async () => render(fixture(true)));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(globalThis.localStorage.getItem("lasercode-activity-disclosure-overrides")).toBeNull();

    // Closed find, closed row: the reveal left nothing behind.
    await act(async () => render(fixture(false)));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Standalone reasoning body");
  });

  it("keeps a child reasoning choice independent across aggregate collapse and reopen", async () => {
    preferences.level = "everything";
    const fixture = () => (
      <ToolGroupSummaryRow members={[{ toolCallId: "child-read", toolName: "read", args: {}, running: false, awaiting: false, isError: false, cancelled: false }]}
        reasoning={{ count: 1, running: false }} activityLevel="everything" timingKey="child-message:activity:0" groupStatus={{ type: "complete" }}>
        <ActivityReasoning disclosureId="child-message:reasoning:0">Remember this reasoning body</ActivityReasoning>
      </ToolGroupSummaryRow>
    );
    await act(async () => render(fixture()));
    const parent = container.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!;
    let child = container.querySelector<HTMLButtonElement>('[data-slot="activity-reasoning"] button')!;
    expect(child.getAttribute("aria-expanded")).toBe("true");
    await act(async () => child.click());
    expect(child.getAttribute("aria-expanded")).toBe("false");
    await act(async () => parent.click());
    expect(container.querySelector('[data-slot="activity-reasoning"]')).toBeNull();
    await act(async () => parent.click());
    child = container.querySelector<HTMLButtonElement>('[data-slot="activity-reasoning"] button')!;
    expect(child.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Remember this reasoning body");
  });

  // M16-T48 / review #49: the per-call lines were a native `title` on the
  // aggregate's trigger — pointer-only, and drawn in system chrome over the
  // transcript. They are the app's tooltip now, and a focused row shows them.
  it("shows what ran in the app's tooltip on the aggregate's own row, by keyboard", async () => {
    const lines = Array.from({ length: 11 }, (_, index) => `Ran command ${index + 1}`);
    await act(async () => render(
      <ToolGroupRoot><ToolGroupTrigger label="Ran 11 commands" lines={lines} /><ToolGroupContent>Eleven rows</ToolGroupContent></ToolGroupRoot>,
    ));
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!;
    expect(trigger.getAttribute("title")).toBeNull();

    await act(async () => trigger.focus());
    const tip = [...document.querySelectorAll('[data-slot="tooltip-content"]')].map((node) => node.textContent).join(" ");
    expect(tip).toContain("Ran command 1");
    expect(tip).toContain("Ran command 8");
    // A long run does not cover the conversation: the rest are one row away.
    expect(tip).not.toContain("Ran command 9");
    expect(tip).toContain("+3 more");
    await act(async () => trigger.blur());
  });

  it("keeps standalone streaming reasoning quiet until the reader opens it", async () => {
    await act(async () => render(
      <ReasoningRoot streaming>
        <ReasoningTrigger active />
        <ReasoningContent>Streaming reasoning body</ReasoningContent>
      </ReasoningRoot>,
    ));
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="reasoning-trigger"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Streaming reasoning body");
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it.each(["answers", "reasoning", "everything"] as const)("keeps the aggregate and each child independent in %s", async (level) => {
    preferences.level = level;
    await act(async () => render(
      <ToolGroupSummaryRow members={[{toolCallId:"read-test",toolName:"read",args:{path:"README.md"},running:false,awaiting:false,isError:false,cancelled:false}]}
        reasoning={{count:1,running:false}} activityLevel={level} timingKey="group-test" groupStatus={{type:"complete"}}>
        <ActivityReasoning disclosureId={`independent:${level}`}>Reasoning body</ActivityReasoning>
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
