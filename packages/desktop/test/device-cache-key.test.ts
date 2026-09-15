/**
 * The key this computer keeps for cached conversations (RP-10, M18-T10).
 *
 * Two properties matter more than the happy path:
 *
 * 1. **No file fallback.** The host token falls back to a 0600 file, and that
 *    is correct for a bearer this machine needs to work at all. A cache key is
 *    the opposite: a key in a file beside the ciphertext it decrypts is not
 *    encryption, so a machine with no keyring is told it has none and the
 *    renderer stores what it caches unencrypted and says so.
 * 2. **Nothing leaks.** The key never reaches the log, and the sentence a
 *    person reads never carries a platform error dump.
 *
 * `@napi-rs/keyring` is mocked, because a real keychain prompt in a test run
 * would be a test that depends on somebody's login session.
 */
import { readdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_NAME } from "@lasercode/protocol";

const entries = new Map<string, string | null>();
let probeThrows: string | undefined;
let setThrows = false;

vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    constructor(readonly service: string, readonly account: string) {
      if (probeThrows) throw new Error(probeThrows);
    }

    private get key(): string {
      return `${this.service}\u0000${this.account}`;
    }

    getPassword(): string | null {
      return entries.get(this.key) ?? null;
    }

    setPassword(value: string): void {
      if (setThrows) throw new Error("the keychain is locked");
      entries.set(this.key, value);
    }

    deletePassword(): void {
      entries.delete(this.key);
    }
  },
}));

const lines: string[] = [];
const log = {
  line: (text: string) => lines.push(text),
  error: (text: string, error?: unknown) => lines.push(`${text} ${String(error ?? "")}`),
} as unknown as import("../src/log.js").DesktopLog;

let stateDir: string;

beforeEach(() => {
  entries.clear();
  lines.length = 0;
  probeThrows = undefined;
  setThrows = false;
  stateDir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-cache-key-`));
});

afterEach(() => {
  vi.resetModules();
});

async function load() {
  return (await import("../src/keychain.js")).loadDeviceCacheKey;
}

describe("the device cache key", () => {
  it("creates one key, reuses it, and names the store it lives in", async () => {
    const loadDeviceCacheKey = await load();
    const first = loadDeviceCacheKey(log);
    expect(first.available).toBe(true);
    if (!first.available) return;
    // 32 bytes as base64url.
    expect(first.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.store).toMatch(/keychain|Credential Manager|keyring/);

    const second = loadDeviceCacheKey(log);
    expect(second.available && second.key).toBe(first.key);
  });

  it("replaces the key on request, which makes everything cached unreadable", async () => {
    const loadDeviceCacheKey = await load();
    const first = loadDeviceCacheKey(log);
    const reset = loadDeviceCacheKey(log, true);
    expect(reset.available).toBe(true);
    expect(reset.available && first.available && reset.key).not.toBe(first.available && first.key);
    // And the new one is what a later read returns.
    const after = loadDeviceCacheKey(log);
    expect(after.available && reset.available && after.key).toBe(reset.key);
  });

  it("has no key at all, and no file, when this machine has no keychain", async () => {
    probeThrows = "no secret service";
    const loadDeviceCacheKey = await load();
    const answer = loadDeviceCacheKey(log);
    expect(answer.available).toBe(false);
    expect(answer.available === false && answer.reason).toContain("no keychain");
    // The whole point: nothing was written anywhere.
    expect(readdirSync(stateDir)).toEqual([]);
    expect(entries.size).toBe(0);
  });

  it("reports a locked keychain as unavailable, without the platform's own words", async () => {
    setThrows = true;
    const loadDeviceCacheKey = await load();
    const answer = loadDeviceCacheKey(log);
    expect(answer.available).toBe(false);
    expect(answer.available === false && answer.reason).toMatch(/locked/);
    expect(answer.available === false && answer.reason).not.toContain("Error");
  });

  it("never writes the key to the log", async () => {
    const loadDeviceCacheKey = await load();
    const answer = loadDeviceCacheKey(log);
    expect(answer.available).toBe(true);
    if (!answer.available) return;
    expect(lines.join("\n")).not.toContain(answer.key);
  });

  it("refuses a stored value too short to be a key and writes a real one", async () => {
    const { KEYCHAIN_SERVICE } = await import("@lasercode/crypto");
    entries.set(`${KEYCHAIN_SERVICE}\u0000device-cache-key`, "short");
    const loadDeviceCacheKey = await load();
    const answer = loadDeviceCacheKey(log);
    expect(answer.available && answer.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
