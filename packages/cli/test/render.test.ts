/**
 * Two things here are worth a test: the duration/summary formatting a person
 * reads in every tool row, and the guarantee that nothing an agent or a tool
 * produced can drive the terminal (AGENTS.md invariant 9, applied to stdout).
 */
import { describe, expect, it } from "vitest";
import { painterFor, sanitize } from "../src/output.js";
import { TailRenderer, firstLine, formatDuration, summarizeArgs, summarizeResult } from "../src/render.js";

const plain = painterFor({ isTTY: false } as NodeJS.WriteStream, "never", {});

function renderInto(updates: Parameters<TailRenderer["update"]>[0][]): { text: string; settled: boolean } {
  let text = "";
  const renderer = new TailRenderer({ paint: plain, write: (chunk) => (text += chunk) });
  let settled = false;
  for (const update of updates) settled = renderer.update(update) || settled;
  renderer.finish();
  return { text, settled };
}

describe("formatDuration", () => {
  it("reads the way a person would say it", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(842)).toBe("842ms");
    expect(formatDuration(1234)).toBe("1.2s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(63_400)).toBe("1m 03s");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});

describe("summaries", () => {
  it("prefers the field that says what a tool is acting on", () => {
    expect(summarizeArgs({ cwd: "/tmp", command: "pnpm test" })).toBe("pnpm test");
    expect(summarizeArgs({ offset: 1, path: "src/a.ts" })).toBe("src/a.ts");
    expect(summarizeArgs({ n: 3 })).toBe('{"n":3}');
    expect(summarizeArgs(undefined)).toBe("");
  });

  it("finds the readable part of a result of any shape", () => {
    expect(summarizeResult({ error: "boom" })).toBe("boom");
    expect(summarizeResult("plain text")).toBe("plain text");
    expect(summarizeResult({ nothing: 1 })).toBe("");
  });

  it("collapses whitespace and clips", () => {
    expect(firstLine("a\n\n  b   c", 100)).toBe("a b c");
    expect(firstLine("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("sanitize", () => {
  it("removes escape sequences, keeping the visible text", () => {
    expect(sanitize("\u001b[31mred\u001b[0m")).toBe("red");
    expect(sanitize("\u001b]0;window title\u0007ok")).toBe("ok");
    expect(sanitize("a\u0000b\u0008c")).toBe("abc");
  });

  it("keeps tabs and newlines, which are content", () => {
    expect(sanitize("a\tb\nc")).toBe("a\tb\nc");
  });
});

describe("TailRenderer", () => {
  it("never lets agent text drive the terminal", () => {
    const { text } = renderInto([
      { kind: "message_start", role: "assistant" },
      { kind: "text_delta", delta: "\u001b[2Jcleared your screen?", contentIndex: 0 },
      { kind: "message_end", message: {} },
    ]);
    expect(text).not.toContain("\u001b");
    expect(text).toContain("cleared your screen?");
  });

  it("sanitises tool names and results too", () => {
    const { text } = renderInto([
      { kind: "tool_execution_start", toolCallId: "t1", toolName: "ba\u001b[31msh", args: { command: "ls" } },
      { kind: "tool_execution_end", toolCallId: "t1", result: { error: "\u001b]0;x\u0007nope" }, isError: true },
    ]);
    expect(text).not.toContain("\u001b");
    expect(text).toContain("bash");
    expect(text).toContain("nope");
  });

  it("reports a settle exactly once, which is what `tail` exits on", () => {
    const { settled } = renderInto([{ kind: "agent_settled" }]);
    expect(settled).toBe(true);
    expect(renderInto([{ kind: "turn_end" }]).settled).toBe(false);
  });

  it("starts a tool row on its own line even mid-sentence", () => {
    const { text } = renderInto([
      { kind: "message_start", role: "assistant" },
      { kind: "text_delta", delta: "thinking about it", contentIndex: 0 },
      { kind: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } },
    ]);
    expect(text).toContain("thinking about it\n");
    expect(text).toContain("read");
  });

  it("hides thinking unless asked", () => {
    const updates: Parameters<TailRenderer["update"]>[0][] = [
      { kind: "thinking_delta", delta: "hmm", contentIndex: 0 },
    ];
    expect(renderInto(updates).text).toBe("");
    let shown = "";
    const renderer = new TailRenderer({ paint: plain, write: (chunk) => (shown += chunk), thinking: true });
    for (const update of updates) renderer.update(update);
    expect(shown).toContain("hmm");
  });
});
