/**
 * Byte helpers shared by every module here. No Node built-ins: this file runs in
 * the browser too, so `Buffer`, `btoa` and `atob` are all off the table
 * (`atob` mangles binary in some engines and is absent in workers).
 */

export const EMPTY: Uint8Array = new Uint8Array(0);

/**
 * WebCrypto's DOM typings insist on an `ArrayBuffer`-backed view, while a plain
 * `Uint8Array` is typed as possibly `SharedArrayBuffer`-backed. Nothing here is
 * ever built on shared memory, so this narrows the type without a runtime cost.
 */
export function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new TypeError(`hex string has odd length (${hex.length})`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new TypeError(`invalid hex at offset ${i * 2}`);
    out[i] = byte;
  }
  return out;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_INVERSE = /* @__PURE__ */ (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64URL.length; i++) table[B64URL.charCodeAt(i)] = i;
  // Accept standard base64 on input so a pasted token still works.
  table["+".charCodeAt(0)] = 62;
  table["/".charCodeAt(0)] = 63;
  return table;
})();

/** base64url, unpadded (RFC 4648 §5). */
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array {
  const s = text.replace(/=+$/, "");
  const full = Math.floor(s.length / 4);
  const rest = s.length - full * 4;
  if (rest === 1) throw new TypeError("invalid base64url: length ≡ 1 (mod 4)");
  const out = new Uint8Array(full * 3 + (rest === 0 ? 0 : rest - 1));
  const sextet = (index: number): number => {
    const code = s.charCodeAt(index);
    const value = code < 128 ? B64URL_INVERSE[code]! : -1;
    if (value < 0) throw new TypeError(`invalid base64url character at offset ${index}`);
    return value;
  };
  let o = 0;
  let i = 0;
  for (; i + 3 < s.length; i += 4) {
    const n = (sextet(i) << 18) | (sextet(i + 1) << 12) | (sextet(i + 2) << 6) | sextet(i + 3);
    out[o++] = (n >> 16) & 255;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  if (rest === 2) {
    out[o++] = ((sextet(i) << 2) | (sextet(i + 1) >> 4)) & 255;
  } else if (rest === 3) {
    const n = (sextet(i) << 12) | (sextet(i + 1) << 6) | sextet(i + 2);
    out[o++] = (n >> 10) & 255;
    out[o++] = (n >> 2) & 255;
  }
  return out;
}

const ENCODER = /* @__PURE__ */ new TextEncoder();
const DECODER = /* @__PURE__ */ new TextDecoder("utf-8", { fatal: true });

export function utf8(text: string): Uint8Array {
  return ENCODER.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return DECODER.decode(bytes);
}

/** Constant-time for equal-length inputs; length is not secret. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Best-effort wipe. JS gives no guarantee (GC copies), but it shortens the window. */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}

export function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

export function u64be(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, false);
  return out;
}

export function readU32be(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

export function readU64be(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, false);
}
