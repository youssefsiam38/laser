/**
 * Node-only helpers. Importing this from a browser bundle will fail at build
 * time, which is the point: `@lasercode/crypto` proper stays portable.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fromBase64Url, toBase64Url } from "./bytes.js";
import { IdentityStoreError, type RootIdentityStore } from "./identity.js";
import { DATA_DIR_NAME, ENV } from "@lasercode/protocol/identity";

export function defaultIdentityPath(): string {
  return join(process.env[ENV.home] ?? join(homedir(), `.${DATA_DIR_NAME}`), "identity.key");
}

/**
 * Fallback for headless hosts with no keychain (a Linux box with no Secret
 * Service, CI). Mode 0600, written atomically. The desktop should prefer
 * `createKeyringRootIdentityStore`; this exists so `piorbit` still runs where a
 * keychain does not.
 */
export class FileRootIdentityStore implements RootIdentityStore {
  readonly description: string;

  constructor(private readonly path: string = defaultIdentityPath()) {
    this.description = path;
  }

  async load(): Promise<Uint8Array | null> {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8").trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new IdentityStoreError(`could not read the root identity from ${this.path}`, { cause: error });
    }
    try {
      const seed = fromBase64Url(text);
      if (seed.length !== 32) throw new Error(`expected 32 bytes, got ${seed.length}`);
      return seed;
    } catch (cause) {
      throw new IdentityStoreError(
        `the root identity file ${this.path} is damaged. Delete it and pair your devices again.`,
        { cause },
      );
    }
  }

  async save(seed: Uint8Array): Promise<void> {
    const temporary = `${this.path}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, toBase64Url(seed), { encoding: "utf8", mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.path);
    } catch (cause) {
      rmSync(temporary, { force: true });
      throw new IdentityStoreError(`could not write the root identity to ${this.path}`, { cause });
    }
  }

  async clear(): Promise<void> {
    rmSync(this.path, { force: true });
  }
}
