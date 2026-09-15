/**
 * SHA-256 over a body that arrives a slice at a time (RP-5b §7).
 *
 * Reconstructing a body — copying all of it, rebuilding an image — must end
 * with the same digest the conversation's authority published for it, and that
 * check cannot wait for the whole body: the whole point is that the whole body
 * is never in hand. `crypto.subtle.digest` takes one buffer and has no
 * streaming form, so this wraps the exact-pinned `@noble/hashes`
 * implementation the relay already trusts, and adds nothing of its own beyond
 * text encoding and hex.
 */
import { sha256 } from "@noble/hashes/sha2.js";

/** A running SHA-256 over bytes handed to it in any number of pieces. */
export class Sha256Stream {
  private readonly hash = sha256.create();
  private readonly encoder = new TextEncoder();

  update(bytes: Uint8Array): this {
    this.hash.update(bytes);
    return this;
  }

  /** The same bytes a `TextEncoder` would produce for this text. */
  updateText(text: string): this {
    return this.update(this.encoder.encode(text));
  }

  /** Lowercase hex, matching `sliceDigestOf` and the authority's digests. */
  digest(): string {
    let hex = "";
    for (const byte of this.hash.digest()) hex += byte.toString(16).padStart(2, "0");
    return hex;
  }
}
