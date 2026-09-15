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
  redactForStorage,
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
  key: string;
  actor: CaptureActor;
  sessionPath: string;
  meta: ProviderCaptureMeta;
  pieces: string[];
  /** Bytes actually received so far. */
  bytes: number;
  /** Announced size, held against every bound from `begin` until it ends. */
  reserved: number;
  next: number;
  startedAt: number;
}

/**
 * Who a capture belongs to.
 *
 * `generation` is the exact worker process: opaque, host-internal, and the
 * only thing ownership is keyed by, so a late message from a process that has
 * been replaced can never touch its successor's capture. `cwd` is carried for
 * the row the capture becomes and is never an identity.
 */
export interface CaptureActor {
  generation: string;
  cwd: string;
}

export interface CaptureRetention {
  /** Captures open right now. */
  open: number;
  /** Bytes actually held in memory. */
  bytes: number;
  /** Announced-but-not-yet-received bytes still reserved against the bounds. */
  reservedBytes: number;
}

function keyOf(generation: string, captureId: string): string {
  return `${generation}\u0000${captureId}`;
}

export class CaptureAccumulator {
  private readonly open = new Map<string, Open>();
  private bytes = 0;

  constructor(private readonly options: CaptureAccumulatorOptions) {}

  /**
   * What the host is holding for captures in flight, for the RP-3 counters.
   * Reserved bytes are announced sizes not yet received: they are held against
   * every bound from `begin`, so captures that start empty cannot each claim a
   * full capture's worth later.
   */
  retained(): CaptureRetention {
    let reservedBytes = 0;
    for (const entry of this.open.values()) reservedBytes += Math.max(0, entry.reserved - entry.bytes);
    return { open: this.open.size, bytes: this.bytes, reservedBytes };
  }

  begin(actor: CaptureActor, sessionPath: string, meta: ProviderCaptureMeta): void {
    if (!isProviderCaptureId(meta.captureId, CAPTURE_ID_MAX)) return;
    if (!Number.isInteger(meta.bytes) || meta.bytes < 0 || meta.bytes > CAPTURE_MAX_BYTES) {
      this.options.onAbsent({ cwd: actor.cwd, sessionPath, meta, reason: "corrupt" });
      return;
    }
    const key = keyOf(actor.generation, meta.captureId);
    // An id already in flight **for this generation** is two streams under one
    // name. Neither may be merged into the other, so the incumbent ends as it
    // stands. Another generation using the same id is a different capture.
    if (this.open.has(key)) this.end(key, "interrupted");
    const entry: Open = {
      key,
      actor,
      sessionPath,
      meta,
      pieces: [],
      bytes: 0,
      reserved: meta.bytes,
      next: 0,
      startedAt: Date.now(),
    };
    this.open.set(key, entry);
    // The new capture is inside every bound from this moment, and is its own
    // last resort: a capture that alone exceeds its scope ends itself.
    this.enforce(entry);
  }

  chunk(actor: CaptureActor, captureId: string, index: number, text: string): void {
    const key = keyOf(actor.generation, captureId);
    const entry = this.open.get(key);
    if (!entry) return;
    if (index !== entry.next) {
      this.end(key, "corrupt");
      return;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (entry.bytes + bytes > entry.meta.bytes) {
      this.end(key, "corrupt");
      return;
    }
    entry.pieces.push(text);
    entry.bytes += bytes;
    entry.next += 1;
    this.bytes += bytes;
    this.enforce(entry);
  }

  finish(actor: CaptureActor, captureId: string, chunks: number, bytes: number): void {
    const key = keyOf(actor.generation, captureId);
    const entry = this.open.get(key);
    if (!entry) return;
    if (entry.next !== chunks || entry.bytes !== bytes || entry.bytes !== entry.meta.bytes) {
      this.end(key, "corrupt");
      return;
    }
    const body = entry.pieces.join("");
    this.release(key);
    const digest = createHash("sha256").update(body).digest("hex");
    if (digest !== entry.meta.sha256) {
      this.options.onAbsent({ cwd: entry.actor.cwd, sessionPath: entry.sessionPath, meta: entry.meta, reason: "corrupt" });
      return;
    }
    // Exactly one terminal outcome per capture, and the metadata on it always
    // describes the bytes that are actually stored.
    const defended = this.defend(body);
    if (!defended.ok) {
      this.options.onAbsent({ cwd: entry.actor.cwd, sessionPath: entry.sessionPath, meta: entry.meta, reason: defended.reason });
      return;
    }
    this.options.onComplete({
      cwd: entry.actor.cwd,
      sessionPath: entry.sessionPath,
      meta: defended.body === body ? entry.meta : restate(entry.meta, defended.body, defended.redactedFields),
      body: defended.body,
    });
  }

  /**
   * The producer gave up on a capture it had begun (RP-7).
   *
   * The one atomic path for that, keyed by the capture id: the pieces are
   * released and the request is recorded exactly once, with the metadata the
   * capture announced and the producer's reason. An id nobody opened is
   * ignored — its row, if it needed one, was written when `begin` refused it.
   */
  abort(actor: CaptureActor, captureId: string, reason: ProviderCaptureOmission): void {
    this.end(keyOf(actor.generation, captureId), reason);
  }

  /** That worker process is gone: nothing it opened can ever complete. */
  generationGone(generation: string): void {
    for (const [key, entry] of [...this.open]) {
      if (entry.actor.generation === generation) this.end(key, "interrupted");
    }
  }

  /** Every open capture ends as it stands; used when the host is closing. */
  clear(): void {
    for (const key of [...this.open.keys()]) this.end(key, "interrupted");
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
    // The same verified projection every durable path uses: it redacts, and
    // then reads its own output back. If anything credential-shaped is still
    // there, this body is not storable at all.
    const projected = redactForStorage(parsed);
    if (!projected.ok) {
      this.options.log?.(
        `provider capture: refused a body with ${projected.survivors.length} credential-shaped field(s) that redaction could not remove ` +
          `(${projected.survivors.join(", ")})`,
      );
      return { ok: false, reason: "unredacted" };
    }
    return { ok: true, body: projected.body, redactedFields: projected.redactedFields };
  }

  /** End one capture with a reason, releasing its pieces. */
  private end(key: string, reason: ProviderCaptureOmission): void {
    const entry = this.open.get(key);
    if (!entry) return;
    this.release(key);
    this.options.onAbsent({ cwd: entry.actor.cwd, sessionPath: entry.sessionPath, meta: entry.meta, reason });
  }

  private release(key: string): void {
    const entry = this.open.get(key);
    if (!entry) return;
    this.bytes = Math.max(0, this.bytes - entry.bytes);
    entry.pieces.length = 0;
    this.open.delete(key);
  }

  /**
   * Hold every scope this capture belongs to inside its bounds.
   *
   * The capture being filled counts towards `used` and `count` like any other
   * — excluding it was how four captures could begin empty and then retain
   * 64 MiB against a 48 MiB bound — and it is only excluded from the list of
   * captures that may be ended to make room. If a scope is still over its
   * bound with nothing else left to end, the capture ends itself: a bound that
   * exempts its own cause is not a bound.
   */
  private enforce(current: Open): void {
    const held = (entry: Open): number => Math.max(entry.bytes, entry.reserved);
    const scopes: Array<{ bytesMax: number; openMax: number; match: (entry: Open) => boolean }> = [
      {
        bytesMax: CAPTURE_ACCUM_SESSION_BYTES,
        openMax: CAPTURE_OPEN_SESSION,
        match: (entry) => entry.sessionPath === current.sessionPath && entry.actor.generation === current.actor.generation,
      },
      {
        bytesMax: CAPTURE_ACCUM_ACTOR_BYTES,
        openMax: Number.POSITIVE_INFINITY,
        match: (entry) => entry.actor.generation === current.actor.generation,
      },
      { bytesMax: CAPTURE_ACCUM_GLOBAL_BYTES, openMax: CAPTURE_OPEN_GLOBAL, match: () => true },
    ];
    for (const scope of scopes) {
      for (;;) {
        const members = [...this.open.values()].filter((entry) => scope.match(entry));
        const used = members.reduce((sum, entry) => sum + held(entry), 0);
        if (used <= scope.bytesMax && members.length <= scope.openMax) break;
        const victims = members.filter((entry) => entry.key !== current.key).sort((a, b) => a.startedAt - b.startedAt);
        const victim = victims[0] ?? (this.open.has(current.key) ? current : undefined);
        if (!victim) break;
        this.end(victim.key, "interrupted");
        if (victim.key === current.key) break;
      }
    }
  }
}
