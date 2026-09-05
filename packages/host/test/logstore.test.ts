/**
 * M4-T5: paging, byte budgets, content references, correlation and retention.
 * These are the parts where a mistake is silent (a page that never advances, a
 * ref whose body was collected, a duration attributed to the wrong request),
 * so they are worth a test; the SQL itself is exercised through them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionUpdateParams } from "@piorbit/protocol";
import { LogStore, describeProviderRequest } from "../src/logstore.js";

let base: string;
let store: LogStore;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "piorbit-logs-"));
  store = new LogStore({ file: join(base, "logs.db") });
});

afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

const update = (u: SessionUpdateParams["update"], at: string, seq = 1): SessionUpdateParams => ({
  sessionPath: "/s/a.jsonl",
  seq,
  at,
  update: u,
});

describe("paging", () => {
  beforeEach(() => {
    for (let i = 1; i <= 50; i++) {
      store.record({ section: "host", kind: "note", summary: `row ${i}` });
    }
  });

  it("returns pages oldest-first, newest page first", () => {
    const page = store.query({ limit: 10 });
    expect(page.entries.map((e) => e.summary)).toEqual(
      ["row 41", "row 42", "row 43", "row 44", "row 45", "row 46", "row 47", "row 48", "row 49", "row 50"],
    );
    expect(page.hasMore).toBe(true);
    expect(page.oldestId).toBeLessThan(page.newestId!);
  });

  it("pages backwards with beforeId and stops", () => {
    const first = store.query({ limit: 10 });
    const second = store.query({ limit: 10, beforeId: first.oldestId! });
    expect(second.entries.map((e) => e.summary)).toEqual(
      ["row 31", "row 32", "row 33", "row 34", "row 35", "row 36", "row 37", "row 38", "row 39", "row 40"],
    );
    const last = store.query({ limit: 100, beforeId: 11 });
    expect(last.entries).toHaveLength(10);
    expect(last.hasMore).toBe(false);
  });

  it("tails forward with afterId", () => {
    const seen = store.query({ limit: 50 }).newestId!;
    store.record({ section: "host", kind: "note", summary: "row 51" });
    const tail = store.query({ afterId: seen });
    expect(tail.entries.map((e) => e.summary)).toEqual(["row 51"]);
  });

  it("never returns an empty page while claiming there is more", () => {
    store.record({ section: "host", kind: "big", summary: "x".repeat(2000) });
    const page = store.query({ limit: 10, byteBudget: 1 });
    expect(page.entries).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });

  it("stops filling a page at the byte budget", () => {
    const page = store.query({ limit: 50, byteBudget: 400 });
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.entries.length).toBeLessThan(50);
    expect(page.hasMore).toBe(true);
    expect(page.approxBytes).toBeLessThanOrEqual(400 + JSON.stringify(page.entries[0]).length);
  });
});

describe("filters", () => {
  it("narrows by section, level, session and search", () => {
    store.record({ section: "provider", kind: "provider_request", summary: "anthropic · 3 messages" });
    store.record({ section: "tools", kind: "tool_start", summary: "bash started", sessionPath: "/s/a.jsonl" });
    store.record({ section: "host", kind: "worker_stderr", summary: "EADDRINUSE", level: "error" });

    expect(store.query({ sections: ["provider"] }).entries).toHaveLength(1);
    expect(store.query({ levels: ["error"] }).entries[0]!.summary).toBe("EADDRINUSE");
    expect(store.query({ sessionPath: "/s/a.jsonl" }).entries[0]!.kind).toBe("tool_start");
    expect(store.query({ search: "ANTHROPIC" }).entries).toHaveLength(1);
  });

  it("treats a % in the search as a literal, not a wildcard", () => {
    store.record({ section: "host", kind: "note", summary: "context at 80% full" });
    store.record({ section: "host", kind: "note", summary: "unrelated" });
    expect(store.query({ search: "80%" }).entries).toHaveLength(1);
    expect(store.query({ search: "%" }).entries).toHaveLength(1);
  });
});

describe("large payloads", () => {
  it("moves a big payload behind a content ref with a preview", () => {
    const payload = { model: "claude-sonnet-4", messages: Array.from({ length: 200 }, (_, i) => ({ role: "user", text: `m${i}` })) };
    const entry = store.record({ section: "provider", kind: "provider_request", summary: "big", detail: payload });
    expect(entry.detail).toBeUndefined();
    expect(entry.detailRef).toBeDefined();
    expect(entry.detailRef!.preview.length).toBeGreaterThan(0);
    expect(entry.detailRef!.bytes).toBeGreaterThan(2048);

    const body = store.content(entry.detailRef!.ref);
    expect(body.truncated).toBe(false);
    expect(JSON.parse(body.text)).toEqual(payload);
  });

  it("stores an identical payload once", () => {
    const payload = { messages: Array.from({ length: 300 }, () => "same") };
    const a = store.record({ section: "provider", kind: "provider_request", summary: "a", detail: payload });
    const b = store.record({ section: "provider", kind: "provider_request", summary: "b", detail: payload });
    expect(a.detailRef!.ref).toBe(b.detailRef!.ref);
  });

  it("keeps small payloads inline", () => {
    const entry = store.record({ section: "tools", kind: "tool_start", summary: "ls", detail: { path: "/tmp" } });
    expect(entry.detail).toEqual({ path: "/tmp" });
    expect(entry.detailRef).toBeUndefined();
  });

  it("explains a payload whose rows retention already removed", () => {
    expect(() => store.content("a".repeat(64))).toThrow(/no longer stored.*Retention/s);
  });
});

describe("ingestion", () => {
  it("correlates a provider response with its request and times it", () => {
    store.observeExtensionMessage("/p", "/s/a.jsonl", {
      type: "piorbit/provider/request",
      at: "2026-09-05T10:00:00.000Z",
      payload: { model: "claude-sonnet-4-5", messages: [{}, {}], tools: [{}, {}, {}], stream: true },
    });
    store.observeExtensionMessage("/p", "/s/a.jsonl", {
      type: "piorbit/provider/response",
      at: "2026-09-05T10:00:01.500Z",
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const [request, response] = store.query({ sections: ["provider"] }).entries;
    expect(request!.summary).toBe("claude-sonnet-4-5 · 2 messages · 3 tools · stream · 81 B");
    expect(response!.status).toBe(200);
    expect(response!.durationMs).toBe(1500);
    expect(response!.correlationId).toBe(`req-${request!.id}`);
    // The ceiling: Pi has no response-body hook, and the row says so.
    expect(response!.detail).toMatchObject({ bodyAvailable: false });
  });

  it("logs an HTTP error response at error level", () => {
    store.observeExtensionMessage("/p", "/s/a.jsonl", {
      type: "piorbit/provider/response",
      at: new Date().toISOString(),
      status: 429,
      headers: {},
    });
    expect(store.query({ sections: ["provider"] }).entries[0]!.level).toBe("error");
  });

  it("pairs tool start and end by tool call id, across interleaved tools", () => {
    store.observeSessionUpdate("/p", update({ kind: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} }, "2026-09-05T10:00:00.000Z"));
    store.observeSessionUpdate("/p", update({ kind: "tool_execution_start", toolCallId: "t2", toolName: "read", args: {} }, "2026-09-05T10:00:00.500Z"));
    store.observeSessionUpdate("/p", update({ kind: "tool_execution_end", toolCallId: "t2", result: {}, isError: false }, "2026-09-05T10:00:01.000Z"));
    store.observeSessionUpdate("/p", update({ kind: "tool_execution_end", toolCallId: "t1", result: {}, isError: true }, "2026-09-05T10:00:03.000Z"));

    const ends = store.query({ sections: ["tools"] }).entries.filter((e) => e.kind === "tool_end");
    expect(ends.map((e) => [e.summary, e.durationMs])).toEqual([
      ["read finished · 500 ms", 500],
      ["bash failed · 3000 ms", 3000],
    ]);
    expect(ends[1]!.level).toBe("error");
  });

  it("ignores transcript deltas", () => {
    store.observeSessionUpdate("/p", update({ kind: "text_delta", delta: "hi", contentIndex: 0 }, new Date().toISOString()));
    expect(store.query({}).entries).toHaveLength(0);
  });

  it("splits worker stderr into one row per line and flags errors", () => {
    store.observeWorkerStderr("/p", "warming up\nError: boom\n\n");
    const rows = store.query({ sections: ["host"] }).entries;
    expect(rows.map((r) => r.summary)).toEqual(["warming up", "Error: boom"]);
    expect(rows.map((r) => r.level)).toEqual(["debug", "error"]);
  });
});

describe("retention", () => {
  it("keeps at most maxRows and collects orphaned payloads", async () => {
    const bounded = new LogStore({ file: join(base, "bounded.db"), maxRows: 5, pruneEvery: 1 });
    try {
      const refs: string[] = [];
      for (let i = 0; i < 20; i++) {
        const entry = bounded.record({
          section: "host",
          kind: "note",
          summary: `row ${i}`,
          detail: { filler: "x".repeat(3000), i },
        });
        refs.push(entry!.detailRef!.ref);
      }
      // Retention runs off the hot path now, so give it its tick.
      await new Promise((r) => setTimeout(r, 0));
      const stats = bounded.stats();
      expect(stats.total).toBe(5);
      expect(stats.retention.maxRows).toBe(5);

      const survivors = bounded.query({ limit: 100 }).entries;
      for (const entry of survivors) expect(() => bounded.content(entry.detailRef!.ref)).not.toThrow();
      // The 15 dropped rows take their payloads with them on a sweeping pass.
      bounded.prune();
      expect(() => bounded.content(refs[0]!)).toThrow();
      expect(() => bounded.content(refs.at(-1)!)).not.toThrow();
    } finally {
      bounded.close();
    }
  });

  it("never stores a credential-shaped field", () => {
    const store = new LogStore({ file: ":memory:" });
    try {
      const entry = store.record({
        section: "provider",
        kind: "provider_request",
        summary: "req",
        detail: {
          headers: { Authorization: "Bearer sk-secret", "content-type": "application/json" },
          body: { messages: [{ apiKey: "sk-also-secret", text: "hello" }] },
        },
      })!;
      const detail = JSON.stringify(entry.detail);
      expect(detail).not.toContain("sk-secret");
      expect(detail).not.toContain("sk-also-secret");
      expect(detail).toContain("[redacted]");
      expect(detail).toContain("hello"); // everything else survives intact
      expect((entry.detail as { piorbitRedactedFields?: number }).piorbitRedactedFields).toBe(2);

      // A gateway names its key with a vendor prefix; Pi's own payloads are full
      // of token *budgets*, which must survive or every row lies the other way.
      const vendor = store.record({
        section: "provider",
        kind: "provider_request",
        summary: "req",
        detail: {
          headers: { "x-goog-api-key": "goog-secret", "anthropic-api-key": "anthropic-secret" },
          body: { max_tokens: 8192, reserveTokens: 4096 },
        },
      })!;
      const vendorDetail = JSON.stringify(vendor.detail);
      expect(vendorDetail).not.toContain("goog-secret");
      expect(vendorDetail).not.toContain("anthropic-secret");
      expect(vendorDetail).toContain("8192");
      expect(vendorDetail).toContain("4096");
    } finally {
      store.close();
    }
  });

  it("drops rows older than maxAgeDays", () => {
    const aged = new LogStore({ file: join(base, "aged.db"), maxAgeDays: 1 });
    try {
      aged.record({ section: "host", kind: "old", summary: "ancient", at: "2020-01-01T00:00:00.000Z" });
      aged.record({ section: "host", kind: "new", summary: "fresh" });
      aged.prune();
      expect(aged.query({}).entries.map((e) => e.summary)).toEqual(["fresh"]);
    } finally {
      aged.close();
    }
  });

  it("clears one section without touching the others", () => {
    store.record({ section: "provider", kind: "provider_request", summary: "a" });
    store.record({ section: "tools", kind: "tool_start", summary: "b" });
    expect(store.clear(["provider"])).toBe(1);
    expect(store.query({}).entries.map((e) => e.section)).toEqual(["tools"]);
  });

  it("reports the ceiling in its stats", () => {
    expect(store.stats().providerResponseBodies).toBe("unavailable");
  });
});

describe("describeProviderRequest", () => {
  it("degrades to a size when it recognises nothing", () => {
    expect(describeProviderRequest("not an object")).toMatch(/provider request · \d+ B/);
    expect(describeProviderRequest({ unknown: 1 })).toMatch(/^\d+ B$/);
  });

  it("reads the OpenAI responses shape too", () => {
    expect(describeProviderRequest({ model: "gpt-5", input: [{}], reasoning_effort: "high" })).toMatch(
      /^gpt-5 · 1 message · thinking · \d+ B$/,
    );
  });
});

describe("live append", () => {
  it("hands new rows to the host as they land", () => {
    const seen: number[] = [];
    const live = new LogStore({ file: ":memory:", onAppend: (entries) => seen.push(...entries.map((e) => e.id)) });
    try {
      const a = live.record({ section: "host", kind: "note", summary: "one" });
      const b = live.record({ section: "host", kind: "note", summary: "two" });
      expect(seen).toEqual([a.id, b.id]);
    } finally {
      live.close();
    }
  });
});
