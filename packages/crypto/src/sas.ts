import { WIRE_NAMESPACE } from "@lasercode/protocol/identity";
/**
 * Short Authentication String from the Noise handshake hash.
 *
 * The relay cannot read the traffic, but it *is* positioned to attempt a
 * machine-in-the-middle during pairing if it can also get the QR (a photograph,
 * a shoulder-surf). Two independent handshakes produce two different handshake
 * hashes, so comparing six emoji across the two screens closes that gap. It is
 * optional by design: skipping it leaves you exactly where every other product
 * in this category already sits.
 *
 * 36 bits of emoji (6 × 6) or 40 bits of code (8 × base32). An attacker gets one
 * live attempt per pairing, so ~7×10^10 is generous.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8 } from "./bytes.js";

const SAS_CONTEXT = /* @__PURE__ */ utf8(`${WIRE_NAMESPACE}-sas-v1`);

/** 64 emoji chosen to be visually distinct, single-codepoint, and present on every platform. */
export const SAS_EMOJI: readonly string[] = [
  "🐶", "🐱", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁",
  "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🦉", "🦆",
  "🦄", "🐝", "🐞", "🦋", "🐢", "🐍", "🐙", "🦀",
  "🐬", "🐳", "🐟", "🦈", "🌵", "🌲", "🍀", "🌻",
  "🌹", "🍁", "🍄", "🌍", "🌙", "⭐", "🔥", "🌈",
  "❄", "⚡", "💧", "🍎", "🍊", "🍋", "🍌", "🍉",
  "🍇", "🍒", "🥕", "🌽", "🍞", "🧀", "🍕", "🍔",
  "🎃", "🎁", "🎈", "🎸", "🎺", "🚀", "⚓", "🔑",
];

/** Crockford-style base32 without I, L, O or U: no ambiguity when read aloud. */
const SAS_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface Sas {
  /** Six emoji, in order. Compare these across the two screens. */
  emoji: string[];
  /** Eight characters as `ABCD-EFGH`, for reading over a phone call. */
  code: string;
}

function sasBytes(handshakeHash: Uint8Array): Uint8Array {
  return sha256(concatBytes(SAS_CONTEXT, handshakeHash));
}

/** Deterministic on both peers: same handshake, same six emoji and same code. */
export function shortAuthenticationString(handshakeHash: Uint8Array): Sas {
  const bytes = sasBytes(handshakeHash);
  // 40 bits from the first five bytes, read as one big-endian integer.
  let value = 0n;
  for (let i = 0; i < 5; i++) value = (value << 8n) | BigInt(bytes[i]!);

  const emoji: string[] = [];
  let emojiBits = value >> 4n; // top 36 of the 40 bits
  for (let i = 0; i < 6; i++) {
    emoji.unshift(SAS_EMOJI[Number(emojiBits & 63n)]!);
    emojiBits >>= 6n;
  }

  let codeBits = value;
  let code = "";
  for (let i = 0; i < 8; i++) {
    code = SAS_ALPHABET[Number(codeBits & 31n)]! + code;
    codeBits >>= 5n;
  }
  return { emoji, code: `${code.slice(0, 4)}-${code.slice(4)}` };
}
