/**
 * Pairing (M6-T2).
 *
 * The desktop shows a QR whose fragment carries a **single-use ephemeral X25519
 * public key**. Nothing durable is in it, so a photograph of the QR taken after
 * the pairing completes is worth nothing: the desktop destroys the ephemeral the
 * moment the handshake finishes or the invite expires.
 *
 * The phone runs Noise_IK as initiator with that ephemeral standing in for the
 * desktop's static, and sends its own real static inside message 1 (encrypted).
 * The desktop — the side that already holds the root identity — replies with the
 * grant: its real static public key, its root public key, and the signed device
 * list. That is what "the authenticated side encrypts the real key material to
 * it" means in practice.
 *
 * Two channel ids exist and they are different on purpose:
 *
 *   pairing    HKDF(salt = "piorbit-pairing-channel-v1", ikm = ephemeral pub,
 *                   info = "relay_token")
 *              — derivable by anyone who sees the QR, which is inherent: the two
 *                peers have to rendezvous before they share a secret. Bounded by
 *                a TTL, single use, exactly two sockets, and the SAS.
 *
 *   steady      HKDF(salt = "piorbit-channel-v1",
 *                    ikm = DH(device static, desktop static),
 *                    info = "relay_token" ‖ epoch)
 *              — only the two peers can compute it. This is the routing key for
 *                every reconnection, one per paired device.
 */
import { PRODUCT_NAME } from "@lasercode/protocol/identity";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { selectBackend, type CryptoBackend, type KeyPair } from "./backend.js";
import { concatBytes, fromBase64Url, toBase64Url, u32be, utf8 } from "./bytes.js";
import { NoiseHandshake } from "./noise.js";
import { shortAuthenticationString, type Sas } from "./sas.js";
import { deviceIdFor, findDevice, verifyDeviceList, type SignedDeviceList } from "./device-list.js";
import { CHANNEL_ID_BYTES, NoiseSession } from "./session.js";

export const RELAY_TOKEN_INFO = "relay_token";
export const PAIRING_LINK_VERSION = "v1";
export const DEFAULT_PAIRING_TTL_MS = 180_000;

const CHANNEL_SALT = /* @__PURE__ */ utf8("piorbit-channel-v1");
const PAIRING_CHANNEL_SALT = /* @__PURE__ */ utf8("piorbit-pairing-channel-v1");

export class PairingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PairingError";
  }
}

/**
 * The relay's routing key for a paired device: `HKDF(shared_secret,
 * "relay_token")`. `epoch` exists so a future task can rotate the id on a
 * schedule both peers agree on; today it is always 0 and the id is stable, which
 * is why "channel id linkability" is on the residual-metadata list.
 */
export function deriveChannelId(sharedSecret: Uint8Array, options: { epoch?: number } = {}): Uint8Array {
  const info = concatBytes(utf8(RELAY_TOKEN_INFO), u32be(options.epoch ?? 0));
  return hkdf(sha256, sharedSecret, CHANNEL_SALT, info, CHANNEL_ID_BYTES);
}

/** The rendezvous channel for one pairing attempt. Derivable from the QR alone. */
export function derivePairingChannelId(ephemeralPublicKey: Uint8Array): Uint8Array {
  return hkdf(sha256, ephemeralPublicKey, PAIRING_CHANNEL_SALT, utf8(RELAY_TOKEN_INFO), CHANNEL_ID_BYTES);
}

/** What the phone tells the desktop about itself, encrypted inside Noise message 1. */
export interface PairingRequest {
  /** Shown on the desktop's approval prompt. Untrusted text: escape it. */
  name: string;
  platform?: string;
  /** The app version doing the pairing, for the device list. */
  client?: string;
}

/** What the desktop hands back, encrypted inside Noise message 2. */
export interface PairingGrant {
  /** Where to reconnect. The QR's relay URL, restated so the phone stores one source of truth. */
  relayUrl: string;
  /** base64url X25519 — the desktop's real, durable static key. */
  staticPublicKey: string;
  /** base64url Ed25519 — the root identity that signs the device list. */
  rootPublicKey: string;
  /** The device list as re-signed to include this device. Verify it before storing. */
  deviceList: SignedDeviceList;
  /** This device's id inside that list. */
  deviceId: string;
  /** Human label for the desktop, shown in the phone's UI. */
  hostName?: string;
}

export interface PairingLink {
  version: typeof PAIRING_LINK_VERSION;
  relayUrl: string;
  ephemeralPublicKey: Uint8Array;
  /** Derived, not transmitted. */
  channelId: Uint8Array;
}

function encodeFragment(relayUrl: string, ephemeralPublicKey: Uint8Array): string {
  return [PAIRING_LINK_VERSION, toBase64Url(utf8(relayUrl)), toBase64Url(ephemeralPublicKey)].join(".");
}

/**
 * Parse a scanned link. Everything sensitive is in the URL **fragment**, which
 * browsers never put in a request line, a Referer header or a server log.
 */
export function parsePairingLink(link: string): PairingLink {
  const hash = link.indexOf("#");
  const fragment = hash >= 0 ? link.slice(hash + 1) : link;
  const parts = fragment.split(".");
  if (parts.length !== 3) {
    throw new PairingError(
      `this is not a ${PRODUCT_NAME} pairing link — scan the QR shown by “Link a device” on the desktop`,
    );
  }
  const [version, relay, ephemeral] = parts as [string, string, string];
  if (version !== PAIRING_LINK_VERSION) {
    throw new PairingError(`pairing link version ${version} is not supported by this build (expected ${PAIRING_LINK_VERSION}); update both sides`);
  }
  let relayUrl: string;
  let ephemeralPublicKey: Uint8Array;
  try {
    relayUrl = new TextDecoder().decode(fromBase64Url(relay));
    ephemeralPublicKey = fromBase64Url(ephemeral);
  } catch (cause) {
    throw new PairingError("the pairing link is damaged — rescan the QR", { cause });
  }
  if (ephemeralPublicKey.length !== 32) {
    throw new PairingError(`the pairing link carries a ${ephemeralPublicKey.length}-byte key, expected 32 — rescan the QR`);
  }
  if (!/^wss?:\/\//.test(relayUrl)) {
    throw new PairingError(`the pairing link points at ${relayUrl}, which is not a WebSocket URL`);
  }
  return { version: PAIRING_LINK_VERSION, relayUrl, ephemeralPublicKey, channelId: derivePairingChannelId(ephemeralPublicKey) };
}

// ------------------------------------------------------------- responder ---

export interface PairingResponderOptions {
  /** `wss://relay.example/ws` — where both sides meet. */
  relayUrl: string;
  ttlMs?: number;
  backend?: CryptoBackend;
  now?: () => number;
}

/**
 * Desktop side of pairing. Create one per press of "Link a device"; it is good
 * for exactly one successful handshake and then refuses.
 */
export class PairingResponder {
  readonly relayUrl: string;
  readonly ephemeralPublicKey: Uint8Array;
  readonly channelId: Uint8Array;
  readonly expiresAt: number;

  private request: PairingRequest | undefined;
  private devicePublicKey: Uint8Array | undefined;
  private sasValue: Sas | undefined;
  private granted = false;
  /** True once a message has been fed to the handshake, successfully or not. */
  private attempted = false;

  private constructor(
    options: PairingResponderOptions,
    private readonly handshake: NoiseHandshake,
    private readonly ephemeral: KeyPair,
    private readonly now: () => number,
  ) {
    this.relayUrl = options.relayUrl;
    this.ephemeralPublicKey = ephemeral.publicKey;
    this.channelId = derivePairingChannelId(ephemeral.publicKey);
    this.expiresAt = this.now() + (options.ttlMs ?? DEFAULT_PAIRING_TTL_MS);
  }

  static async create(options: PairingResponderOptions): Promise<PairingResponder> {
    const backend = options.backend ?? (await selectBackend());
    const ephemeral = await backend.generateKeyPair();
    const channelId = derivePairingChannelId(ephemeral.publicKey);
    const handshake = await NoiseHandshake.create({
      pattern: "IK",
      initiator: false,
      prologue: channelId,
      staticKeyPair: ephemeral,
      backend,
    });
    return new PairingResponder(options, handshake, ephemeral, options.now ?? Date.now);
  }

  /** The string to render as a QR. `baseUrl` is the PWA origin, e.g. `https://app.piorbit.dev/link`. */
  link(baseUrl: string): string {
    return `${baseUrl}#${encodeFragment(this.relayUrl, this.ephemeralPublicKey)}`;
  }

  get expired(): boolean {
    return this.now() >= this.expiresAt;
  }

  /**
   * Consume Noise message 1. Returns what to put on the approval prompt: the
   * device's claimed name, its key, and — the point — the SAS to compare.
   *
   * The SAS is derived here, from the handshake hash after message 1, which
   * both sides can compute before anything is disclosed. Deriving it after
   * `grant()` (as this used to) made it a detector rather than a gate: by the
   * time either screen could show an emoji, the desktop had already shipped its
   * static key, its root key and the whole signed device list to whoever was on
   * the other end.
   */
  async readRequest(
    message1: Uint8Array,
  ): Promise<{ request: PairingRequest; devicePublicKey: Uint8Array; sas: Sas }> {
    if (this.expired) throw new PairingError("this pairing code has expired — show a new one on the desktop");
    if (this.request) throw new PairingError("this pairing code has already been used — show a new one on the desktop");
    const first = !this.attempted;
    this.attempted = true;
    let payload: Uint8Array;
    try {
      payload = await this.handshake.readMessage(message1);
    } catch (cause) {
      // A single junk frame poisons the handshake, so this code can never be
      // used again; say that rather than blaming the desktop it belongs to.
      throw new PairingError(
        first
          ? "the pairing request did not authenticate — the code may belong to a different desktop"
          : // The handshake was already mutated by the earlier attempt, so this
            // failure says nothing about the phone in front of the user.
            "this pairing code was disturbed by an unexpected connection — show a new one on the desktop",
        { cause },
      );
    }
    this.request = decodeJson<PairingRequest>(payload, "pairing request");
    if (typeof this.request.name !== "string" || this.request.name.length === 0) {
      throw new PairingError("the device did not send a name");
    }
    this.devicePublicKey = this.handshake.remoteStaticPublicKey!;
    this.sasValue = shortAuthenticationString(this.handshake.handshakeHash);
    return { request: this.request, devicePublicKey: this.devicePublicKey, sas: this.sasValue };
  }

  /**
   * Called after the user approves. Produces Noise message 2 carrying the grant.
   *
   * `sasConfirmed` is not ceremony: this message discloses the desktop's static
   * key, its root key and every linked device's name and key. The caller must
   * have shown `sas` and had a person say it matches the phone's before setting
   * it, because after this there is nothing left to protect.
   */
  async grant(grant: PairingGrant, options: { sasConfirmed: boolean }): Promise<Uint8Array> {
    if (!this.request) throw new PairingError("grant() before readRequest()");
    if (this.granted) throw new PairingError("this pairing code has already been used");
    if (options?.sasConfirmed !== true) {
      throw new PairingError(
        "the grant was refused because the emoji were not confirmed: show readRequest()'s `sas` on both screens " +
          "and pass { sasConfirmed: true } only once a person has compared them",
      );
    }
    const message2 = await this.handshake.writeMessage(utf8(JSON.stringify(grant)));
    this.granted = true;
    return message2;
  }

  /**
   * The six emoji to compare with the phone's screen. Defined from the moment
   * `readRequest()` succeeds — before anything has been disclosed — so it can
   * gate the approval rather than merely audit it afterwards.
   */
  get sas(): Sas {
    if (!this.sasValue) throw new PairingError("the SAS is only defined once readRequest() has accepted message 1");
    return this.sasValue;
  }

  /**
   * The transport for this pairing connection, valid until the phone reconnects
   * on its steady-state channel.
   */
  async session(options: { rekeyIntervalMs?: number; now?: () => number } = {}): Promise<NoiseSession> {
    if (!this.granted) throw new PairingError("session() before grant()");
    return new NoiseSession({
      ...(await this.handshake.split()),
      channelId: this.channelId,
      initiator: false,
      ...(options.rekeyIntervalMs !== undefined ? { rekeyIntervalMs: options.rekeyIntervalMs } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  }
}

// ------------------------------------------------------------- initiator ---

export interface PairingInitiatorOptions {
  link: string | PairingLink;
  /** The phone's durable static key. Generate it non-extractable and keep it. */
  staticKeyPair: KeyPair;
  backend?: CryptoBackend;
}

/** Phone side of pairing. */
export class PairingInitiator {
  readonly relayUrl: string;
  readonly channelId: Uint8Array;

  private started = false;
  private sasValue: Sas | undefined;

  private constructor(
    private readonly parsed: PairingLink,
    private readonly handshake: NoiseHandshake,
    /** This phone's own static public key, for checking the grant names us. */
    private readonly staticPublicKey: Uint8Array,
  ) {
    this.relayUrl = parsed.relayUrl;
    this.channelId = parsed.channelId;
  }

  static async create(options: PairingInitiatorOptions): Promise<PairingInitiator> {
    const parsed = typeof options.link === "string" ? parsePairingLink(options.link) : options.link;
    const backend = options.backend ?? (await selectBackend());
    const handshake = await NoiseHandshake.create({
      pattern: "IK",
      initiator: true,
      prologue: parsed.channelId,
      staticKeyPair: options.staticKeyPair,
      remoteStaticPublicKey: parsed.ephemeralPublicKey,
      backend,
    });
    return new PairingInitiator(parsed, handshake, options.staticKeyPair.publicKey);
  }

  /**
   * Noise message 1: our static, encrypted, plus who we claim to be — and the
   * SAS to put on screen. Both sides can compute it from the handshake hash at
   * this point, which is what makes the comparison a gate on the desktop's
   * disclosure instead of a post-mortem.
   */
  async start(request: PairingRequest): Promise<{ message1: Uint8Array; sas: Sas }> {
    if (this.started) throw new PairingError("this pairing attempt has already started");
    this.started = true;
    const message1 = await this.handshake.writeMessage(utf8(JSON.stringify(request)));
    this.sasValue = shortAuthenticationString(this.handshake.handshakeHash);
    return { message1, sas: this.sasValue };
  }

  /**
   * Noise message 2: the grant, fully checked before it is handed back.
   *
   * The signature, the root key it names, and the fact that this phone is in
   * the list under the id the grant gives it are all verified here rather than
   * left to a caller's discipline: a caller that forgets one line would adopt
   * an unsigned device list.
   */
  async complete(message2: Uint8Array): Promise<{ grant: PairingGrant; sas: Sas }> {
    let payload: Uint8Array;
    try {
      payload = await this.handshake.readMessage(message2);
    } catch (cause) {
      throw new PairingError(
        "the desktop's reply did not authenticate — someone may be sitting between you; compare the emoji or try again",
        { cause },
      );
    }
    const grant = decodeJson<PairingGrant>(payload, "pairing grant");
    for (const field of ["relayUrl", "staticPublicKey", "rootPublicKey", "deviceId"] as const) {
      if (typeof grant[field] !== "string" || grant[field].length === 0) {
        throw new PairingError(`the desktop's grant is missing "${field}"`);
      }
    }
    this.verifyGrant(grant);
    return { grant, sas: this.sas };
  }

  /** Every check that must pass before this phone stores anything from a grant. */
  private verifyGrant(grant: PairingGrant): void {
    let body;
    try {
      body = verifyDeviceList(grant.deviceList, grant.rootPublicKey);
    } catch (cause) {
      throw new PairingError(
        `the desktop's device list did not verify: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    if (body.rootPublicKey !== grant.rootPublicKey) {
      throw new PairingError("the grant's root key is not the key that signed its device list");
    }
    const us = findDevice(body, this.staticPublicKey);
    if (!us) {
      throw new PairingError("the desktop's device list does not contain this device; pair again from the desktop");
    }
    if (us.id !== grant.deviceId) {
      throw new PairingError("the grant names a different device id than the one this device has in the list");
    }
    let desktopStatic: Uint8Array;
    try {
      desktopStatic = fromBase64Url(grant.staticPublicKey);
    } catch (cause) {
      throw new PairingError("the grant's transport key is not valid base64url", { cause });
    }
    if (body.devices.some((device) => device.id === deviceIdFor(desktopStatic))) {
      throw new PairingError("the desktop listed its own transport key as a device; that list cannot be trusted");
    }
  }

  get sas(): Sas {
    if (!this.sasValue) throw new PairingError("the SAS is only defined once start() has written message 1");
    return this.sasValue;
  }

  async session(options: { rekeyIntervalMs?: number; now?: () => number } = {}): Promise<NoiseSession> {
    return new NoiseSession({
      ...(await this.handshake.split()),
      channelId: this.channelId,
      initiator: true,
      ...(options.rekeyIntervalMs !== undefined ? { rekeyIntervalMs: options.rekeyIntervalMs } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  }
}

// ------------------------------------------------------------ steady state --

/**
 * Open a Noise_KK connection on the steady-state channel. Both peers hold both
 * statics by now, so the pattern gives mutual authentication in one round trip.
 */
export async function openKkHandshake(options: {
  initiator: boolean;
  staticKeyPair: KeyPair;
  remoteStaticPublicKey: Uint8Array;
  channelId: Uint8Array;
  backend?: CryptoBackend;
}): Promise<NoiseHandshake> {
  return NoiseHandshake.create({
    pattern: "KK",
    initiator: options.initiator,
    prologue: options.channelId,
    staticKeyPair: options.staticKeyPair,
    remoteStaticPublicKey: options.remoteStaticPublicKey,
    ...(options.backend ? { backend: options.backend } : {}),
  });
}

/** The channel id for a device, computed from the static-static DH. */
export async function channelIdFor(
  staticKeyPair: KeyPair,
  remoteStaticPublicKey: Uint8Array,
  options: { epoch?: number; backend?: CryptoBackend } = {},
): Promise<Uint8Array> {
  const backend = options.backend ?? (await selectBackend());
  const shared = await backend.dh(staticKeyPair.privateKey, remoteStaticPublicKey);
  const id = deriveChannelId(shared, options.epoch !== undefined ? { epoch: options.epoch } : {});
  shared.fill(0);
  return id;
}

function decodeJson<T>(bytes: Uint8Array, what: string): T {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch (cause) {
    throw new PairingError(`the ${what} was not valid JSON`, { cause });
  }
}
