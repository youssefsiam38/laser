/**
 * The bounded window a command writes into (RP-6).
 *
 * A command can print for hours. Before this, every byte it printed was kept
 * for ever in a file nobody ever deleted, and the same bytes were kept a
 * second time in a 256 KiB buffer that outlived the process. This file owns
 * the durable half of that problem: a **bounded window** on disk, with the
 * exact truth about everything that was produced kept beside it.
 *
 * Five rules shape it.
 *
 * 1. **The command is never held up.** Counting and the digest happen
 *    synchronously, because they are arithmetic; the bytes go to disk through
 *    one asynchronous write at a time behind a hard queue. Nothing here blocks
 *    the producer, waits for a slow disk, or makes a command's completion
 *    depend on storage.
 * 2. **Admission comes before retention.** A chunk is asked about *before* it
 *    is kept — by this log's own queue bound and by the session's ceiling —
 *    because bytes already handed to the platform cannot be taken back. When
 *    the answer is no, the body is abandoned and the command carries on with
 *    its size and digest still exact.
 * 3. **Every segment is immutable and says where it starts.** A segment is
 *    `<id>.<first stream byte>.log`, created once and only appended to; a
 *    rotation creates the next name and unlinks the oldest file. Nothing is
 *    ever renamed, so a reader — in this process or in the host — takes its
 *    offsets from the file's own name and size, never from a record that may
 *    be a moment out of date. A stale reader reads a correctly labelled
 *    segment or finds none; it can never mislabel one.
 * 4. **One writer.** The task that created a log is the only thing that
 *    writes, rotates or deletes it.
 * 5. **Bytes may be released; facts may not.** `bytes` is the exact number of
 *    bytes the command produced and `digest` is the sha256 of every one of
 *    them, whatever is still on disk. A window that dropped its head says
 *    `truncated`; one that is gone says `released`. A failure to write is a
 *    release too — the bytes go with it, so nothing escapes the accounting.
 *
 * Files are created private (0600) inside a private directory (0700), never
 * followed through a symlink, and their names carry no session id or path.
 */
import { createHash, type Hash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, write } from "node:fs";
import { join } from "node:path";

/** Bytes one segment grows to before the next one starts. */
export const LOG_SEGMENT_BYTES = 4 * 1024 * 1024;
/** Bytes one log may hold on their way to disk before its body is abandoned. */
export const LOG_QUEUE_BYTES = 16 * 1024 * 1024;
/** Bytes one asynchronous write carries: the queue is coalesced, not drip-fed. */
const WRITE_SLICE_BYTES = 4 * 1024 * 1024;
/** Segments kept: the one being written and the one before it. */
const SEGMENTS_KEPT = 2;
/** Mode of a log file: readable by its owner and nobody else. */
const FILE_MODE = 0o600;
/** Mode of the directory a session's logs live in. */
export const LOG_DIR_MODE = 0o700;

export type TaskLogState = "retained" | "truncated" | "released";

/** The one asynchronous call this file makes, injectable so a test can stall it. */
export type TaskLogWrite = (fd: number, chunk: Buffer) => Promise<number>;

const writeToFd: TaskLogWrite = (fd, chunk) =>
  new Promise((resolve, reject) => {
    write(fd, chunk, 0, chunk.length, null, (error, written) => (error ? reject(error) : resolve(written)));
  });

/** What a release did. `freed` is disk bytes; `changed` is whether anything happened. */
export interface TaskLogRelease {
  changed: boolean;
  freed: number;
}

export interface TaskLogOptions {
  dir: string;
  id: string;
  segmentBytes?: number;
  queueBytes?: number;
  /** Test seam: the asynchronous write. Defaults to `fs.write`. */
  write?: TaskLogWrite;
  /**
   * The session's admission, asked **before** a chunk is retained: may this log
   * hold `bytes` more? It may release other logs to make room, and a `false`
   * means this command's body is abandoned rather than the session's ceiling
   * exceeded, even for an instant.
   */
  admit?: (bytes: number) => boolean;
  /** Reported once, in the module's own log, when the file cannot be written. */
  onError?: (error: unknown) => void;
  /**
   * Anything a reader or an accountant cares about moved: bytes on disk, bytes
   * pending, or the retained window itself. Called synchronously, so a session
   * keeps exact running totals without ever walking its logs.
   */
  onChange?: (reason: "accounting" | "window") => void;
}

/** One immutable file of the window. */
interface Segment {
  /** Stream offset of its first byte. It is in the file's own name. */
  from: number;
  /** Bytes written into it so far. */
  size: number;
  path: string;
}

/** `<id>.<from>.log` — the name a reader takes its offsets from. */
export function segmentName(id: string, from: number): string {
  return `${id}.${from}.log`;
}

/** The stream offset a segment file's name declares, or `undefined`. */
export function segmentOffset(id: string, name: string): number | undefined {
  if (!name.startsWith(`${id}.`) || !name.endsWith(".log")) return undefined;
  const middle = name.slice(id.length + 1, -".log".length);
  if (!/^\d+$/.test(middle)) return undefined;
  const from = Number(middle);
  return Number.isSafeInteger(from) ? from : undefined;
}

export class TaskLog {
  /**
   * The base path of this log: `<dir>/<id>`. Its segments are
   * `<base>.<from>.log`, which is what a reader lists the directory for.
   */
  readonly path: string;
  readonly id: string;
  private readonly dir: string;
  /** Exact bytes the command produced, retained or not. */
  bytes = 0;
  private readonly hash: Hash = createHash("sha256");
  private readonly segmentBytes: number;
  private readonly queueBytes: number;
  private readonly io: TaskLogWrite;
  private readonly admit: ((bytes: number) => boolean) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly onChange: ((reason: "accounting" | "window") => void) | undefined;
  private fd: number | undefined;
  private segments: Segment[] = [];
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
  private idle: Promise<void> = Promise.resolve();
  private settleIdle: () => void = () => {};

  constructor(options: TaskLogOptions) {
    this.id = options.id;
    this.dir = options.dir;
    this.path = join(options.dir, options.id);
    this.segmentBytes = options.segmentBytes ?? LOG_SEGMENT_BYTES;
    this.queueBytes = options.queueBytes ?? LOG_QUEUE_BYTES;
    this.io = options.write ?? writeToFd;
    this.admit = options.admit;
    this.onError = options.onError;
    this.onChange = options.onChange;
    try {
      mkdirSync(options.dir, { recursive: true, mode: LOG_DIR_MODE });
      // A symlink standing where our directory should be is not our directory.
      if (!lstatSync(options.dir).isDirectory()) throw new Error("the log directory is not a directory");
      this.open(0);
    } catch (error) {
      this.fail(error);
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
    return this.segments[0]?.from ?? this.bytes;
  }

  /**
   * The stream offsets of the segments that exist right now, oldest first and
   * never more than two. This is what a reader is given, instead of listing a
   * directory it does not own.
   */
  get segmentOffsets(): number[] {
    if (this.released || this.broken) return [];
    return this.segments.map((segment) => segment.from);
  }

  /** Bytes this command currently occupies on disk. */
  get diskBytes(): number {
    if (this.released || this.broken) return 0;
    return this.segments.reduce((sum, segment) => sum + segment.size, 0);
  }

  /**
   * Bytes on their way to disk: the queue **and** the slice the platform has
   * not acknowledged. Both are memory, so both are counted, and both are what
   * the admission bound is checked against.
   */
  get pendingBytes(): number {
    return this.queued + this.inFlight;
  }

  /** sha256 of everything produced so far; safe to call while the task runs. */
  digest(): string {
    return this.hash.copy().digest("hex");
  }

  /**
   * Append what the command printed. Synchronous work only: the size, the
   * digest, the two admission questions, and a bounded queue.
   */
  append(chunk: Buffer): void {
    this.bytes += chunk.length;
    this.hash.update(chunk);
    if (this.released || this.broken || this.fd === undefined) return;
    if (this.pendingBytes + chunk.length > this.queueBytes) {
      this.release();
      return;
    }
    if (this.admit && !this.admit(chunk.length)) {
      // The session could not make room. This command's body goes; the command
      // itself, its byte count and its digest carry on.
      this.release();
      return;
    }
    // Making room may have released this very log.
    if (this.released || this.broken || this.fd === undefined) return;
    if (this.queue.length === 0 && this.inFlight === 0) {
      this.idle = new Promise<void>((resolve) => {
        this.settleIdle = resolve;
      });
    }
    this.queue.push(chunk);
    this.queued += chunk.length;
    this.onChange?.("accounting");
    if (!this.draining) void this.drain();
  }

  /** The command ended: stop holding the descriptor once the queue has gone. */
  close(): void {
    this.closed = true;
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

  /** Give back the oldest segment. Returns what it freed and whether it did. */
  releaseOldest(): TaskLogRelease {
    if (this.segments.length <= 1 || this.released || this.broken) return { changed: false, freed: 0 };
    const oldest = this.segments.shift()!;
    this.unlink(oldest.path);
    this.droppedHead = true;
    this.onChange?.("window");
    return { changed: true, freed: oldest.size };
  }

  /**
   * Give back every byte, including a live command's. The command is not
   * touched: it keeps running, its output keeps being counted and digested,
   * and its row says the body is gone.
   */
  release(): TaskLogRelease {
    if (this.released) return { changed: false, freed: 0 };
    const freed = this.diskBytes;
    this.released = true;
    this.droppedHead = this.bytes > 0;
    this.queue.length = 0;
    this.queued = 0;
    // A write the platform has not acknowledged still owns the descriptor and
    // the buffer. Closing or unlinking now would race it, so the cleanup waits
    // for it to settle — and `drained()` waits with it.
    if (this.inFlight > 0) this.cleanupPending = true;
    else this.finishCleanup();
    this.onChange?.("window");
    return { changed: true, freed };
  }

  /**
   * The last `maxBytes` of the retained window. `undefined` when there is
   * nothing readable, which the caller says out loud rather than showing an
   * empty pane.
   */
  readTail(maxBytes: number): Buffer | undefined {
    if (this.released || this.broken) return undefined;
    const parts: Buffer[] = [];
    let want = Math.max(0, maxBytes);
    let readAnything = false;
    for (const segment of [...this.segments].reverse()) {
      if (want <= 0) break;
      const bytes = readEnd(segment.path, want);
      if (bytes === undefined) continue;
      readAnything = true;
      if (bytes.length > 0) {
        parts.unshift(bytes);
        want -= bytes.length;
      }
    }
    if (!readAnything) return undefined;
    return parts.length === 0 ? Buffer.alloc(0) : Buffer.concat(parts);
  }

  // -------------------------------------------------------------- internals

  /**
   * One write at a time, never more than the room left in the current segment,
   * and never fewer bytes than the platform actually took: a short write is
   * resumed from where it stopped, and no progress at all is a failure rather
   * than a spin.
   */
  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.released && !this.broken && this.fd !== undefined) {
        const active = this.segments[this.segments.length - 1]!;
        const room = Math.min(Math.max(0, this.segmentBytes - active.size), WRITE_SLICE_BYTES);
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
          this.rotate();
          continue;
        }
        this.queued -= taken;
        // Still held, just held by the platform now.
        this.inFlight += taken;
        this.onChange?.("accounting");
        let slice = parts.length === 1 ? parts[0]! : Buffer.concat(parts, taken);
        while (slice.length > 0) {
          let written: number;
          try {
            written = await this.io(this.fd, slice);
          } catch (error) {
            this.inFlight -= slice.length;
            this.fail(error);
            return;
          }
          if (this.released || this.broken) {
            // Abandoned while that write was in flight: its bytes are not
            // accounted, nothing rotates, and the cleanup that was waiting for
            // this write happens now.
            this.inFlight -= slice.length;
            if (this.cleanupPending) this.finishCleanup();
            else this.onChange?.("accounting");
            return;
          }
          if (!Number.isFinite(written) || written <= 0) {
            this.inFlight -= slice.length;
            this.fail(new Error("the log file accepted no bytes"));
            return;
          }
          const accepted = Math.min(written, slice.length);
          this.inFlight -= accepted;
          active.size += accepted;
          slice = slice.subarray(accepted);
          this.onChange?.("accounting");
        }
        if (active.size >= this.segmentBytes) this.rotate();
      }
    } finally {
      this.draining = false;
      if (this.queue.length === 0 && this.inFlight === 0) {
        if (this.cleanupPending) this.finishCleanup();
        this.settleIdle();
        if (this.closed) this.closeFd();
      }
    }
  }

  /**
   * Start the next segment. Its name declares where it begins, the oldest file
   * beyond the two we keep is unlinked, and nothing is ever renamed — a reader
   * holding the old name reads the same bytes it always did, or finds the file
   * gone.
   */
  private rotate(): void {
    const active = this.segments[this.segments.length - 1];
    if (!active) return;
    this.closeFd();
    try {
      this.open(active.from + active.size);
      while (this.segments.length > SEGMENTS_KEPT) {
        const oldest = this.segments.shift()!;
        this.unlink(oldest.path);
        this.droppedHead = true;
      }
      this.onChange?.("window");
    } catch (error) {
      this.fail(error);
    }
  }

  /** Open the segment that starts at `from`, privately and without following a link. */
  private open(from: number): void {
    const path = join(this.dir, segmentName(this.id, from));
    // `O_EXCL`: a segment is created, never joined. If anything already holds
    // that name — another command's file after an id collision, a leftover, a
    // symlink — this fails rather than appending one command's output to
    // another command's bytes. There is no reopening: the descriptor lives as
    // long as the segment does.
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    const fd = openSync(path, flags, FILE_MODE);
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile()) throw new Error("the log path is not a regular file");
      this.fd = fd;
      this.segments.push({ from, size: 0, path });
      void stats;
    } catch (error) {
      closeSync(fd);
      throw error;
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
      // Already gone, or never created.
    }
  }

  /** The part of a release or a failure that may only happen with no write in flight. */
  private finishCleanup(): void {
    this.cleanupPending = false;
    this.closeFd();
    for (const segment of this.segments.splice(0)) this.unlink(segment.path);
    this.settleIdle();
    this.onChange?.("window");
  }

  /**
   * A write, a rotation or an open failed. The body goes with it: bytes on
   * disk that nothing is accounting for are exactly the leak this whole file
   * exists to prevent, so the segments are unlinked — after any in-flight
   * write settles — and the row says `released`.
   */
  private fail(error: unknown): void {
    if (this.broken) return;
    this.broken = true;
    this.droppedHead = this.bytes > 0;
    this.queue.length = 0;
    this.queued = 0;
    if (this.inFlight > 0) this.cleanupPending = true;
    else this.finishCleanup();
    this.onError?.(error);
    this.onChange?.("window");
  }
}

/** The last `maxBytes` of one file, or `undefined` when it cannot be read. */
function readEnd(path: string, maxBytes: number): Buffer | undefined {
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
        // The read already answered.
      }
    }
  }
}
