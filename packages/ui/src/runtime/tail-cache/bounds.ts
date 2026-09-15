/**
 * What this device may keep, and what one pass over it may touch (RP-10).
 *
 * Two different kinds of number live here, and confusing them is the bug this
 * file exists to prevent:
 *
 * - {@link TAIL_HARD_LIMITS} is **what may be kept**: records, exact UTF-8
 *   bytes, entries and age. The environment's own policy narrows it and never
 *   widens it, exactly as `clampCachePolicy` already guarantees on the wire.
 * - {@link TAIL_SCAN_LIMITS} is **what may be touched while deciding**: rows
 *   read, bytes read, rows deleted, wall clock, batch size and how long a
 *   blocked database may be waited on. A pre-existing database this build did
 *   not write can be arbitrarily large or arbitrarily hostile, and a pass that
 *   cannot finish inside these ceilings **fails closed**: the cache does not
 *   open, nothing is read, and nothing is written over bytes whose provenance
 *   was never established. That is the same rule `device-storage.ts` already
 *   keeps for `localStorage`.
 *
 * Pure: no DOM, no storage, no React.
 */
import type { CachePolicy } from "@lasercode/protocol";

/** Record generation. Any change to the stored shape changes this string. */
export const TAIL_RECORD_SCHEMA = "tail-cache/2";

/** Ceilings that apply however generous an environment's policy is. */
export const TAIL_HARD_LIMITS = {
  /** Records one environment may hold. */
  sessions: 24,
  /** Exact UTF-8 plaintext bytes across every record of one environment. */
  bytes: 8 * 1024 * 1024,
  /** Exact UTF-8 plaintext bytes of one record. Matches RP-5's tail bound. */
  bytesPerSession: 256 * 1024,
  /** Entries of one record. Matches RP-5's tail bound. */
  entriesPerSession: 40,
  /** Age of a record, in hours. */
  ageHours: 336,
  /** Base64 payload a picture may keep inline instead of becoming a reference. */
  inlineAttachmentBytes: 4 * 1024,
  /** Records held in memory for a synchronous `peek`. */
  hotRecords: 8,
  /** Exact UTF-8 plaintext bytes held in memory for a synchronous `peek`. */
  hotBytes: 2 * 1024 * 1024,
} as const;

/** Ceilings on one pass over the database. Hitting any of them fails closed. */
export const TAIL_SCAN_LIMITS = {
  /** Rows one pass may examine, across every environment in the database. */
  scanRows: 2_000,
  /** Stored bytes one pass may read while examining rows. */
  scanBytes: 24 * 1024 * 1024,
  /** Rows one pass may delete. */
  deleteRows: 2_000,
  /** Wall clock for a whole preparation pass, inside the handshake budget. */
  prepareMs: 500,
  /** Rows per transaction before the pass yields to the event loop. */
  batchRows: 100,
  /** The yield itself: one macrotask, never a busy loop. */
  yieldMs: 0,
  /** How long an `open`/`delete` may be blocked by another connection. */
  blockedMs: 250,
  /** Records decrypted while warming the hot set. */
  warmRecords: 8,
} as const;

/** Why a pass stopped. `complete` is the only outcome that may open a cache. */
export type ScanOutcome = "complete" | "over-rows" | "over-bytes" | "over-time" | "failed";

/** The bounds actually in force: the policy and the hard limits, intersected. */
export interface TailBounds {
  sessions: number;
  bytes: number;
  bytesPerSession: number;
  entriesPerSession: number;
  ageMs: number;
  /** May a picture's bytes be referenced at all, or not even that? */
  attachments: "reference" | "none";
  inlineAttachmentBytes: number;
}

/** Narrowing only: every dimension takes the smaller of policy and ceiling. */
export function boundsFor(policy: CachePolicy): TailBounds {
  const min = (a: number, b: number): number => (a < b ? a : b);
  return {
    sessions: min(policy.maxSessions, TAIL_HARD_LIMITS.sessions),
    bytes: min(policy.maxBytes, TAIL_HARD_LIMITS.bytes),
    // A per-record cap can never exceed the whole environment's budget.
    bytesPerSession: min(min(policy.maxBytes, TAIL_HARD_LIMITS.bytesPerSession), TAIL_HARD_LIMITS.bytes),
    entriesPerSession: min(policy.maxEntriesPerSession, TAIL_HARD_LIMITS.entriesPerSession),
    ageMs: min(policy.maxAgeHours, TAIL_HARD_LIMITS.ageHours) * 60 * 60 * 1000,
    attachments: policy.attachments === "none" ? "none" : "reference",
    inlineAttachmentBytes: policy.attachments === "none" ? 0 : TAIL_HARD_LIMITS.inlineAttachmentBytes,
  };
}

/**
 * Why transcript content is not being kept on this device.
 *
 * The first five are `device-storage.ts`'s own vocabulary, repeated verbatim so
 * a person reads the same sentence about drafts and about conversations. The
 * last two are this cache's own: a browser that will not give us a database,
 * and a database whose contents could not be established.
 */
export type TailRefusal = "inactive" | "unavailable" | "policy" | "bounds" | "encryption" | "storage" | "purge";

/** Is the environment's validated policy one that admits content at all? */
export function policyAdmits(policy: CachePolicy): TailRefusal | undefined {
  if (policy.transcripts === "disabled") return "policy";
  if (policy.maxBytes <= 0 || policy.maxSessions <= 0 || policy.maxEntriesPerSession <= 0 || policy.maxAgeHours <= 0) {
    return "bounds";
  }
  return undefined;
}
