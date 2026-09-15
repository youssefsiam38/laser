/**
 * RP-7: a large request body is stored in bounded pieces, read in bounded
 * pieces, released with its pieces, and recorded honestly when it is not
 * stored at all.
 */
import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderCaptureMeta } from "@lasercode/protocol";
import { LogStore } from "../src/logstore.js";

let store: LogStore | undefined;
let root: string | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function open(options: { bodyBudgetBytes?: number; bodiesPerSession?: number } = {}): LogStore {
  root = mkdtempSync(join(tmpdir(), "logstore-chunked-"));
  store = new LogStore({ file: join(root, "logs.db"), ...options });
  return store;
}

function metaFor(body: string, captureId = "c-0123456789abcdef"): ProviderCaptureMeta {
  return {
    captureId,
    at: new Date().toISOString(),
    bytes: Buffer.byteLength(body, "utf8"),
    sha256: createHash("sha256").update(body).digest("hex"),
    preview: body.slice(0, 40),
    redactedFields: 0,
    summary: { model: "claude", messages: 3, tools: 2 },
  };
}

/** A body comfortably past the chunking threshold, and not compressible-looking. */
function largeBody(megabytes = 3): string {
  return JSON.stringify({ model: "claude", messages: [{ role: "user", content: "日本語x".repeat((megabytes * 1024 * 1024) / 10) }] });
}

it("stores a large body in chunks and reads it back exactly", () => {
  const log = open();
  const body = largeBody();
  const meta = metaFor(body);
  log.recordProviderCapture("/project", "/session", meta, body);

  const entry = log.query({ kind: "provider_request" }).entries[0]!;
  expect(entry.detailRef?.ref).toBe(meta.sha256);
  expect(entry.detailRef?.bytes).toBe(meta.bytes);
  expect(entry.summary).toContain("claude");
  const content = log.content(meta.sha256, 32 * 1024 * 1024);
  expect(content.truncated).toBe(false);
  expect(content.text).toBe(body);
  expect(content.bytes).toBe(meta.bytes);
});

it("reads at most the budget asked for, plus nothing else", () => {
  const log = open();
  const body = largeBody();
  const meta = metaFor(body);
  log.recordProviderCapture("/project", "/session", meta, body);

  const content = log.content(meta.sha256, 512 * 1024);
  expect(content.truncated).toBe(true);
  expect(Buffer.byteLength(content.text, "utf8")).toBeLessThanOrEqual(512 * 1024);
  expect(content.truncatedAt).toBe(Buffer.byteLength(content.text, "utf8"));
  // The row still reports the stored size, so the reader knows what is missing.
  expect(content.bytes).toBe(meta.bytes);
  // Cut on a UTF-8 boundary, so the text never arrives with a replacement.
  expect(content.text).not.toContain("\ufffd");
  expect(body.startsWith(content.text)).toBe(true);
});

it("steps only the chunks a small budget needs, never the whole body", () => {
  const log = open();
  const body = largeBody(4);
  const meta = metaFor(body);
  log.recordProviderCapture("/project", "/session", meta, body);

  // Count what the read actually pulls out of SQLite. `all()` would hand back
  // every 256 KiB chunk before the loop that is supposed to stop early.
  const db = (log as unknown as {
    db: { prepare(sql: string): { iterate(...params: unknown[]): IterableIterator<unknown> } };
    statements: Map<string, unknown>;
  });
  const realPrepare = db.db.prepare.bind(db.db);
  let stepped = 0;
  db.statements.clear();
  db.db.prepare = (sql: string) => {
    const statement = realPrepare(sql);
    if (!sql.includes("content_chunks")) return statement;
    return {
      iterate: (...params: unknown[]) => {
        const rows = statement.iterate(...params);
        return (function* counted() {
          for (const row of rows) {
            stepped += 1;
            yield row;
          }
        })();
      },
    } as never;
  };

  const read = log.content(meta.sha256, 512 * 1024);
  db.db.prepare = realPrepare;
  db.statements.clear();
  expect(read.truncated).toBe(true);
  expect(Buffer.byteLength(read.text, "utf8")).toBeLessThanOrEqual(512 * 1024);
  // 512 KiB of budget is two 256 KiB chunks, plus the one that crosses it.
  expect(stepped).toBeLessThanOrEqual(3);
  const total = (log as unknown as { db: { prepare(sql: string): { get(...p: unknown[]): unknown } } }).db
    .prepare("SELECT COUNT(*) AS n FROM content_chunks WHERE ref = ?")
    .get(meta.sha256) as { n: number };
  expect(Number(total.n)).toBeGreaterThan(8);
});

it("reports a gap inside the part it must trust, rather than stitching it together", () => {
  const log = open();
  const body = largeBody(3);
  const meta = metaFor(body);
  log.recordProviderCapture("/project", "/session", meta, body);
  // Remove a chunk inside the first megabyte: a small-budget read has to cross
  // it, and must not hand back a body with a hole in it.
  (log as unknown as { db: { exec(sql: string): void } }).db.exec(`DELETE FROM content_chunks WHERE ref = '${meta.sha256}' AND idx = 1`);
  const read = log.content(meta.sha256, 1024 * 1024);
  expect(read.text).toBe("");
  expect(read.released).toMatchObject({ reason: "corrupt", bytes: meta.bytes, sha256: meta.sha256 });
});

it("reads the prefix it was asked for even when a later chunk is missing", () => {
  const log = open();
  const body = largeBody(3);
  const meta = metaFor(body);
  log.recordProviderCapture("/project", "/session", meta, body);
  const last = (log as unknown as { db: { prepare(sql: string): { get(...p: unknown[]): unknown } } }).db
    .prepare("SELECT MAX(idx) AS n FROM content_chunks WHERE ref = ?")
    .get(meta.sha256) as { n: number };
  (log as unknown as { db: { exec(sql: string): void } }).db.exec(
    `DELETE FROM content_chunks WHERE ref = '${meta.sha256}' AND idx = ${Number(last.n)}`,
  );
  // The budget stops well before the damage, so this read is complete and
  // truthful about being partial; nothing later is read at all.
  const read = log.content(meta.sha256, 256 * 1024);
  expect(read.truncated).toBe(true);
  expect(body.startsWith(read.text)).toBe(true);
  expect(read.released).toBeUndefined();
});

it("releases a chunked body and its pieces together, and says why", () => {
  const log = open({ bodyBudgetBytes: 1 });
  const body = largeBody();
  const meta = metaFor(body);
  log.recordProviderCapture("/project", "/session", meta, body);
  log.maintain();

  const content = log.content(meta.sha256);
  expect(content.released?.reason).toBe("budget");
  expect(content.released?.bytes).toBe(meta.bytes);
  expect(content.released?.sha256).toBe(meta.sha256);
  expect(content.text).toBe("");
  // Nothing of the body is left behind: no retained bytes, and no orphan pieces.
  expect(log.stats().retention.retainedBodyBytes).toBe(0);
  const chunks = (log as unknown as { db: { prepare(sql: string): { get(): unknown } } }).db
    .prepare("SELECT COUNT(*) AS n FROM content_chunks")
    .get() as { n: number };
  expect(Number(chunks.n)).toBe(0);
});

it("records a capture with no body, with its exact size, digest and reason", () => {
  const log = open();
  const body = largeBody();
  const meta = metaFor(body);
  log.recordProviderAbsent("/project", "/session", meta, "over-ceiling");

  const entry = log.query({ kind: "provider_request" }).entries[0]!;
  expect(entry.detailRef?.ref).toBe(meta.sha256);
  const content = log.content(meta.sha256);
  expect(content.released).toMatchObject({ reason: "over-ceiling", bytes: meta.bytes, sha256: meta.sha256 });
  expect(content.released?.preview).toBe(meta.preview);
  expect(content.released?.model).toBe("claude");
});

it("does not claim a body is missing when the same bytes are already stored", () => {
  const log = open();
  const body = largeBody();
  const meta = metaFor(body);
  log.recordProviderCapture("/project", "/session", meta, body);
  // The same conversation, captured again while the link was busy: content is
  // shared by digest, so this row opens too rather than lying about it.
  log.recordProviderAbsent("/project", "/session", { ...metaFor(body, "c-1111111111111111") }, "link-busy");
  const content = log.content(meta.sha256, 32 * 1024 * 1024);
  expect(content.released).toBeUndefined();
  expect(content.text).toBe(body);
});

it("keeps small bodies on the single-row path", () => {
  const log = open();
  const body = JSON.stringify({ model: "claude", messages: [{ role: "user", content: "hello" }] });
  const meta = metaFor(body);
  log.recordProviderCapture("/project", "/session", meta, body);
  expect(log.content(meta.sha256).text).toBe(body);
});

it("survives a store whose chunks are gone, without inventing a short body", () => {
  const log = open();
  const body = largeBody();
  const meta = metaFor(body);
  log.recordProviderCapture("/project", "/session", meta, body);
  // Damage of exactly the kind an interrupted write would leave.
  (log as unknown as { db: { exec(sql: string): void } }).db.exec("DELETE FROM content_chunks");
  const content = log.content(meta.sha256);
  expect(content.text).toBe("");
  expect(content.released).toMatchObject({ reason: "corrupt", bytes: meta.bytes, sha256: meta.sha256 });
});

it("upgrades an existing store in place", () => {
  const log = open();
  const body = JSON.stringify({ model: "claude", messages: [] });
  log.record({ section: "provider", kind: "provider_request", summary: "old", detail: { body: body.repeat(200) } });
  const ref = log.query({ kind: "provider_request" }).entries[0]!.detailRef!.ref;
  log.close();
  // Reopening the same file runs the migration again; the old row still reads.
  store = new LogStore({ file: join(root!, "logs.db") });
  expect(store.content(ref).text.length).toBeGreaterThan(0);
});
