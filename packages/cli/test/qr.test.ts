/**
 * The QR encoder, pinned against an independent implementation.
 *
 * `src/qr.ts` is a from-scratch encoder, and the failure mode of a
 * from-scratch encoder is a symbol that looks exactly like a QR code and that
 * no phone will read. Eyeballing the terminal output proves nothing, so the
 * fixture below is a whole 41×41 matrix produced by `qrcode@1.5.4` for a real
 * pairing link at error-correction level L — the level and the shape
 * `piorbit relay pair` actually prints. During development the two agreed on
 * every length from 1 to 2400 bytes at all four levels; this keeps the one
 * that matters honest.
 *
 * Only the mask is a free choice: any of the eight is a valid symbol and the
 * format bits say which one was used. This fixture is a case where both
 * implementations pick the same mask, so it compares module for module.
 */
import { describe, expect, it } from "vitest";

import { encodeQr, qrLines, renderQr } from "../src/qr.js";

const LINK =
  "https://app.piorbit.dev/link#v1.d3NzOi8vcmVsYXkucGlvcmJpdC5kZXYvd3M.Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG0";

/** `qrcode@1.5.4`, `QR.create(LINK, { errorCorrectionLevel: "L" })`. */
const EXPECTED_L = [
  "11111110000111100111101110000001101111111",
  "10000010111001111100111000111000101000001",
  "10111010010001000110111010000010001011101",
  "10111010111100111000001110101001001011101",
  "10111010010010010010000100000010101011101",
  "10000010101010111110010011011000101000001",
  "11111110101010101010101010101010101111111",
  "00000000000000110000010110100010100000000",
  "11111011100001110000101111110111010101010",
  "01011100100110011011111101101011101111001",
  "11110110000110010010111001110000001010010",
  "01110001001000111001010100101001000011000",
  "11011010000010010011101100100100000001101",
  "10011000101001111001010000101100110110101",
  "00010111011111000100101011110100010111000",
  "11001000111100101001110000000010110001010",
  "11011111001110100100001111000100010101100",
  "00000100010001101111100000101111111110011",
  "11111111101001110100001011111010000110000",
  "01100101011111010110011110110001011011011",
  "00000110111000111001001110100000110111111",
  "10001001010011010110110100001011001111001",
  "10010111110001011000000010010000001110100",
  "10001000101010010011011110101011111001010",
  "10001011000000111100101001000100100001011",
  "00010100110110101000110100001111101110000",
  "01100011100010010010110011110000100101100",
  "00100000100000100000011100011001111100011",
  "00011111010010000011011101100101100101101",
  "10001101010001111001101001011000111110111",
  "10011111011110000100011011111000010001000",
  "10101101011100001011011110010000010111001",
  "10100110010110100100111011110101111110110",
  "00000000100101111110111001001100100010111",
  "11111110111011111100101000011111101010110",
  "10000010010101011111011110101011100010000",
  "10111010110000101000101000101000111110101",
  "10111010100011010011111110100001000001101",
  "10111010111000011110001000111100111011000",
  "10000010101010110000010010010011010101010",
  "11111110100001110100101101010111001100000",
];

const asRows = (modules: boolean[][]): string[] =>
  modules.map((row) => row.map((cell) => (cell ? "1" : "0")).join(""));

describe("encodeQr", () => {
  it("produces the reference matrix for a pairing link at level L", () => {
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
    const symbol = encodeQr("piorbit", "L");
    const lines = renderQr(symbol, { quietZone: 2 });
    const width = symbol.size + 4;
    expect(lines).toHaveLength(Math.ceil(width / 2));
    for (const line of lines) expect([...line]).toHaveLength(width);
    // The first line is entirely quiet zone: both halves light, so full blocks.
    expect(lines[0]).toBe("█".repeat(width));
  });

  it("inverts for a light terminal", () => {
    const plain = qrLines("piorbit", { ecc: "L", quietZone: 2 });
    const inverted = qrLines("piorbit", { ecc: "L", quietZone: 2, invert: true });
    expect(inverted[0]).toBe(" ".repeat((plain[0] as string).length));
    expect(inverted).not.toEqual(plain);
  });
});
