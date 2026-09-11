// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime } from "@assistant-ui/react";

import { CodeDiff, DiffStat } from "../../src/components/assistant-ui/elements/code-diff.js";
import { ToolCall } from "../../src/components/assistant-ui/elements/tool-call.js";
import { ToolGroup } from "../../src/components/assistant-ui/elements/tool-group.aui.js";
import { toolTimelineFromParts } from "../../src/components/assistant-ui/elements/tool-timeline.js";
import { ToolRow } from "../../src/components/thread/ToolRow.js";
import { projectMessages } from "../../src/runtime/projection.js";
import type { Block } from "../../src/store.js";
import { MAX_DIFF_LINES } from "@lasercode/protocol/tool-diff";

const preferences = vi.hoisted(() => ({ path: "/test/session" }));
vi.mock("@/runtime", async () => ({
  ...await import("../../src/runtime/sessionPreferences.js"),
  ...await import("../../src/runtime/projection.js"),
  useActivityDetailLevel: () => "answers",
  useLaserState: () => preferences.path,
  useLaserStable: () => ({ actions: { answerDialog: vi.fn(), send: vi.fn(async () => {}) } }),
  useLaserView: () => ({ dialogs: [] }),
}));
vi.mock("@/agents/hooks", () => ({ useNamerLabel: () => undefined }));
vi.mock("@assistant-ui/react", async (original) => ({
  ...await original<typeof import("@assistant-ui/react")>(),
  useToolCallElapsed: () => undefined,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await import("../../src/components/assistant-ui/elements/tool-code-highlights.js");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("collapsed diff summaries", () => {
  function ToolRowFixture(props: React.ComponentProps<typeof ToolRow>) {
    const runtime = useExternalStoreRuntime({ messages: [], isRunning: false, onNew: async () => {} });
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <ToolRow {...props} />
      </AssistantRuntimeProvider>
    );
  }

  const toolProps = (toolCallId: string, toolName: string, args: Record<string, unknown>) => ({
    toolCallId,
    toolName,
    args,
    argsText: JSON.stringify(args),
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn(async () => {}),
  });

  it("keeps generic trailing content visible and described while preserving the trigger's accessible name", async () => {
    function Fixture() {
      const [open, setOpen] = useState(false);
      return (
        <ToolCall
          verb="Edited"
          summary="src/a/very/long/path/to/the/file/being/changed.ts"
          state="done"
          elapsedMs={1_250}
          open={open}
          onOpenChange={setOpen}
          trailing={<DiffStat added={12} removed={3} />}
          accessibleDescription="12 lines added, 3 lines removed"
        >
          <p>Expanded diff body</p>
        </ToolCall>
      );
    }

    await act(async () => root.render(<Fixture />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    const content = container.querySelector<HTMLElement>('[data-slot="tool-fallback-content"]')!;

    expect(trigger.textContent).toContain("+12 −3");
    expect(trigger.textContent).toContain("1.3s");
    expect(trigger.getAttribute("aria-label")).toBe("Edited src/a/very/long/path/to/the/file/being/changed.ts");
    expect(trigger.getAttribute("aria-description")).toBe("12 lines added, 3 lines removed");
    expect(content.hasAttribute("hidden")).toBe(true);
    expect(container.textContent).not.toContain("Expanded diff body");
    expect(trigger.querySelector("[data-search-content]")).toBeNull();

    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Expanded diff body");
    expect(trigger.textContent).toContain("+12 −3");

    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(content.hasAttribute("hidden")).toBe(true);
  });

  it("preserves normal and non-zero accessible labels when no description is supplied", async () => {
    const row = (state: "done" | "nonzero") => (
      <ToolCall verb="Run" summary="pnpm test" state={state} open={false} onOpenChange={vi.fn()}>
        <p>output</p>
      </ToolCall>
    );

    await act(async () => root.render(row("done")));
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Run pnpm test");
    expect(container.querySelector("button")?.hasAttribute("aria-description")).toBe(false);

    await act(async () => root.render(row("nonzero")));
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Run pnpm test, exited non-zero");
  });

  it("lets a long non-count verb truncate on a narrow row", async () => {
    await act(async () => root.render(
      <div style={{ width: 390 }}>
        <ToolCall
          verb="extremely_long_extension_tool_name_that_must_yield_to_duration"
          state="done"
          elapsedMs={1_250}
          open={false}
          onOpenChange={vi.fn()}
        >
          <p>output</p>
        </ToolCall>
      </div>,
    ));

    const label = container.querySelector<HTMLElement>('[data-slot="tool-fallback-trigger-label"]')!;
    expect(label.classList).toContain("truncate");
    expect(label.classList).not.toContain("shrink-0");
    expect(container.querySelector('[data-slot="tool-fallback-duration"]')?.textContent).toBe("1.3s");
  });

  it("shows aggregate counts collapsed, then each still-collapsed Edit/Write count inside the expanded group", async () => {
    const patch = ["@@ -1,2 +1,5 @@", "-old one", "-old two", "+new one", "+new two", "+new three", "+new four", "+new five"].join("\n");
    const blocks: Block[] = [
      { kind: "assistant", id: "group-answer", text: "", thinking: "", streaming: false },
      {
        kind: "tool",
        id: "group-edit",
        name: "edit",
        args: { path: "src/edited.ts", edits: [{ oldText: "fallback old", newText: "fallback new" }] },
        result: { content: [{ type: "text", text: "Edited" }], details: { patch } },
        done: true,
      },
      { kind: "tool", id: "group-bash", name: "bash", args: { command: "pnpm test" }, result: "ok", done: true },
      { kind: "tool", id: "group-write", name: "write", args: { path: "src/written.ts", content: "one\ntwo\nthree" }, result: "Wrote", done: true },
    ];

    function Fixture() {
      const projected = projectMessages({ blocks, running: false, dialogs: [] });
      const runtime = useExternalStoreRuntime({ messages: projected.messages, isRunning: false, onNew: async () => {} });
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadPrimitive.Root>
            <ThreadPrimitive.Messages>{() => (
              <MessagePrimitive.Root>
                <MessagePrimitive.GroupedParts groupBy={() => ["group-activity"]} indicator="empty">
                  {({ part, children }) => {
                    if (part.type === "tool-call") return <ToolRow {...part} />;
                    if (part.type === "group-activity") return <ToolGroup part={part} timingKey="diff-summary-group">{children}</ToolGroup>;
                    return null;
                  }}
                </MessagePrimitive.GroupedParts>
              </MessagePrimitive.Root>
            )}</ThreadPrimitive.Messages>
          </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
      );
    }

    await act(async () => root.render(<Fixture />));
    const groupTrigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!;
    expect(groupTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(groupTrigger.textContent).toContain("+8 −2");
    expect(groupTrigger.getAttribute("aria-label")).toContain("8 lines added, 2 lines removed");
    expect(container.querySelector('[data-tool="edit"]')).toBeNull();

    await act(async () => groupTrigger.click());
    const edit = container.querySelector<HTMLElement>('[data-tool="edit"]')!;
    const write = container.querySelector<HTMLElement>('[data-tool="write"]')!;
    const editTrigger = edit.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    const writeTrigger = write.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(editTrigger.textContent).toContain("+5 −2");
    expect(writeTrigger.textContent).toContain("+3");
    expect(editTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(writeTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(edit.querySelector('[data-slot="tool-fallback-content"]')?.hasAttribute("hidden")).toBe(true);
    expect(write.querySelector('[data-slot="tool-fallback-content"]')?.hasAttribute("hidden")).toBe(true);
  });

  it("shows successful Edit and Write counts without opening their bodies", async () => {
    const editArgs = {
      path: "src/a/very/long/path/that/must/yield/to/stats/file.ts",
      edits: [{ oldText: "keep\nremove", newText: "keep\nfirst\nsecond" }],
    };
    await act(async () => root.render(
      <ToolRowFixture {...toolProps("edit-success", "edit", editArgs)} status={{ type: "complete", reason: "stop" }} result="Edited" />,
    ));
    let trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    let body = container.querySelector<HTMLElement>('[data-slot="tool-fallback-content"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toContain("+2 −1");
    expect(trigger.getAttribute("aria-label")).toBe("Edit to/stats/file.ts");
    expect(trigger.getAttribute("aria-description")).toBe("2 lines added, 1 line removed");
    expect(body.hasAttribute("hidden")).toBe(true);

    const writeArgs = { path: "src/new.ts", content: "one\ntwo\nthree" };
    await act(async () => root.render(
      <ToolRowFixture {...toolProps("write-success", "write", writeArgs)} status={{ type: "complete", reason: "stop" }} result="Wrote" />,
    ));
    trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    body = container.querySelector<HTMLElement>('[data-slot="tool-fallback-content"]')!;
    expect(trigger.textContent).toContain("+3");
    expect(trigger.textContent).not.toContain("−");
    expect(trigger.getAttribute("aria-description")).toBe("3 lines added");
    expect(body.hasAttribute("hidden")).toBe(true);
  });

  it.each([
    { label: "failed", status: { type: "complete" as const, reason: "stop" as const }, isError: true },
    { label: "cancelled", status: { type: "incomplete" as const, reason: "cancelled" as const }, isError: false },
  ])("does not claim applied counts for a $label edit", async ({ label, status, isError }) => {
    const args = { path: `src/${label}.ts`, edits: [{ oldText: "old", newText: "new" }] };
    await act(async () => root.render(
      <ToolRowFixture {...toolProps(`edit-${label}`, "edit", args)} status={status} isError={isError} result={isError ? "Could not edit" : undefined} />,
    ));
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(trigger.textContent).not.toContain("+1");
    expect(trigger.textContent).not.toContain("−1");
    expect(trigger.hasAttribute("aria-description")).toBe(false);
  });

  it("hides unsupported and unknown write-deletion counts", async () => {
    await act(async () => root.render(
      <ToolRowFixture {...toolProps("empty-write", "write", { path: "src/cleared.ts", content: "" })}
        status={{ type: "complete", reason: "stop" }} result="Wrote" />,
    ));
    let trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(trigger.querySelector(".text-ok, .text-danger")).toBeNull();
    expect(trigger.hasAttribute("aria-description")).toBe(false);

    await act(async () => root.render(
      <ToolRowFixture {...toolProps("unknown-edit", "edit", { path: "src/unknown.ts", edits: [{ replacement: "new" }] })}
        status={{ type: "complete", reason: "stop" }} result="Edited" />,
    ));
    trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(trigger.querySelector(".text-ok, .text-danger")).toBeNull();
  });

  it("shows full counts on a successful truncated ToolRow preview", async () => {
    const added = Array.from({ length: MAX_DIFF_LINES + 27 }, (_, index) => `line ${index + 1}`);
    const patch = [`@@ -0,0 +1,${added.length} @@`, ...added.map((line) => `+${line}`)].join("\n");
    const result = { content: [{ type: "text", text: "Edited" }], details: { patch } };
    await act(async () => root.render(
      <ToolRowFixture {...toolProps("large-edit", "edit", { path: "src/large.ts" })}
        status={{ type: "complete", reason: "stop" }} result={result} />,
    ));
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-fallback-trigger"]')!;
    expect(trigger.textContent).toContain(`+${added.length}`);
    expect(trigger.getAttribute("aria-description")).toBe(`${added.length} lines added`);
    expect(container.querySelector('[data-slot="tool-fallback-content"]')?.hasAttribute("hidden")).toBe(true);

    await act(async () => trigger.click());
    const diff = container.querySelector<HTMLElement>('[data-slot="code-diff"]')!;
    expect(diff.textContent).toContain(`+${added.length}`);
    expect(diff.querySelectorAll("tr[data-kind]")).toHaveLength(MAX_DIFF_LINES);
    expect(diff.textContent).toContain("diff truncated");
  });

  it("keeps the tool timeline on the same full-source metric", () => {
    const added = Array.from({ length: MAX_DIFF_LINES + 11 }, (_, index) => `line ${index + 1}`);
    const patch = [`@@ -0,0 +1,${added.length} @@`, ...added.map((line) => `+${line}`)].join("\n");
    const timeline = toolTimelineFromParts([{ parts: [{
      type: "tool-call",
      toolCallId: "timeline-edit",
      toolName: "edit",
      args: { path: "src/timeline.ts" },
      status: { type: "complete", reason: "stop" },
      result: { details: { patch } },
    } as never] }]);

    expect(timeline.stats).toEqual([{ file: "src/timeline.ts", added: added.length, removed: 0 }]);
    expect(toolTimelineFromParts([{ parts: [{
      type: "tool-call",
      toolCallId: "cancelled-timeline-edit",
      toolName: "edit",
      args: { path: "src/timeline.ts", edits: [{ oldText: "old", newText: "new" }] },
      status: { type: "incomplete", reason: "cancelled" },
    } as never] }]).stats).toEqual([]);
  });

  it("uses full-source stats and falls back for older handcrafted views", async () => {
    const hunk = {
      header: "@@ -1,1 +1,1 @@",
      lines: [
        { kind: "del" as const, text: "old", oldNo: 1 },
        { kind: "add" as const, text: "new", newNo: 1 },
      ],
    };

    await act(async () => root.render(
      <CodeDiff view={{ hunks: [hunk], stats: { added: 501, removed: 499 }, truncated: true }} />,
    ));
    expect(container.querySelector('[data-slot="code-diff"]')?.textContent).toContain("+501 −499");

    await act(async () => root.render(<CodeDiff view={{ hunks: [hunk], truncated: false }} />));
    expect(container.querySelector('[data-slot="code-diff"]')?.textContent).toContain("+1 −1");
  });
});
