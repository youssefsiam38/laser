/**
 * The log buffer is a rolling window shared by every watcher, and its ref is
 * read by byte range. Both are easy to get subtly wrong (a bucket that grows
 * without bound, a ref that answers for another section) and invisible when
 * they are.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { LogEntry } from "@lasercode/protocol";
import {
  LOG_MAX_LINES,
  logContent,
  logLine,
  logPanelId,
  logRef,
  logStreamPanel,
  recordLogRows,
  resetLogBuffer,
} from "../../src/panels/index.js";

const row = (over: Partial<LogEntry> = {}): LogEntry => ({
  id: 1,
  at: "2026-09-05T10:11:12.000Z",
  section: "provider",
  level: "info",
  kind: "request",
  summary: "openai/gpt-5 · 4 messages",
  ...over,
});

beforeEach(() => resetLogBuffer());

describe("logLine", () => {
  it("carries the same facts the logs page's row shows", () => {
    expect(logLine(row({ status: 200 }))).toMatch(/request \(200\) · openai\/gpt-5 · 4 messages$/);
    expect(logLine(row({ durationMs: 120 }))).toContain("(120ms)");
    expect(logLine(row({ durationMs: 2400 }))).toContain("(2.4s)");
    // `info` is the quiet default and does not shout its own name.
    expect(logLine(row())).not.toContain("INFO");
    expect(logLine(row({ level: "error" }))).toContain("ERROR");
  });
});

describe("the buffer", () => {
  it("keeps one bucket per section and answers only for that section's ref", () => {
    recordLogRows([row({ id: 1 }), row({ id: 2, section: "tools", summary: "bash · ls" })]);
    expect(logContent(logRef("provider"))).toContain("openai/gpt-5");
    expect(logContent(logRef("provider"))).not.toContain("bash · ls");
    expect(logContent(logRef("tools"))).toContain("bash · ls");
    expect(logContent("inline:widget:something")).toBeUndefined();
  });

  it("reports which sections changed, so only watched islands are re-emitted", () => {
    expect(recordLogRows([row(), row({ section: "host" })]).sort()).toEqual(["host", "provider"]);
    expect(recordLogRows([])).toEqual([]);
  });

  it("holds a bounded window: an hour of logs is still one island", () => {
    recordLogRows(Array.from({ length: LOG_MAX_LINES + 500 }, (_, i) => row({ id: i, summary: `row ${i}` })));
    const text = logContent(logRef("provider")) ?? "";
    const lines = text.split("\n");
    expect(lines).toHaveLength(LOG_MAX_LINES);
    // The window is the newest rows, not the first ones recorded.
    expect(lines.at(-1)).toContain(`row ${LOG_MAX_LINES + 499}`);
    expect(text).not.toContain("row 0 ");
  });
});

describe("logStreamPanel", () => {
  it("is a follow stream whose byte count matches its content", () => {
    recordLogRows([row()]);
    const panel = logStreamPanel("provider");
    expect(panel).toMatchObject({ kind: "stream", id: logPanelId("provider"), intent: "follow", follow: true, encoding: "text" });
    expect(panel.bytes).toBe(new TextEncoder().encode(logContent(logRef("provider"))!).length);
  });

  it("declares ansi only for the section that really carries escape codes", () => {
    expect(logStreamPanel("host").encoding).toBe("ansi");
    for (const section of ["provider", "tools", "session", "subagents"] as const) {
      expect(logStreamPanel(section).encoding).toBe("text");
    }
  });
});
