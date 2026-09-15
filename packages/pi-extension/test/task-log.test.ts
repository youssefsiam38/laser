/**
 * The bounded window a command writes into (RP-6).
 *
 * The rules under test are the ones that make a log safe to keep: it never
 * grows past its window however long the command runs, the exact size and
 * digest of everything produced survive whatever was released, and releasing
 * bytes is the owner's own act — never a guess about somebody else's file.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

it("keeps everything while it fits, with an exact count and digest", async () => {
  const log = new TaskLog({ dir: scratch(), id: "t-1", segmentBytes: 1024 });
  log.append(Buffer.from("hello "));
  log.append(Buffer.from("world"));
  log.close();
  await log.drained();
  expect(log.bytes).toBe(11);
  expect(log.state).toBe("retained");
  expect(log.retainedFromByte).toBe(0);
  expect(log.digest()).toBe(createHash("sha256").update("hello world").digest("hex"));
  expect(log.readTail(1024)?.toString("utf8")).toBe("hello world");
});

it("bounds a command that never stops printing, and says the head is gone", async () => {
  const log = new TaskLog({ dir: scratch(), id: "t-2", segmentBytes: 1024 });
  const expected = createHash("sha256");
  for (let index = 0; index < 100; index++) {
    const piece = chunk(String.fromCharCode(97 + (index % 26)), 1000);
    expected.update(piece);
    log.append(piece);
  }
  await log.drained();
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

it("releases its own bytes on request, oldest half first, and keeps the facts", async () => {
  const dir = scratch();
  const log = new TaskLog({ dir, id: "t-3", segmentBytes: 1024 });
  for (let index = 0; index < 4; index++) log.append(chunk("x", 900));
  await log.drained();
  const produced = () => log.bytes;
  const digest = () => log.digest();
  expect(existsSync(join(dir, "t-3.log.prev"))).toBe(true);

  const freedHalf = log.releaseOldest();
  expect(freedHalf).toBeGreaterThan(0);
  expect(existsSync(join(dir, "t-3.log.prev"))).toBe(false);
  expect(log.state).toBe("truncated");
  expect(log.usable).toBe(true);

  log.append(chunk("y", 500));
  await log.drained();
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

it("counts and digests even when the file cannot be written", async () => {
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

it("survives its file being deleted underneath it", async () => {
  const dir = scratch();
  const log = new TaskLog({ dir, id: "t-5", segmentBytes: 1024 });
  log.append(Buffer.from("before"));
  await log.drained();
  rmSync(join(dir, "t-5.log"));
  expect(log.readTail(100)).toBeUndefined();
  log.append(Buffer.from("after"));
  await log.drained();
  expect(log.bytes).toBe(11);
  log.close();
});

it("writes what it says it wrote", async () => {
  const dir = scratch();
  const log = new TaskLog({ dir, id: "t-6", segmentBytes: 1 << 20 });
  log.append(Buffer.from("one\n"));
  log.append(Buffer.from("two\n"));
  log.close();
  await log.drained();
  expect(readFileSync(join(dir, "t-6.log"), "utf8")).toBe("one\ntwo\n");
  expect(statSync(join(dir, "t-6.log")).size).toBe(log.diskBytes);
});

it("never blocks the command: a stalled disk bounds the queue, then the body goes and the facts stay", async () => {
  const dir = scratch();
  let release: (() => void) | undefined;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const log = new TaskLog({
    dir,
    id: "t-stall",
    segmentBytes: 64 * 1024,
    queueBytes: 32 * 1024,
    write: async () => {
      await stalled;
    },
  });
  const expected = createHash("sha256");
  // Far more than the queue may hold, appended without ever awaiting: this is
  // the command's own `onData` path, and it must keep advancing.
  const started = Date.now();
  for (let index = 0; index < 200; index++) {
    const piece = chunk("q", 4096);
    expected.update(piece);
    log.append(piece);
    expect(log.pendingBytes).toBeLessThanOrEqual(32 * 1024);
  }
  expect(Date.now() - started).toBeLessThan(2000);
  // The body was abandoned rather than either growing this process or waiting
  // for the disk, and it says so.
  expect(log.state).toBe("released");
  expect(log.bytes).toBe(200 * 4096);
  expect(log.digest()).toBe(expected.digest("hex"));
  expect(log.pendingBytes).toBe(0);
  expect(log.diskBytes).toBe(0);
  expect(log.readTail(1024)).toBeUndefined();
  // Output after the release is still counted exactly.
  log.append(chunk("r", 10));
  expect(log.bytes).toBe(200 * 4096 + 10);
  // Nothing is left behind once the stalled write returns.
  release?.();
  log.close();
  await log.drained();
  expect(existsSync(join(dir, "t-stall.log"))).toBe(false);
  expect(existsSync(join(dir, "t-stall.log.prev"))).toBe(false);
});

it("splits one adversarial chunk across segments instead of overrunning the window", async () => {
  const dir = scratch();
  const log = new TaskLog({ dir, id: "t-huge", segmentBytes: 64 * 1024, queueBytes: 8 * 1024 * 1024 });
  // One append far larger than a segment, and larger than two of them.
  log.append(chunk("h", 1024 * 1024));
  await log.drained();
  expect(log.bytes).toBe(1024 * 1024);
  expect(log.diskBytes).toBeLessThanOrEqual(2 * 64 * 1024);
  expect(statSync(join(dir, "t-huge.log")).size).toBeLessThanOrEqual(64 * 1024);
  expect(statSync(join(dir, "t-huge.log.prev")).size).toBeLessThanOrEqual(64 * 1024);
  expect(log.state).toBe("truncated");
  expect(log.retainedFromByte).toBe(log.bytes - log.diskBytes);
});

it("creates private files in a private directory, and refuses a symlink in their place", async () => {
  const dir = join(scratch(), "logs");
  const log = new TaskLog({ dir, id: "t-mode", segmentBytes: 1024 });
  log.append(Buffer.from("private"));
  await log.drained();
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, "t-mode.log")).mode & 0o777).toBe(0o600);
  log.close();

  // A log path somebody replaced with a symlink is not written through.
  const target = join(scratch(), "victim");
  writeFileSync(target, "untouched");
  symlinkSync(target, join(dir, "t-evil.log"));
  const hostile = new TaskLog({ dir, id: "t-evil", segmentBytes: 1024 });
  hostile.append(Buffer.from("attack"));
  await hostile.drained();
  expect(hostile.state).toBe("released");
  expect(hostile.bytes).toBe(6);
  expect(readFileSync(target, "utf8")).toBe("untouched");
  expect(lstatSync(join(dir, "t-evil.log")).isSymbolicLink()).toBe(true);
});
