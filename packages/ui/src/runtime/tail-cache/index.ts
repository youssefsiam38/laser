/**
 * The device tail cache this app uses (RP-10).
 *
 * One instance, wired to the real browser: IndexedDB for storage, the desktop
 * bridge for a key the operating system holds, and deferred delivery so a write
 * never lands on the paint path. Everything it needs is injected, so the
 * focused tests stand a fake store, a fake vault and a fake clock in front of
 * the same authority without a seam that ships.
 */
import { PRODUCT_VERSION } from "@lasercode/protocol";
import { installViewTailSink } from "../view-tail.js";
import { createTailCache, type TailCache } from "./cache.js";
import { destroyTailDatabase, indexedDbFactory, openTailStore } from "./store.js";
import { createDesktopVault, desktopCacheBridge, NULL_VAULT } from "./vault.js";

/**
 * Deferred work, off the reducer and off the frame.
 *
 * `queueMicrotask` would still run before paint, which is exactly what RP-5's
 * release path avoids, so this is a macrotask — or the browser's own background
 * priority where it exists.
 */
function deferWork(task: () => void): void {
  const scheduler = (globalThis as typeof globalThis & {
    scheduler?: { postTask?: (callback: () => void, options?: { priority?: string }) => unknown };
  }).scheduler;
  if (scheduler?.postTask) {
    try {
      void scheduler.postTask(task, { priority: "background" });
      return;
    } catch {
      // Fall through to the timer: a scheduler that refuses is not a reason to
      // drop the write.
    }
  }
  setTimeout(task, 0);
}

export const tailCache: TailCache = createTailCache({
  openStore: () => openTailStore(indexedDbFactory(), { now: () => Date.now() }),
  resolveVault: () => {
    const bridge = desktopCacheBridge();
    if (!bridge) return Promise.resolve(NULL_VAULT);
    const subtle = globalThis.crypto?.subtle;
    const random = globalThis.crypto?.getRandomValues
      ? (into: Uint8Array) => {
        globalThis.crypto.getRandomValues(into);
      }
      : undefined;
    return createDesktopVault(bridge, subtle, random);
  },
  destroy: () => destroyTailDatabase(indexedDbFactory()),
  appVersion: PRODUCT_VERSION,
  now: () => Date.now(),
  defer: deferWork,
});

/**
 * Take the released transcripts of this renderer, for as long as an
 * environment is open.
 *
 * Installed once, here: RP-5 reads the installed sink at delivery time, so a
 * cache that is closed or refused simply drops what it is handed — the memory
 * was already released and the conversation is read from its host.
 */
export function installTailCacheSink(): void {
  installViewTailSink({ release: (tail) => tailCache.release(tail) });
}

export { createTailCache, type TailCache, type TailCacheDeps } from "./cache.js";
export { createLifecycle, type Lifecycle, type TailCacheState } from "./lifecycle.js";
export { createRecencyIndex, DURABLE_TOUCH_INTERVAL_MS, type HeldRow, type RecencyIndex } from "./recency.js";
export { QUEUE_LIMITS, createMutationOwner, type MutationOwner } from "./mutations.js";
export {
  carriesOnlyKnownFields,
  fitRelease,
  openPayload,
  parseStoredRow,
  readableAge,
  storedBytesOf,
  type ValidatedRow,
} from "./admission.js";
export { deviceCacheStore, type DeviceCacheCounters, type TailDiscardReason } from "./counters.js";
export {
  TAIL_HARD_LIMITS,
  TAIL_RECORD_SCHEMA,
  TAIL_SCAN_LIMITS,
  boundsFor,
  policyAdmits,
  type ScanOutcome,
  type TailBounds,
  type TailRefusal,
} from "./bounds.js";
export {
  TAIL_ATTACHMENT_MARKER_KEY,
  TAIL_OMITTED_ATTACHMENT,
  TAIL_PAYLOAD_VERSION,
  checksumOf,
  contentText,
  identityAad,
  payloadBytes,
  payloadText,
  type TailAttachmentRef,
  type TailEntryRecord,
  type TailKey,
  type TailPayload,
  type TailRecord,
} from "./record.js";
export {
  TAIL_DATABASE_NAME,
  TAIL_DATABASE_VERSION,
  TAIL_STORE_NAME,
  deletionPending,
  destroyTailDatabase,
  indexedDbFactory,
  openTailStore,
  storedRowBytes,
  whenDeletionSettles,
  type StoredRow,
  type TailRow,
  type TailStore,
} from "./store.js";
export { NULL_VAULT, createDesktopVault, unencryptedVault, type EncryptionState, type TailVault } from "./vault.js";
