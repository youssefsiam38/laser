import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, type ReadStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionSummary } from "@lasercode/protocol";
import { searchSessions } from "../src/session-search.js";
import { SearchCancellation } from "../src/search-cancellation.js";

const observed = vi.hoisted(() => ({ streams: [] as ReadStream[], onOpen: undefined as ((stream: ReadStream) => void) | undefined }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, createReadStream: (...args: Parameters<typeof fs.createReadStream>) => {
    const stream = fs.createReadStream(...args);
    observed.streams.push(stream); observed.onOpen?.(stream); return stream;
  } };
});
let root: string | undefined;
afterEach(() => { observed.onOpen = undefined; observed.streams.length = 0; if (root) rmSync(root, { recursive: true, force: true }); });
it("closes a huge real read on cancellation without returning partial hits/unreadable counts", async () => {
  root = mkdtempSync(join(tmpdir(), "cancel-search-"));
  const path = join(root, "huge.jsonl");
  const line = JSON.stringify({ type: "message", message: { role: "user", content: "needle " + "x".repeat(1000) } }) + "\n";
  const body = line.repeat(16_000); writeFileSync(path, body);
  const sessions = [{ path } as SessionSummary];
  const baseline = await searchSessions(sessions, "needle");
  expect(baseline.hits[0]?.count).toBe(16_000);
  const beforeBytes = observed.streams[0]!.bytesRead;
  const abort = new AbortController();
  observed.onOpen = stream => stream.once("data", () => setImmediate(() => abort.abort()));
  await expect(searchSessions(sessions, "needle", 0, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  const stream = observed.streams[1]!;
  await expect.poll(() => stream.closed).toBe(true);
  expect(stream.bytesRead).toBeLessThan(body.length / 10);
  console.log(JSON.stringify({ finding: "F07", beforeBytes, afterBytes: stream.bytesRead }));
  const preCancelled = new AbortController(); preCancelled.abort();
  await expect(searchSessions(sessions, "needle", 0, preCancelled.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(observed.streams).toHaveLength(2);
});
it("isolates connections, supersedes named reads and fences late completion and disconnect", () => {
  const first = new SearchCancellation(), second = new SearchCancellation();
  const old = first.begin("same"), other = second.begin("same");
  const next = first.begin("same"); expect(old.signal.aborted).toBe(true); old.finish();
  expect(next.signal.aborted).toBe(false); expect(other.signal.aborted).toBe(false);
  first.cancel("same"); expect(next.signal.aborted).toBe(true); expect(other.signal.aborted).toBe(false);
  second.close(); expect(other.signal.aborted).toBe(true);
  expect(second.begin("late").signal.aborted).toBe(true);
});
