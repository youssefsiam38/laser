/**
 * The bounded ports the focused tail-cache tests run against.
 *
 * Deliberately not a database. happy-dom has no IndexedDB, and this milestone
 * takes **no new dependency** for one: real IndexedDB semantics — an
 * interrupted transaction, an incompatible version, a blocked delete — are
 * proved in browser acceptance (`scripts/browser-check/test/device-tail-cache.mjs`),
 * where there is a real browser to prove them in. What lives here is the
 * behaviour a port can model faithfully: ordering, ceilings, deadlines, faults,
 * and the exact bytes of what is stored.
 *
 * Everything under `test/`, never imported by `src/`: production stores durably
 * or refuses (`authority.test.ts` proves it).
 */
import { DEFAULT_CACHE_POLICY, PRODUCT_VERSION, type CachePolicy, type EnvironmentDescriptor } from "@lasercode/protocol";
import { expect } from "vitest";

import { TAIL_RECORD_SCHEMA, TAIL_SCAN_LIMITS } from "../../../src/runtime/tail-cache/bounds.js";
import { createTailCache, type TailCache } from "../../../src/runtime/tail-cache/cache.js";
import {
  TAIL_PAYLOAD_VERSION,
  checksumOf,
  contentText,
  payloadBytes,
  payloadText,
  type TailAttachmentRef,
  type TailEntryRecord,
  type TailKey,
  type TailPayload,
} from "../../../src/runtime/tail-cache/record.js";
import type { ScanOptions, ScanReport, StoredRow, TailRow, TailStore } from "../../../src/runtime/tail-cache/store.js";
import { storedRowBytes } from "../../../src/runtime/tail-cache/store.js";
import { NULL_VAULT, type TailVault } from "../../../src/runtime/tail-cache/vault.js";
import { VIEW_TAIL_SCHEMA, type ViewTailDto } from "../../../src/runtime/view-tail.js";

/**
 * One clock for the cache and every port it talks to.
 *
 * Production has one (`Date.now`), and a port that compared a caller's
 * deadline against a different clock would expire a pass that had its whole
 * budget left — a trap this suite fell into twice. `harness()` resets it.
 */
export const BASE_NOW = 1_700_000_000_000;
export const clock = { now: BASE_NOW };

export const ENV_A = "e1.AAAAAAAAAAAAAAAAAAAAAA";
export const ENV_B = "e1.BBBBBBBBBBBBBBBBBBBBBB";
export const REVISION = "r1.abcdefgh.AAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const REVISION_2 = "r1.abcdefgh.BBBBBBBBBBBBBBBBBBBBBBBBBBB";
export const REVISION_3 = "r1.abcdefgh.CCCCCCCCCCCCCCCCCCCCCCCCCCC";

export function descriptor(environmentKey = ENV_A, cache: Partial<CachePolicy> = {}): EnvironmentDescriptor {
  return {
    contract: "ep1",
    version: PRODUCT_VERSION,
    environmentKey,
    deployment: "local",
    actor: { class: "local_browser", id: "actor" },
    capabilities: { revisions: true, deltas: true, snapshots: true, durableReads: true, search: true, diagnostics: true, logs: true, push: false },
    cache: { ...DEFAULT_CACHE_POLICY, ...cache },
    scopes: [],
    localOnly: [],
  };
}

export const entry = (id: string, text = "hello", parentId: string | null = null): TailEntryRecord => ({
  id,
  parentId,
  json: JSON.stringify({ id, parentId, type: "message", message: { role: "user", content: [{ type: "text", text }] } }),
});

export const picture = (id: string, bytes: number): TailEntryRecord => ({
  id,
  parentId: null,
  json: JSON.stringify({
    id,
    parentId: null,
    type: "message",
    message: { role: "user", content: [{ type: "image", mimeType: "image/png", data: "A".repeat(bytes) }] },
  }),
});

export function tail(overrides: Partial<ViewTailDto> = {}): ViewTailDto {
  return Object.freeze({
    schema: VIEW_TAIL_SCHEMA,
    path: "/p/a.jsonl",
    sessionId: "session-a",
    environmentKey: ENV_A,
    revision: REVISION,
    epoch: "epoch-1",
    seq: 7,
    leafId: "e2",
    capturedAt: new Date(1_700_000_000_000).toISOString(),
    entries: Object.freeze([entry("e1"), entry("e2", "world", "e1")]),
    truncated: false,
    bytes: 200,
    ...overrides,
  }) as ViewTailDto;
}

/** A payload exactly as the cache writes one. */
export function payloadOf(options: {
  entries?: readonly TailEntryRecord[];
  attachments?: readonly TailAttachmentRef[];
  revision?: string;
  epoch?: string;
  seq?: number;
  leafId?: string | null;
  truncated?: boolean;
  omitted?: number;
} = {}): { payload: TailPayload; text: string; bytes: number } {
  const content = {
    entries: options.entries ?? [entry("e1")],
    attachments: options.attachments ?? [],
  };
  const payload: TailPayload = {
    v: TAIL_PAYLOAD_VERSION,
    revision: options.revision ?? REVISION,
    leafId: options.leafId ?? null,
    epoch: options.epoch ?? "epoch-1",
    seq: options.seq ?? 3,
    truncated: options.truncated ?? false,
    attachmentsOmitted: options.omitted ?? 0,
    checksum: checksumOf(contentText(content)),
    content,
  };
  const text = payloadText(payload);
  return { payload, text, bytes: payloadBytes(text) };
}

/** One stored row, written the way the cache writes them. */
export function row(overrides: Partial<TailRow> = {}, payload = payloadOf()): TailRow {
  return {
    schema: TAIL_RECORD_SCHEMA,
    appVersion: PRODUCT_VERSION,
    environmentKey: ENV_A,
    sessionId: "session-a",
    capturedAt: new Date(1_699_999_000_000).toISOString(),
    lastUsedAt: new Date(1_699_999_000_000).toISOString(),
    bytes: payload.bytes,
    body: { kind: "plain", text: payload.text },
    ...overrides,
  };
}

export interface StoreFaults {
  /** `put` never settles. */
  stuckPut?: boolean;
  /** `put` waits for this before committing: a store write a test can release. */
  pausePut?: Promise<void>;
  /** A row whose metadata is a Windows-style locator. */
  windowsLocatorRows?: number;
  /** `scan` rejects outright (a store that throws rather than reports). */
  rejectScan?: boolean;
  /** `scan` never settles. */
  stuckScan?: boolean;
  /** `remove` never settles. */
  stuckRemove?: boolean;
  /** `remove` waits for this before deleting: a proved deletion a test can hold open. */
  pauseRemove?: Promise<void>;
  /** `scan` hands back a row with a key this build cannot address. */
  unaddressableRows?: number;
  /** Every `put` fails to commit. */
  refusePut?: boolean;
  /** The first `n` puts fail; later ones commit (a quota eviction can fix). */
  refuseFirstPuts?: number;
  /** A store with a capacity of its own: it refuses while it holds this many. */
  capacity?: number;
  /** `remove` reports success but the rows stay: the un-provable purge. */
  silentRemove?: boolean;
  /** `remove` fails outright. */
  refuseRemove?: boolean;
  /** `scan` cannot be taken at all. */
  refuseScan?: boolean;
  /** Milliseconds the fake clock advances per scanned batch. */
  msPerBatch?: number;
  /** Scan reports this outcome instead of running (a partial pass). */
  scanOutcome?: ScanReport["outcome"];
  /** Rows to hand back with a malformed primary key. */
  malformedKeys?: number;
}

export interface TestStore extends TailStore {
  readonly rows: Map<string, TailRow>;
  readonly transactions: { put: number; remove: number; scan: number };
  faults: StoreFaults;
}

const keyText = (key: TailKey | { environmentKey: string; sessionId: string }): string =>
  Array.isArray(key) ? `${key[0]}\u0000${key[1]}` : `${key.environmentKey}\u0000${key.sessionId}`;

export function createTestStore(seed: readonly TailRow[] = [], faults: StoreFaults = {}, time: { now: number } = clock): TestStore {
  const rows = new Map<string, TailRow>();
  for (const stored of seed) rows.set(keyText(stored), stored);
  const transactions = { put: 0, remove: 0, scan: 0 };
  let puts = 0;
  let closed = false;

  const store: TestStore = {
    durable: true,
    rows,
    transactions,
    faults,

    async scan(options: ScanOptions, visit): Promise<ScanReport> {
      const report: ScanReport = { outcome: "complete", rowsSeen: 0, bytesSeen: 0 };
      if (store.faults.rejectScan) throw new Error("this store throws instead of reporting");
      if (store.faults.stuckScan) return new Promise<never>(() => {});
      if (closed || store.faults.refuseScan) return { ...report, outcome: "failed" };
      if (store.faults.scanOutcome && store.faults.scanOutcome !== "complete") {
        return { ...report, outcome: store.faults.scanOutcome, rowsSeen: 1, bytesSeen: 1 };
      }
      const all: StoredRow[] = [...rows.entries()].map(([key, value]) => ({
        key: [value.environmentKey, value.sessionId],
        row: value,
        stored: key,
      }));
      for (let index = 0; index < (store.faults.windowsLocatorRows ?? 0); index += 1) {
        // A locator is a locator on every platform.
        all.unshift({
          key: [ENV_A, `C:\\Users\\someone\\sessions\\${index}.jsonl`],
          row: {
            schema: TAIL_RECORD_SCHEMA,
            appVersion: PRODUCT_VERSION,
            environmentKey: ENV_A,
            sessionId: `C:\\Users\\someone\\sessions\\${index}.jsonl`,
            capturedAt: new Date(1_699_999_000_000).toISOString(),
            lastUsedAt: new Date(1_699_999_000_000).toISOString(),
            bytes: 10,
            body: { kind: "plain", text: "{}" },
          },
        });
      }
      for (let index = 0; index < (store.faults.unaddressableRows ?? 0); index += 1) {
        // No usable primary key at all: nothing can delete this row, which is
        // why a pass that meets one must fail closed.
        all.unshift({ key: "not-a-key", row: { schema: TAIL_RECORD_SCHEMA, appVersion: PRODUCT_VERSION } });
      }
      for (let index = 0; index < (store.faults.malformedKeys ?? 0); index += 1) {
        // A row this build could not have written: addressable only by the key
        // the store hands over with it.
        all.unshift({
          key: [ENV_A, `malformed-${index}`],
          // This build's schema and version, and junk everywhere else: it is
          // addressable, so it must be *removable*, which is the point.
          row: { schema: TAIL_RECORD_SCHEMA, appVersion: PRODUCT_VERSION, environmentKey: 7, sessionId: null, body: "no" },
        });
      }
      for (let index = 0; index < all.length; index += options.batch) {
        transactions.scan += 1;
        for (const stored of all.slice(index, index + options.batch)) {
          report.rowsSeen += 1;
          report.bytesSeen += storedRowBytes((stored.row as { body?: TailRow["body"] } | undefined)?.body);
          if (report.rowsSeen > options.rows) return { ...report, outcome: "over-rows" };
          if (report.bytesSeen > options.bytes) return { ...report, outcome: "over-bytes" };
          if (visit(stored) === false) return report;
        }
        if (store.faults.msPerBatch) time.now += store.faults.msPerBatch;
        if (index + options.batch < all.length) {
          if (options.deadline !== undefined && time.now > options.deadline) {
            return { ...report, outcome: "over-time" };
          }
          await Promise.resolve();
        }
      }
      return report;
    },

    async put(stored) {
      if (store.faults.stuckPut) return new Promise<never>(() => {});
      if (store.faults.pausePut) await store.faults.pausePut;
      transactions.put += 1;
      puts += 1;
      if (closed || store.faults.refusePut) return Promise.resolve(false);
      if (store.faults.refuseFirstPuts !== undefined && puts <= store.faults.refuseFirstPuts) return Promise.resolve(false);
      const replacing = rows.has(keyText(stored));
      if (store.faults.capacity !== undefined && !replacing && rows.size >= store.faults.capacity) return Promise.resolve(false);
      rows.set(keyText(stored), { ...stored });
      return Promise.resolve(true);
    },

    async remove(keys, batch, limits) {
      if (store.faults.stuckRemove) return new Promise<never>(() => {});
      if (store.faults.pauseRemove) await store.faults.pauseRemove;
      if (closed || store.faults.refuseRemove) return false;
      if (keys.length > (limits?.rows ?? TAIL_SCAN_LIMITS.deleteRows)) return false;
      const expired = (): boolean => limits?.deadline !== undefined && time.now > limits.deadline;
      for (let index = 0; index < keys.length; index += batch) {
        if (expired()) return false;
        transactions.remove += 1;
        if (!store.faults.silentRemove) for (const key of keys.slice(index, index + batch)) rows.delete(keyText(key));
        if (index + batch < keys.length) await Promise.resolve();
      }
      // Verified the way the real store verifies it.
      return !keys.some((key) => rows.has(keyText(key)));
    },

    close() {
      closed = true;
    },
  };
  return store;
}

export interface Harness {
  cache: TailCache;
  store: TestStore;
  clock: { now: number };
  deferred(): number;
  flush(): Promise<void>;
  /** Run the deferred tasks but not the queue behind them. */
  deliver(): void;
}

export function harness(options: {
  rows?: readonly TailRow[];
  faults?: StoreFaults;
  vault?: TailVault;
  noStore?: boolean;
  openStore?: () => Promise<TailStore | undefined>;
  destroy?: () => Promise<"deleted" | "absent" | "blocked" | "failed">;
  appVersion?: string;
  store?: TestStore;
  /** How long one queued mutation may take. Small, so a stuck port is quick. */
  budgetMs?: number;
} = {}): Harness {
  clock.now = BASE_NOW;
  const store = options.store ?? createTestStore(options.rows ?? [], options.faults ?? {}, clock);
  const tasks: Array<() => void> = [];
  const cache = createTailCache({
    openStore: options.openStore ?? (() => Promise.resolve(options.noStore ? undefined : store)),
    resolveVault: () => Promise.resolve(options.vault ?? NULL_VAULT),
    destroy: options.destroy ?? (() => Promise.resolve("deleted")),
    appVersion: options.appVersion ?? PRODUCT_VERSION,
    now: () => clock.now,
    ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
    defer: (task) => tasks.push(task),
  });
  return {
    cache,
    store,
    clock,
    deferred: () => tasks.length,
    deliver() {
      for (const task of tasks.splice(0, tasks.length)) task();
    },
    async flush() {
      for (let round = 0; round < 4; round += 1) {
        for (const task of tasks.splice(0, tasks.length)) task();
        for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}

/** Assert the cache holds exactly these sessions, durably and in memory. */
export function expectHolds(view: Harness, sessionIds: readonly string[]): void {
  expect([...view.store.rows.values()].map((stored) => stored.sessionId).sort()).toEqual([...sessionIds].sort());
  expect(view.cache.counters().records).toBe(sessionIds.length);
}
