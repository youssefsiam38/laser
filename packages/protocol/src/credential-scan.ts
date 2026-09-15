/**
 * Reading a JSON body as it goes past, looking for a credential (RP-7).
 *
 * The host defends a body it did not redact itself. It used to do that by
 * running the key regular expression over each piece plus a fixed 512
 * characters of the piece before it — which is not a complete check: the key
 * grammar allows arbitrarily long prefix segments, so a key of any length that
 * ends in `password` can be cut across two pieces and be missed.
 *
 * This is a scanner instead. It walks the text once, as it arrives, and keeps
 * only the key token it is currently reading, bounded by
 * {@link JSON_KEY_MAX_CHARS}. Values are never retained: a value is only
 * compared, character by character, against the redaction sentinel. Anything
 * it cannot prove — a key longer than the bound, a string that never ends, a
 * body that stops mid-token — is a failure, not a pass.
 */
import { REDACTED, SECRET_KEY } from "./log-redaction.js";

/**
 * The longest key this scanner will hold. Real provider payloads have short
 * keys; a longer one is either not a key or not something we can check, and
 * either way the body is not stored.
 */
export const JSON_KEY_MAX_CHARS = 256;

export type ScanOutcome =
  | { ok: true }
  /** A credential-shaped key whose value is not the sentinel. Key names only. */
  | { ok: false; reason: "unredacted"; keys: string[] }
  /** Not provably clean: a key past the bound, or JSON that does not end. */
  | { ok: false; reason: "corrupt"; detail: "overlong-key" | "unterminated" | "malformed" };

type Mode =
  /** Anywhere that is not inside a string. */
  | "text"
  /** Inside a string that might be a key. */
  | "string"
  /** Inside a string, having just read a backslash. */
  | "escape"
  /** Inside a string, reading the four hex digits of a `\uXXXX` escape. */
  | "unicode"
  /** A string ended; looking for the `:` that would make it a key. */
  | "after-string"
  /** Reading the value of a credential-shaped key. */
  | "secret-value";

/** What each escape stands for inside a key. */
const UNESCAPED: Readonly<Record<string, string>> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };

export class CredentialScanner {
  private mode: Mode = "text";
  private token = "";
  private tokenTruncated = false;
  private pendingKey: string | undefined;
  private failure: ScanOutcome | undefined;
  private readonly keys: string[] = [];
  /** How much of the sentinel the current secret value has matched. */
  private sentinelMatched = 0;
  private sentinelExact = true;
  private sentinelIsString = false;
  /** Hex digits collected for a `\uXXXX` escape inside a key. */
  private unicode = "";

  /** True once the body cannot be stored; the caller may stop feeding it. */
  get failed(): boolean {
    return this.failure !== undefined;
  }

  /** Feed the next piece. Never throws; never keeps a value. */
  push(text: string): void {
    if (this.failure) return;
    for (let index = 0; index < text.length; index++) {
      const character = text[index]!;
      switch (this.mode) {
        case "text":
          if (character === '"') {
            this.mode = "string";
            this.token = "";
            this.tokenTruncated = false;
          }
          continue;
        case "string":
          if (character === "\\") {
            this.mode = "escape";
            continue;
          }
          if (character === '"') {
            this.mode = "after-string";
            continue;
          }
          this.append(character);
          if (this.failure) return;
          continue;
        case "escape":
          // An escape is decoded, so a key written as `\u0061pi_key` is the
          // same key as `api_key` to this scanner.
          if (character === "u") {
            this.unicode = "";
            this.mode = "unicode";
            continue;
          }
          this.append(UNESCAPED[character] ?? character);
          this.mode = "string";
          if (this.failure) return;
          continue;
        case "unicode":
          this.unicode += character;
          if (this.unicode.length < 4) continue;
          {
            const code = Number.parseInt(this.unicode, 16);
            // A malformed escape is not something this can read; the body is
            // not stored rather than guessed at.
            if (!Number.isFinite(code)) {
              this.failure = { ok: false, reason: "corrupt", detail: "malformed" };
              return;
            }
            this.append(String.fromCharCode(code));
          }
          this.unicode = "";
          this.mode = "string";
          if (this.failure) return;
          continue;
        case "after-string":
          if (character === " " || character === "\n" || character === "\r" || character === "\t") continue;
          if (character !== ":") {
            // Not a key: it was a value, or an array member.
            this.mode = character === '"' ? "string" : "text";
            if (this.mode === "string") {
              this.token = "";
              this.tokenTruncated = false;
            }
            continue;
          }
          // It is a key. One longer than this scanner will hold cannot be
          // checked, so the body is not stored: a bound that silently gives up
          // is the hole this replaced.
          if (this.tokenTruncated) {
            this.failure = { ok: false, reason: "corrupt", detail: "overlong-key" };
            return;
          }
          // Only a credential-shaped key is worth following.
          if (SECRET_KEY.test(this.token)) {
            this.pendingKey = this.token;
            this.mode = "secret-value";
            this.sentinelMatched = 0;
            this.sentinelExact = true;
            this.sentinelIsString = false;
          } else {
            this.mode = "text";
          }
          this.token = "";
          continue;
        case "secret-value":
          this.value(character);
          if (this.failure) return;
          continue;
      }
    }
  }

  /** Nothing more is coming. Anything unfinished is a failure. */
  end(): ScanOutcome {
    if (this.failure) return this.failure;
    if (this.mode === "string" || this.mode === "escape" || this.mode === "unicode") {
      return { ok: false, reason: "corrupt", detail: "unterminated" };
    }
    if (this.mode === "secret-value") {
      // A credential's value that the body ended in the middle of: not
      // provably the sentinel, so not storable.
      return { ok: false, reason: "unredacted", keys: this.keys.concat(this.pendingKey ?? []) };
    }
    if (this.keys.length > 0) return { ok: false, reason: "unredacted", keys: [...this.keys] };
    return { ok: true };
  }

  private append(character: string): void {
    // Past the bound the token is no longer kept — most long strings are
    // values, and a value is never retained. If it turns out to be a key, the
    // body is refused rather than guessed at (see `after-string`).
    if (this.token.length >= JSON_KEY_MAX_CHARS) {
      this.tokenTruncated = true;
      return;
    }
    this.token += character;
  }

  /**
   * Walk a credential's value without keeping it: only how much of the
   * sentinel it has matched so far, and whether it still could be it.
   */
  private value(character: string): void {
    if (this.sentinelMatched === 0 && !this.sentinelIsString) {
      if (character === " " || character === "\n" || character === "\r" || character === "\t") return;
      if (character !== '"') {
        // A number, a literal, an object: not the sentinel, so a survivor.
        this.flagPending();
        this.mode = character === "{" || character === "[" ? "text" : "text";
        return;
      }
      this.sentinelIsString = true;
      return;
    }
    const expected = REDACTED[this.sentinelMatched];
    if (character === '"') {
      // The value ended. It is the sentinel only if it matched all of it.
      if (!(this.sentinelExact && this.sentinelMatched === REDACTED.length)) this.flagPending();
      else this.pendingKey = undefined;
      this.mode = "text";
      return;
    }
    if (character === "\\") {
      // An escape inside what would have to be a literal sentinel: it is not.
      this.sentinelExact = false;
      return;
    }
    if (expected === undefined || character !== expected) this.sentinelExact = false;
    this.sentinelMatched += 1;
  }

  private flagPending(): void {
    const key = this.pendingKey;
    this.pendingKey = undefined;
    if (key && !this.keys.includes(key)) this.keys.push(key);
  }
}

/**
 * The whole of one text, in one call: the same scanner, for a body that is
 * already in memory.
 */
export function scanForCredentials(text: string): ScanOutcome {
  const scanner = new CredentialScanner();
  scanner.push(text);
  return scanner.end();
}
