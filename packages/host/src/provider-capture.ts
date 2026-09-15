/**
 * Reassembling a chunked provider capture (RP-7).
 *
 * The worker sends a large request body as `begin`, bounded `chunk`s and an
 * `end` that declares how many chunks and how many bytes there were. This
 * holds the pieces until the end, checks that what arrived is exactly what was
 * announced — order, count, size and digest — and then hands the body to the
 * log store once.
 *
 * Every bound is a scope: one session, one worker generation, and the host as
 * a whole. Crossing any of them ends the oldest capture in that scope, and
 * ending a capture — for any reason, including success — releases its pieces
 * in the same step. A capture that does not complete is still a row: the
 * request happened, and the row says its exact size, its digest and why the
 * body is not there. Nothing here logs a body, a preview or a session path.
 *
 * These messages arrive only on the host's own pipe to a worker it started.
 * They are never accepted from a client socket, and they never leave the host
 * (`broadcast` drops every capture message before serialization).
 */
import {
  CAPTURE_ACCUM_ACTOR_BYTES,
  CAPTURE_ACCUM_GLOBAL_BYTES,
  CAPTURE_ACCUM_SESSION_BYTES,
  CAPTURE_ID_MAX,
  CAPTURE_MAX_BYTES,
  CAPTURE_OPEN_GLOBAL,
  CAPTURE_OPEN_SESSION,
  findCredentialShapedKeys,
  isProviderCaptureId,
  redact,
  type ProviderCaptureMeta,
  type ProviderCaptureOmission,
} from "@lasercode/protocol";
import { createHash } from "node:crypto";

export interface CaptureComplete {
  cwd: string;
  sessionPath: string;
  meta: ProviderCaptureMeta;
  /** The redacted body, exactly as it will be stored. */
  body: string;
}

export interface CaptureAbsent {
  cwd: string;
  sessionPath: string;
  meta: ProviderCaptureMeta;
  reason: ProviderCaptureOmission;
}

type DefenceResult =
  | { ok: true; body: string; redactedFields: number }
  | { ok: false; reason: ProviderCaptureOmission };

/**
 * Metadata for a body this host had to change.
 *
 * Size, digest, preview and redaction count describe the **stored** redacted
 * representation — the only thing anybody can ever read back — so they are
 * recomputed from the bytes that are about to be written rather than inherited
 * from what the producer announced. The producer's own count is kept as a
 * floor: it redacted fields too, and this pass only saw what it left behind.
 */
function restate(meta: ProviderCaptureMeta, body: string, redactedHere: number): ProviderCaptureMeta {
  return {
    ...meta,
    bytes: Buffer.byteLength(body, "utf8"),
    sha256: createHash("sha256").update(body).digest("hex"),
    preview: body.slice(0, meta.preview.length > 0 ? meta.preview.length : CAPTURE_PREVIEW_CHARS),
    redactedFields: Math.max(meta.redactedFields, redactedHere),
  };
}

/** Leading characters kept on a row, matching the producer's own preview. */
const CAPTURE_PREVIEW_CHARS = 240;

export interface CaptureAccumulatorOptions {
  /** A capture arrived whole; store it. */
  onComplete: (input: CaptureComplete) => void;
  /** A capture happened and its body is not kept; record the row and why. */
  onAbsent: (input: CaptureAbsent) => void;
  /** Numbers and key names only; never a body, a preview or a path. */
  log?: (message: string) => void;
}

interface Open {
  actor: string;
  sessionPath: string;
  meta: ProviderCaptureMeta;
  pieces: string[];
  bytes: number;
  next: number;
  startedAt: number;
}

export interface CaptureRetention {
  open: number;
  bytes: number;
}

export class CaptureAccumulator {
  private readonly open = new Map<string, Open>();
  private bytes = 0;

  constructor(private readonly options: CaptureAccumulatorOptions) {}

  /** Open captures and the bytes they hold, for the RP-3 counters. */
  retained(): CaptureRetention {
    return { open: this.open.size, bytes: this.bytes };
  }

  begin(actor: string, sessionPath: string, meta: ProviderCaptureMeta): void {
    if (!isProviderCaptureId(meta.captureId, CAPTURE_ID_MAX)) return;
    if (!Number.isInteger(meta.bytes) || meta.bytes < 0 || meta.bytes > CAPTURE_MAX_BYTES) {
      this.options.onAbsent({ cwd: actor, sessionPath, meta, reason: "corrupt" });
      return;
    }
    // An id already in flight is two streams under one name. Neither may be
    // merged into the other, so the incumbent ends as it stands.
    const existing = this.open.get(meta.captureId);
    if (existing) this.end(meta.captureId, "interrupted");
    this.evictFor(actor, sessionPath, meta.bytes);
    this.open.set(meta.captureId, {
      actor,
      sessionPath,
      meta,
      pieces: [],
      bytes: 0,
      next: 0,
      startedAt: Date.now(),
    });
  }

  chunk(captureId: string, index: number, text: string): void {
    const entry = this.open.get(captureId);
    if (!entry) return;
    if (index !== entry.next) {
      this.end(captureId, "corrupt");
      return;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (entry.bytes + bytes > entry.meta.bytes) {
      this.end(captureId, "corrupt");
      return;
    }
    entry.pieces.push(text);
    entry.bytes += bytes;
    entry.next += 1;
    this.bytes += bytes;
    this.evictFor(entry.actor, entry.sessionPath, 0, captureId);
  }

  finish(captureId: string, chunks: number, bytes: number): void {
    const entry = this.open.get(captureId);
    if (!entry) return;
    if (entry.next !== chunks || entry.bytes !== bytes || entry.bytes !== entry.meta.bytes) {
      this.end(captureId, "corrupt");
      return;
    }
    const body = entry.pieces.join("");
    this.release(captureId);
    const digest = createHash("sha256").update(body).digest("hex");
    if (digest !== entry.meta.sha256) {
      this.options.onAbsent({ cwd: entry.actor, sessionPath: entry.sessionPath, meta: entry.meta, reason: "corrupt" });
      return;
    }
    // Exactly one terminal outcome per capture, and the metadata on it always
    // describes the bytes that are actually stored.
    const defended = this.defend(body);
    if (!defended.ok) {
      this.options.onAbsent({ cwd: entry.actor, sessionPath: entry.sessionPath, meta: entry.meta, reason: defended.reason });
      return;
    }
    this.options.onComplete({
      cwd: entry.actor,
      sessionPath: entry.sessionPath,
      meta: defended.body === body ? entry.meta : restate(entry.meta, defended.body, defended.redactedFields),
      body: defended.body,
    });
  }

  /** A worker generation is gone: nothing it opened can ever complete. */
  actorGone(actor: string): void {
    for (const [id, entry] of [...this.open]) {
      if (entry.actor === actor) this.end(id, "interrupted");
    }
  }

  /** Every open capture ends as it stands; used when the host is closing. */
  clear(): void {
    for (const id of [...this.open.keys()]) this.end(id, "interrupted");
  }

  /**
   * The host's own guard over a body it did not redact itself.
   *
   * The producer runs the same projection this package exports, so a survivor
   * means an older worker generation, a bug or something hostile. The body is
   * redacted again here rather than stored as it arrived, and the log line
   * names the **keys** that were caught, never their values.
   */
  private defend(body: string): DefenceResult {
    const survivors = findCredentialShapedKeys(body);
    if (survivors.length === 0) return { ok: true, body, redactedFields: 0 };
    this.options.log?.(
      `provider capture: ${survivors.length} credential-shaped field(s) were not redacted by the worker (${survivors.join(", ")}); redacted here`,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Not parseable and carrying something credential-shaped: nothing is
      // stored, and the row says so. The caller emits that outcome, and only
      // that one.
      return { ok: false, reason: "corrupt" };
    }
    const { value, count } = redact(parsed);
    const redacted = JSON.stringify(value);
    if (redacted === undefined) return { ok: false, reason: "corrupt" };
    return { ok: true, body: redacted, redactedFields: count };
  }

  /** End one capture with a reason, releasing its pieces. */
  private end(captureId: string, reason: ProviderCaptureOmission): void {
    const entry = this.open.get(captureId);
    if (!entry) return;
    this.release(captureId);
    this.options.onAbsent({ cwd: entry.actor, sessionPath: entry.sessionPath, meta: entry.meta, reason });
  }

  private release(captureId: string): void {
    const entry = this.open.get(captureId);
    if (!entry) return;
    this.bytes = Math.max(0, this.bytes - entry.bytes);
    entry.pieces.length = 0;
    this.open.delete(captureId);
  }

  /**
   * Make room for `incoming` bytes in every scope this capture belongs to:
   * its session, its worker generation, and the host. The oldest capture in
   * the offending scope goes first, and it goes as a row, not as silence.
   */
  private evictFor(actor: string, sessionPath: string, incoming: number, keep?: string): void {
    const scopes = [
      { name: "session", bytesMax: CAPTURE_ACCUM_SESSION_BYTES, openMax: CAPTURE_OPEN_SESSION, match: (e: Open) => e.sessionPath === sessionPath },
      { name: "worker", bytesMax: CAPTURE_ACCUM_ACTOR_BYTES, openMax: Number.POSITIVE_INFINITY, match: (e: Open) => e.actor === actor },
      { name: "host", bytesMax: CAPTURE_ACCUM_GLOBAL_BYTES, openMax: CAPTURE_OPEN_GLOBAL, match: () => true },
    ];
    for (const scope of scopes) {
      for (;;) {
        const members = [...this.open].filter(([id, entry]) => scope.match(entry) && id !== keep);
        const used = members.reduce((sum, [, entry]) => sum + entry.bytes, 0) + incoming;
        const count = members.length + (keep === undefined ? 1 : 0);
        if (used <= scope.bytesMax && count <= scope.openMax) break;
        const oldest = members.sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
        if (!oldest) break;
        this.end(oldest[0], "interrupted");
      }
    }
  }
}
