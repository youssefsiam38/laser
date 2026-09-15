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
  // The queue went with the body; only the slice the platform is still holding
  // remains counted, and it is bounded by one write.
  expect(log.pendingBytes).toBeLessThanOrEqual(32 * 1024);
  expect(log.diskBytes).toBe(0);
  expect(log.readTail(1024)).toBeUndefined();
  // Output after the release is still counted exactly.
  log.append(chunk("r", 10));
  expect(log.bytes).toBe(200 * 4096 + 10);
  // Nothing is left behind once the stalled write returns.
  release?.();
  log.close();
  await log.drained();
  expect(log.pendingBytes).toBe(0);
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

it("counts the slice the platform is still holding, and never closes the descriptor under it", async () => {
  const dir = scratch();
  const settle: Array<() => void> = [];
  const log = new TaskLog({
    dir,
    id: "t-inflight",
    segmentBytes: 1024 * 1024,
    queueBytes: 64 * 1024,
    write: () => new Promise<void>((resolve) => settle.push(resolve)),
  });
  // One append leaves the queue; the drain hands it to the platform and waits.
  log.append(chunk("a", 16 * 1024));
  await Promise.resolve();
  expect(settle).toHaveLength(1);
  // The bytes are still in this process, so they are still counted: a bound
  // checked against the queue alone would have let another 64 KiB in.
  expect(log.pendingBytes).toBe(16 * 1024);
  log.append(chunk("b", 40 * 1024));
  expect(log.pendingBytes).toBe(56 * 1024);
  // The next append would put total pending past the bound, so the body goes.
  log.append(chunk("c", 16 * 1024));
  expect(log.state).toBe("released");
  expect(log.bytes).toBe(72 * 1024);

  // The write is still in flight: nothing has been closed or unlinked yet, and
  // `drained()` has not resolved either.
  expect(existsSync(join(dir, "t-inflight.log"))).toBe(true);
  let drained = false;
  void log.drained().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(drained).toBe(false);

  // It settles: only now is the descriptor closed and the file removed.
  settle[0]!();
  await log.drained();
  expect(drained).toBe(true);
  expect(existsSync(join(dir, "t-inflight.log"))).toBe(false);
  expect(log.pendingBytes).toBe(0);
  expect(log.diskBytes).toBe(0);
});

it("writes nothing to a descriptor it no longer owns after an abandonment", async () => {
  const dir = scratch();
  const seen: number[] = [];
  const settle: Array<() => void> = [];
  const log = new TaskLog({
    dir,
    id: "t-fd",
    segmentBytes: 4096,
    queueBytes: 1024 * 1024,
    write: (fd) => {
      seen.push(fd);
      return new Promise<void>((resolve) => settle.push(resolve));
    },
  });
  log.append(chunk("a", 2048));
  await Promise.resolve();
  const released = log.release();
  expect(released).toBe(0); // nothing had reached the disk yet
  log.append(chunk("b", 2048));
  settle[0]!();
  await log.drained();
  // Exactly one write was ever issued, on the descriptor that existed when it
  // was issued: the release did not close that descriptor underneath it, and
  // nothing was written after the body was abandoned.
  expect(seen).toHaveLength(1);
  expect(settle).toHaveLength(1);
  expect(log.state).toBe("released");
  expect(log.bytes).toBe(4096);
  expect(existsSync(join(dir, "t-fd.log"))).toBe(false);
});
