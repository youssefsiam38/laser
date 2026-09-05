/**
 * Where the relay's state lives on this machine (M9-T7, M6).
 *
 * Three files in the state directory, and nothing anywhere else:
 *
 *   relay.json         the relay URL, the phone's origin, and the signed
 *                      device list. Not secret — the list is public by
 *                      design, which is why it is signed rather than hidden.
 *   identity.key       the Ed25519 root seed that signs that list. Mode 0600.
 *   relay-static.key   the durable X25519 scalar every paired device runs its
 *                      Noise_KK against. Mode 0600.
 *
 * The two keys are separate on purpose: the root identity is the thing that
 * says *who this desktop is* and outlives everything, while the static key is
 * transport. Losing the root key invalidates every pairing (the phones verify
 * the list against it), so it is created once and never rotated here.
 *
 * The state directory follows `--state-dir` like everything else, so
 * `piorbit --state-dir /tmp/x relay …` is a sandbox and cannot reach the real
 * pairings. The desktop shell keeps the same root seed in the OS keychain
 * (`packages/desktop/src/keychain.ts`); this is the headless path, and
 * `FileRootIdentityStore` is the store the crypto package ships for exactly
 * that case.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  emptyDeviceList,
  fromBase64Url,
  loadOrCreateRootIdentity,
  rootIdentityFromSeed,
  selectBackend,
  toBase64Url,
  verifyDeviceList,
  type DeviceListBody,
  type KeyPair,
  type RootIdentity,
  type SignedDeviceList,
} from "@piorbit/crypto";
import { FileRootIdentityStore } from "@piorbit/crypto/node";

import { CliError, ExitCode } from "./errors.js";
import type { PiorbitPaths } from "./config.js";

export interface RelayConfig {
  v: 1;
  /** `wss://relay.example/ws`. */
  relayUrl: string;
  /**
   * The https origin a phone opens — where the PWA is served from. The QR
   * points at `<publicOrigin>/link`, and the host uses it to build absolute
   * links in push notifications (`HostRelayOptions.publicOrigin`).
   */
  publicOrigin?: string;
  /** Human label for this desktop, shown on the phone after pairing. */
  hostName?: string;
  deviceList?: SignedDeviceList;
}

export function relayConfigPath(paths: PiorbitPaths): string {
  return join(paths.stateDir, "relay.json");
}

export function identityPath(paths: PiorbitPaths): string {
  return join(paths.stateDir, "identity.key");
}

export function staticKeyPath(paths: PiorbitPaths): string {
  return join(paths.stateDir, "relay-static.key");
}

/** The stored config, or undefined when `relay login` has never run. */
export function readRelayConfig(paths: PiorbitPaths): RelayConfig | undefined {
  const path = relayConfigPath(paths);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CliError(`could not read ${path}`, {
      cause: error,
      fix: "Check the file's permissions, or delete it and run `piorbit relay login <url>` again.",
    });
  }
  let parsed: Partial<RelayConfig>;
  try {
    parsed = JSON.parse(text) as Partial<RelayConfig>;
  } catch (error) {
    throw new CliError(`${path} is not valid JSON`, {
      cause: error,
      details: ["Nothing else reads this file, so deleting it loses only the relay URL and the device list."],
      fix: "Delete it and run `piorbit relay login <url>`, then pair each device again.",
    });
  }
  if (parsed.v !== 1 || typeof parsed.relayUrl !== "string") {
    throw new CliError(`${path} is not a relay configuration this version understands`, {
      fix: "Delete it and run `piorbit relay login <url>`.",
    });
  }
  return parsed as RelayConfig;
}

export function writeRelayConfig(paths: PiorbitPaths, config: RelayConfig): void {
  const path = relayConfigPath(paths);
  const temporary = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new CliError(`could not write ${path}`, {
      cause: error,
      fix: `Check that ${dirname(path)} is writable.`,
    });
  }
}

/** The root identity, created on first use. `created` invalidates every pairing. */
export async function loadIdentity(paths: PiorbitPaths): Promise<{ identity: RootIdentity; created: boolean }> {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  return loadOrCreateRootIdentity(new FileRootIdentityStore(identityPath(paths)));
}

/**
 * The root identity if it exists, and nothing if it does not. Reading status
 * must not generate a key: `piorbit relay` on a machine that has never paired
 * anything should leave the disk exactly as it found it.
 */
export async function readIdentity(paths: PiorbitPaths): Promise<RootIdentity | undefined> {
  const seed = await new FileRootIdentityStore(identityPath(paths)).load();
  if (!seed) return undefined;
  const identity = rootIdentityFromSeed(seed);
  seed.fill(0);
  return identity;
}

/**
 * The durable X25519 transport key, created on first use. Stored as a raw
 * scalar and imported through whichever backend this engine chose, so on Node
 * 24 the private key ends up as a non-extractable WebCrypto key even though it
 * came off disk.
 */
export async function loadStaticKey(paths: PiorbitPaths): Promise<{ keyPair: KeyPair; created: boolean }> {
  const path = staticKeyPath(paths);
  const backend = await selectBackend();
  let raw: Uint8Array | undefined;
  try {
    raw = fromBase64Url(readFileSync(path, "utf8").trim());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new CliError(`the relay transport key at ${path} is damaged`, {
        cause: error,
        fix: "Delete it and pair your devices again; nothing else depends on it.",
      });
    }
  }
  if (raw && raw.length !== 32) {
    throw new CliError(`the relay transport key at ${path} is ${raw.length} bytes, expected 32`, {
      fix: "Delete it and pair your devices again.",
    });
  }
  if (raw) return { keyPair: await backend.importKeyPair(raw), created: false };

  const seed = backend.randomBytes(32);
  const temporary = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, toBase64Url(seed), { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new CliError(`could not write the relay transport key to ${path}`, { cause: error });
  }
  const keyPair = await backend.importKeyPair(seed);
  seed.fill(0);
  return { keyPair, created: true };
}

/**
 * The device list as it stands: verified against the root key, or a fresh
 * empty one. A list that does not verify is a hard stop — quietly starting
 * over would drop a revocation on the floor.
 */
export function deviceListOf(config: RelayConfig | undefined, identity: RootIdentity): DeviceListBody {
  if (!config?.deviceList) return emptyDeviceList(identity);
  try {
    return verifyDeviceList(config.deviceList, identity.publicKey);
  } catch (error) {
    throw new CliError(`the stored device list does not verify: ${error instanceof Error ? error.message : String(error)}`, {
      exitCode: ExitCode.Failure,
      details: ["piorbit will not connect any device on a list it cannot check."],
      fix: "If you changed or lost the root identity, delete relay.json and pair every device again.",
    });
  }
}

/** `wss://` or `ws://`, with a path. Anything else is a mistake worth naming. */
export function normalizeRelayUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.includes("://") ? input : `wss://${input}`);
  } catch {
    throw new CliError(`${JSON.stringify(input)} is not a URL`, {
      exitCode: ExitCode.Usage,
      fix: "Give the relay's WebSocket endpoint, for example `wss://relay.example.com/ws`.",
    });
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new CliError(`the relay URL uses ${url.protocol}, which is not a WebSocket scheme`, {
      exitCode: ExitCode.Usage,
      fix: "Use `wss://…` (or `ws://…` only for a relay on this machine).",
    });
  }
  if (url.protocol === "ws:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new CliError("a remote relay must be wss://, not ws://", {
      exitCode: ExitCode.Usage,
      details: ["The traffic is encrypted end to end either way, but ws:// leaks the channel id to every hop."],
      fix: `Use wss://${url.host}${url.pathname}.`,
    });
  }
  return url.toString().replace(/\/+$/, url.pathname === "/" ? "" : "");
}

/** The https origin a phone opens, defaulted from the relay's host. */
export function normalizePublicOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    throw new CliError(`${JSON.stringify(input)} is not a URL`, {
      exitCode: ExitCode.Usage,
      fix: "Give the origin the phone opens, for example `https://app.example.com`.",
    });
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new CliError(`${url.origin} is not https`, {
      exitCode: ExitCode.Usage,
      details: ["A phone will not install a PWA, use a camera, or keep a service worker on an insecure origin."],
      fix: `Use https://${url.host}.`,
    });
  }
  return url.origin;
}
