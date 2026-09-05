/**
 * The transport half: one Noise CipherState per direction, counter nonces,
 * bucket padding, epoch-driven rekey, and no buffering of out-of-order frames.
 *
 * AAD is exactly `channel_id ‖ direction ‖ seq` (41 bytes). Binding the channel
 * id means a frame captured on one channel cannot be replayed onto another even
 * if the same keys somehow reappeared; binding the direction means a frame
 * cannot be reflected back at its sender; binding seq means the relay cannot
 * reorder or drop frames unnoticed.
 *
 * Rekey is time-driven (120 s, WireGuard's constant) but signalled, not
 * negotiated: the sender bumps `epoch` in the frame header and the receiver
 * catches up by applying Noise Rekey() that many times. No clock agreement is
 * needed, and a peer that talks rarely never rekeys at all.
 */
import { PRODUCT_NAME } from "@lasercode/protocol/identity";
import { concatBytes, readU32be, readU64be, u32be, u64be } from "./bytes.js";
import {
  AEAD_TAG_BYTES,
  FRAME_HEADER_BYTES,
  FRAME_TYPE_CHAFF,
  FRAME_TYPE_DATA,
  FramingError,
  SMALLEST_PAYLOAD_CAPACITY,
  padPlaintext,
  unpadPlaintext,
} from "./framing.js";
import { CipherState, NoiseError, type SplitCiphers } from "./noise.js";
import { shortAuthenticationString, type Sas } from "./sas.js";

export const CHANNEL_ID_BYTES = 32;
export const REKEY_INTERVAL_MS = 120_000;
/** A receiver will catch up at most this many rekeys in one frame; beyond that the peer is broken or hostile. */
export const MAX_REKEY_CATCH_UP = 64;

export const DIRECTION_INITIATOR = 0;
export const DIRECTION_RESPONDER = 1;
export type Direction = typeof DIRECTION_INITIATOR | typeof DIRECTION_RESPONDER;

export class NoiseSessionError extends Error {
  constructor(
    message: string,
    /** True when the session must be torn down; every error here is fatal by design. */
    readonly fatal = true,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "NoiseSessionError";
  }
}

export interface NoiseSessionOptions extends SplitCiphers {
  /** 32 bytes, the same value used as the Noise prologue and as the relay route. */
  channelId: Uint8Array;
  initiator: boolean;
  rekeyIntervalMs?: number;
  maxRekeyCatchUp?: number;
  now?: () => number;
}

function aad(channelId: Uint8Array, direction: Direction, seq: bigint): Uint8Array {
  return concatBytes(channelId, Uint8Array.of(direction), u64be(seq));
}

/**
 * Encrypts and decrypts frames for one connection. Both `encrypt` and `decrypt`
 * are serialized internally: WebCrypto is async, and a frame's sequence number
 * has to match the order it hits the socket, so concurrent calls would be a
 * silent desync waiting to happen.
 */
export class NoiseSession {
  readonly channelId: Uint8Array;
  readonly sendDirection: Direction;
  readonly receiveDirection: Direction;
  readonly handshakeHash: Uint8Array;
  readonly sas: Sas;

  private readonly sendCipher: CipherState;
  private readonly receiveCipher: CipherState;
  private readonly rekeyIntervalMs: number;
  private readonly maxRekeyCatchUp: number;
  private readonly now: () => number;

  private sendSeqCounter = 0n;
  private receiveSeqCounter = 0n;
  private sendEpochCounter = 0;
  private receiveEpochCounter = 0;
  private lastRekeyAt: number;
  private sendChain: Promise<unknown> = Promise.resolve();
  private receiveChain: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(options: NoiseSessionOptions) {
    if (options.channelId.length !== CHANNEL_ID_BYTES) {
      throw new NoiseSessionError(`channel id must be ${CHANNEL_ID_BYTES} bytes, got ${options.channelId.length}`);
    }
    this.channelId = Uint8Array.from(options.channelId);
    this.sendDirection = options.initiator ? DIRECTION_INITIATOR : DIRECTION_RESPONDER;
    this.receiveDirection = options.initiator ? DIRECTION_RESPONDER : DIRECTION_INITIATOR;
    this.sendCipher = options.send;
    this.receiveCipher = options.receive;
    this.handshakeHash = Uint8Array.from(options.handshakeHash);
    this.sas = shortAuthenticationString(this.handshakeHash);
    this.rekeyIntervalMs = options.rekeyIntervalMs ?? REKEY_INTERVAL_MS;
    this.maxRekeyCatchUp = options.maxRekeyCatchUp ?? MAX_REKEY_CATCH_UP;
    this.now = options.now ?? Date.now;
    this.lastRekeyAt = this.now();
  }

  get sendSeq(): bigint {
    return this.sendSeqCounter;
  }
  get receiveSeq(): bigint {
    return this.receiveSeqCounter;
  }
  get sendEpoch(): number {
    return this.sendEpochCounter;
  }
  get receiveEpoch(): number {
    return this.receiveEpochCounter;
  }
  get isClosed(): boolean {
    return this.closed;
  }

  /** Refuse all further work. Any error out of this class is fatal, so callers close on catch. */
  close(): void {
    this.closed = true;
  }

  /** Encrypt one application payload into a padded frame. */
  encrypt(payload: Uint8Array): Promise<Uint8Array> {
    return this.enqueueSend(() => this.encryptFrame(FRAME_TYPE_DATA, payload));
  }

  /**
   * A frame indistinguishable from a real one to anyone but the peer, who drops
   * it. Sized to the smallest bucket unless told otherwise.
   */
  encryptChaff(payloadLength = SMALLEST_PAYLOAD_CAPACITY): Promise<Uint8Array> {
    return this.enqueueSend(() => this.encryptFrame(FRAME_TYPE_CHAFF, new Uint8Array(Math.max(0, payloadLength))));
  }

  /** Decrypt one frame. Returns `null` for chaff, which the caller discards. */
  decrypt(frame: Uint8Array): Promise<Uint8Array | null> {
    return this.enqueueReceive(() => this.decryptFrame(frame));
  }

  private enqueueSend<T>(work: () => Promise<T>): Promise<T> {
    const next = this.sendChain.then(work, work);
    this.sendChain = next.catch(() => {});
    return next;
  }

  private enqueueReceive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.receiveChain.then(work, work);
    this.receiveChain = next.catch(() => {});
    return next;
  }

  private async encryptFrame(type: typeof FRAME_TYPE_DATA | typeof FRAME_TYPE_CHAFF, payload: Uint8Array): Promise<Uint8Array> {
    if (this.closed) throw new NoiseSessionError("session is closed");
    await this.maybeRekeySend();
    const seq = this.sendSeqCounter;
    let padded: Uint8Array;
    try {
      padded = padPlaintext(type, payload);
    } catch (error) {
      // A framing problem is the caller's bug, not a protocol failure: stay open.
      throw error instanceof FramingError ? new NoiseSessionError(error.message, false, { cause: error }) : error;
    }
    const ciphertext = await this.sendCipher.encryptWithAd(aad(this.channelId, this.sendDirection, seq), padded);
    padded.fill(0);
    if (this.sendCipher.nonce !== seq + 1n) {
      this.closed = true;
      throw new NoiseSessionError("internal: send counter and AEAD nonce diverged");
    }
    this.sendSeqCounter = seq + 1n;
    return concatBytes(u32be(this.sendEpochCounter), u64be(seq), ciphertext);
  }

  private async maybeRekeySend(): Promise<void> {
    if (this.sendSeqCounter === 0n) return;
    if (this.now() - this.lastRekeyAt < this.rekeyIntervalMs) return;
    await this.sendCipher.rekey();
    this.sendEpochCounter++;
    this.lastRekeyAt = this.now();
  }

  private async decryptFrame(frame: Uint8Array): Promise<Uint8Array | null> {
    if (this.closed) throw new NoiseSessionError("session is closed");
    if (frame.length < FRAME_HEADER_BYTES + AEAD_TAG_BYTES + 1) {
      this.closed = true;
      throw new NoiseSessionError(`frame is ${frame.length} bytes, too short to be a ${PRODUCT_NAME} frame`);
    }
    const epoch = readU32be(frame, 0);
    const seq = readU64be(frame, 4);

    if (seq !== this.receiveSeqCounter) {
      this.closed = true;
      throw new NoiseSessionError(
        `frame sequence gap: expected ${this.receiveSeqCounter}, got ${seq}. ` +
          "Frames are never buffered or reordered; reconnect and resume from the last session seq.",
      );
    }
    if (epoch < this.receiveEpochCounter) {
      this.closed = true;
      throw new NoiseSessionError(`frame carries rekey epoch ${epoch}, older than the current ${this.receiveEpochCounter}`);
    }
    const catchUp = epoch - this.receiveEpochCounter;
    if (catchUp > this.maxRekeyCatchUp) {
      this.closed = true;
      throw new NoiseSessionError(`peer jumped ${catchUp} rekey epochs at once (limit ${this.maxRekeyCatchUp})`);
    }
    for (let i = 0; i < catchUp; i++) await this.receiveCipher.rekey();
    this.receiveEpochCounter = epoch;

    let padded: Uint8Array;
    try {
      padded = await this.receiveCipher.decryptWithAd(
        aad(this.channelId, this.receiveDirection, seq),
        frame.subarray(FRAME_HEADER_BYTES),
      );
    } catch (cause) {
      this.closed = true;
      throw new NoiseSessionError(
        cause instanceof NoiseError ? cause.message : "frame failed authentication",
        true,
        { cause },
      );
    }
    this.receiveSeqCounter = seq + 1n;
    let unpadded: { type: number; payload: Uint8Array };
    try {
      unpadded = unpadPlaintext(padded);
    } catch (cause) {
      this.closed = true;
      throw new NoiseSessionError(cause instanceof Error ? cause.message : "bad padding", true, { cause });
    } finally {
      padded.fill(0);
    }
    return unpadded.type === FRAME_TYPE_CHAFF ? null : unpadded.payload;
  }
}
