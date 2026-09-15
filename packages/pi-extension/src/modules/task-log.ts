/**
 * The bounded window a command writes into (RP-6).
 *
 * A command can print for hours. Before this, every byte it printed was kept
 * for ever in a file nobody ever deleted, and the same bytes were kept a
 * second time in a 256 KiB buffer that outlived the process. This file owns
 * the durable half of that problem: a **bounded window** on disk, with the
 * exact truth about everything that was produced kept beside it.
 *
 * Four rules shape it.
 *
 * 1. **The command is never held up.** Counting and the digest happen
 *    synchronously, because they are arithmetic; the bytes go to disk through
 *    one asynchronous write at a time behind a hard byte queue. Nothing here
 *    blocks the producer's pipe, waits for a slow disk, or makes a command's
 *    completion depend on storage: when the queue is full the *retained body*
 *    is abandoned — released, said out loud — and the command carries on with
 *    its size and digest still exact.
 * 2. **The window is a hard bound.** A single 100 MiB chunk is split at
 *    segment boundaries, so a segment never exceeds its size and a task never
 *    holds more than two of them, however adversarial the output is.
 * 3. **One writer.** The task that created a log is the only thing that writes
 *    it, rotates it or deletes it. Nothing else removes bytes it does not own;
 *    the worker can only tell an owner how much it may keep.
 * 4. **Bytes may be released; facts may not.** `bytes` is the exact number of
 *    bytes the command produced and `digest` is the sha256 of every one of
 *    them, whatever is still on disk. A window that dropped its head says
 *    `truncated`; one that is gone says `released`.
 *
 * The window is two files: `<id>.log` (active, appended) and `<id>.log.prev`
 * (the previous segment, immutable). Rotation renames active over prev, so a
 * reader part-way through the old bytes reads a file that never changes
 * underneath it. Files are created private (0600) inside a private directory
 * (0700), never followed through a symlink, and their names carry no session
 * id or path.
 */
import { createHash, type Hash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, write } from "node:fs";
import { join } from "node:path";

/** Bytes one segment grows to before it rotates. */
export const LOG_SEGMENT_BYTES = 4 * 1024 * 1024;
/** Bytes that may be waiting to reach the disk before the body is abandoned. */
export const LOG_QUEUE_BYTES = 16 * 1024 * 1024;
/** Bytes one asynchronous write carries: the queue is coalesced, not drip-fed. */
const WRITE_SLICE_BYTES = 4 * 1024 * 1024;
/** Mode of a log file: readable by its owner and nobody else. */
const FILE_MODE = 0o600;
/** Mode of the directory a session's logs live in. */
export const LOG_DIR_MODE = 0o700;

export type TaskLogState = "retained" | "truncated" | "released";

/** The one asynchronous call this file makes, injectable so a test can stall it. */
export type TaskLogWrite = (fd: number, chunk: Buffer) => Promise<void>;

const writeToFd: TaskLogWrite = (fd, chunk) =>
  new Promise((resolve, reject) => {
    write(fd, chunk, 0, chunk.length, null, (error) => (error ? reject(error) : resolve()));
  });

export interface TaskLogOptions {
  dir: string;
  id: string;
  segmentBytes?: number;
  queueBytes?: number;
  /** Test seam: the asynchronous write. Defaults to `fs.write`. */
  write?: TaskLogWrite;
  /** Reported once, in the module's own log, when the file cannot be written. */
  onError?: (error: unknown) => void;
  /** The retained window moved or went: publish it now, not on the next tick. */
  onWindowChange?: () => void;
}

export class TaskLog {
  /** Absolute path of the active segment. The previous one is `${path}.prev`. */
  readonly path: string;
  /** Exact bytes the command produced, retained or not. */
  bytes = 0;
  private readonly hash: Hash = createHash("sha256");
  private readonly segmentBytes: number;
  private readonly queueBytes: number;
  private readonly io: TaskLogWrite;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly onWindowChange: (() => void) | undefined;
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
  private closed = false;
  private readonly queue: Buffer[] = [];
  private queued = 0;
  /** Bytes handed to the platform and not yet acknowledged. Retained memory too. */
  private inFlight = 0;
  private draining = false;
  /** Set when the body was abandoned and its files still have to be cleaned up. */
  private cleanupPending = false;
  /** Resolves when the queue is empty. Tests and shutdown may await it; nothing else does. */
  private idle: Promise<void> = Promise.resolve();
  private settleIdle: () => void = () => {};

  constructor(options: TaskLogOptions) {
    this.path = join(options.dir, `${options.id}.log`);
    this.segmentBytes = options.segmentBytes ?? LOG_SEGMENT_BYTES;
    this.queueBytes = options.queueBytes ?? LOG_QUEUE_BYTES;
    this.io = options.write ?? writeToFd;
    this.onError = options.onError;
    this.onWindowChange = options.onWindowChange;
    try {
      mkdirSync(options.dir, { recursive: true, mode: LOG_DIR_MODE });
      // A symlink standing where our directory should be is not our directory.
      if (!lstatSync(options.dir).isDirectory()) throw new Error("the log directory is not a directory");
      this.fd = this.openSegment(this.path);
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

  /**
   * Bytes this log is holding on their way to disk: the queue **and** the
   * slice the platform has not acknowledged yet. Both are memory, so both are
   * counted, and both are what the admission bound is checked against.
   */
  get pendingBytes(): number {
    return this.queued + this.inFlight;
  }

  /** sha256 of everything produced so far; safe to call while the task runs. */
  digest(): string {
    return this.hash.copy().digest("hex");
  }

  /**
   * Append what the command printed.
   *
   * Synchronous work only: the size, the digest, and putting the bytes on a
   * bounded queue. Counting happens even when there is no file, because the
   * exact size of a command's output is not a function of what we kept.
   */
  append(chunk: Buffer): void {
    this.bytes += chunk.length;
    this.hash.update(chunk);
    if (this.released || this.broken || this.fd === undefined) return;
    if (this.pendingBytes + chunk.length > this.queueBytes) {
      // Storage cannot keep up. Abandoning the body is the only answer that
      // neither slows the command down nor grows this process without bound;
      // the row says `released`, and the size and digest still describe every
      // byte the command produced.
      this.release();
      return;
    }
    if (this.queue.length === 0) {
      this.idle = new Promise<void>((resolve) => {
        this.settleIdle = resolve;
      });
    }
    this.queue.push(chunk);
    this.queued += chunk.length;
    if (!this.draining) void this.drain();
  }

  /** The command ended: stop holding the descriptor once the queue has gone. */
  close(): void {
    this.closed = true;
    // Never while the platform still owns the descriptor: closing it under an
    // unacknowledged write is how a file descriptor gets reused by somebody
    // else's open and written into.
    if (this.queue.length === 0 && this.inFlight === 0) this.closeFd();
  }

  /**
   * Resolves when everything accepted so far has reached the disk (or has been
   * abandoned). Nothing on the command's path waits for this; it exists for
   * shutdown and for tests.
   */
  drained(): Promise<void> {
    return this.idle;
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
    this.onWindowChange?.();
    return freed;
  }

  /**
   * Give back every byte, including a live command's. The command is not
   * touched: it keeps running, its output keeps being counted and digested,
   * and its row says the body is gone.
   */
  release(): number {
    if (this.released) return 0;
    const freed = this.diskBytes;
    // Abandoned from this instant: nothing more is written, nothing rotates,
    // and no retained window is published again.
    this.released = true;
    this.droppedHead = this.bytes > 0;
    this.queue.length = 0;
    this.queued = 0;
    this.hasPrev = false;
    this.prevBytes = 0;
    this.activeBytes = 0;
    // A write the platform has not acknowledged still owns the descriptor and
    // the buffer. Closing or unlinking now would race it, so the cleanup waits
    // for it to settle — and `drained()` waits with it rather than claiming
    // the queue has gone while it has not.
    if (this.inFlight > 0) this.cleanupPending = true;
    else this.finishRelease();
    this.onWindowChange?.();
    return freed;
  }

  /** The part of a release that may only happen once no write is in flight. */
  private finishRelease(): void {
    this.cleanupPending = false;
    this.closeFd();
    this.unlink(`${this.path}.prev`);
    this.unlink(this.path);
    this.settleIdle();
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

  // -------------------------------------------------------------- internals

  /**
   * One write at a time, and never more than the room left in the current
   * segment: an adversarial 100 MiB chunk becomes a sequence of segment-sized
   * writes with a rotation between them, so the window bound holds whatever
   * the command prints.
   */
  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.released && !this.broken && this.fd !== undefined) {
        // One write carries as much as the segment has room for, up to a
        // slice bound: a command printing in 8 KiB pieces must not cost one
        // asynchronous write per piece, and a 100 MiB piece must not become
        // one write that ignores the segment bound.
        const room = Math.min(Math.max(0, this.segmentBytes - this.activeBytes), WRITE_SLICE_BYTES);
        const parts: Buffer[] = [];
        let taken = 0;
        while (this.queue.length > 0 && taken < room) {
          const chunk = this.queue[0]!;
          const want = Math.min(chunk.length, room - taken);
          parts.push(want === chunk.length ? chunk : chunk.subarray(0, want));
          taken += want;
          if (want === chunk.length) this.queue.shift();
          else this.queue[0] = chunk.subarray(want);
        }
        if (taken === 0) {
          // No room left in this segment: rotate and try again.
          this.rotate();
          continue;
        }
        this.queued -= taken;
        // Still held, just held by the platform now: the bytes move from the
        // queue to `inFlight`, and `pendingBytes` never dips while they are in
        // somebody else's hands.
        this.inFlight += taken;
        const slice = parts.length === 1 ? parts[0]! : Buffer.concat(parts, taken);
        try {
          await this.io(this.fd, slice);
        } catch (error) {
          this.inFlight -= taken;
          this.fail(error);
          return;
        }
        this.inFlight -= taken;
        // The body may have been abandoned while that write was in flight. The
        // bytes it wrote are not accounted, nothing rotates, and the cleanup
        // that was waiting for this write happens now.
        if (this.released || this.broken) {
          if (this.cleanupPending) this.finishRelease();
          return;
        }
        this.activeBytes += slice.length;
        if (this.activeBytes >= this.segmentBytes) this.rotate();
      }
    } finally {
      this.draining = false;
      if (this.queue.length === 0 && this.inFlight === 0) {
        if (this.cleanupPending) this.finishRelease();
        this.settleIdle();
        if (this.closed) this.closeFd();
      }
    }
  }

  /** Open a segment privately, refusing anything that is not a plain new file. */
  private openSegment(path: string): number {
    // `O_NOFOLLOW` refuses a symlink in place of the log; the mode makes the
    // file private from the moment it exists.
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW;
    const fd = openSync(path, flags, FILE_MODE);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("the log path is not a regular file");
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  private readEnd(path: string, maxBytes: number): Buffer | undefined {
    if (maxBytes <= 0) return Buffer.alloc(0);
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stats = fstatSync(fd);
      if (!stats.isFile()) return undefined;
      const size = stats.size;
      const start = Math.max(0, size - maxBytes);
      const length = size - start;
      if (length === 0) return Buffer.alloc(0);
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
   * runs. The move is published immediately: a reader that still believed the
   * old offsets would read the right bytes under the wrong name.
   */
  private rotate(): void {
    this.closeFd();
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
      this.fd = this.openSegment(this.path);
      this.onWindowChange?.();
    } catch (error) {
      this.fail(error);
    }
  }

  private closeFd(): void {
    if (this.fd === undefined) return;
    try {
      closeSync(this.fd);
    } catch {
      // Nothing useful to do: the bytes are already on disk or already lost.
    }
    this.fd = undefined;
  }

  private unlink(path: string): void {
    try {
      // Safe for a hostile entry too: `unlink` removes the name, never what a
      // symlink points at.
      unlinkSync(path);
    } catch {
      // Already gone, or never created. Either way there is nothing to keep.
    }
  }

  private fail(error: unknown): void {
    this.broken = true;
    this.queue.length = 0;
    this.queued = 0;
    this.cleanupPending = false;
    this.settleIdle();
    if (this.inFlight === 0) this.closeFd();
    this.onError?.(error);
    this.onWindowChange?.();
  }
}
