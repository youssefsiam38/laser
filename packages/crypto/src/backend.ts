/**
 * The two primitive backends behind one interface.
 *
 * `webcrypto` is preferred wherever the engine supports X25519 (Node 24 and
 * current browsers): the static private key is a **non-extractable** CryptoKey,
 * so a scripting bug in the PWA cannot exfiltrate a device's identity. `noble`
 * is the portable fallback and the only path that can import a raw private key,
 * which is what the Noise known-answer vectors need.
 *
 * Everything is async because WebCrypto is. Hashing (SHA-256, HMAC) is always
 * @noble: the Noise chaining key has to live in JS memory for MixKey to work,
 * so wrapping it in a CryptoKey would buy nothing and cost determinism.
 */
import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { randomBytes as nobleRandomBytes } from "@noble/hashes/utils.js";

import { bufferSource } from "./bytes.js";

export const DH_LEN = 32;
export const AEAD_KEY_LEN = 32;
export const AEAD_NONCE_LEN = 12;
export const AEAD_TAG_LEN = 16;

export type DhPrivateKey =
  | { readonly kind: "raw"; readonly bytes: Uint8Array }
  | { readonly kind: "webcrypto"; readonly key: CryptoKey };

export type AeadKey =
  | { readonly kind: "raw"; readonly bytes: Uint8Array }
  | { readonly kind: "webcrypto"; readonly key: CryptoKey };

export interface KeyPair {
  /** Raw 32-byte X25519 public key, always exportable — it goes on the wire. */
  readonly publicKey: Uint8Array;
  readonly privateKey: DhPrivateKey;
}

export interface CryptoBackend {
  readonly name: "webcrypto" | "noble";
  /** `extractable` only affects the WebCrypto backend; the noble backend is always raw. */
  generateKeyPair(options?: { extractable?: boolean }): Promise<KeyPair>;
  /** Rebuild a key pair from a stored 32-byte scalar (keychain restore, test vectors). */
  importKeyPair(rawPrivateKey: Uint8Array): Promise<KeyPair>;
  dh(privateKey: DhPrivateKey, publicKey: Uint8Array): Promise<Uint8Array>;
  importAeadKey(raw: Uint8Array): Promise<AeadKey>;
  seal(key: AeadKey, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>;
  open(key: AeadKey, nonce: Uint8Array, ad: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array>;
  randomBytes(length: number): Uint8Array;
}

export class CryptoBackendError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CryptoBackendError";
  }
}

function assertLength(name: string, bytes: Uint8Array, expected: number): void {
  if (bytes.length !== expected) {
    throw new CryptoBackendError(`${name} must be ${expected} bytes, got ${bytes.length}`);
  }
}

// ---------------------------------------------------------------- noble ----

export const nobleBackend: CryptoBackend = {
  name: "noble",

  async generateKeyPair(): Promise<KeyPair> {
    return nobleBackend.importKeyPair(nobleRandomBytes(DH_LEN));
  },

  async importKeyPair(rawPrivateKey: Uint8Array): Promise<KeyPair> {
    assertLength("X25519 private key", rawPrivateKey, DH_LEN);
    const bytes = Uint8Array.from(rawPrivateKey);
    return { publicKey: x25519.getPublicKey(bytes), privateKey: { kind: "raw", bytes } };
  },

  async dh(privateKey: DhPrivateKey, publicKey: Uint8Array): Promise<Uint8Array> {
    if (privateKey.kind !== "raw") {
      throw new CryptoBackendError("the noble backend cannot use a WebCrypto private key");
    }
    assertLength("X25519 public key", publicKey, DH_LEN);
    try {
      return x25519.getSharedSecret(privateKey.bytes, publicKey);
    } catch (cause) {
      throw new CryptoBackendError("X25519 rejected the peer's public key (low-order point?)", { cause });
    }
  },

  async importAeadKey(raw: Uint8Array): Promise<AeadKey> {
    assertLength("AES-256-GCM key", raw, AEAD_KEY_LEN);
    return { kind: "raw", bytes: Uint8Array.from(raw) };
  },

  async seal(key: AeadKey, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    if (key.kind !== "raw") throw new CryptoBackendError("the noble backend cannot use a WebCrypto AEAD key");
    return gcm(key.bytes, nonce, ad).encrypt(plaintext);
  },

  async open(key: AeadKey, nonce: Uint8Array, ad: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    if (key.kind !== "raw") throw new CryptoBackendError("the noble backend cannot use a WebCrypto AEAD key");
    return gcm(key.bytes, nonce, ad).decrypt(ciphertext);
  },

  randomBytes(length: number): Uint8Array {
    return nobleRandomBytes(length);
  },
};

// ------------------------------------------------------------ webcrypto ----

/** PKCS#8 prefix for a bare X25519 private key (RFC 8410 id-X25519, 1.3.101.110). */
const X25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

function subtleOf(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new CryptoBackendError("WebCrypto is unavailable in this environment");
  return c.subtle;
}

export const webCryptoBackend: CryptoBackend = {
  name: "webcrypto",

  async generateKeyPair(options?: { extractable?: boolean }): Promise<KeyPair> {
    const subtle = subtleOf();
    const pair = (await subtle.generateKey({ name: "X25519" }, options?.extractable ?? false, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const publicKey = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
    return { publicKey, privateKey: { kind: "webcrypto", key: pair.privateKey } };
  },

  async importKeyPair(rawPrivateKey: Uint8Array): Promise<KeyPair> {
    assertLength("X25519 private key", rawPrivateKey, DH_LEN);
    const subtle = subtleOf();
    const pkcs8 = new Uint8Array(X25519_PKCS8_PREFIX.length + DH_LEN);
    pkcs8.set(X25519_PKCS8_PREFIX, 0);
    pkcs8.set(rawPrivateKey, X25519_PKCS8_PREFIX.length);
    const key = await subtle.importKey("pkcs8", bufferSource(pkcs8), { name: "X25519" }, false, ["deriveBits"]);
    pkcs8.fill(0);
    // WebCrypto cannot derive a public key from a private one; X25519 base-point
    // multiplication is public arithmetic, so doing it with noble leaks nothing.
    return { publicKey: x25519.getPublicKey(rawPrivateKey), privateKey: { kind: "webcrypto", key } };
  },

  async dh(privateKey: DhPrivateKey, publicKey: Uint8Array): Promise<Uint8Array> {
    if (privateKey.kind !== "webcrypto") return nobleBackend.dh(privateKey, publicKey);
    assertLength("X25519 public key", publicKey, DH_LEN);
    const subtle = subtleOf();
    try {
      const peer = await subtle.importKey("raw", bufferSource(publicKey), { name: "X25519" }, true, []);
      return new Uint8Array(await subtle.deriveBits({ name: "X25519", public: peer }, privateKey.key, 256));
    } catch (cause) {
      throw new CryptoBackendError("X25519 rejected the peer's public key (low-order point?)", { cause });
    }
  },

  async importAeadKey(raw: Uint8Array): Promise<AeadKey> {
    assertLength("AES-256-GCM key", raw, AEAD_KEY_LEN);
    const key = await subtleOf().importKey("raw", bufferSource(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    return { kind: "webcrypto", key };
  },

  async seal(key: AeadKey, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    if (key.kind !== "webcrypto") return nobleBackend.seal(key, nonce, ad, plaintext);
    const params: AesGcmParams = { name: "AES-GCM", iv: bufferSource(nonce), tagLength: 128, additionalData: bufferSource(ad) };
    return new Uint8Array(await subtleOf().encrypt(params, key.key, bufferSource(plaintext)));
  },

  async open(key: AeadKey, nonce: Uint8Array, ad: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    if (key.kind !== "webcrypto") return nobleBackend.open(key, nonce, ad, ciphertext);
    const params: AesGcmParams = { name: "AES-GCM", iv: bufferSource(nonce), tagLength: 128, additionalData: bufferSource(ad) };
    return new Uint8Array(await subtleOf().decrypt(params, key.key, bufferSource(ciphertext)));
  },

  randomBytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    const c = globalThis.crypto;
    if (!c?.getRandomValues) throw new CryptoBackendError("crypto.getRandomValues is unavailable");
    c.getRandomValues(out);
    return out;
  },
};

// ------------------------------------------------------------ selection ----

let probe: Promise<CryptoBackend> | undefined;

/** True when this engine can do X25519 in WebCrypto with a non-extractable private key. */
export async function webCryptoSupportsX25519(): Promise<boolean> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return false;
    const pair = (await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
    await subtle.exportKey("raw", pair.publicKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick a backend once per process. Result is cached; pass a backend explicitly
 * anywhere you need determinism (the known-answer tests do).
 */
export function selectBackend(): Promise<CryptoBackend> {
  probe ??= webCryptoSupportsX25519().then((ok) => (ok ? webCryptoBackend : nobleBackend));
  return probe;
}

/** Test seam: forget the cached probe. */
export function resetBackendSelection(): void {
  probe = undefined;
}
