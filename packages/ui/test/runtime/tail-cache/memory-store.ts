/**
 * A `TailStore` in memory, for the focused tests **only**.
 *
 * It lives under `test/` on purpose. There is no in-memory store in the
 * product: a cache a reload disproves would make the durability the settings
 * screen claims a lie, so an unavailable IndexedDB is a refusal rather than a
 * substitute (RP-10, D-l). `tail-cache-authority.test.ts` proves nothing under
 * `src/` can reach this file.
 *
 * It also injects the faults a real database can produce and a fake one
 * usually cannot: a transaction that will not commit, a delete that silently
 * keeps the row, a cursor that takes longer than the pass is allowed, and a
 * scan that fails outright.
 */
import { TAIL_SCAN_LIMITS } from "../../../src/runtime/tail-cache/bounds.js";
import type { ScanOptions, ScanReport, TailRow, TailStore } from "../../../src/runtime/tail-cache/store.js";
import { rowStoredBytes } from "../../../src/runtime/tail-cache/store.js";
import type { TailKey } from "../../../src/runtime/tail-cache/record.js";

export interface MemoryStoreFaults {
  /** Every `put` fails to commit. */
  refusePut?: boolean;
  /** The first `n` puts fail; later ones commit (a quota that eviction fixes). */
  refuseFirstPuts?: number;
  /** `remove` reports success but the rows stay: the un-verifiable purge. */
  silentRemove?: boolean;
  /** `remove` fails outright. */
  refuseRemove?: boolean;
  /** `scan` cannot be taken at all. */
  refuseScan?: boolean;
  /** Milliseconds the fake clock advances per scanned batch. */
  msPerBatch?: number;
}

export interface MemoryTailStore extends TailStore {
  readonly rows: Map<string, TailRow>;
  /** Transactions this store has been asked to commit, for the batching test. */
  readonly transactions: { put: number; remove: number; scan: number };
}

const keyText = (key: TailKey | { environmentKey: string; sessionId: string }): string =>
  Array.isArray(key) ? `${key[0]}\u0000${key[1]}` : `${key.environmentKey}\u0000${key.sessionId}`;

export function createMemoryTailStore(
  seed: readonly TailRow[] = [],
  faults: MemoryStoreFaults = {},
  clock?: { now: number },
): MemoryTailStore {
  const rows = new Map<string, TailRow>();
  for (const row of seed) rows.set(keyText(row), row);
  const transactions = { put: 0, remove: 0, scan: 0 };
  let puts = 0;
  let closed = false;

  return {
    durable: true,
    rows,
    transactions,

    async scan(options: ScanOptions, visit): Promise<ScanReport> {
      const report: ScanReport = { outcome: "complete", rowsSeen: 0, bytesSeen: 0 };
      if (closed || faults.refuseScan) return { ...report, outcome: "failed" };
      const all = [...rows.values()];
      for (let index = 0; index < all.length; index += options.batch) {
        transactions.scan += 1;
        for (const row of all.slice(index, index + options.batch)) {
          report.rowsSeen += 1;
          report.bytesSeen += rowStoredBytes(row);
          if (report.rowsSeen > options.rows) return { ...report, outcome: "over-rows" };
          if (report.bytesSeen > options.bytes) return { ...report, outcome: "over-bytes" };
          if (visit(row) === false) return report;
        }
        if (clock && faults.msPerBatch) clock.now += faults.msPerBatch;
        if (index + options.batch < all.length) {
          if (options.deadline !== undefined && (clock?.now ?? Date.now()) > options.deadline) {
            return { ...report, outcome: "over-time" };
          }
          await Promise.resolve();
        }
      }
      return report;
    },

    put(row) {
      transactions.put += 1;
      puts += 1;
      if (closed || faults.refusePut) return Promise.resolve(false);
      if (faults.refuseFirstPuts !== undefined && puts <= faults.refuseFirstPuts) return Promise.resolve(false);
      rows.set(keyText(row), { ...row });
      return Promise.resolve(true);
    },

    async remove(keys, batch) {
      if (closed || faults.refuseRemove) return false;
      for (let index = 0; index < keys.length; index += batch) {
        transactions.remove += 1;
        if (!faults.silentRemove) for (const key of keys.slice(index, index + batch)) rows.delete(keyText(key));
        if (index + batch < keys.length) await Promise.resolve();
      }
      // Verified the way the real store verifies: a row still present means the
      // purge did not happen, whatever the deletes reported.
      return !keys.some((key) => rows.has(keyText(key)));
    },

    close() {
      closed = true;
    },
  };
}

export const BATCH = TAIL_SCAN_LIMITS.batchRows;
