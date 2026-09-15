/**
 * Where a cached tail actually lives (RP-10).
 *
 * One IndexedDB database, one object store, rows keyed by
 * `[environmentKey, sessionId]` — opaque identity, and **nothing else**. There
 * is no second index: a path is a private locator and never reaches this file,
 * so the only way to a row is the identity the app already holds.
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
 * deliberately **no** in-memory production store: a cache a reload disproves
 * would make the durability this device's settings screen claims a lie.
 */
import { storageKey } from "@lasercode/protocol";
import { byteLength } from "../view-measure.js";
import type { SealedBody } from "./vault.js";
import { TAIL_SCAN_LIMITS, type ScanOutcome } from "./bounds.js";
import type { TailKey } from "./record.js";

/** `laser-tails`. The product's own prefix, generated, never spelled out. */
export const TAIL_DATABASE_NAME = storageKey("tails");
export const TAIL_DATABASE_VERSION = 2;
export const TAIL_STORE_NAME = "records";

/**
 * Exactly what is persisted, and no more.
 *
 * Everything derived from the conversation — entries, attachment references,
 * the revision, the branch leaf, the engine epoch and sequence, the checksum —
 * lives inside `body`, which the desktop seals. Outside it there is only what
 * this device needs to find the row and bound it. No path, and nothing shaped
 * like one.
 */
export interface TailRow {
  schema: string;
  appVersion: string;
  environmentKey: string;
  sessionId: string;
  capturedAt: string;
  lastUsedAt: string;
  /** Exact UTF-8 bytes of the payload inside `body`. Verified on every read. */
  bytes: number;
  body: SealedBody;
}

/** A row as the store hands it over: its primary key beside its unvalidated self. */
export interface StoredRow {
  readonly key: unknown;
  readonly row: unknown;
}

export interface ScanOptions {
  /** Rows this pass may examine. */
  rows: number;
  /** Stored bytes this pass may read. */
  bytes: number;
  /** Rows per transaction before yielding. */
  batch: number;
  /** A deadline in the caller's own clock, or `undefined` for no clock bound. */
  deadline?: number | undefined;
}

export interface ScanReport {
  outcome: ScanOutcome;
  rowsSeen: number;
  bytesSeen: number;
}

/** What one delete pass may spend. Both halves — delete and proof — obey it. */
export interface RemoveBounds {
  /** Keys one pass may delete. More than this is refused, not truncated. */
  rows?: number | undefined;
  /** A deadline in the caller's clock for the whole pass, verification included. */
  deadline?: number | undefined;
}

export interface TailStore {
  /** True for real storage. Always true in production (there is one store). */
  readonly durable: boolean;
  /**
   * Visit rows in key order, bounded, **with their primary keys**, so a row
   * whose own fields are malformed can still be removed.
   */
  scan(options: ScanOptions, visit: (stored: StoredRow) => boolean | void): Promise<ScanReport>;
  /** One atomic write. `false` means the transaction did not commit. */
  put(row: TailRow): Promise<boolean>;
  /**
   * Delete these keys in bounded batches, then prove they are gone.
   *
   * `false` for anything short of proof: too many keys for one pass, a
   * transaction that did not commit, a key still present afterwards, or a
   * deadline reached. A caller that cannot prove a deletion keeps the cache
   * shut rather than reading over bytes it believes are gone.
   */
  remove(keys: readonly TailKey[], batch: number, bounds?: RemoveBounds): Promise<boolean>;
  close(): void;
}

/** One macrotask. Never a busy loop. */
export const yieldToLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, TAIL_SCAN_LIMITS.yieldMs));

/** Identity and accounting fields beside a body, generously. */
export const ROW_IDENTITY_ALLOWANCE = 2_048;

/** What a row really cost to read, measured rather than believed. */
export function storedRowBytes(body: SealedBody | undefined): number {
  const bytes = body === undefined
    ? 0
    : body.kind === "plain"
      ? byteLength(body.text)
      : (body.data?.byteLength ?? 0) + (body.iv?.byteLength ?? 0);
  return bytes + ROW_IDENTITY_ALLOWANCE;
}

const request = <T>(value: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("request failed"));
  });

/**
 * Databases whose deletion has been asked for and has not settled.
 *
 * An IndexedDB delete request cannot be cancelled. When one is blocked past its
 * deadline the caller is told `blocked`, but the request stays live — and if
 * something opened the database again in the meantime, that late delete would
 * take the *successor*. So a pending deletion is tracked here, and no open is
 * allowed while one is outstanding: there is nothing for the late delete to
 * destroy but the database it was asked about.
 */
const pendingDeletions = new Map<string, Promise<void>>();

/** Is a deletion of this database still outstanding? */
export function deletionPending(name: string = TAIL_DATABASE_NAME): boolean {
  return pendingDeletions.has(name);
}

/** For tests and for an orderly shutdown: await whatever is outstanding. */
export function whenDeletionSettles(name: string = TAIL_DATABASE_NAME): Promise<void> {
  return pendingDeletions.get(name) ?? Promise.resolve();
}

/**
 * Open the database, bounded.
 *
 * `undefined` means this device will not give us storage — a private window,
 * blocked site data, a leftover database at a newer version this build cannot
 * read, another connection holding an upgrade open past `blockedMs`, or a
 * deletion of this database that has not settled yet. Every one of those is the
 * same honest answer to the caller: no durable cache, and **never** an
 * in-memory substitute.
 */
export async function openTailStore(
  factory: IDBFactory | undefined,
  options: { blockedMs?: number | undefined; now?: (() => number) | undefined } = {},
): Promise<TailStore | undefined> {
  if (!factory) return undefined;
  // Never race a deletion that is still outstanding.
  if (pendingDeletions.has(TAIL_DATABASE_NAME)) return undefined;
  const blockedMs = options.blockedMs ?? TAIL_SCAN_LIMITS.blockedMs;
  // One clock for the store and its caller: every deadline that reaches here
  // was computed from the *caller's* clock, and comparing it against a
  // different one would expire a pass that had its whole budget left.
  const now = options.now ?? (() => Date.now());
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
      // A blocked open is given `blockedMs` and then refused. If the request
      // succeeds afterwards, that connection is closed rather than left open.
      const blocked = setTimeout(() => {
        settle(undefined);
        try {
          open.result?.close();
        } catch {
          // Nothing opened yet; the success handler below closes a late one.
        }
      }, blockedMs);
      open.onupgradeneeded = () => {
        const db = open.result;
        // Generation 2 keys by identity alone and indexes nothing. An earlier
        // generation's store (which carried a path index) is replaced outright:
        // its rows are a schema this build refuses anyway.
        if (db.objectStoreNames.contains(TAIL_STORE_NAME)) db.deleteObjectStore(TAIL_STORE_NAME);
        db.createObjectStore(TAIL_STORE_NAME, { keyPath: ["environmentKey", "sessionId"] });
      };
      open.onsuccess = () => {
        clearTimeout(blocked);
        if (settled) {
          try {
            open.result.close();
          } catch {
            // Already closing; nothing to do.
          }
          return;
        }
        settle(open.result);
      };
      open.onerror = () => {
        clearTimeout(blocked);
        settle(undefined);
      };
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
        let keys: IDBValidKey[];
        let rows: unknown[];
        try {
          const range = cursorKey === undefined ? null : IDBKeyRange.lowerBound(cursorKey, true);
          keys = await request(store.getAllKeys(range, options.batch));
          rows = await request(store.getAll(range, options.batch)) as unknown[];
        } catch {
          return { ...report, outcome: "failed" };
        }
        if (keys.length === 0) return report;
        for (let index = 0; index < keys.length; index += 1) {
          const row = rows[index];
          report.rowsSeen += 1;
          report.bytesSeen += storedRowBytes((row as { body?: SealedBody } | undefined)?.body);
          if (report.rowsSeen > options.rows) return { ...report, outcome: "over-rows" };
          if (report.bytesSeen > options.bytes) return { ...report, outcome: "over-bytes" };
          if (visit({ key: keys[index], row }) === false) return report;
        }
        cursorKey = keys[keys.length - 1]!;
        if (keys.length < options.batch) return report;
        if (options.deadline !== undefined && now() > options.deadline) return { ...report, outcome: "over-time" };
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

    async remove(keys, batch, limits) {
      const rows = limits?.rows ?? TAIL_SCAN_LIMITS.deleteRows;
      // Refused, never truncated: a partial delete reported as a success is
      // exactly the lie this cache must not tell.
      if (keys.length > rows) return false;
      const expired = (): boolean => limits?.deadline !== undefined && now() > limits.deadline;
      for (let index = 0; index < keys.length; index += batch) {
        if (expired()) return false;
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
      // Verified, not assumed, and batched like the deletion itself: two
      // thousand reads in one transaction would be a frame, not a check.
      for (let index = 0; index < keys.length; index += batch) {
        if (expired()) return false;
        const store = transaction("readonly");
        if (!store) return false;
        try {
          for (const key of keys.slice(index, index + batch)) {
            const found = await request(store.getKey(key as unknown as IDBValidKey));
            if (found !== undefined) return false;
          }
        } catch {
          return false;
        }
        if (index + batch < keys.length) await yieldToLoop();
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
 * claims success. Own connections must be closed by the caller first, and while
 * a blocked request is outstanding {@link openTailStore} refuses to open, so
 * nothing can be created for the late delete to take.
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
    // Track it until it really settles: an uncancellable request must not be
    // able to delete a database opened after it was given up on.
    let finish: (() => void) | undefined;
    pendingDeletions.set(TAIL_DATABASE_NAME, new Promise<void>((done) => {
      finish = () => {
        pendingDeletions.delete(TAIL_DATABASE_NAME);
        done();
      };
    }));
    const timer = setTimeout(() => settle("blocked"), blockedMs);
    deletion.onsuccess = () => {
      clearTimeout(timer);
      finish?.();
      settle("deleted");
    };
    deletion.onerror = () => {
      clearTimeout(timer);
      finish?.();
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
