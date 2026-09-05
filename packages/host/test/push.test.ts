/**
 * Web Push, checked the only way that proves anything: encrypt with our code
 * and decrypt with an independent implementation of the receiver side of
 * RFC 8291, then verify the VAPID JWT against its own public key.
 *
 * Everything else in `push.ts` is bookkeeping; this is the part that is
 * impossible to eyeball and silent when it is wrong (a push service answers
 * 201 for a message no device can decrypt).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushService, b64url, encryptPushPayload, generateVapidKeys, vapidAuthorization } from "../src/push.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

/** A browser's subscription: an ECDH key pair plus a 16-byte auth secret. */
async function fakeSubscription() {
  const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    ua,
    uaPublic,
    auth,
    subscription: {
      endpoint: "https://push.example/send/abc",
      keys: { p256dh: b64url.encode(uaPublic), auth: b64url.encode(auth) },
    },
  };
}

describe("push encryption", () => {
  it("produces a body a receiver can decrypt back to the exact document", async () => {
    const { ua, uaPublic, auth, subscription } = await fakeSubscription();
    const message = JSON.stringify({
      web_push: 8030,
      notification: { title: "piorbit needs you", navigate: "https://r.example/?decision=d1#/session/x" },
    });

    const body = await encryptPushPayload(subscription, utf8(message));

    const salt = body.slice(0, 16);
    const view = new DataView(body.buffer, body.byteOffset);
    expect(view.getUint32(16)).toBe(4096);
    expect(body[20]).toBe(65);
    const asPublic = body.slice(21, 21 + 65);
    const ciphertext = body.slice(21 + 65);

    const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
    const ikm = await hkdf(auth, ecdh, concat(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
    const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
    const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, ciphertext));

    const delimiter = padded.lastIndexOf(2);
    expect(delimiter).toBeGreaterThan(0);
    expect(padded.slice(delimiter + 1).every((byte) => byte === 0)).toBe(true);
    expect(new TextDecoder().decode(padded.slice(0, delimiter))).toBe(message);
  });

  it("refuses a subscription whose keys are the wrong shape", async () => {
    await expect(
      encryptPushPayload(
        { endpoint: "https://push.example/x", keys: { p256dh: b64url.encode(new Uint8Array(64)), auth: "AAAA" } },
        utf8("x"),
      ),
    ).rejects.toThrow(/uncompressed P-256 point/);
  });
});

describe("vapid", () => {
  it("signs a JWT that verifies against the key it advertises", async () => {
    const keys = await generateVapidKeys();
    const header = await vapidAuthorization(keys, "https://push.example", "mailto:me@example.com");
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    expect(match![2]).toBe(keys.publicKey);

    const [h, c, sig] = match![1]!.split(".");
    const pub = await crypto.subtle.importKey(
      "raw",
      b64url.decode(keys.publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64url.decode(sig!), utf8(`${h}.${c}`)),
    ).toBe(true);
    const claims = JSON.parse(new TextDecoder().decode(b64url.decode(c!))) as { aud: string; exp: number };
    expect(claims.aud).toBe("https://push.example");
    expect(claims.exp - Date.now() / 1000).toBeLessThanOrEqual(24 * 3600);
  });
});

describe("PushService", () => {
  it("keeps one row per endpoint, persists its keys, and drops a subscription the service says is gone", async () => {
    const { subscription } = await fakeSubscription();
    const agentDir = mkdtempSync(join(tmpdir(), "piorbit-push-"));
    const calls: { headers: Record<string, string> }[] = [];
    const service = new PushService({
      agentDir,
      fetch: (async (_url: string, init: { headers: Record<string, string> }) => {
        calls.push({ headers: init.headers });
        return new Response("", { status: calls.length === 1 ? 201 : 410 });
      }) as unknown as typeof fetch,
    });

    const config = await service.config();
    expect(config.enabled).toBe(true);
    expect(config.vapidPublicKey).toBeTruthy();

    const device = { label: "iPhone · Safari", platform: "ios" as const, standalone: true };
    const first = await service.subscribe(subscription, device);
    const second = await service.subscribe(subscription, device);
    expect(second.id).toBe(first.id);
    expect(await service.list()).toHaveLength(1);

    // A second process must find the same keys: rotating them would silently
    // orphan every device that already subscribed.
    expect((await new PushService({ agentDir }).config()).vapidPublicKey).toBe(config.vapidPublicKey);

    const sent = await service.send(
      subscription.endpoint,
      { web_push: 8030, notification: { title: "t", navigate: "https://r.example/" } },
      { topic: "decision:d1" },
    );
    expect(sent.delivered).toBe(true);
    expect(calls[0]!.headers["Content-Type"]).toBe("application/notification+json");
    expect(calls[0]!.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(calls[0]!.headers["Topic"]).toBe("decision_d1");
    expect(calls[0]!.headers["Authorization"]).toMatch(/^vapid t=/);

    const gone = await service.send(subscription.endpoint, {}, {});
    expect(gone.expired).toBe(true);
    expect(await service.list()).toHaveLength(0);
  });
});
