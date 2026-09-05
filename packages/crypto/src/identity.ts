/**
 * Where the root identity lives.
 *
 * The seed never touches a piorbit file on disk. On the desktop it goes into the
 * OS keychain through `@napi-rs/keyring` (keytar is archived and unmaintained,
 * so it is not an option). This module deliberately does NOT depend on that
 * package: `@lasercode/crypto` also runs in a browser, where a native addon cannot
 * be resolved. The desktop injects a keyring entry that satisfies
 * `KeyringEntryLike`, which is exactly the shape of `@napi-rs/keyring`'s `Entry`.
 */
import { fromBase64Url, toBase64Url, wipe } from "./bytes.js";
import { generateRootSeed, rootIdentityFromSeed, type RootIdentity } from "./device-list.js";
import { FORMER_NAMES, PRODUCT_NAME } from "@lasercode/protocol/identity";

/**
 * The OS keychain service the root identity is stored under.
 *
 * Derived, so a rename renames it too — and `readEnv`-style fallbacks are not
 * enough here: the entry itself moves. `identityStoreFormerServices` below is
 * what a store consults before deciding a device has no identity yet.
 */
export const KEYCHAIN_SERVICE: string = PRODUCT_NAME;

/**
 * Keychain services this product used before it was renamed, newest first.
 *
 * A store reads the current service, then these, so a person who paired their
 * phone under the old name keeps that pairing instead of silently becoming a
 * new device.
 */
export const KEYCHAIN_FORMER_SERVICES: readonly string[] = FORMER_NAMES.map((former) => former.name);
export const KEYCHAIN_ROOT_ACCOUNT = "root-identity";

export class IdentityStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IdentityStoreError";
  }
}

export interface RootIdentityStore {
  /** Human-readable, for error messages: "the macOS keychain", "~/.piorbit/identity.key". */
  readonly description: string;
  load(): Promise<Uint8Array | null>;
  save(seed: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}

/** The subset of `@napi-rs/keyring`'s `Entry` that this package uses. */
export interface KeyringEntryLike {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

/** Tests and ephemeral hosts. Nothing survives the process. */
export class MemoryRootIdentityStore implements RootIdentityStore {
  readonly description = "process memory (not persisted)";
  private seed: Uint8Array | null = null;

  async load(): Promise<Uint8Array | null> {
    return this.seed ? Uint8Array.from(this.seed) : null;
  }
  async save(seed: Uint8Array): Promise<void> {
    this.seed = Uint8Array.from(seed);
  }
  async clear(): Promise<void> {
    if (this.seed) wipe(this.seed);
    this.seed = null;
  }
}

/**
 * Wrap an OS keychain entry. On the desktop:
 *
 *   import { Entry } from "@napi-rs/keyring";
 *   const store = createKeyringRootIdentityStore(
 *     new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ROOT_ACCOUNT), "the OS keychain");
 */
export function createKeyringRootIdentityStore(entry: KeyringEntryLike, description = "the OS keychain"): RootIdentityStore {
  return {
    description,
    async load(): Promise<Uint8Array | null> {
      let stored: string | null;
      try {
        stored = entry.getPassword();
      } catch (cause) {
        // A locked keychain throws rather than returning null; say so.
        throw new IdentityStoreError(`could not read the root identity from ${description}: unlock it and try again`, { cause });
      }
      if (!stored) return null;
      try {
        const seed = fromBase64Url(stored);
        if (seed.length !== 32) throw new Error(`expected 32 bytes, got ${seed.length}`);
        return seed;
      } catch (cause) {
        throw new IdentityStoreError(
          `the root identity in ${description} is damaged. Remove the "${KEYCHAIN_SERVICE}" entry and pair your devices again.`,
          { cause },
        );
      }
    },
    async save(seed: Uint8Array): Promise<void> {
      try {
        entry.setPassword(toBase64Url(seed));
      } catch (cause) {
        throw new IdentityStoreError(`could not write the root identity to ${description}`, { cause });
      }
    },
    async clear(): Promise<void> {
      try {
        entry.deletePassword();
      } catch (cause) {
        throw new IdentityStoreError(`could not remove the root identity from ${description}`, { cause });
      }
    },
  };
}

/**
 * Load the root identity, creating it on first run. `created` is true only when
 * a new key was generated, which is the moment every existing pairing dies — the
 * caller should say so rather than silently orphaning phones.
 */
export async function loadOrCreateRootIdentity(
  store: RootIdentityStore,
): Promise<{ identity: RootIdentity; created: boolean }> {
  const existing = await store.load();
  if (existing) {
    const identity = rootIdentityFromSeed(existing);
    wipe(existing);
    return { identity, created: false };
  }
  const seed = generateRootSeed();
  await store.save(seed);
  const identity = rootIdentityFromSeed(seed);
  wipe(seed);
  return { identity, created: true };
}
