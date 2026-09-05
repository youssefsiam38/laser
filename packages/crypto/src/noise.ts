/**
 * Noise Protocol Framework (revision 34), patterns IK and KK, suite
 * `25519_AESGCM_SHA256`.
 *
 *   IK:                          KK:
 *     <- s                         -> s
 *     ...                          <- s
 *     -> e, es, s, ss              ...
 *     <- e, ee, se                 -> e, es, ss
 *                                  <- e, ee, se
 *
 * IK is first contact after a QR scan: the phone already knows the desktop's
 * public key (the QR's single-use ephemeral) and sends its own static inside the
 * first message, encrypted. KK is every reconnection afterwards, when both sides
 * hold each other's statics.
 *
 * Conformance is pinned by the Noise project's own vectors (cacophony) in
 * `test/vectors/noise-ik-kk-25519-aesgcm-sha256.json`.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  AEAD_KEY_LEN,
  AEAD_NONCE_LEN,
  AEAD_TAG_LEN,
  DH_LEN,
  selectBackend,
  type AeadKey,
  type CryptoBackend,
  type KeyPair,
} from "./backend.js";
import { EMPTY, concatBytes, u64be, wipe } from "./bytes.js";

export const HASH_LEN = 32;
export { AEAD_TAG_LEN, DH_LEN };

/** Reserved by the Noise spec for Rekey(); a CipherState must never reach it. */
const MAX_NONCE = (1n << 64n) - 1n;

export class NoiseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NoiseError";
  }
}

/**
 * Noise HKDF: `outputs` × HASHLEN bytes chained off `chainingKey`. This is
 * HKDF-SHA256 with salt = chainingKey, ikm = input and an empty info string,
 * split into 32-byte chunks — written out longhand because the spec is.
 */
export function noiseHkdf(chainingKey: Uint8Array, ikm: Uint8Array, outputs: 2): [Uint8Array, Uint8Array];
export function noiseHkdf(
  chainingKey: Uint8Array,
  ikm: Uint8Array,
  outputs: 3,
): [Uint8Array, Uint8Array, Uint8Array];
export function noiseHkdf(chainingKey: Uint8Array, ikm: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const tempKey = hmac(sha256, chainingKey, ikm);
  const o1 = hmac(sha256, tempKey, Uint8Array.of(1));
  const o2 = hmac(sha256, tempKey, concatBytes(o1, Uint8Array.of(2)));
  const out = outputs === 2 ? [o1, o2] : [o1, o2, hmac(sha256, tempKey, concatBytes(o2, Uint8Array.of(3)))];
  wipe(tempKey);
  return out;
}

/** AESGCM nonce per the Noise spec: 32 zero bits then `n` big-endian. */
function nonceFor(n: bigint): Uint8Array {
  const out = new Uint8Array(AEAD_NONCE_LEN);
  out.set(u64be(n), 4);
  return out;
}

/**
 * One direction's symmetric key plus its counter. Nonces are never reused
 * because `n` only ever increases — including across Rekey(), which the Noise
 * spec deliberately leaves the counter alone for.
 */
export class CipherState {
  private key: AeadKey | null = null;
  private n = 0n;

  private constructor(private readonly backend: CryptoBackend) {}

  static async create(backend: CryptoBackend, key?: Uint8Array): Promise<CipherState> {
    const state = new CipherState(backend);
    if (key) await state.initializeKey(key);
    return state;
  }

  async initializeKey(key: Uint8Array): Promise<void> {
    if (key.length !== AEAD_KEY_LEN) throw new NoiseError(`cipher key must be ${AEAD_KEY_LEN} bytes`);
    this.key = await this.backend.importAeadKey(key);
    this.n = 0n;
  }

  hasKey(): boolean {
    return this.key !== null;
  }

  /** Current counter. In transport use this doubles as the frame sequence number. */
  get nonce(): bigint {
    return this.n;
  }

  async encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    if (!this.key) return plaintext;
    if (this.n >= MAX_NONCE) throw new NoiseError("nonce exhausted; the session must be torn down");
    const out = await this.backend.seal(this.key, nonceFor(this.n), ad, plaintext);
    this.n++;
    return out;
  }

  async decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    if (!this.key) return ciphertext;
    if (this.n >= MAX_NONCE) throw new NoiseError("nonce exhausted; the session must be torn down");
    let out: Uint8Array;
    try {
      out = await this.backend.open(this.key, nonceFor(this.n), ad, ciphertext);
    } catch (cause) {
      throw new NoiseError("authentication failed: the frame was forged, corrupted, or replayed", { cause });
    }
    this.n++;
    return out;
  }

  /** Noise Rekey(): k = ENCRYPT(k, 2^64-1, empty ad, 32 zero bytes). `n` is untouched. */
  async rekey(): Promise<void> {
    if (!this.key) throw new NoiseError("cannot rekey a cipher state that has no key");
    const wide = await this.backend.seal(this.key, nonceFor(MAX_NONCE), EMPTY, new Uint8Array(AEAD_KEY_LEN));
    const next = wide.slice(0, AEAD_KEY_LEN);
    this.key = await this.backend.importAeadKey(next);
    wipe(next);
    wipe(wide);
  }
}

/** Noise SymmetricState: the running hash `h` and chaining key `ck`. */
class SymmetricState {
  ck: Uint8Array;
  h: Uint8Array;
  cipher!: CipherState;

  private constructor(
    private readonly backend: CryptoBackend,
    protocolName: string,
  ) {
    const name = new TextEncoder().encode(protocolName);
    if (name.length <= HASH_LEN) {
      this.h = new Uint8Array(HASH_LEN);
      this.h.set(name, 0);
    } else {
      this.h = sha256(name);
    }
    this.ck = Uint8Array.from(this.h);
  }

  static async create(backend: CryptoBackend, protocolName: string): Promise<SymmetricState> {
    const state = new SymmetricState(backend, protocolName);
    state.cipher = await CipherState.create(backend);
    return state;
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concatBytes(this.h, data));
  }

  async mixKey(ikm: Uint8Array): Promise<void> {
    const [ck, tempK] = noiseHkdf(this.ck, ikm, 2);
    this.ck = ck;
    await this.cipher.initializeKey(tempK);
    wipe(tempK);
  }

  async mixKeyAndHash(ikm: Uint8Array): Promise<void> {
    const [ck, tempH, tempK] = noiseHkdf(this.ck, ikm, 3);
    this.ck = ck;
    this.mixHash(tempH);
    await this.cipher.initializeKey(tempK);
    wipe(tempK);
  }

  encryptAndHash(plaintext: Uint8Array): Promise<Uint8Array> {
    const h = this.h;
    return this.cipher.encryptWithAd(h, plaintext).then((ciphertext) => {
      this.mixHash(ciphertext);
      return ciphertext;
    });
  }

  decryptAndHash(ciphertext: Uint8Array): Promise<Uint8Array> {
    const h = this.h;
    return this.cipher.decryptWithAd(h, ciphertext).then((plaintext) => {
      this.mixHash(ciphertext);
      return plaintext;
    });
  }

  async split(): Promise<[CipherState, CipherState]> {
    const [k1, k2] = noiseHkdf(this.ck, EMPTY, 2);
    const c1 = await CipherState.create(this.backend, k1);
    const c2 = await CipherState.create(this.backend, k2);
    wipe(k1);
    wipe(k2);
    return [c1, c2];
  }
}

// ------------------------------------------------------------- patterns ----

export type NoisePattern = "IK" | "KK";

type Token = "e" | "s" | "ee" | "es" | "se" | "ss";

interface PatternSpec {
  /** Pre-message tokens the initiator publishes, then the responder's. */
  readonly initiatorPre: readonly "s"[];
  readonly responderPre: readonly "s"[];
  readonly messages: readonly (readonly Token[])[];
}

const PATTERNS: Record<NoisePattern, PatternSpec> = {
  IK: {
    initiatorPre: [],
    responderPre: ["s"],
    messages: [
      ["e", "es", "s", "ss"],
      ["e", "ee", "se"],
    ],
  },
  KK: {
    initiatorPre: ["s"],
    responderPre: ["s"],
    messages: [
      ["e", "es", "ss"],
      ["e", "ee", "se"],
    ],
  },
};

export function noiseProtocolName(pattern: NoisePattern): string {
  return `Noise_${pattern}_25519_AESGCM_SHA256`;
}

export interface NoiseHandshakeOptions {
  pattern: NoisePattern;
  initiator: boolean;
  /** Bound into `h` before anything else. laser always uses the channel id. */
  prologue?: Uint8Array;
  /** Local static. Required by both IK and KK for both roles. */
  staticKeyPair: KeyPair;
  /** Peer static. Required for the IK initiator and for both KK roles. */
  remoteStaticPublicKey?: Uint8Array;
  backend?: CryptoBackend;
  /** Test seam only: pin the ephemeral so a run reproduces a published vector. */
  ephemeralKeyPair?: KeyPair;
}

export interface SplitCiphers {
  /** Cipher for frames this peer sends. */
  send: CipherState;
  /** Cipher for frames this peer receives. */
  receive: CipherState;
  handshakeHash: Uint8Array;
}

/**
 * A two-message handshake. Drive it by alternating `writeMessage` and
 * `readMessage` starting with whichever the role dictates, then `split()`.
 */
export class NoiseHandshake {
  private index = 0;
  private e: KeyPair | undefined;
  private re: Uint8Array | undefined;
  private rs: Uint8Array | undefined;
  private done = false;
  /**
   * Set when a read or write threw partway through. The SymmetricState has
   * already been mutated by the tokens that ran, so a retry on the same object
   * would run them again over poisoned state and fail to authenticate a message
   * that was perfectly good. One junk frame must end this handshake, not quietly
   * break the next legitimate attempt on it.
   */
  private failed = false;

  private constructor(
    private readonly backend: CryptoBackend,
    private readonly symmetric: SymmetricState,
    private readonly spec: PatternSpec,
    readonly pattern: NoisePattern,
    readonly initiator: boolean,
    private readonly s: KeyPair,
    private readonly pinnedEphemeral: KeyPair | undefined,
  ) {}

  static async create(options: NoiseHandshakeOptions): Promise<NoiseHandshake> {
    const backend = options.backend ?? (await selectBackend());
    const spec = PATTERNS[options.pattern];
    const symmetric = await SymmetricState.create(backend, noiseProtocolName(options.pattern));
    symmetric.mixHash(options.prologue ?? EMPTY);

    const needsRemote = options.pattern === "KK" || options.initiator;
    if (needsRemote && !options.remoteStaticPublicKey) {
      throw new NoiseError(
        `Noise_${options.pattern} needs the peer's static public key up front` +
          (options.pattern === "IK" ? " (the initiator reads it from the pairing QR)" : ""),
      );
    }
    if (options.remoteStaticPublicKey && options.remoteStaticPublicKey.length !== DH_LEN) {
      throw new NoiseError(`peer static public key must be ${DH_LEN} bytes`);
    }

    const handshake = new NoiseHandshake(
      backend,
      symmetric,
      spec,
      options.pattern,
      options.initiator,
      options.staticKeyPair,
      options.ephemeralKeyPair,
    );
    handshake.rs = options.remoteStaticPublicKey ? Uint8Array.from(options.remoteStaticPublicKey) : undefined;

    // Pre-messages, the initiator's first, exactly as the spec orders them.
    const local = options.staticKeyPair.publicKey;
    const remote = handshake.rs;
    if (spec.initiatorPre.includes("s")) symmetric.mixHash(options.initiator ? local : remote!);
    if (spec.responderPre.includes("s")) symmetric.mixHash(options.initiator ? remote! : local);
    return handshake;
  }

  get complete(): boolean {
    return this.done;
  }

  /** Available only after the handshake completes. Feeds the SAS. */
  get handshakeHash(): Uint8Array {
    return Uint8Array.from(this.symmetric.h);
  }

  /** The peer's static public key: known up front for KK, learnt from IK message 1. */
  get remoteStaticPublicKey(): Uint8Array | undefined {
    return this.rs ? Uint8Array.from(this.rs) : undefined;
  }

  /** True when it is this peer's turn to call `writeMessage`. */
  get isMyTurn(): boolean {
    return !this.done && this.index % 2 === (this.initiator ? 0 : 1);
  }

  async writeMessage(payload: Uint8Array = EMPTY): Promise<Uint8Array> {
    const tokens = this.nextTokens("write");
    try {
      return await this.write(tokens, payload);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  private async write(tokens: readonly Token[], payload: Uint8Array): Promise<Uint8Array> {
    let out = EMPTY;
    for (const token of tokens) {
      switch (token) {
        case "e": {
          this.e = this.pinnedEphemeral ?? (await this.backend.generateKeyPair());
          out = concatBytes(out, this.e.publicKey);
          this.symmetric.mixHash(this.e.publicKey);
          break;
        }
        case "s": {
          out = concatBytes(out, await this.symmetric.encryptAndHash(this.s.publicKey));
          break;
        }
        default:
          await this.mixDh(token);
      }
    }
    out = concatBytes(out, await this.symmetric.encryptAndHash(payload));
    this.advance();
    return out;
  }

  async readMessage(message: Uint8Array): Promise<Uint8Array> {
    const tokens = this.nextTokens("read");
    try {
      return await this.read(tokens, message);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  /** True once a read or write failed; this handshake can never be used again. */
  get poisoned(): boolean {
    return this.failed;
  }

  private async read(tokens: readonly Token[], message: Uint8Array): Promise<Uint8Array> {
    let offset = 0;
    const take = (n: number, what: string): Uint8Array => {
      if (offset + n > message.length) {
        throw new NoiseError(`handshake message is truncated: needed ${n} more bytes for ${what}`);
      }
      const slice = message.subarray(offset, offset + n);
      offset += n;
      return slice;
    };
    for (const token of tokens) {
      switch (token) {
        case "e": {
          this.re = Uint8Array.from(take(DH_LEN, "the peer ephemeral"));
          this.symmetric.mixHash(this.re);
          break;
        }
        case "s": {
          const size = this.symmetric.cipher.hasKey() ? DH_LEN + AEAD_TAG_LEN : DH_LEN;
          const rs = await this.symmetric.decryptAndHash(Uint8Array.from(take(size, "the peer static")));
          if (this.rs && !this.rs.every((b, i) => b === rs[i])) {
            throw new NoiseError("peer presented a different static key than the one we were given");
          }
          this.rs = rs;
          break;
        }
        default:
          await this.mixDh(token);
      }
    }
    const payload = await this.symmetric.decryptAndHash(Uint8Array.from(message.subarray(offset)));
    this.advance();
    return payload;
  }

  /**
   * Transport ciphers. `send`/`receive` are already oriented for this peer, so
   * neither side has to remember which of Noise's c1/c2 is which.
   */
  async split(): Promise<SplitCiphers> {
    if (!this.done) throw new NoiseError("split() before the handshake finished");
    const [c1, c2] = await this.symmetric.split();
    // c1 always encrypts initiator → responder.
    return this.initiator
      ? { send: c1, receive: c2, handshakeHash: this.handshakeHash }
      : { send: c2, receive: c1, handshakeHash: this.handshakeHash };
  }

  private nextTokens(op: "read" | "write"): readonly Token[] {
    if (this.failed) throw new NoiseError("this handshake failed partway through and cannot be reused");
    if (this.done) throw new NoiseError(`handshake already complete; cannot ${op} another message`);
    const wantWrite = this.index % 2 === (this.initiator ? 0 : 1);
    if ((op === "write") !== wantWrite) {
      throw new NoiseError(
        `it is this peer's turn to ${wantWrite ? "write" : "read"} handshake message ${this.index + 1}`,
      );
    }
    const tokens = this.spec.messages[this.index];
    if (!tokens) throw new NoiseError("handshake pattern exhausted");
    return tokens;
  }

  private advance(): void {
    this.index++;
    if (this.index >= this.spec.messages.length) this.done = true;
  }

  private async mixDh(token: Exclude<Token, "e" | "s">): Promise<void> {
    const pairs: Record<Exclude<Token, "e" | "s">, () => [KeyPair | undefined, Uint8Array | undefined]> = {
      ee: () => [this.e, this.re],
      es: () => (this.initiator ? [this.e, this.rs] : [this.s, this.re]),
      se: () => (this.initiator ? [this.s, this.re] : [this.e, this.rs]),
      ss: () => [this.s, this.rs],
    };
    const [local, remote] = pairs[token]();
    if (!local || !remote) throw new NoiseError(`token "${token}" needs a key that has not been seen yet`);
    const shared = await this.backend.dh(local.privateKey, remote);
    await this.symmetric.mixKey(shared);
    wipe(shared);
  }
}
