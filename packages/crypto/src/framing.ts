/**
 * Transport framing: fixed-size buckets so an observer of the ciphertext learns
 * only which bucket a message fell into, never its exact length.
 *
 * Wire layout of one frame:
 *
 *   0..3    epoch  (uint32 BE)   how many times the sender has rekeyed
 *   4..11   seq    (uint64 BE)   the sender's AEAD counter for this direction
 *   12..    ciphertext           AES-256-GCM over the padded plaintext + 16-byte tag
 *
 * Padded plaintext, always exactly one bucket size:
 *
 *   0       type   (1 byte)      0 = data, 1 = chaff
 *   1..4    length (uint32 BE)   real payload length
 *   5..     payload, then zeros
 *
 * `epoch` rides in the clear and is NOT in the AAD (the AAD is exactly
 * `channel_id ‖ direction ‖ seq`). Tampering with it only makes the receiver
 * derive the wrong key, which fails authentication — the same outcome as
 * flipping a ciphertext bit, so authenticating it would buy nothing.
 */
import { readU32be, u32be } from "./bytes.js";

export const FRAME_BUCKETS = [64, 256, 1024, 4096] as const;
export const FRAME_HEADER_BYTES = 12;
export const AEAD_TAG_BYTES = 16;
/** type byte + uint32 length, inside the encrypted plaintext. */
export const PLAINTEXT_HEADER_BYTES = 5;
/** Largest bucket we will ever emit. Bigger payloads are rejected, not split. */
export const MAX_BUCKET_BYTES = 262_144;

export const FRAME_TYPE_DATA = 0;
export const FRAME_TYPE_CHAFF = 1;
export type FrameType = typeof FRAME_TYPE_DATA | typeof FRAME_TYPE_CHAFF;

export class FramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FramingError";
  }
}

/** Largest payload that fits the smallest bucket, for callers sizing chaff. */
export const SMALLEST_PAYLOAD_CAPACITY = FRAME_BUCKETS[0] - PLAINTEXT_HEADER_BYTES;

/** The padded-plaintext size a payload of `length` bytes lands in. */
export function bucketFor(length: number): number {
  const needed = length + PLAINTEXT_HEADER_BYTES;
  for (const bucket of FRAME_BUCKETS) if (needed <= bucket) return bucket;
  const largest = FRAME_BUCKETS[FRAME_BUCKETS.length - 1]!;
  const rounded = Math.ceil(needed / largest) * largest;
  if (rounded > MAX_BUCKET_BYTES) {
    throw new FramingError(
      `payload of ${length} bytes exceeds the ${MAX_BUCKET_BYTES - PLAINTEXT_HEADER_BYTES}-byte frame limit; ` +
        "split it at the application layer",
    );
  }
  return rounded;
}

/** On-the-wire size of the frame carrying a payload of `length` bytes. */
export function frameSizeFor(length: number): number {
  return FRAME_HEADER_BYTES + bucketFor(length) + AEAD_TAG_BYTES;
}

/**
 * Every legal on-the-wire frame size up to `maxBytes`. The relay uses this to
 * reject anything that is not a padded frame without knowing what padding is.
 */
export function allowedFrameSizes(maxBytes = MAX_BUCKET_BYTES + FRAME_HEADER_BYTES + AEAD_TAG_BYTES): number[] {
  const sizes = new Set<number>();
  for (const bucket of FRAME_BUCKETS) {
    const size = FRAME_HEADER_BYTES + bucket + AEAD_TAG_BYTES;
    if (size <= maxBytes) sizes.add(size);
  }
  const largest = FRAME_BUCKETS[FRAME_BUCKETS.length - 1]!;
  for (let bucket = largest * 2; bucket <= MAX_BUCKET_BYTES; bucket += largest) {
    const size = FRAME_HEADER_BYTES + bucket + AEAD_TAG_BYTES;
    if (size <= maxBytes) sizes.add(size);
  }
  return [...sizes].sort((a, b) => a - b);
}

export function padPlaintext(type: FrameType, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(bucketFor(payload.length));
  out[0] = type;
  out.set(u32be(payload.length), 1);
  out.set(payload, PLAINTEXT_HEADER_BYTES);
  return out;
}

export function unpadPlaintext(padded: Uint8Array): { type: FrameType; payload: Uint8Array } {
  if (padded.length < PLAINTEXT_HEADER_BYTES) throw new FramingError("padded plaintext is shorter than its header");
  const type = padded[0]!;
  if (type !== FRAME_TYPE_DATA && type !== FRAME_TYPE_CHAFF) {
    throw new FramingError(`unknown frame type ${type}; the peer is speaking a newer framing`);
  }
  const length = readU32be(padded, 1);
  if (PLAINTEXT_HEADER_BYTES + length > padded.length) {
    throw new FramingError(`frame claims a ${length}-byte payload but only ${padded.length - PLAINTEXT_HEADER_BYTES} bytes are present`);
  }
  return { type, payload: padded.slice(PLAINTEXT_HEADER_BYTES, PLAINTEXT_HEADER_BYTES + length) };
}
