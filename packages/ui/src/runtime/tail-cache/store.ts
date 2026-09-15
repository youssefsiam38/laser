/**
 * Where a cached tail actually lives (RP-10).
 *
 * One IndexedDB database, one object store, rows keyed by
 * `[environmentKey, sessionId]` — opaque identity and nothing else. The path is
 * an index, because that is what a navigation has in its hand; it is never part
 * of a key, and a row is refused whatever its path says when its environment is
 * not the live one.
 *
 * One database rather than one per environment on purpose: purging a foreign
 * environment is then a bounded cursor delete inside a store this build already
 * has open, and needs no `indexedDB.databases()` — which Firefox does not
 * implement. Deleting *everything* is still one `deleteDatabase`.
 *
 * Atomicity comes from IndexedDB itself: one `readwrite` transaction per write
 * commits or does not, so there is no half-written row to read back. Every scan
 * and every delete runs in bounded batches with a yield between them, so a pass
 * over somebody else's enormous database cannot cost a frame — and a pass that
 * reaches a ceiling stops and says which one.
 *
 * `TailStore` is a port with exactly one production implementation. There is
 * deliberately **no** in-memory production store: a cache that a reload
 * disproves would make the durability this device's settings screen claims a
 * lie. The in-memory store used by the focused tests lives under `test/`.
 */
import { storageKey } from "@lasercode/protocol";
import type { SealedBody } from "./vault.js";
import { TAIL_SCAN_LIMITS, type ScanOutcome } from "./bounds.js";
import type { TailAttachmentRef, TailKey } from "./record.js";

/** `laser-tails`. The product's own prefix, generated, never spelled out. */
export const TAIL_DATABASE_NAME = storageKey("tails");
export const TAIL_DATABASE_VERSION = 1;
export const TAIL_STORE_NAME = "records";
export const TAIL_PATH_INDEX = "by-path";

/** Exactly what is persisted. Identity in the clear, body sealed. */
export interface TailRow {
  schema: string;
  appVersion: string;
  environmentKey: string;
  sessionId: string;
  path: string;
  revision: string;
  leafId: string | null;
  epoch: string;
  seq: number;
  truncated: boolean;
  attachments: TailAttachmentRef[];
  attachmentsOmitted: number;
  bytes: number;
  capturedAt: string;
  lastUsedAt: string;
  checksum: string;
  body: SealedBody;
}

export interface ScanOptions {
  /** Rows this pass may examine. */
  rows: number;
  /** Stored bytes this pass may read. */
  bytes: number;
  /** Rows per transaction before yielding. */
  batch: number;
  /** A deadline in `Date.now()` terms, or `undefined` for no clock bound. */
  deadline?: number | undefined;
}

export interface ScanReport {
  outcome: ScanOutcome;
  rowsSeen: number;
  bytesSeen: number;
}

export interface TailStore {
  /** True for real storage. Always true in production (there is one store). */
  readonly durable: boolean;
  /**
   * Visit rows in key order, bounded. The visitor is called for every row the
   * pass examines; returning `false` stops the pass as `complete`.
   */
  scan(options: ScanOptions, visit: (row: TailRow) => boolean | void): Promise<ScanReport>;
  /** One atomic write. `false` means the transaction did not commit. */
  put(row: TailRow): Promise<boolean>;
  /** Delete these keys in bounded batches, then prove they are gone. */
  remove(keys: readonly TailKey[], batch: number): Promise<boolean>;
  close(): void;
}

/** One macrotask. Never a busy loop. */
export const yieldToLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, TAIL_SCAN_LIMITS.yieldMs));

/**
 * What a row actually cost to read, measured rather than believed.
 *
 * Deliberately **not** `row.bytes`: that field is what some build of this app
 * claimed the plaintext weighed, and a row this one did not write can claim
 * anything. Trusting it let a single hostile row exhaust the scan's byte
 * ceiling, and a pass that fails closed then never reaches the delete that
 * would have removed it — a row that could not be read would have made the
 * cache permanently refuse. Only the bytes really read are counted, plus a
 * fixed allowance for the identity fields beside them.
 */
export function rowStoredBytes(row: TailRow): number {
  const body = row.body as SealedBody | undefined;
  const bodyBytes = body === undefined
    ? 0
    : body.kind === "plain"
      ? body.text.length
      : (body.data?.byteLength ?? 0) + (body.iv?.byteLength ?? 0);
  return bodyBytes + ROW_IDENTITY_ALLOWANCE;
}

/** Identity, accounting and reference fields beside a body, generously. */
const ROW_IDENTITY_ALLOWANCE = 2_048;

const request = <T>(value: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("request failed"));
  });

/**
 * Open the database, bounded.
 *
 * `undefined` means this device will not give us storage — a private window,
 * blocked site data, a leftover database at a newer version this build cannot
 * read, or another connection holding an upgrade open past `blockedMs`. Every
 * one of those is the same honest answer to the caller: no durable cache, and
 * **never** an in-memory substitute.
 */
export async function openTailStore(
  factory: IDBFactory | undefined,
  blockedMs: number = TAIL_SCAN_LIMITS.blockedMs,
): Promise<TailStore | undefined> {
  if (!factory) return undefined;
  let database: IDBDatabase | undefined;
  try {
    database = await new Promise<IDBDatabase | undefined>((resolve) => {
      let settled = false;
      const settle = (value: IDBDatabase | undefined): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let open: IDBOpenDBRequest;
      try {
        open = factory.open(TAIL_DATABASE_NAME, TAIL_DATABASE_VERSION);
      } catch {
        settle(undefined);
        return;
      }
      const blocked = setTimeout(() => settle(undefined), blockedMs);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(TAIL_STORE_NAME)) {
          const store = db.createObjectStore(TAIL_STORE_NAME, { keyPath: ["environmentKey", "sessionId"] });
          store.createIndex(TAIL_PATH_INDEX, ["environmentKey", "path"], { unique: false });
        }
      };
      open.onsuccess = () => {
        clearTimeout(blocked);
        settle(open.result);
      };
      open.onerror = () => {
        clearTimeout(blocked);
        settle(undefined);
      };
      // Another tab is holding an older generation open. Bounded, then refused:
      // half a database is not something to read a conversation out of.
      open.onblocked = () => {};
    });
  } catch {
    return undefined;
  }
  if (!database) return undefined;
  if (!database.objectStoreNames.contains(TAIL_STORE_NAME)) {
    database.close();
    return undefined;
  }
  let closed = false;
  // Another context asking for a version change must not be blocked by us.
  database.onversionchange = () => {
    closed = true;
    database?.close();
  };

  const transaction = (mode: IDBTransactionMode): IDBObjectStore | undefined => {
    if (closed) return undefined;
    try {
      return database!.transaction(TAIL_STORE_NAME, mode).objectStore(TAIL_STORE_NAME);
    } catch {
      closed = true;
      return undefined;
    }
  };

  return {
    durable: true,

    async scan(options, visit) {
      const report: ScanReport = { outcome: "complete", rowsSeen: 0, bytesSeen: 0 };
      let cursorKey: IDBValidKey | undefined;
      for (;;) {
        if (closed) return { ...report, outcome: "failed" };
        const store = transaction("readonly");
        if (!store) return { ...report, outcome: "failed" };
        let batch: TailRow[];
        try {
          const range = cursorKey === undefined ? null : IDBKeyRange.lowerBound(cursorKey, true);
          batch = await request(store.getAll(range, options.batch)) as TailRow[];
        } catch {
          return { ...report, outcome: "failed" };
        }
        if (batch.length === 0) return report;
        for (const row of batch) {
          report.rowsSeen += 1;
          report.bytesSeen += rowStoredBytes(row);
          if (report.rowsSeen > options.rows) return { ...report, outcome: "over-rows" };
          if (report.bytesSeen > options.bytes) return { ...report, outcome: "over-bytes" };
          if (visit(row) === false) return report;
        }
        const last = batch[batch.length - 1]!;
        cursorKey = [last.environmentKey, last.sessionId];
        if (batch.length < options.batch) return report;
        if (options.deadline !== undefined && Date.now() > options.deadline) return { ...report, outcome: "over-time" };
        await yieldToLoop();
      }
    },

    put(row) {
      const store = transaction("readwrite");
      if (!store) return Promise.resolve(false);
      return new Promise((resolve) => {
        const owner = store.transaction;
        owner.oncomplete = () => resolve(true);
        owner.onerror = () => resolve(false);
        owner.onabort = () => resolve(false);
        try {
          store.put(row);
        } catch {
          resolve(false);
        }
      });
    },

    async remove(keys, batch) {
      for (let index = 0; index < keys.length; index += batch) {
        const slice = keys.slice(index, index + batch);
        const store = transaction("readwrite");
        if (!store) return false;
        const committed = await new Promise<boolean>((resolve) => {
          const owner = store.transaction;
          owner.oncomplete = () => resolve(true);
          owner.onerror = () => resolve(false);
          owner.onabort = () => resolve(false);
          try {
            for (const key of slice) store.delete(key as unknown as IDBValidKey);
          } catch {
            resolve(false);
          }
        });
        if (!committed) return false;
        if (index + batch < keys.length) await yieldToLoop();
      }
      // Verified, not assumed: a delete that did not take must not leave the
      // cache open over bytes it believes are gone.
      const store = transaction("readonly");
      if (!store) return false;
      for (const key of keys) {
        try {
          const found = await request(store.getKey(key as unknown as IDBValidKey));
          if (found !== undefined) return false;
        } catch {
          return false;
        }
      }
      return true;
    },

    close() {
      closed = true;
      try {
        database!.close();
      } catch {
        // Already gone; nothing to do and nothing worth saying.
      }
    },
  };
}

export type DestroyOutcome = "deleted" | "absent" | "blocked" | "failed";

/**
 * Delete the whole database and prove it.
 *
 * The person's "forget everything" recovery promises removal, so this resolves
 * only when the delete has completed — or says `blocked`, which the caller
 * turns into "your browser is still holding this" rather than a reload that
 * claims success. Own connections must be closed by the caller first.
 */
export function destroyTailDatabase(
  factory: IDBFactory | undefined,
  blockedMs: number = TAIL_SCAN_LIMITS.blockedMs,
): Promise<DestroyOutcome> {
  if (!factory) return Promise.resolve("absent");
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: DestroyOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let deletion: IDBOpenDBRequest;
    try {
      deletion = factory.deleteDatabase(TAIL_DATABASE_NAME);
    } catch {
      settle("failed");
      return;
    }
    const timer = setTimeout(() => settle("blocked"), blockedMs);
    deletion.onsuccess = () => {
      clearTimeout(timer);
      settle("deleted");
    };
    deletion.onerror = () => {
      clearTimeout(timer);
      settle("failed");
    };
    deletion.onblocked = () => {
      // Left to the timer: another context may still close in time.
    };
  });
}

/** The browser's factory, read defensively (it throws in some sandboxes). */
export function indexedDbFactory(): IDBFactory | undefined {
  try {
    return globalThis.indexedDB ?? undefined;
  } catch {
    return undefined;
  }
}
