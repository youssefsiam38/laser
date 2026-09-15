/**
 * The bounded window a command writes into (RP-6).
 *
 * The rules under test are the ones that make a log safe to keep: it never
 * grows past its window however long the command runs, every segment is
 * immutable and says where it starts, the exact size and digest of everything
 * produced survive whatever was released, the command is never held up by
 * storage, and a failure leaves nothing on disk that nothing is accounting for.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TaskLog, segmentName, segmentOffset } from "../src/modules/task-log.js";

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
const segments = (dir: string, id: string): Array<{ from: number; size: number }> =>
  readdirSync(dir)
    .map((name) => ({ name, from: segmentOffset(id, name) }))
    .filter((entry): entry is { name: string; from: number } => entry.from !== undefined)
    .filter((entry) => statSync(join(dir, entry.name)).isFile())
    .map((entry) => ({ from: entry.from, size: statSync(join(dir, entry.name)).size }))
    .sort((left, right) => left.from - right.from);

it("names a segment for the stream byte it starts at, and reads that name back", () => {
  expect(segmentName("t-1", 0)).toBe("t-1.0.log");
  expect(segmentOffset("t-1", "t-1.4194304.log")).toBe(4_194_304);
  expect(segmentOffset("t-1", "t-1.log")).toBeUndefined();
  expect(segmentOffset("t-1", "t-2.0.log")).toBeUndefined();
  expect(segmentOffset("t-1", "t-1.x.log")).toBeUndefined();
  expect(segmentOffset("t-1", "t-1.0.log.bak")).toBeUndefined();
});

it("keeps everything while it fits, with an exact count and digest", async () => {
  const dir = scratch();
  const log = new TaskLog({ dir, id: "t-1", segmentBytes: 1024 });
  log.append(Buffer.from("hello "));
  log.append(Buffer.from("world"));
  log.close();
  await log.drained();
  expect(log.bytes).toBe(11);
  expect(log.state).toBe("retained");
  expect(log.retainedFromByte).toBe(0);
  expect(log.digest()).toBe(createHash("sha256").update("hello world").digest("hex"));
  expect(log.readTail(1024)?.toString("utf8")).toBe("hello world");
  expect(segments(dir, "t-1")).toEqual([{ from: 0, size: 11 }]);
});

it("bounds a command that never stops printing, and says the head is gone", async () => {
  const dir = scratch();
  const log = new TaskLog({ dir, id: "t-2", segmentBytes: 1024 });
  const expected = createHash("sha256");
  for (let index = 0; index < 100; index++) {
    const piece = chunk(String.fromCharCode(97 + (index % 26)), 1000);
    expected.update(piece);
    log.append(piece);
  }
  await log.drained();
  // A hundred kilobytes produced; at most two segments retained, each named
  // for where it begins.
  expect(log.bytes).toBe(100_000);
  expect(log.diskBytes).toBeLessThanOrEqual(2 * 1024 + 1000);
  expect(log.state).toBe("truncated");
  expect(log.retainedFromByte).toBeGreaterThan(0);
  expect(log.digest()).toBe(expected.digest("hex"));
  const window = segments(dir, "t-2");
  expect(window.length).toBeLessThanOrEqual(2);
  expect(window[0]!.from).toBe(log.retainedFromByte);
  // The segments are contiguous and end where the stream does.
  expect(window.reduce((sum, segment) => sum + segment.size, 0)).toBe(log.bytes - log.retainedFromByte);
  const tail = log.readTail(4096)!;
  expect(tail.length).toBe(log.bytes - log.retainedFromByte);
  expect(tail.subarray(-10).toString("utf8")).toBe("v".repeat(10));
  log.close();
});

it("releases its own bytes on request, oldest segment first, and keeps the facts", async () => {
  const dir = scratch();
  const log = new TaskLog({ dir, id: "t-3", segmentBytes: 1024 });
  for (let index = 0; index < 4; index++) log.append(chunk("x", 900));
  await log.drained();
  expect(segments(dir, "t-3").length).toBe(2);

  const half = log.releaseOldest();
  expect(half.changed).toBe(true);
  expect(half.freed).toBeGreaterThan(0);
  expect(segments(dir, "t-3").length).toBe(1);
  expect(log.state).toBe("truncated");
  expect(log.usable).toBe(true);
  // Nothing left to give at that level: the answer says so rather than
  // counting a release that did not happen.
  expect(log.releaseOldest()).toEqual({ changed: false, freed: 0 });

  log.append(chunk("y", 500));
  await log.drained();
  const digest = log.digest();
  const rest = log.release();
  expect(rest.changed).toBe(true);
  expect(rest.freed).toBeGreaterThan(0);
  // Repeated releases are not repeated events.
  expect(log.release()).toEqual({ changed: false, freed: 0 });
  expect(segments(dir, "t-3")).toEqual([]);
  expect(log.state).toBe("released");
  expect(log.usable).toBe(false);
  expect(log.readTail(1024)).toBeUndefined();
  expect(log.bytes).toBe(4 * 900 + 500);
  expect(log.digest()).toBe(digest);
  expect(log.retainedFromByte).toBe(log.bytes);
});

it("counts and digests even when the file cannot be written, and leaves nothing behind", () => {
  const dir = scratch();
  const log = new TaskLog({ dir: join(dir, "missing", "\0bad"), id: "t-4" });
  log.append(Buffer.from("output"));
  expect(log.bytes).toBe(6);
  expect(log.digest()).toBe(createHash("sha256").update("output").digest("hex"));
  expect(log.state).toBe("released");
  expect(log.readTail(10)).toBeUndefined();
});

it("gives back the bytes it had when a write fails: nothing on disk goes unaccounted", async () => {
  const dir = scratch();
  const errors: unknown[] = [];
  let calls = 0;
  const log = new TaskLog({
    dir,
    id: "t-write-fail",
    segmentBytes: 4096,
    write: async (fd, slice) => {
      calls += 1;
      if (calls === 1) return slice.length;
      throw new Error("disk is gone");
    },
    onError: (error) => errors.push(error),
  });
  log.append(chunk("a", 1000));
  await log.drained();
  expect(segments(dir, "t-write-fail")).toEqual([{ from: 0, size: 0 }]);

  log.append(chunk("b", 1000));
  await log.drained();
  expect(errors).toHaveLength(1);
  expect(log.state).toBe("released");
  // The file the failed write was going into is gone with it: bytes on disk
  // that no accounting knows about are the leak this prevents.
  expect(segments(dir, "t-write-fail")).toEqual([]);
  expect(log.diskBytes).toBe(0);
  expect(log.pendingBytes).toBe(0);
  expect(log.bytes).toBe(2000);
});

it("treats a write that accepts nothing as a failure rather than a spin", async () => {
  const dir = scratch();
  const log = new TaskLog({ dir, id: "t-zero", segmentBytes: 4096, write: async () => 0 });
  log.append(chunk("a", 64));
  await log.drained();
  expect(log.state).toBe("released");
  expect(log.bytes).toBe(64);
  expect(segments(dir, "t-zero")).toEqual([]);
});

it("resumes a short write from where the platform stopped", async () => {
  const dir = scratch();
  const accepted: number[] = [];
  const log = new TaskLog({
    dir,
    id: "t-short",
    segmentBytes: 1 << 20,
    // A platform that takes a third of what it is offered each time.
    write: async (_fd, slice) => {
      const take = Math.max(1, Math.floor(slice.length / 3));
      accepted.push(take);
      writeFileSync(join(dir, segmentName("t-short", 0)), slice.subarray(0, take), { flag: "a" });
      return take;
    },
  });
  log.append(chunk("p", 900));
  await log.drained();
  expect(accepted.length).toBeGreaterThan(1);
  expect(accepted.reduce((sum, value) => sum + value, 0)).toBe(900);
  expect(log.diskBytes).toBe(900);
  expect(segments(dir, "t-short")).toEqual([{ from: 0, size: 900 }]);
  log.close();
});

it("gives its bytes back when a rotation cannot open the next segment", async () => {
  const dir = scratch();
  const errors: unknown[] = [];
  const log = new TaskLog({ dir, id: "t-rotate-fail", segmentBytes: 512, onError: (error) => errors.push(error) });
  log.append(chunk("a", 512));
  await log.drained();
  // Somebody put a directory where the next segment's file has to go.
  const next = join(dir, segmentName("t-rotate-fail", 1024));
  log.append(chunk("b", 512));
  await log.drained();
  mkdirBlocking(join(dir, segmentName("t-rotate-fail", 1536)));
  log.append(chunk("c", 512));
  await log.drained();
  expect(errors.length).toBeGreaterThan(0);
  expect(log.state).toBe("released");
  expect(log.bytes).toBe(1536);
  expect(log.diskBytes).toBe(0);
  // Every segment of the window went, including the ones that were fine.
  expect(segments(dir, "t-rotate-fail")).toEqual([]);
  expect(existsSync(next)).toBe(false);
});

it("survives its file being deleted underneath it", async () => {
  const dir = scratch();
  const log = new TaskLog({ dir, id: "t-5", segmentBytes: 1024 });
  log.append(Buffer.from("before"));
  await log.drained();
  rmSync(join(dir, segmentName("t-5", 0)));
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
  expect(readFileSync(join(dir, segmentName("t-6", 0)), "utf8")).toBe("one\ntwo\n");
  expect(statSync(join(dir, segmentName("t-6", 0))).size).toBe(log.diskBytes);
});

it("never blocks the command: a stalled disk bounds the queue, then the body goes and the facts stay", async () => {
  const dir = scratch();
  let release: (() => void) | undefined;
  const stalled = new Promise<number>((resolve) => {
    release = () => resolve(0);
  });
  const log = new TaskLog({
    dir,
    id: "t-stall",
    segmentBytes: 64 * 1024,
    queueBytes: 32 * 1024,
    write: () => stalled,
  });
  const expected = createHash("sha256");
  const started = Date.now();
  for (let index = 0; index < 200; index++) {
    const piece = chunk("q", 4096);
    expected.update(piece);
    log.append(piece);
    expect(log.pendingBytes).toBeLessThanOrEqual(32 * 1024);
  }
  expect(Date.now() - started).toBeLessThan(2000);
  expect(log.state).toBe("released");
  expect(log.bytes).toBe(200 * 4096);
  expect(log.digest()).toBe(expected.digest("hex"));
  expect(log.diskBytes).toBe(0);
  expect(log.readTail(1024)).toBeUndefined();
  release?.();
  log.close();
  await log.drained();
  expect(log.pendingBytes).toBe(0);
  expect(segments(dir, "t-stall")).toEqual([]);
});

it("splits one adversarial chunk across segments instead of overrunning the window", async () => {
  const dir = scratch();
  const log = new TaskLog({ dir, id: "t-huge", segmentBytes: 64 * 1024, queueBytes: 8 * 1024 * 1024 });
  log.append(chunk("h", 1024 * 1024));
  await log.drained();
  expect(log.bytes).toBe(1024 * 1024);
  expect(log.diskBytes).toBeLessThanOrEqual(2 * 64 * 1024);
  for (const segment of segments(dir, "t-huge")) expect(segment.size).toBeLessThanOrEqual(64 * 1024);
  expect(log.state).toBe("truncated");
  expect(log.retainedFromByte).toBe(log.bytes - log.diskBytes);
});

it("creates private files in a private directory, and refuses a symlink in their place", async () => {
  const dir = join(scratch(), "logs");
  const log = new TaskLog({ dir, id: "t-mode", segmentBytes: 1024 });
  log.append(Buffer.from("private"));
  await log.drained();
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, segmentName("t-mode", 0))).mode & 0o777).toBe(0o600);
  log.close();

  const target = join(scratch(), "victim");
  writeFileSync(target, "untouched");
  symlinkSync(target, join(dir, segmentName("t-evil", 0)));
  const hostile = new TaskLog({ dir, id: "t-evil", segmentBytes: 1024 });
  hostile.append(Buffer.from("attack"));
  await hostile.drained();
  expect(hostile.state).toBe("released");
  expect(hostile.bytes).toBe(6);
  expect(readFileSync(target, "utf8")).toBe("untouched");
  expect(lstatSync(join(dir, segmentName("t-evil", 0))).isSymbolicLink()).toBe(true);
});

it("counts the slice the platform is still holding, and never closes the descriptor under it", async () => {
  const dir = scratch();
  const settle: Array<(written: number) => void> = [];
  const log = new TaskLog({
    dir,
    id: "t-inflight",
    segmentBytes: 1024 * 1024,
    queueBytes: 64 * 1024,
    write: (_fd, slice) => new Promise<number>((resolve) => settle.push(() => resolve(slice.length))),
  });
  log.append(chunk("a", 16 * 1024));
  await Promise.resolve();
  expect(settle).toHaveLength(1);
  expect(log.pendingBytes).toBe(16 * 1024);
  log.append(chunk("b", 40 * 1024));
  expect(log.pendingBytes).toBe(56 * 1024);
  log.append(chunk("c", 16 * 1024));
  expect(log.state).toBe("released");
  expect(log.bytes).toBe(72 * 1024);

  expect(existsSync(join(dir, segmentName("t-inflight", 0)))).toBe(true);
  let drained = false;
  void log.drained().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(drained).toBe(false);

  settle[0]!(16 * 1024);
  await log.drained();
  expect(drained).toBe(true);
  expect(segments(dir, "t-inflight")).toEqual([]);
  expect(log.pendingBytes).toBe(0);
  expect(log.diskBytes).toBe(0);
});

it("writes nothing to a descriptor it no longer owns after an abandonment", async () => {
  const dir = scratch();
  const seen: number[] = [];
  const settle: Array<(written: number) => void> = [];
  const log = new TaskLog({
    dir,
    id: "t-fd",
    segmentBytes: 4096,
    queueBytes: 1024 * 1024,
    write: (fd, slice) => {
      seen.push(fd);
      return new Promise<number>((resolve) => settle.push(() => resolve(slice.length)));
    },
  });
  log.append(chunk("a", 2048));
  await Promise.resolve();
  expect(log.release().changed).toBe(true);
  log.append(chunk("b", 2048));
  settle[0]!(2048);
  await log.drained();
  expect(seen).toHaveLength(1);
  expect(settle).toHaveLength(1);
  expect(log.state).toBe("released");
  expect(log.bytes).toBe(4096);
  expect(segments(dir, "t-fd")).toEqual([]);
});

/** A directory where a file has to go: the simplest way to make an open fail. */
function mkdirBlocking(path: string): void {
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(path, { recursive: true });
}

it("creates a segment, never joins one: an id collision fails released and touches no bytes", async () => {
  const dir = scratch();
  // Somebody else's file already has the name this command's first segment
  // would take.
  const taken = join(dir, segmentName("t-collide", 0));
  writeFileSync(taken, "another command's output");
  const errors: unknown[] = [];
  const log = new TaskLog({ dir, id: "t-collide", segmentBytes: 1024, onError: (error) => errors.push(error) });
  log.append(Buffer.from("mine"));
  await log.drained();
  expect(errors).toHaveLength(1);
  expect(log.state).toBe("released");
  expect(log.bytes).toBe(4);
  // Not one byte of the other file was written, and it is still there.
  expect(readFileSync(taken, "utf8")).toBe("another command's output");
});

it("fails a rotation onto an existing name rather than appending to it", async () => {
  const dir = scratch();
  const log = new TaskLog({ dir, id: "t-rotate-collide", segmentBytes: 512 });
  // The name the next segment will take is already somebody's.
  const next = join(dir, segmentName("t-rotate-collide", 512));
  writeFileSync(next, "not this command's bytes");
  log.append(chunk("a", 512));
  await log.drained();
  log.append(chunk("b", 64));
  await log.drained();
  expect(log.state).toBe("released");
  expect(log.bytes).toBe(576);
  expect(readFileSync(next, "utf8")).toBe("not this command's bytes");
  // Its own segments went with the failure; the stranger's file did not.
  expect(existsSync(join(dir, segmentName("t-rotate-collide", 0)))).toBe(false);
});
