/**
 * A QR encoder, written here rather than installed (M9-T7).
 *
 * `laser relay pair` has to put a link on a phone's camera, and the link is
 * the only thing that matters in this whole flow: it carries the ephemeral key
 * the pairing handshake is built on. Pulling a package tree in to draw it —
 * for a CLI whose only dependency today is a WebSocket — is a poor trade when
 * the algorithm is a page of finite-field arithmetic and a fixed table.
 *
 * Scope on purpose: **byte mode only**, one segment, ISO-8859-1/UTF-8 bytes.
 * The pairing link is base64url and ASCII throughout, so alphanumeric mode
 * would be a smaller symbol for no benefit and another mode to get wrong.
 *
 * The implementation follows ISO/IEC 18004: capacity from the raw module
 * count, Reed–Solomon over GF(256) with the primitive 0x11D, interleaved
 * blocks, the eight masks scored by the four penalty rules, BCH format and
 * version information. `test/qr.test.ts` pins a full symbol against a
 * reference encoding, because "it looked like a QR code" is not a test.
 */

export type EccLevel = "L" | "M" | "Q" | "H";

/** Format-info bits per level (not the level's ordinal — the standard's own order). */
const FORMAT_BITS: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** EC codewords per block, indexed by version 1..40. Index 0 is unused. */
const ECC_CODEWORDS_PER_BLOCK: Record<EccLevel, readonly number[]> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

/** Number of RS blocks, indexed by version 1..40. */
const NUM_BLOCKS: Record<EccLevel, readonly number[]> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

const MIN_VERSION = 1;
const MAX_VERSION = 40;

/** Modules a version can hold before EC, function patterns already removed. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number, ecc: EccLevel): number {
  return (
    Math.floor(rawDataModules(version) / 8) -
    (ECC_CODEWORDS_PER_BLOCK[ecc][version] as number) * (NUM_BLOCKS[ecc][version] as number)
  );
}

/** Centres of the alignment patterns for a version, `[6, …, size-7]`. */
function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 17 - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---------------------------------------------------------------- GF(256) ---

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] as number;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] as number) + (LOG[b] as number)] as number;
}

/** The generator polynomial of degree `degree`, coefficients high-to-low minus the leading 1. */
function generator(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j] as number, root);
      if (j + 1 < degree) result[j] = (result[j] as number) ^ (result[j + 1] as number);
    }
    root = gfMul(root, 2);
  }
  return result;
}

function remainder(data: Uint8Array, gen: Uint8Array): Uint8Array {
  const result = new Uint8Array(gen.length);
  for (const byte of data) {
    const factor = byte ^ (result[0] as number);
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) result[i] = (result[i] as number) ^ gfMul(gen[i] as number, factor);
  }
  return result;
}

// ------------------------------------------------------------- bit stream ---

class Bits {
  readonly bits: number[] = [];
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

// ----------------------------------------------------------------- symbol ---

export interface QrSymbol {
  version: number;
  size: number;
  /** `true` is a dark module. Row-major, `size × size`. */
  modules: boolean[][];
}

export class QrError extends Error {
  override readonly name = "QrError";
}

/** Bytes of `text` as UTF-8, which is what every scanner assumes for byte mode. */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function encodeQr(text: string, ecc: EccLevel = "M"): QrSymbol {
  const data = utf8(text);

  // Byte mode needs 4 mode bits + 8 or 16 length bits + the payload.
  let version = MIN_VERSION;
  for (; version <= MAX_VERSION; version++) {
    const lengthBits = version < 10 ? 8 : 16;
    if (4 + lengthBits + data.length * 8 <= dataCodewords(version, ecc) * 8) break;
  }
  if (version > MAX_VERSION) {
    throw new QrError(`${data.length} bytes will not fit in a QR code at error-correction level ${ecc}`);
  }

  const capacity = dataCodewords(version, ecc);
  const stream = new Bits();
  stream.push(0b0100, 4);
  stream.push(data.length, version < 10 ? 8 : 16);
  for (const byte of data) stream.push(byte, 8);

  // Terminator, byte alignment, then the two alternating pad codewords.
  stream.push(0, Math.min(4, capacity * 8 - stream.bits.length));
  stream.push(0, (8 - (stream.bits.length % 8)) % 8);
  for (let pad = 0xec; stream.bits.length < capacity * 8; pad ^= 0xec ^ 0x11) stream.push(pad, 8);

  const codewords = new Uint8Array(capacity);
  for (let i = 0; i < stream.bits.length; i++) {
    codewords[i >>> 3] = (codewords[i >>> 3] as number) | ((stream.bits[i] as number) << (7 - (i & 7)));
  }

  return draw(version, ecc, interleave(codewords, version, ecc));
}

/** Split into RS blocks, append each block's remainder, and interleave. */
function interleave(data: Uint8Array, version: number, ecc: EccLevel): Uint8Array {
  const blocks = NUM_BLOCKS[ecc][version] as number;
  const eccLen = ECC_CODEWORDS_PER_BLOCK[ecc][version] as number;
  const total = Math.floor(rawDataModules(version) / 8);
  const shortLen = Math.floor(total / blocks) - eccLen;
  const numLong = total % blocks;

  const gen = generator(eccLen);
  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < blocks; i++) {
    const length = shortLen + (i >= blocks - numLong ? 1 : 0);
    const block = data.subarray(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    eccBlocks.push(remainder(block, gen));
  }

  const result = new Uint8Array(total);
  let at = 0;
  for (let i = 0; i < shortLen + 1; i++) {
    for (let b = 0; b < blocks; b++) {
      const block = dataBlocks[b] as Uint8Array;
      if (i < block.length) result[at++] = block[i] as number;
    }
  }
  for (let i = 0; i < eccLen; i++) {
    for (let b = 0; b < blocks; b++) result[at++] = (eccBlocks[b] as Uint8Array)[i] as number;
  }
  return result;
}

function draw(version: number, ecc: EccLevel, codewords: Uint8Array): QrSymbol {
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const set = (x: number, y: number, dark: boolean): void => {
    (modules[y] as boolean[])[x] = dark;
    (reserved[y] as boolean[])[x] = true;
  };

  // Finders and their separators.
  for (const [fx, fy] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ] as const) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = fx + dx;
        const y = fy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        set(x, y, d !== 2 && d <= 3);
      }
    }
  }

  // Timing patterns.
  for (let i = 0; i < size; i++) {
    if (!(reserved[6] as boolean[])[i]) set(i, 6, i % 2 === 0);
    if (!(reserved[i] as boolean[])[6]) set(6, i, i % 2 === 0);
  }

  // Alignment patterns, skipping the three that would sit on a finder.
  const centres = alignmentPositions(version);
  for (let i = 0; i < centres.length; i++) {
    for (let j = 0; j < centres.length; j++) {
      const first = i === 0;
      const last = i === centres.length - 1;
      if ((first && j === 0) || (first && j === centres.length - 1) || (last && j === 0)) continue;
      const cx = centres[j] as number;
      const cy = centres[i] as number;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Reserve the format areas (filled after masking) and the dark module.
  for (let i = 0; i <= 8; i++) {
    if (!(reserved[8] as boolean[])[i]) set(i, 8, false);
    if (!(reserved[i] as boolean[])[8]) set(8, i, false);
  }
  for (let i = 0; i < 8; i++) {
    if (!(reserved[8] as boolean[])[size - 1 - i]) set(size - 1 - i, 8, false);
    if (!(reserved[size - 1 - i] as boolean[])[8]) set(8, size - 1 - i, false);
  }
  set(8, size - 8, true);

  // Version information, bottom-left and top-right, for version 7 and up.
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  // Data, in the zig-zag from the bottom right, skipping the timing column.
  let bit = 0;
  const bitAt = (index: number): boolean =>
    index < codewords.length * 8 && (((codewords[index >>> 3] as number) >>> (7 - (index & 7))) & 1) !== 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if ((reserved[y] as boolean[])[x]) continue;
        (modules[y] as boolean[])[x] = bitAt(bit);
        bit++;
      }
    }
  }

  // Every mask, scored; the lowest penalty wins, as the standard requires.
  let bestPenalty = Infinity;
  let bestModules = modules;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = modules.map((row) => [...row]);
    applyMask(candidate, reserved, mask);
    applyFormat(candidate, ecc, mask);
    const score = penalty(candidate);
    if (score < bestPenalty) {
      bestPenalty = score;
      bestModules = candidate;
    }
  }

  return { version, size, modules: bestModules };
}

function applyMask(modules: boolean[][], reserved: boolean[][], mask: number): void {
  const size = modules.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((reserved[y] as boolean[])[x]) continue;
      let invert: boolean;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (invert) (modules[y] as boolean[])[x] = !(modules[y] as boolean[])[x];
    }
  }
}

function applyFormat(modules: boolean[][], ecc: EccLevel, mask: number): void {
  const size = modules.length;
  const data = (FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  const put = (x: number, y: number, dark: boolean): void => {
    (modules[y] as boolean[])[x] = dark;
  };
  const at = (i: number): boolean => ((bits >>> i) & 1) !== 0;

  for (let i = 0; i <= 5; i++) put(8, i, at(i));
  put(8, 7, at(6));
  put(8, 8, at(7));
  put(7, 8, at(8));
  for (let i = 9; i < 15; i++) put(14 - i, 8, at(i));

  for (let i = 0; i < 8; i++) put(size - 1 - i, 8, at(i));
  for (let i = 8; i < 15; i++) put(8, size - 15 + i, at(i));
  put(8, size - 8, true);
}

/** The four penalty rules from the standard, summed. */
function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;

  const runScore = (run: number): number => (run >= 5 ? 3 + (run - 5) : 0);

  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if ((modules[y] as boolean[])[x] === (modules[y] as boolean[])[x - 1]) run++;
      else {
        score += runScore(run);
        run = 1;
      }
    }
    score += runScore(run);
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if ((modules[y] as boolean[])[x] === (modules[y - 1] as boolean[])[x]) run++;
      else {
        score += runScore(run);
        run = 1;
      }
    }
    score += runScore(run);
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const a = (modules[y] as boolean[])[x];
      if (
        a === (modules[y] as boolean[])[x + 1] &&
        a === (modules[y + 1] as boolean[])[x] &&
        a === (modules[y + 1] as boolean[])[x + 1]
      ) {
        score += 3;
      }
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 sequence with four light modules on
  // either side, in both directions.
  const FINDER = [true, false, true, true, true, false, true];
  const matches = (get: (i: number) => boolean, at: number, length: number): boolean => {
    for (let i = 0; i < 7; i++) if (get(at + i) !== FINDER[i]) return false;
    const before = [at - 4, at - 3, at - 2, at - 1].every((i) => i < 0 || !get(i));
    const after = [at + 7, at + 8, at + 9, at + 10].every((i) => i >= length || !get(i));
    return before || after;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x + 7 <= size; x++) {
      if (matches((i) => (modules[y] as boolean[])[i] === true, x, size)) score += 40;
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y + 7 <= size; y++) {
      if (matches((i) => (modules[i] as boolean[])[x] === true, y, size)) score += 40;
    }
  }

  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

// --------------------------------------------------------------- printing ---

/**
 * Two rows per line of text, using the half-block characters, so a version-7
 * symbol (45×45 with the quiet zone) fits an 80×24 terminal.
 *
 * QR readers expect dark-on-light and the quiet zone is part of the symbol,
 * so the four-module border is drawn, not implied by the terminal's
 * background. `invert` swaps the two, for a light terminal where a phone
 * would otherwise be reading a negative.
 */
export function renderQr(symbol: QrSymbol, options: { invert?: boolean; quietZone?: number } = {}): string[] {
  const quiet = options.quietZone ?? 2;
  const invert = options.invert === true;
  const size = symbol.size + quiet * 2;
  const dark = (x: number, y: number): boolean => {
    const mx = x - quiet;
    const my = y - quiet;
    if (mx < 0 || my < 0 || mx >= symbol.size || my >= symbol.size) return false;
    return (symbol.modules[my] as boolean[])[mx] === true;
  };

  // A dark module must print as an *unlit* half so the symbol reads
  // dark-on-light; "▀" paints the top half in the foreground colour.
  const lines: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let line = "";
    for (let x = 0; x < size; x++) {
      const top = dark(x, y) !== invert;
      const bottom = (y + 1 < size ? dark(x, y + 1) : false) !== invert;
      line += top ? (bottom ? " " : "▄") : bottom ? "▀" : "█";
    }
    lines.push(line);
  }
  return lines;
}

/** Convenience: encode and render in one call. */
export function qrLines(text: string, options: { ecc?: EccLevel; invert?: boolean; quietZone?: number } = {}): string[] {
  const { ecc, ...rest } = options;
  return renderQr(encodeQr(text, ecc ?? "M"), rest);
}
