/**
 * M16-T34 / D-245: what the log store keeps of a provider request body, and
 * whether the disk it takes ever comes back.
 *
 * The store reached 27.7 GB in eight days on a real machine with both of its
 * limits (200,000 rows, 14 days) still far from firing, because a provider
 * request body is the whole conversation of that turn and nothing bounded
 * them in bytes. These tests hold the three rules that now do: fifty full
 * bodies per session, a global byte budget enforced as rows arrive, and a
 * file that actually shrinks — proven by `fileBytes()`, never by a row count.
 */
import { PRODUCT_NAME, WIRE_NAMESPACE, type ClientRequests, type LogPage } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LogStore, summaryMessageCount, summaryModel } from "../src/logstore.js";
import { HostServer } from "../src/server.js";

let base: string;
const stores: LogStore[] = [];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-logbudget-`));
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(base, { recursive: true, force: true });
});

function open(name: string, options: Partial<ConstructorParameters<typeof LogStore>[0]> = {}): LogStore {
  const store = new LogStore({ file: join(base, name), ...options });
  stores.push(store);
  return store;
}

/** A provider request the size of a real one: one big message, unique per call. */
function request(index: number, kib = 1024): unknown {
  return {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: `${index}:${"x".repeat(kib * 1024)}` }],
    stream: true,
  };
}

function ingest(store: LogStore, session: string, index: number, kib = 1024): void {
  store.observeExtensionMessage("/project", session, {
    type: "lasercode/provider/request",
    at: new Date(Date.UTC(2026, 8, 13, 0, 0, index)).toISOString(),
    payload: request(index, kib),
  });
}

const retained = (store: LogStore) => store.stats().retention.retainedBodyBytes ?? 0;

describe("the byte budget", () => {
  it("settles an ingestion burst of large bodies at the budget, across sessions", () => {
    const budget = 24 * 1024 * 1024;
    const store = open("burst.db", { bodyBudgetBytes: budget, bodiesPerSession: 50 });
    let peak = 0;
    // 300 × 1 MiB into one session, then two more sessions: a burst that never
    // yields, which is exactly the case a timer alone would miss.
    for (let i = 0; i < 300; i++) {
      ingest(store, "/s/burst.jsonl", i);
      peak = Math.max(peak, retained(store));
    }
    for (const session of ["/s/second.jsonl", "/s/third.jsonl"]) {
      for (let i = 0; i < 20; i++) {
        ingest(store, session, i);
        peak = Math.max(peak, retained(store));
      }
    }
    // Ingestion itself keeps the store inside the budget plus the overshoot
    // margin it is allowed before it stops waiting for the next tick.
    expect(peak).toBeLessThanOrEqual(Math.round(budget * 1.05) + 2 * 1024 * 1024);
    store.maintain();
    expect(retained(store)).toBeLessThanOrEqual(budget);
    // And what survived is the newest end of the stream, not a random subset.
    const bodies = store.query({ sections: ["provider"], limit: 1000 }).entries.filter((entry) => !entry.detailRef?.released);
    expect(bodies.length).toBeGreaterThan(0);
    const newest = store.query({ sections: ["provider"], limit: 1 }).entries[0]!;
    expect(newest.detailRef?.released).toBeUndefined();
    expect(store.content(newest.detailRef!.ref).released).toBeUndefined();
    // Three hundred megabyte-sized bodies through a real file: ~2 s here, ~6 s
    // on a CI runner. The burst is the point of the test, so the time is too.
  }, 30_000);

  it("settles on its own timer, with no administrative call at all", async () => {
    const budget = 6 * 1024 * 1024;
    const store = open("timer.db", { bodyBudgetBytes: budget });
    for (let i = 0; i < 20; i++) {
      ingest(store, "/s/timer.jsonl", i);
      // A real turn arrives in its own turn of the loop.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (let i = 0; i < 10 && retained(store) > budget; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(retained(store)).toBeLessThanOrEqual(budget);
  });
});

describe("fifty per session", () => {
  it("keeps the newest fifty request bodies of a session and summarises the rest", () => {
    const store = open("session.db", { bodiesPerSession: 50 });
    for (let i = 0; i < 80; i++) ingest(store, "/s/a.jsonl", i, 4);
    for (let i = 0; i < 10; i++) ingest(store, "/s/b.jsonl", i, 4);
    store.maintain();

    const rows = store.query({ sessionPath: "/s/a.jsonl", limit: 200 }).entries;
    expect(rows).toHaveLength(80);
    const kept = rows.filter((entry) => !entry.detailRef?.released);
    expect(kept).toHaveLength(50);
    // The fifty that stayed are the last fifty, in order.
    expect(kept.map((entry) => entry.id)).toEqual(rows.slice(30).map((entry) => entry.id));
    // Another session is untouched by the first one's volume.
    expect(store.query({ sessionPath: "/s/b.jsonl", limit: 50 }).entries.every((entry) => !entry.detailRef?.released)).toBe(true);
  });

  it("a released row whose body comes back by hash stops saying summary only", () => {
    const store = open("restore.db", { bodiesPerSession: 2 });
    for (let i = 0; i < 4; i++) ingest(store, "/s/a.jsonl", i, 4);
    store.maintain();
    const first = store.query({ sessionPath: "/s/a.jsonl", limit: 10 }).entries[0]!;
    expect(first.detailRef?.released).toBe(true);
    // The identical payload arrives again (same hash) in another session.
    ingest(store, "/s/b.jsonl", 0, 4);
    const again = store.query({ sessionPath: "/s/a.jsonl", limit: 10 }).entries[0]!;
    expect(again.id).toBe(first.id);
    expect(again.detailRef?.released).toBeUndefined();
    expect(store.content(first.detailRef!.ref).text.length).toBeGreaterThan(0);
  });

  it("answers for a released body with the row's summary, not an error", () => {
    const store = open("summary.db", { bodiesPerSession: 2 });
    for (let i = 0; i < 5; i++) ingest(store, "/s/a.jsonl", i, 4);
    store.maintain();

    const oldest = store.query({ limit: 10 }).entries[0]!;
    expect(oldest.detailRef?.released).toBe(true);
    const answer = store.content(oldest.detailRef!.ref);
    expect(answer.text).toBe("");
    expect(answer.released).toMatchObject({
      reason: "session-limit",
      bytes: oldest.detailRef!.bytes,
      summary: oldest.summary,
      model: "claude-sonnet-4-5",
      messages: 1,
      at: oldest.at,
    });
    // The size and the model are the row's own, not a second copy of anything.
    expect(answer.released!.preview.length).toBeGreaterThan(0);
    expect(answer.released!.preview.length).toBeLessThan(answer.released!.bytes);
    expect(oldest.summary).toContain("claude-sonnet-4-5");

    // A ref no row points at any more is still an error: nothing knows it.
    expect(() => store.content("f".repeat(64))).toThrow(/no longer stored/);
  });

  it("never releases a body a retained entry still points at", () => {
    const store = open("shared.db", { bodiesPerSession: 3 });
    const shared = request(7, 4);
    const record = (index: number, payload: unknown) =>
      store.observeExtensionMessage("/project", "/s/a.jsonl", {
        type: "lasercode/provider/request",
        at: new Date(Date.UTC(2026, 8, 13, 0, 0, index)).toISOString(),
        payload,
      });
    record(0, shared); // beyond the limit once four newer ones exist
    for (let i = 1; i <= 3; i++) record(i, request(i, 4));
    record(4, shared); // the same bytes, inside the limit

    store.maintain();
    const rows = store.query({ limit: 10 }).entries;
    const first = rows[0]!;
    const last = rows.at(-1)!;
    expect(first.detailRef!.ref).toBe(last.detailRef!.ref);
    expect(last.detailRef!.released).toBeUndefined();
    // The oldest row's body was released by policy, but the bytes belong to a
    // capture that is still inside it, so they are still there and still served.
    const answer = store.content(first.detailRef!.ref);
    expect(answer.released).toBeUndefined();
    expect(JSON.parse(answer.text)).toMatchObject({ model: "claude-sonnet-4-5" });
  });
});

describe("the space comes back", () => {
  it("shrinks the file itself once the budget has released bodies", () => {
    const budget = 8 * 1024 * 1024;
    const store = open("shrink.db", { bodyBudgetBytes: budget });
    for (let i = 0; i < 40; i++) ingest(store, "/s/a.jsonl", i);
    const grown = store.stats().bytes;
    const grownFile = statSync(join(base, "shrink.db")).size;
    // 40 MiB went in; the file never held it, because ingestion released as it
    // went — but the pages it freed are still in the file until they are given
    // back, which is the thing this test is about.
    expect(grown).toBeLessThan(30 * 1024 * 1024);
    expect(grown).toBeGreaterThan(budget + 4 * 1024 * 1024);

    const { bytes } = store.maintain();
    expect(retained(store)).toBeLessThanOrEqual(budget);
    // Not the row count: the bytes on disk.
    expect(bytes).toBeLessThan(grown - 4 * 1024 * 1024);
    expect(bytes).toBeLessThan(budget + 2 * 1024 * 1024);
    expect(statSync(join(base, "shrink.db")).size).toBeLessThan(grownFile);
    // Everything still retained still opens.
    for (const entry of store.query({ limit: 100 }).entries) {
      if (entry.detailRef && !entry.detailRef.released) expect(store.content(entry.detailRef.ref).text.length).toBeGreaterThan(0);
    }
  });

  it("converts a store written before the budget existed, once, and says so", () => {
    const file = join(base, "legacy.db");
    // A store in the shape this version inherits: WAL, no auto_vacuum, and a
    // pile of bodies no limit ever touched.
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, section TEXT NOT NULL, kind TEXT NOT NULL,
        level TEXT NOT NULL, cwd TEXT, session_path TEXT, summary TEXT NOT NULL, duration_ms INTEGER,
        status INTEGER, correlation_id TEXT, detail TEXT, detail_ref TEXT, detail_bytes INTEGER,
        detail_type TEXT, detail_preview TEXT, search TEXT NOT NULL);
      CREATE TABLE content (ref TEXT PRIMARY KEY, bytes INTEGER NOT NULL, content_type TEXT NOT NULL, body TEXT NOT NULL);
    `);
    const body = (i: number) => JSON.stringify({ model: "legacy-model", messages: [{ role: "user", content: `${i}:${"y".repeat(1024 * 1024)}` }] });
    for (let i = 0; i < 30; i++) {
      const text = body(i);
      const ref = `${i}`.padStart(64, "0");
      legacy.prepare("INSERT INTO content VALUES (?,?,?,?)").run(ref, text.length, "application/json", text);
      legacy
        .prepare(
          `INSERT INTO entries (at, section, kind, level, session_path, summary, detail_ref, detail_bytes, detail_type, detail_preview, search)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(new Date(Date.UTC(2026, 8, 13, 0, 0, i)).toISOString(), "provider", "provider_request", "info", "/s/legacy.jsonl",
          `legacy-model · 1 message · 1.0 MB`, ref, text.length, "application/json", text.slice(0, 240), "legacy");
    }
    expect((legacy.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum).toBe(0);
    legacy.close();
    const before = statSync(file).size;

    const said: string[] = [];
    const store = open("legacy.db", { bodyBudgetBytes: 4 * 1024 * 1024, bodiesPerSession: 2, log: (message) => said.push(message) });
    // Nothing is lost at open: every row is still there, still readable.
    expect(store.query({ limit: 100 }).entries).toHaveLength(30);
    store.maintain();

    const after = statSync(file).size;
    expect(after).toBeLessThan(before / 2);
    expect(said.join("\n")).toMatch(/compacting .* so deleted captures give their space back/);
    expect(said.join("\n")).toMatch(/compacted .* → .* in \d+ ms/);
    // The compaction is a row of its own, so a person can see what happened.
    const note = store.query({ sections: ["host"], limit: 10 }).entries.find((entry) => entry.kind === "logstore_compacted");
    expect(note?.durationMs).toBeGreaterThanOrEqual(0);
    // One conversion per process: a second pass does not rewrite the file again.
    said.length = 0;
    store.maintain();
    expect(said).toEqual([]);
  });

  it("gives the disk back when a person clears the store", () => {
    const store = open("clear.db", { bodyBudgetBytes: 64 * 1024 * 1024 });
    for (let i = 0; i < 20; i++) ingest(store, "/s/a.jsonl", i);
    const grown = store.stats().bytes;
    expect(store.clear()).toBe(20);
    const stats = store.stats();
    expect(stats.total).toBe(0);
    expect(stats.retention.retainedBodyBytes).toBe(0);
    expect(stats.bytes).toBeLessThan(grown / 4);
  });
});

describe("through the host", () => {
  it("answers pi/logs/content for a released body with the summary, not an error", async () => {
    const root = join(base, "host");
    const host = new HostServer({
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      stateDir: join(root, "state"),
      logRetention: { bodiesPerSession: 1, bodyBudgetBytes: 64 * 1024 * 1024 },
    });
    try {
      const ingress = host as unknown as { observe(cwd: string, n: unknown): void };
      for (let i = 0; i < 3; i++) {
        ingress.observe(root, {
          jsonrpc: "2.0",
          method: "pi/extension/message",
          params: {
            path: "/s/held.jsonl",
            message: { type: `${WIRE_NAMESPACE}/provider/request`, at: new Date(Date.UTC(2026, 8, 13, 0, 0, i)).toISOString(), payload: request(i, 8) },
          },
        });
      }
      // The release is the timer's job, exactly as it is in the running host.
      await expect
        .poll(async () => {
          const page = await host.router.handle({ jsonrpc: "2.0", id: 1, method: "pi/logs/query", params: { kind: "provider_request", sessionPath: "/s/held.jsonl" } });
          return (page.result as LogPage).entries[0]?.detailRef?.released === true;
        })
        .toBe(true);

      const page = await host.router.handle({ jsonrpc: "2.0", id: 2, method: "pi/logs/query", params: { kind: "provider_request", sessionPath: "/s/held.jsonl" } });
      const [oldest, , newest] = (page.result as LogPage).entries;
      const answer = await host.router.handle({ jsonrpc: "2.0", id: 3, method: "pi/logs/content", params: { ref: oldest!.detailRef!.ref } });
      expect(answer.error).toBeUndefined();
      const result = answer.result as ClientRequests["pi/logs/content"]["result"];
      expect(result.text).toBe("");
      expect(result.released).toMatchObject({ reason: "session-limit", summary: oldest!.summary, model: "claude-sonnet-4-5" });

      // The newest request in the session is still there in full.
      const kept = await host.router.handle({ jsonrpc: "2.0", id: 4, method: "pi/logs/content", params: { ref: newest!.detailRef!.ref } });
      const keptResult = kept.result as ClientRequests["pi/logs/content"]["result"];
      expect(keptResult.released).toBeUndefined();
      expect(JSON.parse(keptResult.text)).toMatchObject({ model: "claude-sonnet-4-5" });

      const stats = await host.router.handle({ jsonrpc: "2.0", id: 5, method: "pi/logs/stats", params: {} });
      expect((stats.result as { stats: { retention: { bodiesPerSession?: number } } }).stats.retention.bodiesPerSession).toBe(1);
    } finally {
      await host.close();
    }
  }, 20_000);
});

describe("what stats says", () => {
  it("reports the policy and what it is holding, so Settings can show it", () => {
    const store = open("stats.db", { bodyBudgetBytes: 32 * 1024 * 1024, bodiesPerSession: 12 });
    ingest(store, "/s/a.jsonl", 1, 8);
    const { retention, bytes } = store.stats();
    expect(retention).toMatchObject({ maxRows: 200_000, maxAgeDays: 14, bodyBudgetBytes: 32 * 1024 * 1024, bodiesPerSession: 12 });
    expect(retention.retainedBodyBytes).toBeGreaterThan(8 * 1024);
    expect(bytes).toBeGreaterThan(0);
  });

  it("reads a message count out of the line the row already had", () => {
    expect(summaryMessageCount("claude-sonnet-4-5 · 2 messages · 3 tools · stream · 81 B")).toBe(2);
    expect(summaryMessageCount("gpt-5 · 1 message · thinking · 40 B")).toBe(1);
    expect(summaryMessageCount("provider request · 12 B")).toBeUndefined();
    expect(summaryMessageCount("bash finished · 3000 ms")).toBeUndefined();
  });
});

describe("summaryModel", () => {
  it("never mistakes a count or the stream marker for a model", () => {
    expect(summaryModel("claude-sonnet-4-5 · 3 messages · 1.2 kB")).toBe("claude-sonnet-4-5");
    expect(summaryModel("3 messages · 1.2 kB")).toBeUndefined();
    expect(summaryModel("2 tools · 1.2 kB")).toBeUndefined();
    expect(summaryModel("stream · 1.2 kB")).toBeUndefined();
    expect(summaryModel("provider request")).toBeUndefined();
    expect(summaryModel("1.2 kB")).toBeUndefined();
  });
});
