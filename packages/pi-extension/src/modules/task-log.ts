/**
 * The durable side of a background command (RP-6).
 *
 * A command can print for hours. Before this, every byte it printed was kept
 * for ever in a file nobody ever deleted, and the same bytes were kept a
 * second time in a 256 KiB buffer that outlived the process. This file owns
 * the first half of that problem: a **bounded window** on disk, with the exact
 * truth about everything that was produced kept beside it.
 *
 * Three rules shape it:
 *
 * 1. **One writer.** The task that created a log is the only thing that ever
 *    writes it, rotates it or deletes it. Nothing else — not another session,
 *    not the worker, not the host — removes bytes it does not own; the worker
 *    can only tell an owner how much it may keep
 *    (`lasercode/task/log-budget`), and the owner does the releasing.
 * 2. **Bytes may be released; facts may not.** `bytes` is the exact number of
 *    bytes the command produced, and `digest` is the sha256 of every one of
 *    them, whatever is still on disk. A window that dropped its head says so
 *    (`state: "truncated"`), and a log that was released entirely says that.
 * 3. **The command is never held up.** Nothing here pauses, throttles or kills
 *    a running command to keep bytes. Writes are synchronous into an open
 *    descriptor, which is what keeps the queue bounded: there is no JS write
 *    queue to grow, ordering is the order the bytes arrived, and a slow disk
 *    reaches the producer as backpressure through the pipe it is writing to
 *    rather than as unbounded memory in this process.
 *
 * The window is two files: `<id>.log` (active, appended) and `<id>.log.prev`
 * (the previous segment, immutable). Rotation renames active over prev, so a
 * reader that is part-way through the old bytes reads a file that never
 * changes underneath it. The retained window is therefore between one and two
 * segments, and `retainedFromByte` names the stream offset its first byte has.
 */
import { createHash, type Hash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Bytes one segment grows to before it rotates. */
export const LOG_SEGMENT_BYTES = 4 * 1024 * 1024;

export type TaskLogState = "retained" | "truncated" | "released";

export interface TaskLogOptions {
  dir: string;
  id: string;
  segmentBytes?: number;
  /** Reported once, in the module's own log, when the file cannot be written. */
  onError?: (error: unknown) => void;
}

export class TaskLog {
  /** Absolute path of the active segment. The previous one is `${path}.prev`. */
  readonly path: string;
  /** Exact bytes the command produced, retained or not. */
  bytes = 0;
  private readonly hash: Hash = createHash("sha256");
  private readonly segmentBytes: number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private fd: number | undefined;
  private activeBytes = 0;
  /** Stream offset of the first byte of the active segment. */
  private activeFrom = 0;
  private prevBytes = 0;
  private prevFrom = 0;
  private hasPrev = false;
  private released = false;
  private droppedHead = false;
  /** Set when the file could not be opened or written; bytes are still counted. */
  private broken = false;

  constructor(options: TaskLogOptions) {
    this.path = join(options.dir, `${options.id}.log`);
    this.segmentBytes = options.segmentBytes ?? LOG_SEGMENT_BYTES;
    this.onError = options.onError;
    try {
      mkdirSync(options.dir, { recursive: true });
      this.fd = openSync(this.path, "a");
    } catch (error) {
      this.broken = true;
      this.onError?.(error);
    }
  }

  /** Whether any byte is readable from disk right now. */
  get usable(): boolean {
    return !this.released && !this.broken;
  }

  get state(): TaskLogState {
    if (this.released || this.broken) return "released";
    return this.droppedHead ? "truncated" : "retained";
  }

  /** Stream offset of the first byte still readable. */
  get retainedFromByte(): number {
    if (this.released || this.broken) return this.bytes;
    return this.hasPrev ? this.prevFrom : this.activeFrom;
  }

  /** Bytes this command currently occupies on disk. */
  get diskBytes(): number {
    if (this.released || this.broken) return 0;
    return this.activeBytes + (this.hasPrev ? this.prevBytes : 0);
  }

  /** sha256 of everything produced so far; safe to call while the task runs. */
  digest(): string {
    return this.hash.copy().digest("hex");
  }

  /**
   * Append what the command printed. Counting and the digest happen even when
   * the file is gone: the exact size of the output is not a function of what
   * we managed to keep.
   */
  append(chunk: Buffer): void {
    this.bytes += chunk.length;
    this.hash.update(chunk);
    if (this.released || this.broken || this.fd === undefined) return;
    try {
      writeSync(this.fd, chunk);
    } catch (error) {
      this.fail(error);
      return;
    }
    this.activeBytes += chunk.length;
    if (this.activeBytes >= this.segmentBytes) this.rotate();
  }

  /** The command ended: stop holding the descriptor. The bytes stay readable. */
  close(): void {
    if (this.fd === undefined) return;
    try {
      closeSync(this.fd);
    } catch {
      // Nothing useful to do: the bytes are already on disk or already lost.
    }
    this.fd = undefined;
  }

  /**
   * Give back the older half of the window. Returns the bytes released, so a
   * budget can stop as soon as it is under its bound.
   */
  releaseOldest(): number {
    if (!this.hasPrev || this.released || this.broken) return 0;
    const freed = this.prevBytes;
    this.unlink(`${this.path}.prev`);
    this.hasPrev = false;
    this.prevBytes = 0;
    this.droppedHead = true;
    return freed;
  }

  /** Give back every byte. The count and the digest survive. */
  release(): number {
    if (this.released) return 0;
    const freed = this.diskBytes;
    this.close();
    this.unlink(`${this.path}.prev`);
    this.unlink(this.path);
    this.released = true;
    this.hasPrev = false;
    this.prevBytes = 0;
    this.activeBytes = 0;
    this.droppedHead = this.bytes > 0;
    return freed;
  }

  /**
   * The last `maxBytes` of the retained window, as bytes. `undefined` when
   * there is nothing readable, which the caller says out loud rather than
   * showing an empty pane.
   */
  readTail(maxBytes: number): Buffer | undefined {
    if (this.released || this.broken) return undefined;
    const parts: Buffer[] = [];
    let want = Math.max(0, maxBytes);
    const active = this.readEnd(this.path, want);
    if (active) {
      parts.push(active);
      want -= active.length;
    }
    if (want > 0 && this.hasPrev) {
      const prev = this.readEnd(`${this.path}.prev`, want);
      if (prev) parts.unshift(prev);
    }
    if (parts.length === 0) return active === undefined ? undefined : Buffer.alloc(0);
    return Buffer.concat(parts);
  }

  private readEnd(path: string, maxBytes: number): Buffer | undefined {
    if (maxBytes <= 0) return Buffer.alloc(0);
    let fd: number | undefined;
    try {
      const size = statSync(path).size;
      const start = Math.max(0, size - maxBytes);
      const length = size - start;
      if (length === 0) return Buffer.alloc(0);
      fd = openSync(path, "r");
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, start);
      return buffer.subarray(0, read);
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // The read already answered; a failed close changes nothing.
        }
      }
    }
  }

  /**
   * Close the active segment and start a new one. The old active becomes
   * `.prev` — immutable from here — and whatever `.prev` held is released, so
   * the window stays between one and two segments however long the command
   * runs.
   */
  private rotate(): void {
    this.close();
    try {
      if (this.hasPrev) {
        this.unlink(`${this.path}.prev`);
        this.droppedHead = true;
      }
      renameSync(this.path, `${this.path}.prev`);
      this.prevBytes = this.activeBytes;
      this.prevFrom = this.activeFrom;
      this.hasPrev = true;
      this.activeFrom += this.activeBytes;
      this.activeBytes = 0;
      this.fd = openSync(this.path, "a");
    } catch (error) {
      this.fail(error);
    }
  }

  private unlink(path: string): void {
    try {
      unlinkSync(path);
    } catch {
      // Already gone, or never created. Either way there is nothing to keep.
    }
  }

  private fail(error: unknown): void {
    this.broken = true;
    this.close();
    this.onError?.(error);
  }
}
