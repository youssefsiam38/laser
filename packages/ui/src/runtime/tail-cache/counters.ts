/**
 * What this device is holding, and why it is not holding more (RP-10, RP-3).
 *
 * Every number is exact or absent. A counter nobody can produce is left out
 * rather than reported as zero, which is the same rule the diagnostics surface
 * keeps for memory: "not reported" and "nothing retained" are different
 * sentences and a person can act on only one of them.
 *
 * These are **device-local**. `resource/snapshot` is answered by the host, and
 * one device's cache is not another's, so this producer stays in the renderer
 * and reaches the Resources table through its optional-store adapter — no wire,
 * no host round trip (the same arrangement RP-5 uses for `rendererViews`).
 */
import type { ScanOutcome, TailBounds, TailRefusal } from "./bounds.js";
import type { EncryptionState } from "./vault.js";

/** Why a record was thrown away rather than read. Counted, one per reason. */
export type TailDiscardReason =
  | "schema"
  | "version"
  | "invalid"
  | "corrupt"
  | "undecryptable"
  | "oversize"
  | "expired"
  | "foreign";

export const TAIL_DISCARD_REASONS: readonly TailDiscardReason[] = [
  "schema",
  "version",
  "invalid",
  "corrupt",
  "undecryptable",
  "oversize",
  "expired",
  "foreign",
] as const;

export type TailCacheStatus = "closed" | "preparing" | "open" | "refused";

export interface DeviceCacheCounters {
  readonly status: TailCacheStatus;
  readonly refusal?: TailRefusal | undefined;
  /** Which ceiling stopped the last pass, when one did (\u00a74.2). */
  readonly stoppedBy?: ScanOutcome | undefined;
  /** Records this environment holds on this device. */
  readonly records: number;
  /** Exact UTF-8 plaintext bytes those records carry. */
  readonly bytes: number;
  /** Records held in memory for a synchronous read. */
  readonly hotRecords: number;
  readonly hotBytes: number;
  readonly evictions: number;
  readonly writesRefused: number;
  readonly discarded: Readonly<Record<TailDiscardReason, number>>;
  readonly encryption: EncryptionState;
  /** True when a real durable store is behind this. Never faked. */
  readonly durable: boolean;
  readonly bounds?: TailBounds | undefined;
  readonly lastClearedAt?: string | undefined;
  /**
   * What the one mutation queue is holding right now. Writes and touches can
   * be shed; control ops (deletion, clearing, purging) never are, so this is
   * also the evidence that a deletion is not waiting behind a full write lane.
   */
  readonly queued?: { readonly writes: number; readonly touches: number; readonly control: number } | undefined;
}

/** The `deviceCache` entry of RP-3's retained-store counters. */
export function deviceCacheStore(counters: DeviceCacheCounters): { count: number; bytes: number } {
  return { count: counters.records, bytes: counters.bytes };
}

export function emptyDiscards(): Record<TailDiscardReason, number> {
  return { schema: 0, version: 0, invalid: 0, corrupt: 0, undecryptable: 0, oversize: 0, expired: 0, foreign: 0 };
}
