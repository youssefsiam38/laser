/**
 * The bounded window a command writes into (RP-6).
 *
 * The rules under test are the ones that make a log safe to keep: it never
 * grows past its window however long the command runs, the exact size and
 * digest of everything produced survive whatever was released, and releasing
 * bytes is the owner's own act — never a guess about somebody else's file.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TaskLog } from "../src/modules/task-log.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "task-log-"));
  dirs.push(dir);
  return dir;
}

const chunk = (byte: string, size: number): Buffer => Buffer.alloc(size, byte);

it("keeps everything while it fits, with an exact count and digest", () => {
  const log = new TaskLog({ dir: scratch(), id: "t-1", segmentBytes: 1024 });
  log.append(Buffer.from("hello "));
  log.append(Buffer.from("world"));
  log.close();
  expect(log.bytes).toBe(11);
  expect(log.state).toBe("retained");
  expect(log.retainedFromByte).toBe(0);
  expect(log.digest()).toBe(createHash("sha256").update("hello world").digest("hex"));
  expect(log.readTail(1024)?.toString("utf8")).toBe("hello world");
});

it("bounds a command that never stops printing, and says the head is gone", () => {
  const log = new TaskLog({ dir: scratch(), id: "t-2", segmentBytes: 1024 });
  const expected = createHash("sha256");
  for (let index = 0; index < 100; index++) {
    const piece = chunk(String.fromCharCode(97 + (index % 26)), 1000);
    expected.update(piece);
    log.append(piece);
  }
  // A hundred kilobytes produced; at most two segments retained.
  expect(log.bytes).toBe(100_000);
  expect(log.diskBytes).toBeLessThanOrEqual(2048 + 1000);
  expect(log.state).toBe("truncated");
  expect(log.retainedFromByte).toBeGreaterThan(0);
  expect(log.digest()).toBe(expected.digest("hex"));
  const tail = log.readTail(4096)!;
  // What is retained is the *end* of the stream, contiguous with it.
  expect(tail.length).toBe(log.bytes - log.retainedFromByte);
  expect(tail.subarray(-10).toString("utf8")).toBe("v".repeat(10));
  log.close();
});

it("releases its own bytes on request, oldest half first, and keeps the facts", () => {
  const dir = scratch();
  const log = new TaskLog({ dir, id: "t-3", segmentBytes: 1024 });
  for (let index = 0; index < 4; index++) log.append(chunk("x", 900));
  const produced = () => log.bytes;
  const digest = () => log.digest();
  expect(existsSync(join(dir, "t-3.log.prev"))).toBe(true);

  const freedHalf = log.releaseOldest();
  expect(freedHalf).toBeGreaterThan(0);
  expect(existsSync(join(dir, "t-3.log.prev"))).toBe(false);
  expect(log.state).toBe("truncated");
  expect(log.usable).toBe(true);

  log.append(chunk("y", 500));
  const freedRest = log.release();
  expect(freedRest).toBeGreaterThan(0);
  expect(existsSync(join(dir, "t-3.log"))).toBe(false);
  expect(log.state).toBe("released");
  expect(log.usable).toBe(false);
  expect(log.readTail(1024)).toBeUndefined();
  // Released bytes, kept facts.
  expect(log.bytes).toBe(4 * 900 + 500);
  expect(log.digest()).toBe(digest());
  expect(log.retainedFromByte).toBe(produced());
});

it("counts and digests even when the file cannot be written", () => {
  const dir = scratch();
  // A directory where the log file's name already exists as a directory: the
  // open fails, and the command must not notice.
  const log = new TaskLog({ dir: join(dir, "missing", "\0bad"), id: "t-4" });
  log.append(Buffer.from("output"));
  expect(log.bytes).toBe(6);
  expect(log.digest()).toBe(createHash("sha256").update("output").digest("hex"));
  expect(log.state).toBe("released");
  expect(log.readTail(10)).toBeUndefined();
});

it("survives its file being deleted underneath it", () => {
  const dir = scratch();
  const log = new TaskLog({ dir, id: "t-5", segmentBytes: 1024 });
  log.append(Buffer.from("before"));
  rmSync(join(dir, "t-5.log"));
  expect(log.readTail(100)).toBeUndefined();
  log.append(Buffer.from("after"));
  expect(log.bytes).toBe(11);
  log.close();
});

it("writes what it says it wrote", () => {
  const dir = scratch();
  const log = new TaskLog({ dir, id: "t-6", segmentBytes: 1 << 20 });
  log.append(Buffer.from("one\n"));
  log.append(Buffer.from("two\n"));
  log.close();
  expect(readFileSync(join(dir, "t-6.log"), "utf8")).toBe("one\ntwo\n");
  expect(statSync(join(dir, "t-6.log")).size).toBe(log.diskBytes);
});
