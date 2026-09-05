/**
 * base64url is hand-written because `Buffer` is absent in a browser and `atob`
 * mangles binary in some engines. Device public keys and signatures round-trip
 * through it, so a bug here is a bug in pairing. Fuzz it against Node's own
 * implementation.
 */
import { describe, expect, it } from "vitest";
import { equalBytes, fromBase64Url, fromHex, toBase64Url, toHex } from "../src/index.js";

describe("base64url", () => {
  it("agrees with Node for every length up to 200 bytes", () => {
    for (let length = 0; length <= 200; length++) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = (i * 37 + length * 11) & 255;
      const encoded = toBase64Url(bytes);
      expect(encoded, `length ${length}`).toBe(Buffer.from(bytes).toString("base64url"));
      expect(Buffer.compare(Buffer.from(fromBase64Url(encoded)), Buffer.from(bytes)), `length ${length}`).toBe(0);
    }
  });

  it("accepts padded and standard-alphabet input", () => {
    expect(toHex(fromBase64Url("_-8="))).toBe(toHex(fromBase64Url("/+8")));
  });

  it("rejects impossible input instead of returning garbage", () => {
    expect(() => fromBase64Url("A")).toThrow(/mod 4/);
    expect(() => fromBase64Url("AA*A")).toThrow(/invalid base64url character/);
  });
});

describe("hex", () => {
  it("round-trips and rejects bad input", () => {
    const bytes = Uint8Array.from([0, 1, 15, 16, 127, 128, 255]);
    expect(toHex(bytes)).toBe("00010f107f80ff");
    expect(equalBytes(fromHex(toHex(bytes)), bytes)).toBe(true);
    expect(() => fromHex("abc")).toThrow(/odd length/);
    expect(() => fromHex("zz")).toThrow(/invalid hex/);
  });
});

describe("equalBytes", () => {
  it("compares content, not identity, and is false for different lengths", () => {
    expect(equalBytes(fromHex("0102"), fromHex("0102"))).toBe(true);
    expect(equalBytes(fromHex("0102"), fromHex("0103"))).toBe(false);
    expect(equalBytes(fromHex("0102"), fromHex("010200"))).toBe(false);
  });
});
