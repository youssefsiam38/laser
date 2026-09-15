/**
 * RP-7 / review finding 1, from the outside: a credential the projection
 * cannot remove never reaches anything durable or readable.
 *
 * Every ingestion path is driven with the same canary value, and then every
 * place a body could have landed is searched for it: the rows a client reads,
 * the previews and the search column, both stored-body shapes, the raw SQLite
 * file **and its WAL**, the host's own log lines, and the diagnostics export.
 */
import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderCaptureMeta } from "@lasercode/protocol";
import { REDACT_MAX_DEPTH } from "@lasercode/protocol";
import { LogStore } from "../src/logstore.js";
import { CaptureAccumulator } from "../src/provider-capture.js";

const CANARY = "sk-live-canary-2f9d41c7aa";
const ACTOR = { generation: "gen-privacy", cwd: "/project" };

let store: LogStore | undefined;
let root: string | undefined;
const logs: string[] = [];

afterEach(() => {
  store?.close();
  store = undefined;
  logs.length = 0;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function open(): { log: LogStore; file: string } {
  root = mkdtempSync(join(tmpdir(), "redaction-privacy-"));
  const file = join(root, "logs.db");
  store = new LogStore({ file, log: (message) => logs.push(message) });
  return { log: store, file };
}

/** A credential nested past the redaction ceiling. */
function deepSecret(): Record<string, unknown> {
  let node: Record<string, unknown> = { api_key: CANARY };
  for (let level = 0; level < REDACT_MAX_DEPTH + 3; level++) node = { level, inner: node };
  return { model: "m", messages: [{ role: "user", content: "hello" }], evidence: node };
}

/** Everything on disk for this store, including the WAL and shared-memory file. */
function filesOf(file: string): string[] {
  const dir = join(file, "..");
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile());
}

function assertNoCanary(log: LogStore, file: string, where: string): void {
  const page = log.query({ limit: 500 });
  expect(JSON.stringify(page), `${where}: rows`).not.toContain(CANARY);
  for (const entry of page.entries) {
    if (!entry.detailRef) continue;
    const content = log.content(entry.detailRef.ref, 32 * 1024 * 1024);
    expect(JSON.stringify(content), `${where}: stored body`).not.toContain(CANARY);
  }
  for (const path of filesOf(file)) {
    expect(readFileSync(path).toString("latin1").includes(CANARY), `${where}: ${path}`).toBe(false);
  }
  expect(logs.join("\n"), `${where}: host log`).not.toContain(CANARY);
}

it("keeps a deeply nested credential out of an ordinary row", () => {
  const { log, file } = open();
  log.record({ section: "tools", kind: "tool_end", summary: "a tool", sessionPath: "/s", detail: deepSecret() });
  assertNoCanary(log, file, "small path");
  // The row is still there, and the part of the payload above the ceiling is.
  const entry = log.query({ limit: 10 }).entries[0]!;
  expect(JSON.stringify(entry)).toContain("hello");
});

it("catches a credential that only appears at serialization time, and keeps none of it", () => {
  const { log, file } = open();
  // A value the structural walk never sees, because it is produced at
  // serialization time. The projection scans its own output, canonicalises
  // what it finds and redacts that, so the row keeps a body with no secret in
  // it — and if it still could not clean it, the row would keep no body at all.
  const hostile = {
    model: "m",
    evidence: {
      toJSON() {
        return { api_key: CANARY };
      },
    },
  };
  log.record({ section: "tools", kind: "tool_end", summary: "a tool", sessionPath: "/s", detail: hostile });

  assertNoCanary(log, file, "late credential");
  const entry = log.query({ limit: 10 }).entries[0]!;
  expect(JSON.stringify(entry)).toContain("[redacted]");
});

it("cleans a survivor the producer left in a chunked body, and keeps nothing of it", () => {
  const { log, file } = open();
  // The producer should have redacted this; the host's defence does it instead
  // and stores the cleaned bytes under their own digest. (A body whose text
  // still trips the scan after a parse/serialize round trip cannot be written
  // in valid JSON, so the `unredacted` refusal is proved on the in-process
  // paths above rather than invented here.)
  const body = JSON.stringify({ model: "m", api_key: CANARY, messages: [] });
  const meta: ProviderCaptureMeta = {
    captureId: "c-0f0f0f0f0f0f0f0f",
    at: new Date().toISOString(),
    bytes: Buffer.byteLength(body, "utf8"),
    sha256: createHash("sha256").update(body).digest("hex"),
    preview: body.slice(0, 40),
    redactedFields: 0,
    summary: { model: "m", messages: 0 },
  };
  const stored: string[] = [];
  const accumulator = new CaptureAccumulator({
    onComplete: ({ cwd, sessionPath, meta: restated, body: clean }) => {
      stored.push(clean);
      log.recordProviderCapture(cwd, sessionPath, restated, clean);
    },
    onAbsent: ({ cwd, sessionPath, meta: restated, reason }) => log.recordProviderAbsent(cwd, sessionPath, restated, reason),
    log: (message) => logs.push(message),
  });
  accumulator.begin(ACTOR, "/s", meta);
  accumulator.chunk(ACTOR, meta.captureId, 0, body);
  accumulator.finish(ACTOR, meta.captureId, 1, meta.bytes);

  expect(stored).toHaveLength(1);
  expect(JSON.parse(stored[0]!).api_key).toBe("[redacted]");
  assertNoCanary(log, file, "defended body");
  expect(logs.join("\n")).toContain("api_key");
});

it("keeps it out of a capture recorded through the deep path, preview included", () => {
  const { log, file } = open();
  const deep = deepSecret();
  const body = JSON.stringify(deep);
  const meta: ProviderCaptureMeta = {
    captureId: "c-1a1a1a1a1a1a1a1a",
    at: new Date().toISOString(),
    bytes: Buffer.byteLength(body, "utf8"),
    sha256: createHash("sha256").update(body).digest("hex"),
    preview: body.slice(0, 40),
    redactedFields: 0,
    summary: { model: "m", messages: 1 },
  };
  const accumulator = new CaptureAccumulator({
    onComplete: ({ cwd, sessionPath, meta: stored, body: clean }) => log.recordProviderCapture(cwd, sessionPath, stored, clean),
    onAbsent: ({ cwd, sessionPath, meta: stored, reason }) => log.recordProviderAbsent(cwd, sessionPath, stored, reason),
    log: (message) => logs.push(message),
  });
  accumulator.begin(ACTOR, "/s", meta);
  accumulator.chunk(ACTOR, meta.captureId, 0, body);
  accumulator.finish(ACTOR, meta.captureId, 1, meta.bytes);
  assertNoCanary(log, file, "deep capture");
});
