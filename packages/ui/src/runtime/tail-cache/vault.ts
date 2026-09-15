/**
 * Whether a cached conversation is encrypted at rest, and the honest answer
 * when it is not (RP-10).
 *
 * Two implementations, and no third:
 *
 * - {@link createDesktopVault} — the desktop app asks its own main process for
 *   a 32-byte key the operating system keeps for it (the keychain on macOS,
 *   Credential Manager on Windows, the system keyring on Linux), imports it as
 *   a **non-extractable** AES-256-GCM key, and seals every body with a fresh
 *   random IV and the record's identity as additional authenticated data. A
 *   ciphertext lifted into another row therefore does not open at all.
 * - {@link NULL_VAULT} — everywhere else: the browser, a phone, a desktop with
 *   no usable keychain, an insecure origin with no `crypto.subtle`. It stores
 *   the body as text and **says so**. There is deliberately no key file
 *   fallback: a key sitting beside the ciphertext is not encryption, and
 *   claiming otherwise would be the dishonest kind of comfort.
 *
 * What this protects: the bytes at rest in this origin's storage, against
 * another process, a backup or a file sync reading the profile. What it does
 * not protect: a compromised renderer (which holds the plaintext anyway) or a
 * memory dump. On a local desktop the session files themselves are plaintext,
 * so the value here is that the cache does not add a second plaintext copy
 * somewhere nobody thinks to look; on a paired phone, where no session files
 * exist, it is the whole story.
 */

/** What a person is told about storage on this device. */
export type EncryptionState =
  | { kind: "os-backed"; store: string }
  /** The desktop asked and could not have a key. The reason is a sentence. */
  | { kind: "unavailable"; reason: string }
  /** Not a desktop: the browser owns this storage and nothing claims otherwise. */
  | { kind: "not-applicable" };

export type SealedBody =
  | { readonly kind: "plain"; readonly text: string }
  | { readonly kind: "aes-gcm-256"; readonly iv: Uint8Array; readonly data: ArrayBuffer };

export interface TailVault {
  readonly encryption: EncryptionState;
  /** True only when the bytes at rest are encrypted with an OS-held key. */
  readonly encrypted: boolean;
  seal(text: string, aad: string): Promise<SealedBody | undefined>;
  open(body: SealedBody, aad: string): Promise<string | undefined>;
}

/** The shape the desktop bridge answers with (`packages/desktop/src/api.ts`). */
export interface DeviceCacheKeyBridge {
  key(): Promise<{ available: true; key: string; store: string } | { available: false; reason: string }>;
  reset(): Promise<{ available: true; key: string; store: string } | { available: false; reason: string }>;
}

export const NULL_VAULT: TailVault = {
  encryption: { kind: "not-applicable" },
  encrypted: false,
  seal: (text) => Promise.resolve({ kind: "plain", text } as const),
  open: (body) => Promise.resolve(body.kind === "plain" ? body.text : undefined),
};

/** A desktop that asked and was refused. Stores plaintext, and reports why. */
export function unencryptedVault(reason: string): TailVault {
  return { ...NULL_VAULT, encryption: { kind: "unavailable", reason } };
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const base64urlToBytes = (value: string): Uint8Array | undefined => {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
};

/**
 * Resolve the vault for this device.
 *
 * One attempt, no retry loop: a locked or absent keychain is a state to report,
 * not something to ask about again on every write. The raw key string is
 * dropped as soon as the key is imported — a JavaScript string cannot be wiped,
 * which is said here rather than pretended away, but the imported key is
 * non-extractable so nothing can read it back out of the crypto subsystem.
 */
export async function createDesktopVault(
  bridge: DeviceCacheKeyBridge | undefined,
  subtle: SubtleCrypto | undefined,
  randomBytes: ((into: Uint8Array) => void) | undefined,
): Promise<TailVault> {
  if (!bridge) return NULL_VAULT;
  if (!subtle || !randomBytes) {
    return unencryptedVault("This view cannot encrypt anything, because the browser engine it is running in offers no cryptography here.");
  }
  let answer: Awaited<ReturnType<DeviceCacheKeyBridge["key"]>>;
  try {
    answer = await bridge.key();
  } catch {
    return unencryptedVault("This computer did not answer when asked for the key it keeps for cached conversations.");
  }
  if (!answer.available) return unencryptedVault(answer.reason);
  const bytes = base64urlToBytes(answer.key);
  if (!bytes || bytes.length !== 32) {
    return unencryptedVault("The key this computer keeps for cached conversations could not be read.");
  }
  let key: CryptoKey;
  try {
    key = await subtle.importKey("raw", bytes as unknown as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } catch {
    return unencryptedVault("This computer's key for cached conversations could not be used by this view.");
  }
  bytes.fill(0);
  const store = answer.store;
  return {
    encryption: { kind: "os-backed", store },
    encrypted: true,
    async seal(text, aad) {
      try {
        const iv = new Uint8Array(12);
        randomBytes(iv);
        const data = await subtle.encrypt(
          { name: "AES-GCM", iv: iv as unknown as BufferSource, additionalData: textEncoder.encode(aad) as unknown as BufferSource },
          key,
          textEncoder.encode(text) as unknown as BufferSource,
        );
        return { kind: "aes-gcm-256", iv, data };
      } catch {
        return undefined;
      }
    },
    async open(body, aad) {
      if (body.kind !== "aes-gcm-256") return undefined;
      try {
        const plain = await subtle.decrypt(
          { name: "AES-GCM", iv: body.iv as unknown as BufferSource, additionalData: textEncoder.encode(aad) as unknown as BufferSource },
          key,
          body.data,
        );
        return textDecoder.decode(plain);
      } catch {
        // A wrong key, a flipped byte, a row from another identity: all of them
        // fail closed, and the caller discards the record.
        return undefined;
      }
    },
  };
}

/** The bridge this device exposes, if it is the desktop app. */
export function desktopCacheBridge(): DeviceCacheKeyBridge | undefined {
  const desktop = (globalThis as typeof globalThis & { desktop?: { deviceCache?: DeviceCacheKeyBridge } }).desktop;
  return desktop?.deviceCache;
}
