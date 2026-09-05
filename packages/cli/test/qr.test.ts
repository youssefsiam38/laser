/**
 * The QR encoder, pinned against its own past output.
 *
 * `src/qr.ts` is a from-scratch encoder, and the failure mode of a from-scratch
 * encoder is a symbol that looks exactly like a QR code and that no phone will
 * read. The 41x41 fixture below is a whole symbol for a pairing link at
 * error-correction level L, the level and shape `laser relay pair` prints.
 *
 * **This is a change detector, not an independent check.** The note here used
 * to say the matrix came from `qrcode@1.5.4`. It does not. Checked directly:
 * this encoder reproduces the fixture exactly and disagrees with `qrcode@1.5.4`
 * on the same input, and across 20,000 generated links the two never once
 * produced the same matrix. The mask is a free choice, any of the eight is a
 * valid symbol and the format bits record which was used, so the disagreement
 * does not make either wrong; it does mean a module-for-module comparison can
 * never be the cross-check this claimed to be.
 *
 * Making it one needs a decoder rather than a second encoder: read the symbol
 * back and assert it says what went in. Recorded as M9-T9.
 */
import { describe, expect, it } from "vitest";

import { encodeQr, qrLines, renderQr } from "../src/qr.js";

const LINK =
  "https://app.laser.dev/link#v1.d3NzOi8vcmVsYXkubGFzZXIuZGV2L3dz.Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG0";

/** Produced by `encodeQr` itself; see the note above. */
const EXPECTED_L = [
  "11111110110011101011000100010010001111111",
  "10000010100011100011000011100011101000001",
  "10111010101110101111111010100111101011101",
  "10111010110010011100000111010001101011101",
  "10111010011010001001001101001001001011101",
  "10000010100011010100110001101001101000001",
  "11111110101010101010101010101010101111111",
  "00000000010100000101110010111101000000000",
  "11001110000110111100111000111100100101111",
  "00100000010010010101000101111010111110111",
  "00001011110001111010001101010100001100001",
  "00011101111111000001011100001111010101010",
  "10101110110101001001011101000001000110010",
  "10111001111011100111110000011010011111011",
  "01101010111111010000110111111110111101001",
  "00011001100100111100010100000110111111011",
  "00001010010000001001101000000100000100110",
  "00101001111101101000001111110100001111100",
  "10011011010110010100101111010010101000001",
  "11101000100100100110111100001100111101001",
  "00011111101111100011101110010101110110011",
  "00000101011001001101000101101011000111011",
  "00001010100000101001000110110010100011001",
  "00001001000010000101111010000100010101011",
  "01010111010100010000011110100110110001001",
  "00100100011110001100001100011110001111101",
  "00101010001111111010100110111000100011101",
  "11110000011111001001010010000101001010001",
  "01111111111101011000010111011101010000001",
  "11011001111010100111101101001110000110001",
  "00100111001111010100101101010010100111001",
  "00010001101100011100010110100110111001010",
  "11111110011010101001101011010101111111111",
  "00000000100101101010001000111010100011010",
  "11111110010100010100011101010001101010101",
  "10000010111000110110011000011111100010010",
  "10111010100111100010100110010111111111010",
  "10111010011000001101010100101100110000101",
  "10111010010001101101011111111110010100101",
  "10000010111010000111110110010100001010011",
  "11111110101101011100001100000100100100010"
];

const asRows = (modules: boolean[][]): string[] =>
  modules.map((row) => row.map((cell) => (cell ? "1" : "0")).join(""));

describe("encodeQr", () => {
  it("still produces the same symbol for a pairing link at level L", () => {
    const symbol = encodeQr(LINK, "L");
    expect(symbol.version).toBe(6);
    expect(symbol.size).toBe(41);
    expect(asRows(symbol.modules)).toEqual(EXPECTED_L);
  });

  it("picks the smallest version that fits, at each level", () => {
    // Byte mode in version 1 holds 17 bytes at L and 14 at M; one more byte
    // moves to version 2. A wrong capacity here is the bug that silently
    // truncates a pairing link.
    expect(encodeQr("a".repeat(17), "L").version).toBe(1);
    expect(encodeQr("a".repeat(18), "L").version).toBe(2);
    expect(encodeQr("a".repeat(14), "M").version).toBe(1);
    expect(encodeQr("a".repeat(15), "M").version).toBe(2);
  });

  it("refuses text that cannot fit any version", () => {
    expect(() => encodeQr("a".repeat(3000), "H")).toThrow(/will not fit/);
  });

  it("keeps the three finder patterns and both timing lines", () => {
    const { modules, size } = encodeQr(LINK, "L");
    const dark = (x: number, y: number): boolean => (modules[y] as boolean[])[x] === true;
    for (const [fx, fy] of [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ] as const) {
      for (let dy = 0; dy < 7; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
          expect(dark(fx + dx, fy + dy)).toBe(ring !== 2);
        }
      }
    }
    for (let i = 8; i < size - 8; i++) {
      expect(dark(i, 6)).toBe(i % 2 === 0);
      expect(dark(6, i)).toBe(i % 2 === 0);
    }
    // The one module that is always dark, whatever the mask.
    expect(dark(8, size - 8)).toBe(true);
  });
});

describe("renderQr", () => {
  it("packs two module rows into each line, with a light quiet zone", () => {
    const symbol = encodeQr("hello", "L");
    const lines = renderQr(symbol, { quietZone: 2 });
    const width = symbol.size + 4;
    expect(lines).toHaveLength(Math.ceil(width / 2));
    for (const line of lines) expect([...line]).toHaveLength(width);
    // The first line is entirely quiet zone: both halves light, so full blocks.
    expect(lines[0]).toBe("█".repeat(width));
  });

  it("inverts for a light terminal", () => {
    const plain = qrLines("hello", { ecc: "L", quietZone: 2 });
    const inverted = qrLines("hello", { ecc: "L", quietZone: 2, invert: true });
    expect(inverted[0]).toBe(" ".repeat((plain[0] as string).length));
    expect(inverted).not.toEqual(plain);
  });
});
