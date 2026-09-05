/**
 * M4-T6: the live-tail predicate must agree with the host's WHERE clause, or a
 * followed row lands where a re-query would not put it — the kind of drift a
 * log viewer must never have.
 */
import { describe, expect, it } from "vitest";
import type { LogEntry } from "@piorbit/protocol";

import { appendRows, matchesFilters, rowMetric, toQuery, type LogFilters } from "../../src/components/logs/model.js";

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  id: 1,
  at: "2026-09-05T10:00:00.000Z",
  section: "provider",
  kind: "provider_request",
  level: "info",
  summary: "claude-sonnet-4-5 · 3 messages",
  ...over,
});

const filters = (over: Partial<LogFilters> = {}): LogFilters => ({
  section: "all",
  search: "",
  levels: null,
  ...over,
});

describe("toQuery", () => {
  it("omits every filter that is not narrowing anything", () => {
    expect(toQuery(filters())).toEqual({});
    expect(toQuery(filters({ section: "tools", search: " bash " }), { limit: 50 })).toEqual({
      sections: ["tools"],
      search: "bash",
      limit: 50,
    });
  });
});

describe("matchesFilters", () => {
  it("narrows by section, level, project and session", () => {
    expect(matchesFilters(entry(), filters({ section: "tools" }))).toBe(false);
    expect(matchesFilters(entry(), filters({ section: "provider" }))).toBe(true);
    expect(matchesFilters(entry({ level: "debug" }), filters({ levels: ["error"] }))).toBe(false);
    expect(matchesFilters(entry({ cwd: "/a" }), filters({ cwd: "/b" }))).toBe(false);
    expect(matchesFilters(entry({ sessionPath: "/s" }), filters({ sessionPath: "/s" }))).toBe(true);
  });

  it("searches the same text the store indexes: summary, kind and the preview", () => {
    const row = entry({ detailRef: { ref: "a".repeat(64), bytes: 9000, contentType: "application/json", preview: '{"tools":["bash"]}' } });
    expect(matchesFilters(row, filters({ search: "SONNET" }))).toBe(true);
    expect(matchesFilters(row, filters({ search: "provider_request" }))).toBe(true);
    expect(matchesFilters(row, filters({ search: "bash" }))).toBe(true);
    expect(matchesFilters(row, filters({ search: "gpt" }))).toBe(false);
  });
});

describe("appendRows", () => {
  it("ignores rows already on screen and keeps the list ordered", () => {
    const existing = [entry({ id: 1 }), entry({ id: 2 })];
    const merged = appendRows(existing, [entry({ id: 2 }), entry({ id: 3 })], 100);
    expect(merged.map((row) => row.id)).toEqual([1, 2, 3]);
    expect(appendRows(existing, [entry({ id: 1 })], 100)).toBe(existing);
    expect(appendRows(existing, [], 100)).toBe(existing);
  });

  it("drops the oldest rows past the cap", () => {
    const existing = [entry({ id: 1 }), entry({ id: 2 }), entry({ id: 3 })];
    expect(appendRows(existing, [entry({ id: 4 })], 2).map((row) => row.id)).toEqual([3, 4]);
  });
});

describe("rowMetric", () => {
  it("shows status for a response and duration for anything timed", () => {
    expect(rowMetric(entry({ status: 429 }))).toBe("429");
    expect(rowMetric(entry({ durationMs: 240 }))).toBe("240ms");
    expect(rowMetric(entry({ durationMs: 3200 }))).toBe("3.2s");
    expect(rowMetric(entry())).toBeUndefined();
  });
});
