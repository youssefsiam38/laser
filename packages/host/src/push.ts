/**
 * Web Push from the host (M7-T5).
 *
 * VAPID keys generated on first run into the Pi agent
 * dir, a subscription store next to them, and RFC 8291 (aes128gcm) message
 * encryption + RFC 8292 (VAPID) authentication on Node's WebCrypto. No
 * dependency: the whole of Web Push on the sending side is ~150 lines of
 * HKDF, ECDH and AES-GCM, all of which `globalThis.crypto.subtle` has.
 *
 * One payload for both platforms: the Declarative Web Push document from
 * `@lasercode/protocol` (`src/push.ts`), which the page and the service worker
 * read from the same file. Sent with
 * `Content-Type: application/notification+json` so Safari renders it without
 * a service worker; Chromium's worker renders the same JSON.
 *
 * The encryption is checked against an independent decryption in
 * `test/push.test.ts` (RFC 8291 round trip, VAPID JWT verify, 410 eviction).
 */
import { DATA_DIR_NAME, PRODUCT_NAME } from "@lasercode/protocol";
import type { webcrypto } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PushConfig, PushDeviceInfo, PushSubscriptionJson } from "@lasercode/protocol";

export interface StoredPushSubscription {
  id: string;
  subscription: PushSubscriptionJson;
  device: PushDeviceInfo;
  createdAt: string;
  lastSentAt?: string;
  lastError?: string;
}

interface PushStoreFile {
  version: 1;
  vapid: { publicKey: string; privateJwk: webcrypto.JsonWebKey };
  subject: string;
  subscriptions: StoredPushSubscription[];
}

export interface PushSendResult {
  delivered: boolean;
  status?: number;
  error?: string;
  /** The push service said the subscription is gone (404/410); it was removed. */
  expired?: boolean;
}

// ---------------------------------------------------------------------------
// base64url / bytes
// ---------------------------------------------------------------------------

export const b64url = {
  encode: (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url"),
  decode: (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64url")),
};

const utf8 = (s: string) => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** HKDF-SHA256 with a single expand block (every Web Push output is ≤ 32 bytes). */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

// ---------------------------------------------------------------------------
// VAPID keys
// ---------------------------------------------------------------------------

export interface VapidKeys {
  /** base64url of the 65-byte uncompressed P-256 point — the `applicationServerKey`. */
  publicKey: string;
  privateJwk: webcrypto.JsonWebKey;
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: b64url.encode(raw), privateJwk };
}

/** `Authorization: vapid t=<jwt>, k=<publicKey>` for one push-service origin. */
export async function vapidAuthorization(keys: VapidKeys, audience: string, subject: string, now = Date.now()): Promise<string> {
  const header = b64url.encode(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url.encode(utf8(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const signing = utf8(`${header}.${claims}`);
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, signing));
  return `vapid t=${header}.${claims}.${b64url.encode(signature)}, k=${keys.publicKey}`;
}

// ---------------------------------------------------------------------------
// RFC 8291 encryption
// ---------------------------------------------------------------------------

const RECORD_SIZE = 4096;

export async function encryptPushPayload(subscription: PushSubscriptionJson, plaintext: Uint8Array): Promise<Uint8Array> {
  const uaPublic = b64url.decode(subscription.keys.p256dh);
  const authSecret = b64url.decode(subscription.keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("subscription p256dh is not an uncompressed P-256 point");
  if (authSecret.length !== 16) throw new Error("subscription auth secret is not 16 bytes");

  const asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  const keyInfo = concat(utf8("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  // One record: payload, then the 0x02 "last record" delimiter, then padding to hide length a little.
  const padded = concat(plaintext, new Uint8Array([2]), new Uint8Array(Math.max(0, 128 - ((plaintext.length + 1) % 128))));
  if (padded.length + 16 > RECORD_SIZE) throw new Error(`push payload too large (${plaintext.length} bytes; max ≈ 3900)`);
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));

  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = 65;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

// ---------------------------------------------------------------------------
// Store + sender
// ---------------------------------------------------------------------------

export interface PushServiceOptions {
  /** Pi agent dir; keys and subscriptions live in `<agentDir>/piorbit/push.json`. */
  agentDir: string;
  /** VAPID `sub` claim. A mailto: or https: URL the push service can contact. */
  subject?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export class PushService {
  private readonly file: string;
  private store: PushStoreFile | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly options: PushServiceOptions;

  constructor(options: PushServiceOptions) {
    this.options = options;
    this.file = join(options.agentDir, DATA_DIR_NAME, "push.json");
    this.fetchImpl = options.fetch ?? fetch;
    this.log = options.log ?? (() => {});
  }

  /**
   * Keys are created on first use and never rotated by us: rotation orphans
   * every subscription silently. A phone's `pushManager.subscribe` is bound to
   * the `applicationServerKey` it was made with, so a new pair does not just
   * lose the stored endpoints — it makes every paired device go quiet, and
   * nothing in the browser heals it.
   *
   * Which is why "the file is not there" and "the file is there and I cannot
   * read it" are different answers. Absent is first run: generate. Present but
   * unreadable — a truncated write, a permissions change, a `version: 2` from
   * a newer piorbit — is a refusal, reported by `config()` in words, with the
   * file left exactly as it is for a person to look at.
   */
  async ready(): Promise<PushStoreFile> {
    if (this.store) return this.store;
    if (existsSync(this.file)) {
      let parsed: PushStoreFile;
      try {
        parsed = JSON.parse(readFileSync(this.file, "utf8")) as PushStoreFile;
      } catch (error) {
        throw new Error(
          `${this.file} could not be read (${error instanceof Error ? error.message : String(error)}). ` +
            `Notifications are off until it can be. Move that file aside to start again — every device will then have to turn notifications on once more.`,
        );
      }
      if (parsed.version === 1 && parsed.vapid?.publicKey && parsed.vapid.privateJwk) {
        this.store = { ...parsed, subscriptions: parsed.subscriptions ?? [] };
        return this.store;
      }
      throw new Error(
        `${this.file} was written by a different version of ${PRODUCT_NAME} (version ${String(parsed.version ?? "unknown")}). ` +
          `Notifications are off until this ${PRODUCT_NAME} understands it. Move that file aside to start again — every device will then have to turn notifications on once more.`,
      );
    }
    const vapid = await generateVapidKeys();
    this.store = { version: 1, vapid, subject: this.options.subject ?? `mailto:${PRODUCT_NAME}@localhost`, subscriptions: [] };
    this.persist();
    this.log(`push: generated VAPID keys in ${this.file}`);
    return this.store;
  }

  private persist(): void {
    if (!this.store) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    // Keep the last good copy: the keys in it are the only thing that makes an
    // already-paired phone reachable, and they cannot be derived again.
    if (existsSync(this.file)) {
      try {
        copyFileSync(this.file, `${this.file}.bak`);
      } catch {
        /* a backup is a courtesy; failing to make one must not stop a write */
      }
    }
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.store, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  async config(): Promise<PushConfig> {
    try {
      const store = await this.ready();
      return { enabled: true, vapidPublicKey: store.vapid.publicKey };
    } catch (error) {
      return { enabled: false, reason: `The desktop could not set up push: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** Upsert by endpoint. */
  async subscribe(subscription: PushSubscriptionJson, device: PushDeviceInfo): Promise<{ id: string }> {
    const store = await this.ready();
    const existing = store.subscriptions.find((s) => s.subscription.endpoint === subscription.endpoint);
    if (existing) {
      existing.subscription = subscription;
      existing.device = device;
      delete existing.lastError;
      this.persist();
      return { id: existing.id };
    }
    const id = crypto.randomUUID();
    store.subscriptions.push({ id, subscription, device, createdAt: new Date().toISOString() });
    this.persist();
    return { id };
  }

  async unsubscribe(endpoint: string): Promise<void> {
    const store = await this.ready();
    store.subscriptions = store.subscriptions.filter((s) => s.subscription.endpoint !== endpoint);
    this.persist();
  }

  async list(): Promise<StoredPushSubscription[]> {
    return (await this.ready()).subscriptions.map((s) => ({ ...s }));
  }

  /**
   * Send one document to every device. `Topic` = the notification tag so the
   * push service collapses duplicates of the same decision (R9). TTL one hour:
   * a decision older than that has almost certainly been answered or timed out.
   */
  async sendToAll(payload: unknown, options: { ttlSeconds?: number; topic?: string; urgency?: "very-low" | "low" | "normal" | "high" } = {}): Promise<PushSendResult[]> {
    const store = await this.ready();
    return Promise.all(store.subscriptions.map((s) => this.send(s.subscription.endpoint, payload, options)));
  }

  async send(endpoint: string, payload: unknown, options: { ttlSeconds?: number; topic?: string; urgency?: "very-low" | "low" | "normal" | "high" } = {}): Promise<PushSendResult> {
    const store = await this.ready();
    const row = store.subscriptions.find((s) => s.subscription.endpoint === endpoint);
    if (!row) return { delivered: false, error: "This device is not subscribed." };
    try {
      const body = await encryptPushPayload(row.subscription, utf8(JSON.stringify(payload)));
      const audience = new URL(endpoint).origin;
      const authorization = await vapidAuthorization(store.vapid, audience, store.subject);
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/notification+json",
          TTL: String(options.ttlSeconds ?? 3600),
          Urgency: options.urgency ?? "high",
          ...(options.topic ? { Topic: options.topic.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32) } : {}),
        },
        body: body,
      });
      if (response.status === 404 || response.status === 410) {
        store.subscriptions = store.subscriptions.filter((s) => s !== row);
        this.persist();
        return { delivered: false, status: response.status, expired: true, error: "That device's subscription has expired; it will re-subscribe when the app is next opened." };
      }
      if (!response.ok) {
        row.lastError = `${response.status} ${await response.text().catch(() => "")}`.trim();
        this.persist();
        return { delivered: false, status: response.status, error: `The push service answered ${response.status}.` };
      }
      row.lastSentAt = new Date().toISOString();
      delete row.lastError;
      this.persist();
      return { delivered: true, status: response.status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      row.lastError = message;
      this.persist();
      return { delivered: false, error: message };
    }
  }
}
