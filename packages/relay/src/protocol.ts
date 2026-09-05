/**
 * The relay's own control vocabulary, and the one rule that keeps this package
 * honest:
 *
 *   **text frames are the relay's; binary frames are the peers'.**
 *
 * The relay reads and writes only text frames. It never looks inside a binary
 * frame, never forwards a text frame, and never buffers a binary frame — it
 * copies bytes from one socket to the other or drops them. That is the whole
 * contract (AGENTS.md invariant 7).
 */

/** Relay → client. */
export type RelayControl =
  | { t: "hello"; channel: string; slot: 0 | 1; peer: boolean; pingIntervalMs: number; maxFrameBytes: number }
  /** The other side arrived or left. Hold your handshake until `present` is true. */
  | { t: "peer"; present: boolean }
  | { t: "ping"; n: number }
  | { t: "error"; code: RelayErrorCode; message: string };

/** Client → relay. The only thing the relay accepts. */
export type RelayClientControl = { t: "pong"; n: number };

export type RelayErrorCode =
  | "no_peer"
  | "frame_too_large"
  | "bad_frame_size"
  | "bad_control"
  | "channel_full"
  | "rate_limited";

/** WebSocket close codes in the private-use range (4000-4999). */
export const RelayClose = {
  /** The channel already has its two sockets. */
  ChannelFull: 4409,
  /** Per-IP limit hit. */
  RateLimited: 4429,
  /** Ping went unanswered. */
  Timeout: 4408,
  /** The client sent something the relay does not accept. */
  BadRequest: 4400,
  /** The relay is shutting down. */
  GoingAway: 4001,
} as const;

/**
 * Legal on-the-wire frame sizes: 12-byte header + padded bucket + 16-byte tag,
 * mirroring `@lasercode/crypto`'s `framing.ts`. Duplicated as plain numbers on
 * purpose — the relay must not depend on the crypto package.
 */
export const FRAME_HEADER_BYTES = 12;
export const FRAME_TAG_BYTES = 16;
export const FRAME_BUCKETS = [64, 256, 1024, 4096] as const;
export const MAX_BUCKET_BYTES = 262_144;

export function legalFrameSizes(maxFrameBytes: number): Set<number> {
  const sizes = new Set<number>();
  const add = (bucket: number): void => {
    const size = FRAME_HEADER_BYTES + bucket + FRAME_TAG_BYTES;
    if (size <= maxFrameBytes) sizes.add(size);
  };
  for (const bucket of FRAME_BUCKETS) add(bucket);
  const largest = FRAME_BUCKETS[FRAME_BUCKETS.length - 1]!;
  for (let bucket = largest * 2; bucket <= MAX_BUCKET_BYTES; bucket += largest) add(bucket);
  return sizes;
}

/** 32 bytes, base64url, unpadded. The relay treats it as an opaque route. */
const CHANNEL_ID = /^[A-Za-z0-9_-]{43}$/;

export function isChannelId(value: string): boolean {
  return CHANNEL_ID.test(value);
}

/**
 * The channel id travels as a WebSocket **subprotocol**, never in the request
 * line.
 *
 * A URL path is written to every access log on the way — the platform edge, any
 * TLS-terminating proxy, the relay's own logs — and the channel id is a bearer
 * capability: a channel holds exactly two sockets, so whoever reads one id can
 * occupy a slot and lock the real phone out of its own channel for good.
 * `Sec-WebSocket-Protocol` is a header, so it stays out of request lines, and
 * the relay still treats the value as an opaque route (AGENTS.md invariant 7).
 */
export const CHANNEL_PROTOCOL_PREFIX = "piorbit.channel.";

/** The `Sec-WebSocket-Protocol` value a client offers for one channel. */
export function channelSubprotocol(channelId: string): string {
  return `${CHANNEL_PROTOCOL_PREFIX}${channelId}`;
}

/**
 * The channel id offered in a `Sec-WebSocket-Protocol` header, or `undefined`
 * when the client offered none that names a channel. The header is a
 * comma-separated list and may be repeated.
 */
export function channelIdFromProtocols(header: string | string[] | undefined): string | undefined {
  if (header === undefined) return undefined;
  const values = (Array.isArray(header) ? header : [header]).flatMap((line) => line.split(","));
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed.startsWith(CHANNEL_PROTOCOL_PREFIX)) continue;
    const id = trimmed.slice(CHANNEL_PROTOCOL_PREFIX.length);
    if (isChannelId(id)) return id;
  }
  return undefined;
}
