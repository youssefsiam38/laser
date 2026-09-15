/**
 * How much of this worker's memory provider captures may hold at once (RP-7).
 *
 * The host bounds what it is reassembling. Nothing bounded what the *worker*
 * was holding while it sent: every session's companion extension held its own
 * serialized body and the pieces it was cutting from it, so ten sessions
 * capturing at the same moment held ten bodies, and no rule anywhere said
 * otherwise.
 *
 * This is that rule, and it is one object for the whole process — every
 * session's extension asks the same authority — bounded by the same numbers
 * the host uses for one worker's captures: its bytes, and how many may be in
 * flight at once. A capture that cannot be held is recorded without its body,
 * which is a row saying so, not a silence.
 */
import { CAPTURE_ACCUM_ACTOR_BYTES, CAPTURE_OPEN_GLOBAL, type CaptureReservation } from "@lasercode/protocol";

export class CaptureReservations {
  private bytes = 0;
  private open = 0;

  constructor(
    private readonly maxBytes: number = CAPTURE_ACCUM_ACTOR_BYTES,
    private readonly maxOpen: number = CAPTURE_OPEN_GLOBAL,
  ) {}

  /** What is held right now, for the retained-store counters. */
  held(): { bytes: number; open: number } {
    return { bytes: this.bytes, open: this.open };
  }

  /** `undefined` when there is no room. The caller records the row without a body. */
  reserve(bytes: number): CaptureReservation | undefined {
    if (!Number.isFinite(bytes) || bytes < 0) return undefined;
    if (this.open + 1 > this.maxOpen || this.bytes + bytes > this.maxBytes) return undefined;
    this.bytes += bytes;
    this.open += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.bytes = Math.max(0, this.bytes - bytes);
        this.open = Math.max(0, this.open - 1);
      },
    };
  }
}
