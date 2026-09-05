import { WIRE_NAMESPACE } from "@lasercode/protocol/identity";
/**
 * Signed device list (M6-T3).
 *
 * The desktop holds one Ed25519 root identity, in the OS keychain, and signs a
 * versioned list of the devices allowed to reach it. Revocation is nothing more
 * than re-signing the list without that device and bumping `version`. A phone
 * verifies the signature against the root key it learned during pairing and
 * refuses any list older than the newest one it has already seen, so a relay
 * cannot roll a device's revocation back by replaying an old list.
 *
 * The list is signed over a canonical JSON encoding — sorted keys, no
 * whitespace, no floats — with a domain-separating prefix, so a signature can
 * never be mistaken for a signature over anything else laser signs.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, equalBytes, fromBase64Url, toBase64Url, utf8 } from "./bytes.js";

export const DEVICE_LIST_CONTEXT = `${WIRE_NAMESPACE}-device-list-v1`;
const DEVICE_ID_CONTEXT = /* @__PURE__ */ utf8(`${WIRE_NAMESPACE}-device-id-v1`);
const DEVICE_ID_BYTES = 16;

export class DeviceListError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DeviceListError";
  }
}

export interface DeviceEntry {
  /** Derived from the public key, so it cannot be forged into pointing elsewhere. */
  id: string;
  /** User-supplied label. Untrusted text — escape it wherever it is rendered. */
  name: string;
  /** base64url X25519 static public key. */
  publicKey: string;
  platform?: string;
  client?: string;
  /** ISO 8601. */
  addedAt: string;
}

export interface DeviceListBody {
  version: number;
  updatedAt: string;
  /** base64url Ed25519 root public key, restated so a list is self-describing. */
  rootPublicKey: string;
  devices: DeviceEntry[];
}

export interface SignedDeviceList {
  body: DeviceListBody;
  /** base64url Ed25519 signature over `laser-device-list-v1\n` ‖ canonicalJson(body). */
  signature: string;
}

/** Stable id for a device: the first 16 bytes of a domain-separated hash of its public key. */
export function deviceIdFor(publicKey: Uint8Array): string {
  return toBase64Url(sha256(concatBytes(DEVICE_ID_CONTEXT, publicKey)).slice(0, DEVICE_ID_BYTES));
}

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit, arrays in order,
 * no insignificant whitespace. Rejects anything that would not round-trip
 * (undefined, NaN, Infinity, non-integer-safe numbers, functions).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      // Only safe integers: a float has no single canonical decimal form, so
      // two signers could disagree on the bytes and produce different signatures
      // over the same list.
      if (!Number.isSafeInteger(value)) {
        throw new DeviceListError(`cannot canonicalize ${value}; only safe integers are allowed (use a string)`);
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new DeviceListError(`cannot canonicalize a value of type ${typeof value}`);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function signedBytes(body: DeviceListBody): Uint8Array {
  return concatBytes(utf8(`${DEVICE_LIST_CONTEXT}\n`), utf8(canonicalJson(body)));
}

/** Root identity: an Ed25519 key pair derived from a 32-byte seed. */
export interface RootIdentity {
  /** base64url Ed25519 public key. */
  readonly publicKey: string;
  readonly publicKeyBytes: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
}

export function generateRootSeed(): Uint8Array {
  return ed25519.utils.randomSecretKey();
}

export function rootIdentityFromSeed(seed: Uint8Array): RootIdentity {
  if (seed.length !== 32) throw new DeviceListError(`root identity seed must be 32 bytes, got ${seed.length}`);
  const secret = Uint8Array.from(seed);
  const publicKeyBytes = ed25519.getPublicKey(secret);
  return {
    publicKey: toBase64Url(publicKeyBytes),
    publicKeyBytes,
    sign: (message) => ed25519.sign(message, secret),
  };
}

export function emptyDeviceList(root: RootIdentity, now = new Date()): DeviceListBody {
  return { version: 1, updatedAt: now.toISOString(), rootPublicKey: root.publicKey, devices: [] };
}

export function signDeviceList(body: DeviceListBody, root: RootIdentity): SignedDeviceList {
  if (body.rootPublicKey !== root.publicKey) {
    throw new DeviceListError("the list names a different root public key than the key signing it");
  }
  return { body, signature: toBase64Url(root.sign(signedBytes(body))) };
}

export interface VerifyOptions {
  /**
   * Refuse a list at or below this version. Pass the version you already hold —
   * this is the rollback defence, and skipping it is how revocation gets undone.
   */
  minVersion?: number;
}

/** Throws `DeviceListError` with a message a user can act on. Returns the verified body. */
export function verifyDeviceList(
  signed: SignedDeviceList,
  rootPublicKey: string,
  options: VerifyOptions = {},
): DeviceListBody {
  const body = signed?.body;
  if (!body || typeof body !== "object") throw new DeviceListError("device list is missing its body");
  if (!Number.isSafeInteger(body.version) || body.version < 1) {
    throw new DeviceListError(`device list has an invalid version (${String(body.version)})`);
  }
  if (!Array.isArray(body.devices)) throw new DeviceListError("device list has no devices array");
  if (body.rootPublicKey !== rootPublicKey) {
    throw new DeviceListError(
      "this device list was signed by a different desktop than the one you paired with; pair again from the desktop you trust",
    );
  }
  if (options.minVersion !== undefined && body.version < options.minVersion) {
    throw new DeviceListError(
      `refusing device list version ${body.version}: version ${options.minVersion} is already known. ` +
        "An older list would undo a revocation.",
    );
  }
  let ok = false;
  try {
    ok = ed25519.verify(fromBase64Url(signed.signature), signedBytes(body), fromBase64Url(rootPublicKey));
  } catch (cause) {
    throw new DeviceListError("the device list signature is malformed", { cause });
  }
  if (!ok) throw new DeviceListError("the device list signature does not verify — do not trust this list");
  for (const device of body.devices) {
    if (typeof device?.publicKey !== "string" || typeof device.id !== "string") {
      throw new DeviceListError("a device entry is missing its id or public key");
    }
    if (device.id !== deviceIdFor(fromBase64Url(device.publicKey))) {
      throw new DeviceListError(`device "${device.name}" has an id that does not match its public key`);
    }
  }
  return body;
}

export function addDevice(body: DeviceListBody, device: Omit<DeviceEntry, "id">, now = new Date()): DeviceListBody {
  const id = deviceIdFor(fromBase64Url(device.publicKey));
  if (body.devices.some((d) => d.id === id)) {
    throw new DeviceListError("that device is already linked");
  }
  return {
    ...body,
    version: body.version + 1,
    updatedAt: now.toISOString(),
    devices: [...body.devices, { ...device, id }],
  };
}

/** Revocation is a re-sign with the device gone. There is no revocation list to distribute. */
export function revokeDevice(body: DeviceListBody, deviceId: string, now = new Date()): DeviceListBody {
  const devices = body.devices.filter((d) => d.id !== deviceId);
  if (devices.length === body.devices.length) {
    throw new DeviceListError(`no linked device with id ${deviceId}`);
  }
  return { ...body, version: body.version + 1, updatedAt: now.toISOString(), devices };
}

export function findDevice(body: DeviceListBody, publicKey: Uint8Array): DeviceEntry | undefined {
  const id = deviceIdFor(publicKey);
  return body.devices.find((d) => d.id === id);
}

export function isAuthorized(body: DeviceListBody, publicKey: Uint8Array): boolean {
  const entry = findDevice(body, publicKey);
  return entry !== undefined && equalBytes(fromBase64Url(entry.publicKey), publicKey);
}

/**
 * Holds the newest verified list and refuses to go backwards. The phone keeps
 * one of these; persist `current` and feed it back on startup.
 */
export class DeviceListStore {
  private body: DeviceListBody | undefined;

  constructor(
    readonly rootPublicKey: string,
    initial?: SignedDeviceList,
  ) {
    if (initial) this.body = verifyDeviceList(initial, rootPublicKey);
  }

  get current(): DeviceListBody | undefined {
    return this.body;
  }

  get version(): number {
    return this.body?.version ?? 0;
  }

  /** Verify and adopt. Returns the accepted body; throws if it is older or unsigned. */
  accept(signed: SignedDeviceList): DeviceListBody {
    const body = verifyDeviceList(signed, this.rootPublicKey, { minVersion: this.version });
    if (this.body && body.version === this.body.version && canonicalJson(body) !== canonicalJson(this.body)) {
      throw new DeviceListError(
        `two different device lists claim version ${body.version}; the desktop's signing key may be compromised`,
      );
    }
    this.body = body;
    return body;
  }
}
