// @vitest-environment happy-dom
/**
 * M13-T29 — a shell command that exits non-zero is not an emergency.
 *
 * A `grep` that found nothing, a test run that failed, a `git diff --quiet`:
 * ordinary results. The transcript says which command came back non-zero, in
 * red text, and says nothing else — no rail, no alert icon, no failure count,
 * no group that opens itself. A tool that genuinely broke keeps every bit of
 * the treatment it has.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalBlock } from "../../src/components/assistant-ui/elements/terminal-block.js";
import { ToolCall } from "../../src/components/assistant-ui/elements/tool-call.js";
import { toolRowState } from "../../src/components/assistant-ui/elements/tool-fallback.aui.js";
import { ToolGroupSummaryRow } from "../../src/components/assistant-ui/elements/tool-group.aui.js";
import {
  summarizeToolGroup,
  toolGroupDefaultOpen,
  type ToolGroupMember,
} from "../../src/components/thread/tool-groups.js";
import { isNonZeroExit, parseBashOutput } from "../../src/components/thread/tool-summary.js";
import type { ActivityDetailLevel } from "../../src/runtime/sessionPreferences.js";

const preferences = vi.hoisted(() => ({ level: "answers" as ActivityDetailLevel }));
vi.mock("@/runtime", async () => ({
  ...(await import("../../src/runtime/sessionPreferences.js")),
  useActivityDetailLevel: () => preferences.level,
  useLaserState: () => "/test/session",
  toolDisplayResult: (part: { result?: unknown }) => part.result,
}));
vi.mock("@assistant-ui/react", async (original) => ({
  ...(await original<typeof import("@assistant-ui/react")>()),
  useToolCallElapsed: () => undefined,
}));

/** What Pi's shell tool actually throws for a command that ran and exited 1. */
const NON_ZERO = "no matches found\n\nCommand exited with code 1";
/** …and what it throws when the command could not run at all. */
const BROKEN = "spawn /bin/nope ENOENT";

const call = (over: Partial<ToolGroupMember> = {}): ToolGroupMember => ({
  toolCallId: "call-1",
  toolName: "bash",
  args: { command: "grep -r nothing ." },
  isError: false,
  running: false,
  awaiting: false,
  cancelled: false,
  ...over,
});

const nonZeroMember = (over: Partial<ToolGroupMember> = {}) => call({ isError: true, nonZeroExit: true, ...over });
const brokenMember = (over: Partial<ToolGroupMember> = {}) => call({ isError: true, ...over });

describe("isNonZeroExit — what separates a result from a breakage", () => {
  it("is the exit trailer Pi's shell tool appends, and only that", () => {
    expect(isNonZeroExit("bash", true, NON_ZERO)).toBe(true);
    expect(isNonZeroExit("bash", true, "Command exited with code 137")).toBe(true);
  });

  it("is false for every other way the shell tool fails", () => {
    expect(isNonZeroExit("bash", true, BROKEN)).toBe(false);
    expect(isNonZeroExit("bash", true, "partial output\n\nCommand aborted")).toBe(false);
    expect(isNonZeroExit("bash", true, "partial output\n\nCommand timed out after 30 seconds")).toBe(false);
    expect(isNonZeroExit("bash", true, "Tool bash not found")).toBe(false);
    expect(isNonZeroExit("bash", true, "User denied tool execution")).toBe(false);
  });

  it("is false for a call that did not fail, and for a tool that is not the shell", () => {
    expect(isNonZeroExit("bash", false, "Command exited with code 1")).toBe(false);
    expect(isNonZeroExit("read", true, "Command exited with code 1")).toBe(false);
    expect(isNonZeroExit("some_extension_tool", true, "Command exited with code 1")).toBe(false);
  });

  it("agrees with the exit code the terminal block reads off the same text", () => {
    expect(parseBashOutput(NON_ZERO, true)).toEqual({ output: "no matches found", exitCode: 1 });
    expect(parseBashOutput(BROKEN, true).exitCode).toBeUndefined();
  });
});

describe("toolRowState", () => {
  it("gives a non-zero exit its own settled state, not `failed`", () => {
    expect(toolRowState({ type: "complete" }, true, true)).toBe("nonzero");
    expect(toolRowState({ type: "complete" }, true, false)).toBe("failed");
    expect(toolRowState({ type: "incomplete", reason: "error" }, true, true)).toBe("nonzero");
  });

  it("leaves an interrupted or cancelled command exactly as it was", () => {
    expect(toolRowState({ type: "incomplete", reason: "cancelled" }, true, true)).toBe("cancelled");
    expect(toolRowState({ type: "running" }, false, true)).toBe("running");
    expect(toolRowState({ type: "requires-action", reason: "tool-calls" }, false, true)).toBe("awaiting");
  });
});

describe("the aggregate row", () => {
  it("does not count a non-zero exit as an error", () => {
    const summary = summarizeToolGroup([nonZeroMember(), call({ toolCallId: "b" })]);
    expect(summary.hasError).toBe(false);
    expect(summary.label).toBe("Ran 2 commands");
    expect(toolGroupDefaultOpen(summary)).toBe(false);
  });

  it("still calls a tool that broke an error", () => {
    const summary = summarizeToolGroup([brokenMember(), call({ toolCallId: "b" })]);
    expect(summary.hasError).toBe(true);
    expect(toolGroupDefaultOpen(summary)).toBe(true);
  });

  it("keeps the breakdown truthful for a screen reader", () => {
    const summary = summarizeToolGroup([nonZeroMember(), brokenMember({ toolCallId: "b", args: { command: "pnpm build" } })]);
    expect(summary.lines[0]).toMatch(/exited non-zero$/);
    expect(summary.lines[1]).toMatch(/failed$/);
  });
});

describe("what is rendered", () => {
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

  const group = (members: readonly ToolGroupMember[]) => (
    <ToolGroupSummaryRow
      members={members}
      reasoning={{ count: 0, running: false }}
      activityLevel="answers"
      timingKey="group-nonzero"
      groupStatus={{ type: "complete" }}
    >
      <div>rows</div>
    </ToolGroupSummaryRow>
  );

  it("reads exactly as it would had every command exited zero", async () => {
    await act(async () => root.render(group([nonZeroMember(), call({ toolCallId: "b" })])));
    const rootEl = container.querySelector('[data-slot="tool-group-root"]')!;
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!;
    expect(rootEl.getAttribute("data-tone")).toBeNull();
    expect(rootEl.className).not.toContain("bg-danger");
    expect(trigger.textContent).toContain("Ran 2 commands");
    expect(trigger.textContent).not.toContain("failed");
    expect(trigger.querySelector(".text-danger")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("puts a broken tool in front of the person without painting the block", async () => {
    await act(async () => root.render(group([brokenMember(), call({ toolCallId: "b" })])));
    const rootEl = container.querySelector('[data-slot="tool-group-root"]')!;
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!;
    // Open, so the failure is on screen rather than behind a fold — but the
    // block itself stays ordinary: no rail, no alert icon, no count.
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(rootEl.getAttribute("data-tone")).toBeNull();
    expect(rootEl.className).not.toContain("bg-danger");
    expect(trigger.querySelector(".text-danger")).toBeNull();
    expect(trigger.textContent).not.toContain("failed");
    // Quiet is not hidden: the name still says it out loud.
    expect(trigger.getAttribute("aria-label")).toContain("Something in it failed");
  });

  it("counts nothing, whichever kind of failure a group holds", async () => {
    await act(async () =>
      root.render(group([nonZeroMember(), nonZeroMember({ toolCallId: "b" }), brokenMember({ toolCallId: "c" })])),
    );
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!;
    await act(async () => trigger.click());
    expect(trigger.textContent).not.toContain("failed");
    expect(trigger.textContent).not.toContain("1 failed");
    expect(trigger.textContent).not.toContain("3 failed");
  });

  it("leaves the person's own toggle in charge", async () => {
    await act(async () => root.render(group([nonZeroMember()])));
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("turns the command and nothing else on the individual row", async () => {
    await act(async () =>
      root.render(
        <ToolCall verb="Run" summary="grep -r nothing ." state="nonzero" open={false} onOpenChange={() => {}} toolName="bash">
          <div>body</div>
        </ToolCall>,
      ),
    );
    const rowRoot = container.querySelector('[data-slot="tool-call"]')!;
    const commandText = container.querySelector('[data-slot="tool-fallback-trigger-summary"]')!;
    expect(rowRoot.getAttribute("data-tone")).toBeNull();
    expect(rowRoot.getAttribute("data-state-row")).toBe("nonzero");
    expect(rowRoot.className).not.toContain("bg-danger");
    expect(commandText.className).toContain("text-danger-quiet");
    expect(commandText.className).not.toContain("text-ink-2");
    expect(container.querySelector('[data-slot="tool-fallback-trigger"]')!.getAttribute("aria-label")).toBe(
      "Run grep -r nothing ., exited non-zero",
    );
  });

  it("gives a row whose tool broke no rail either", async () => {
    await act(async () =>
      root.render(
        <ToolCall verb="Run" summary="pnpm build" state="failed" open={false} onOpenChange={() => {}} toolName="bash">
          <div>body</div>
        </ToolCall>,
      ),
    );
    const rowRoot = container.querySelector('[data-slot="tool-call"]')!;
    // The row still knows what it is — the body renders the error, and the
    // state is on the element — but the frame around it says nothing.
    expect(rowRoot.getAttribute("data-state-row")).toBe("failed");
    expect(rowRoot.getAttribute("data-tone")).toBeNull();
    expect(rowRoot.className).not.toContain("before:bg-danger");
  });

  it("still rails a row that is waiting on a person", async () => {
    await act(async () =>
      root.render(
        <ToolCall verb="Run" summary="rm -rf build" state="awaiting" open={false} onOpenChange={() => {}} toolName="bash">
          <div>body</div>
        </ToolCall>,
      ),
    );
    const rowRoot = container.querySelector('[data-slot="tool-call"]')!;
    // A question is not a result. This is the one thing that still earns a rail.
    expect(rowRoot.getAttribute("data-tone")).toBe("attention");
    expect(rowRoot.className).toContain("before:bg-attention");
  });

  it("keeps the exit code visible on the terminal ground without alarm", async () => {
    await act(async () =>
      root.render(<TerminalBlock command="pnpm test" output="1 failing" exitCode={1} running={false} isError={false} />),
    );
    const block = container.querySelector('[data-slot="terminal-block"]')!;
    // The `$` is its own span; the command is the one carrying the search hook.
    const command = block.querySelector("[data-search-content]")!;
    expect(block.getAttribute("data-exit")).toBe("1");
    expect(block.textContent).toContain("exit 1");
    expect(command.className).toContain("text-terminal-danger");
    expect(block.querySelector(".text-danger")).toBeNull();
  });

  it("keeps the loud treatment when the command could not run at all", async () => {
    await act(async () =>
      root.render(<TerminalBlock command="nope" output="spawn nope ENOENT" running={false} isError={true} />),
    );
    const block = container.querySelector('[data-slot="terminal-block"]')!;
    expect(block.textContent).toContain("failed");
    expect(block.querySelector(".text-danger")).not.toBeNull();
    expect(block.querySelector("[data-search-content]")!.className).toContain("text-terminal-ink");
    expect(block.querySelector("[data-search-content]")!.className).not.toContain("text-terminal-danger");
  });
});
