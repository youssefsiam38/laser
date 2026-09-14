/**
 * What happens to what the browser remembers when the product is renamed
 * (MX-T7, D-36).
 *
 * Every key this app writes is namespaced: `<name>-panels`, `<name>.theme`,
 * `<name>-env:<environment>:…`, and the app-shell caches under
 * `<name>-shell-<build>`. A rename changes the prefix, and to the person that
 * looks like the app forgetting their theme and their panel sizes — on a
 * phone, where there is nothing to inspect and nobody to ask.
 *
 * What a rename may **not** carry forward is anything that names a
 * conversation: an environment-scoped key cannot be proved to belong to the
 * environment this build will connect to, and the pre-environment keys never
 * recorded one at all (RP-13). Those are dropped here, not copied.
 *
 * So on boot, before anything reads a key, every key under a former prefix is
 * copied to the current one. It is deliberately conservative:
 *
 * - **It never overwrites.** A key that already exists under the current name
 *   wins; the old one is left alone.
 * - **It removes the old key only once the new one is written**, so an
 *   exception half-way through (quota, a private window, storage disabled)
 *   cannot lose a value.
 * - **It never throws.** `localStorage` can throw on *access*, not just on
 *   write — Safari in private mode, a browser configured to block site data —
 *   and a boot step that cannot run must not stop the app from opening.
 *
 * With no former names it does nothing, which is today's answer.
 */
import { FORMER_NAMES, STORAGE_PREFIX } from "@lasercode/protocol";
import { isLegacyDeviceKey, namespaceOf } from "../runtime/device-storage.js";

export interface StorageMigrationResult {
  /** Keys moved onto the current prefix. */
  moved: string[];
  /** Keys left alone because the current name already had one. */
  kept: string[];
  /**
   * Keys removed instead of moved: they carry conversation content or a path
   * with no environment behind it (RP-13, `runtime/device-storage.ts`).
   */
  dropped: string[];
  /** Cache Storage buckets deleted because they belong to a former name. */
  caches: string[];
}

const EMPTY: StorageMigrationResult = { moved: [], kept: [], dropped: [], caches: [] };

/** `laser-` and `laser.` — both separators this app has ever used. */
function prefixesFor(name: string): string[] {
  return [`${name}-`, `${name}.`];
}

/**
 * Move every `localStorage` key from a former prefix onto the current one.
 *
 * Exported separately from the cache half so it can be tested against a plain
 * object standing in for `Storage`. `formerNames` is a parameter only so a test
 * can exercise the move while the real list is empty.
 */
export function migrateStorageKeys(
  storage: Storage | null | undefined,
  formerNames: readonly { storagePrefix: string }[] = FORMER_NAMES,
): StorageMigrationResult {
  if (!storage || formerNames.length === 0) return EMPTY;
  const moved: string[] = [];
  const kept: string[] = [];
  const dropped: string[] = [];
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) keys.push(key);
    }
    for (const key of keys) {
      for (const former of formerNames) {
        for (const [slot, oldPrefix] of prefixesFor(former.storagePrefix).entries()) {
          if (!key.startsWith(oldPrefix)) continue;
          const next = `${prefixesFor(STORAGE_PREFIX)[slot]}${key.slice(oldPrefix.length)}`;
          if (next === key) continue;
          // A rename must never carry an unsafe key forward (RP-13). The old
          // unscoped keys named sessions and projects without recording which
          // environment they came from, and an environment namespace from
          // before the rename cannot be proved to be this environment's, so
          // both are dropped rather than copied onto the current name.
          if (isLegacyDeviceKey(next) || namespaceOf(next) !== undefined) {
            dropped.push(key);
            storage.removeItem(key);
            continue;
          }
          if (storage.getItem(next) !== null) {
            kept.push(key);
            continue;
          }
          const value = storage.getItem(key);
          if (value === null) continue;
          // Written first, removed second: an exception between the two leaves
          // the value under the old name, which the next boot picks up again.
          storage.setItem(next, value);
          storage.removeItem(key);
          moved.push(key);
        }
      }
    }
  } catch {
    // Storage is unavailable or full. The app opens with its defaults, which is
    // what happens on a fresh install too.
  }
  return { moved, kept, dropped, caches: [] };
}

/**
 * Delete app-shell caches left behind by a former name.
 *
 * These are not migrated but dropped: a cache holds a build's own assets keyed
 * by a hash of that build, so the current build's entries are the only useful
 * ones, and the service worker fills them again on the next load.
 */
export async function dropFormerCaches(): Promise<string[]> {
  if (FORMER_NAMES.length === 0 || typeof caches === "undefined") return [];
  const dropped: string[] = [];
  try {
    for (const name of await caches.keys()) {
      if (name.startsWith(`${STORAGE_PREFIX}-shell-`)) continue;
      if (!FORMER_NAMES.some((former) => name.startsWith(`${former.storagePrefix}-shell-`))) continue;
      if (await caches.delete(name)) dropped.push(name);
    }
  } catch {
    // Cache Storage is unavailable (a non-secure origin, or a browser that
    // blocks it). Nothing to do, and nothing worth saying.
  }
  return dropped;
}

/**
 * The whole migration, for the app's boot path. Never throws, never blocks
 * first paint on the cache half.
 */
export function migrateFormerBrowserStorage(): StorageMigrationResult {
  let storage: Storage | null = null;
  try {
    storage = globalThis.localStorage ?? null;
  } catch {
    storage = null;
  }
  const result = migrateStorageKeys(storage);
  void dropFormerCaches().then((caches) => result.caches.push(...caches));
  return result;
}
