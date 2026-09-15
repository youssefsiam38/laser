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
  /**
   * The redacted body, when this host had to build it — a small capture, or
   * one it had to defend. Empty when `pieces` carries it instead, so a
   * multi-megabyte body is never held twice.
   */
  body: string;
  /** The pieces it arrived in, in order: the shape the store already keeps. */
  pieces?: readonly string[];
  /** Already written by the store, piece by piece, as it arrived. */
  stored?: { ref: string; bytes: number; preview: string };
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
    preview: body.slice(0, meta.preview && meta.preview.length > 0 ? meta.preview.length : CAPTURE_PREVIEW_CHARS),
    redactedFields: Math.max(meta.redactedFields, redactedHere),
  };
}

/** Leading characters kept on a row, matching the producer's own preview. */
const CAPTURE_PREVIEW_CHARS = 240;

export interface CaptureAccumulatorOptions {
  /**
   * Where a large body's pieces go as they arrive.
   *
   * With this, the host writes each piece and lets it go: a 12 MiB request
   * costs one piece of memory while it is arriving, not all of it. Without it
   * (a test with no store) the pieces are kept and handed over at the end.
   */
  openBody?: (meta: ProviderCaptureMeta) => CaptureBodySink | undefined;
  /** A capture arrived whole; store it. */
  onComplete: (input: CaptureComplete) => void;
  /** A capture happened and its body is not kept; record the row and why. */
  onAbsent: (input: CaptureAbsent) => void;
  /** Numbers and key names only; never a body, a preview or a path. */
  log?: (message: string) => void;
}

/** A body being written a piece at a time, from the store's side. */
export interface CaptureBodySink {
  write: (piece: string) => void;
  /** The row's size and digest, or `undefined` when the pieces are not a body. */
  finish: () => { ref: string; bytes: number } | undefined;
  abort: () => void;
}

interface Open {
  key: string;
  actor: CaptureActor;
  sessionPath: string;
  meta: ProviderCaptureMeta;
  /** Kept only when there is nowhere to stream them; see `openBody`. */
  pieces: string[];
  /** Where pieces are written as they arrive, when the store takes them. */
  sink: CaptureBodySink | undefined;
  /** The first characters of the body, kept for the row. */
  preview: string;
  /** Tail of the previous piece, so a key that straddles a cut is still seen. */
  carry: string;
  /** Credential-shaped keys seen while the pieces went past. */
  survivors: string[];
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

/**
 * Look for a credential-shaped key across pieces, with an overlap so one that
 * straddles a boundary is still seen. Key names only ever leave this function.
 */
function scanPieces(pieces: readonly string[]): string[] {
  const found: string[] = [];
  let carry = "";
  for (const piece of pieces) {
    for (const key of findCredentialShapedKeys(carry + piece)) if (!found.includes(key)) found.push(key);
    if (found.length > 0) break;
    carry = piece.slice(-OVERLAP_CHARS);
  }
  return found;
}

/** Enough to carry the longest credential-shaped key and its value across a cut. */
const OVERLAP_CHARS = 512;

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
    // A capture that announces no size or digest announces no body: there is
    // nothing to reassemble and nothing to verify it against.
    const announced = meta.bytes;
    if (announced === undefined || meta.sha256 === undefined || !Number.isInteger(announced) || announced < 0 || announced > CAPTURE_MAX_BYTES) {
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
      sink: this.options.openBody?.(meta),
      preview: "",
      carry: "",
      survivors: [],
      bytes: 0,
      reserved: announced,
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
    if (entry.bytes + bytes > (entry.meta.bytes ?? 0)) {
      this.end(key, "corrupt");
      return;
    }
    // Seen as it goes past, with an overlap so a credential-shaped key that
    // straddles a cut is not missed.
    for (const survivor of findCredentialShapedKeys(entry.carry + text)) {
      if (!entry.survivors.includes(survivor)) entry.survivors.push(survivor);
    }
    entry.carry = text.slice(-OVERLAP_CHARS);
    if (entry.preview.length < CAPTURE_PREVIEW_CHARS) entry.preview = (entry.preview + text).slice(0, CAPTURE_PREVIEW_CHARS);
    if (entry.sink && entry.survivors.length === 0) {
      // Written and let go: the host holds one piece, not the capture.
      entry.sink.write(text);
    } else {
      if (entry.sink) {
        // Something credential-shaped is in this body, so it cannot be stored
        // as it came. Stop writing and keep the pieces: the whole body is
        // needed to redact it, and only a capture that has one pays for that.
        entry.sink.abort();
        entry.sink = undefined;
      }
      entry.pieces.push(text);
    }
    entry.bytes += bytes;
    entry.next += 1;
    this.bytes += bytes;
    this.enforce(entry);
  }

  finish(actor: CaptureActor, captureId: string, chunks: number, bytes: number): void {
    const key = keyOf(actor.generation, captureId);
    const entry = this.open.get(key);
    if (!entry) return;
    if (entry.next !== chunks || entry.bytes !== bytes || entry.bytes !== (entry.meta.bytes ?? -1)) {
      this.end(key, "corrupt");
      return;
    }
    if (entry.sink && entry.survivors.length === 0) {
      // The store took every piece as it arrived; it verifies the digest of
      // what it has, and nothing here ever held the body.
      const stored = entry.sink.finish();
      entry.sink = undefined;
      const preview = entry.preview;
      this.release(key);
      if (!stored) {
        this.options.onAbsent({ cwd: entry.actor.cwd, sessionPath: entry.sessionPath, meta: entry.meta, reason: "corrupt" });
        return;
      }
      this.options.onComplete({
        cwd: entry.actor.cwd,
        sessionPath: entry.sessionPath,
        meta: entry.meta,
        body: "",
        stored: { ref: stored.ref, bytes: stored.bytes, preview },
      });
      return;
    }

    // No store to stream into, or a body that has to be defended: the pieces
    // are here, and the digest is taken over them as they are.
    const digest = createHash("sha256");
    for (const piece of entry.pieces) digest.update(piece);
    if (digest.digest("hex") !== entry.meta.sha256) {
      this.release(key);
      this.options.onAbsent({ cwd: entry.actor.cwd, sessionPath: entry.sessionPath, meta: entry.meta, reason: "corrupt" });
      return;
    }
    if (entry.survivors.length === 0) {
      const pieces = entry.pieces.slice();
      this.release(key);
      this.options.onComplete({ cwd: entry.actor.cwd, sessionPath: entry.sessionPath, meta: entry.meta, body: "", pieces });
      return;
    }
    const body = entry.pieces.join("");
    const survivors = entry.survivors.slice();
    this.release(key);
    const defended = this.defend(body, survivors);
    if (!defended.ok) {
      this.options.onAbsent({ cwd: entry.actor.cwd, sessionPath: entry.sessionPath, meta: entry.meta, reason: defended.reason });
      return;
    }
    this.options.onComplete({
      cwd: entry.actor.cwd,
      sessionPath: entry.sessionPath,
      meta: restate(entry.meta, defended.body, defended.redactedFields),
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
  private defend(body: string, survivors: string[]): DefenceResult {
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
    // Anything written for a capture that is ending goes with it.
    entry.sink?.abort();
    entry.sink = undefined;
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
