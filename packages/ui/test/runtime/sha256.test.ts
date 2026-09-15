import { describe, expect, it } from "vitest";
import { Sha256Stream } from "../../src/runtime/sha256.js";

/** What WebCrypto says, for the same bytes. */
async function reference(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

describe("hashing a body that arrives in pieces", () => {
  it("matches the published vectors", async () => {
    expect(new Sha256Stream().digest()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(new Sha256Stream().updateText("abc").digest()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(new Sha256Stream().updateText("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq").digest())
      .toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(new Sha256Stream().updateText("a".repeat(1_000_000)).digest())
      .toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });

  it("does not care where the pieces were cut, including inside a character", async () => {
    const body = `${"ü".repeat(500)}😀${"x".repeat(4096)}${"\u0130".repeat(300)}`;
    const whole = await reference(body);
    expect(new Sha256Stream().updateText(body).digest()).toBe(whole);

    // Text pieces cut on character boundaries, at every awkward size.
    const characters = [...body];
    for (const size of [1, 3, 55, 56, 63, 64, 65, 127, 128, 1000]) {
      const running = new Sha256Stream();
      for (let index = 0; index < characters.length; index += size) running.updateText(characters.slice(index, index + size).join(""));
      expect(running.digest()).toBe(whole);
    }

    // Byte pieces that split a character: the bytes are what is hashed.
    const bytes = new TextEncoder().encode(body);
    for (const size of [1, 7, 64, 65, 4096]) {
      const running = new Sha256Stream();
      for (let index = 0; index < bytes.byteLength; index += size) running.update(bytes.subarray(index, index + size));
      expect(running.digest()).toBe(whole);
    }
  });

  it("refuses to be used after it has answered", () => {
    const running = new Sha256Stream().updateText("done");
    running.digest();
    expect(() => running.updateText("more")).toThrow();
  });
});
