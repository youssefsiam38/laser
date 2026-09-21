/** Minimal JSON-RPC 2.0 envelope. One record per line when carried over a byte stream. */

export type JsonRpcId = string | number;

export interface JsonRpcRequest<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: M;
  params: P;
  /** Product clients send their compiled version; other ACP clients may omit it. */
  clientVersion?: string;
}

export interface JsonRpcNotification<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  method: M;
  params: P;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: R;
  error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  // laser-specific range
  SessionNotFound: -32000,
  SessionBusy: -32001,
  DriverUnavailable: -32002,
  Cancelled: -32003,
  Unsupported: -32004,
  /** The project has trust-gated resources and nobody has approved it yet (M2-T4). */
  ProjectUntrusted: -32005,
  VersionMismatch: -32006,
  /**
   * This conversation cannot be read as it is stored right now (RP-9): its
   * records cannot be canonicalised, its index exceeds a hard bound with no
   * live worker to ask, or it kept being rewritten underneath the read. A
   * window is never returned without its revision instead.
   */
  RevisionUnavailable: -32007,
  /**
   * A project-work write named a revision that is no longer current (M21-T3).
   *
   * The error data carries {@link ProjectWorkConflict}: what is current now and
   * what the caller believed was current. Nothing was overwritten, and the
   * caller chooses between keeping its version as a new revision and starting
   * from the current one.
   */
  ProjectWorkConflict: -32010,
  /**
   * A durable project-work write was refused because a budget is full
   * (M21-T3). Canonical revisions, comments and approvals are never evicted to
   * make room, so the data carries the recovery action instead: what to export
   * or delete, and where.
   */
  ProjectWorkQuota: -32011,
} as const;

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return "method" in m && "id" in m;
}
export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return "method" in m && !("id" in m);
}
export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return !("method" in m) && "id" in m;
}

/** Hard ceiling for one frame, in UTF-8 bytes (RP-7). */
export const FRAME_MAX_BYTES = 64 * 1024 * 1024;

const LF = 0x0a;
const CR = 0x0d;

export interface LineDecoderOptions {
  /** Refuse a single frame larger than this many UTF-8 bytes. */
  maxFrameBytes?: number;
  /**
   * One frame crossed the ceiling. The decoder is faulted from that moment:
   * it emits nothing more, because skipping to the next newline after losing
   * a response would leave the request that is waiting for it hanging for
   * ever. The owner of the stream settles its generation instead.
   */
  onOverflow?: (info: { bytes: number }) => void;
}

/** Byte-accurate accounting for the diagnostics counters and the linearity tests. */
export interface LineDecoderStats {
  /** Bytes of the frame being assembled right now. */
  retained: number;
  retainedHighWater: number;
  frames: number;
  largestFrame: number;
  /** Every byte handed to `push`, scanned exactly once. */
  bytesScanned: number;
  /** Bytes moved by `Buffer.concat`: at most one pass over a frame that spanned chunks. */
  bytesCopied: number;
  joins: number;
  overflows: number;
}

/**
 * Split a byte stream into complete JSON lines. LF is the only record
 * delimiter; a trailing CR is stripped. Do not use Node `readline`: it also
 * splits on U+2028/U+2029, which are valid inside JSON strings.
 *
 * Linear, by construction (RP-7). The previous implementation accumulated a
 * string and re-scanned it on every chunk, so one 16 MiB frame delivered in
 * 64 KiB chunks cost about 700 ms of event loop and a ~200 MiB transient peak
 * on the receiving process — per model call, because a provider capture is the
 * whole conversation of that turn. This one keeps the pieces in an array,
 * scans only the incoming chunk from a cursor, and copies a frame exactly once
 * (never, when it arrived inside one chunk).
 *
 * Bytes, not characters. Chunks are `Buffer`s and the split is on the byte
 * `0x0A`, which cannot occur inside a UTF-8 multi-byte sequence (continuation
 * bytes are >= 0x80), so a CJK character, an emoji or a surrogate pair split
 * across two chunks is simply two pieces that are joined before they are
 * decoded. The ceiling is therefore an exact UTF-8 byte count, and it is
 * checked from chunk lengths *before* anything is concatenated.
 *
 * A `string` chunk is still accepted for callers that already have text; it is
 * measured and stored as its UTF-8 bytes, so accounting means one thing.
 */
export class LineDecoder {
  private pieces: Buffer[] = [];
  private retained = 0;
  private overflowed = false;
  private readonly maxFrameBytes: number;
  private readonly onOverflow: ((info: { bytes: number }) => void) | undefined;
  private readonly counters: LineDecoderStats = {
    retained: 0,
    retainedHighWater: 0,
    frames: 0,
    largestFrame: 0,
    bytesScanned: 0,
    bytesCopied: 0,
    joins: 0,
    overflows: 0,
  };

  constructor(options: LineDecoderOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? FRAME_MAX_BYTES;
    this.onOverflow = options.onOverflow;
  }

  /** True once a frame crossed the ceiling. Nothing is decoded after that. */
  get faulted(): boolean {
    return this.overflowed;
  }

  get stats(): LineDecoderStats {
    return { ...this.counters, retained: this.retained };
  }

  push(chunk: Buffer | string): string[] {
    if (this.overflowed) return [];
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (bytes.length === 0) return [];
    this.counters.bytesScanned += bytes.length;
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const index = bytes.indexOf(LF, start);
      if (index < 0) break;
      const segment = bytes.subarray(start, index);
      if (!this.admit(segment.length)) return lines;
      const line = this.take(segment);
      if (line.length > 0) lines.push(line);
      start = index + 1;
    }
    if (start < bytes.length) {
      const rest = bytes.subarray(start);
      if (!this.admit(rest.length)) return lines;
      this.pieces.push(rest);
      this.retained += rest.length;
      if (this.retained > this.counters.retainedHighWater) this.counters.retainedHighWater = this.retained;
    }
    return lines;
  }

  end(): string[] {
    if (this.overflowed || this.retained === 0) {
      this.reset();
      return [];
    }
    const line = this.take(undefined);
    return line.length > 0 ? [line] : [];
  }

  /** Room for `adding` more bytes in the frame being assembled? Counted before any copy. */
  private admit(adding: number): boolean {
    if (this.retained + adding <= this.maxFrameBytes) return true;
    this.overflowed = true;
    this.counters.overflows += 1;
    const bytes = this.retained + adding;
    this.reset();
    this.onOverflow?.({ bytes });
    return false;
  }

  /** Complete one frame: at most one copy, and only when it spanned chunks. */
  private take(segment: Buffer | undefined): string {
    let frame: Buffer;
    if (this.pieces.length === 0) {
      frame = segment ?? Buffer.alloc(0);
    } else {
      const pieces = segment === undefined ? this.pieces : [...this.pieces, segment];
      const total = this.retained + (segment?.length ?? 0);
      frame = Buffer.concat(pieces, total);
      this.counters.bytesCopied += total;
      this.counters.joins += 1;
    }
    this.pieces = [];
    this.retained = 0;
    const end = frame.length > 0 && frame[frame.length - 1] === CR ? frame.length - 1 : frame.length;
    this.counters.frames += 1;
    if (frame.length > this.counters.largestFrame) this.counters.largestFrame = frame.length;
    return end > 0 ? frame.toString("utf8", 0, end) : "";
  }

  private reset(): void {
    this.pieces = [];
    this.retained = 0;
  }
}
