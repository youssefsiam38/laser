/**
 * Known-answer tests against the Noise project's own vectors (cacophony),
 * trimmed to the two suites laser speaks. This is the one place in the repo
 * where tests are unambiguously worth the time: a Noise bug is silent.
 *
 * Every vector runs twice — once on the @noble backend, once on WebCrypto —
 * so the two paths are proven byte-identical, not merely both "working".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CipherState,
  EMPTY,
  NoiseHandshake,
  nobleBackend,
  toHex,
  fromHex,
  webCryptoBackend,
  webCryptoSupportsX25519,
  type CryptoBackend,
  type NoisePattern,
} from "../src/index.js";

interface Vector {
  protocol_name: string;
  init_prologue: string;
  init_static: string;
  init_ephemeral: string;
  init_remote_static: string;
  resp_prologue: string;
  resp_static: string;
  resp_remote_static?: string;
  resp_ephemeral: string;
  handshake_hash: string;
  messages: { payload: string; ciphertext: string }[];
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./vectors/noise-ik-kk-25519-aesgcm-sha256.json", import.meta.url)), "utf8"),
) as { vectors: Vector[] };

const HANDSHAKE_MESSAGES = 2;

async function runVector(vector: Vector, backend: CryptoBackend): Promise<void> {
  const pattern = vector.protocol_name.split("_")[1] as NoisePattern;
  const prologue = fromHex(vector.init_prologue);
  expect(vector.resp_prologue).toBe(vector.init_prologue);

  const initStatic = await backend.importKeyPair(fromHex(vector.init_static));
  const respStatic = await backend.importKeyPair(fromHex(vector.resp_static));

  const initiator = await NoiseHandshake.create({
    pattern,
    initiator: true,
    prologue,
    staticKeyPair: initStatic,
    remoteStaticPublicKey: fromHex(vector.init_remote_static),
    backend,
    ephemeralKeyPair: await backend.importKeyPair(fromHex(vector.init_ephemeral)),
  });
  const responder = await NoiseHandshake.create({
    pattern,
    initiator: false,
    prologue,
    staticKeyPair: respStatic,
    ...(pattern === "KK" ? { remoteStaticPublicKey: fromHex(vector.resp_remote_static ?? "") } : {}),
    backend,
    ephemeralKeyPair: await backend.importKeyPair(fromHex(vector.resp_ephemeral)),
  });

  // --- handshake ---
  for (let i = 0; i < HANDSHAKE_MESSAGES; i++) {
    const step = vector.messages[i]!;
    const writer = i % 2 === 0 ? initiator : responder;
    const reader = i % 2 === 0 ? responder : initiator;
    const produced = await writer.writeMessage(fromHex(step.payload));
    expect(toHex(produced), `handshake message ${i + 1} ciphertext`).toBe(step.ciphertext);
    const payload = await reader.readMessage(fromHex(step.ciphertext));
    expect(toHex(payload), `handshake message ${i + 1} payload`).toBe(step.payload);
  }

  expect(initiator.complete).toBe(true);
  expect(responder.complete).toBe(true);
  expect(toHex(initiator.handshakeHash)).toBe(vector.handshake_hash);
  expect(toHex(responder.handshakeHash)).toBe(vector.handshake_hash);
  // IK learns the initiator's static from message 1; KK knew it already.
  expect(toHex(responder.remoteStaticPublicKey!)).toBe(toHex(initStatic.publicKey));

  // --- transport ---
  const initCiphers = await initiator.split();
  const respCiphers = await responder.split();
  for (let i = HANDSHAKE_MESSAGES; i < vector.messages.length; i++) {
    const step = vector.messages[i]!;
    const fromInitiator = i % 2 === 0;
    const send: CipherState = fromInitiator ? initCiphers.send : respCiphers.send;
    const receive: CipherState = fromInitiator ? respCiphers.receive : initCiphers.receive;
    const produced = await send.encryptWithAd(EMPTY, fromHex(step.payload));
    expect(toHex(produced), `transport message ${i} ciphertext`).toBe(step.ciphertext);
    const opened = await receive.decryptWithAd(EMPTY, fromHex(step.ciphertext));
    expect(toHex(opened), `transport message ${i} payload`).toBe(step.payload);
  }
}

const backends: [string, CryptoBackend][] = [["noble", nobleBackend]];
if (await webCryptoSupportsX25519()) backends.push(["webcrypto", webCryptoBackend]);

describe("Noise known-answer vectors", () => {
  it("runs on both backends", () => {
    // Guards against silently testing one path twice on an engine without X25519.
    expect(backends.map(([name]) => name)).toContain("webcrypto");
  });

  for (const [backendName, backend] of backends) {
    for (const vector of fixture.vectors) {
      it(`${vector.protocol_name} on ${backendName}`, async () => {
        await runVector(vector, backend);
      });
    }
  }
});

describe("Rekey", () => {
  it("matches ENCRYPT(k, 2^64-1, empty, zeros[32]) and leaves the counter alone", async () => {
    const key = fromHex("0101010101010101010101010101010101010101010101010101010101010101");
    const state = await CipherState.create(nobleBackend, key);
    await state.encryptWithAd(EMPTY, fromHex("00"));
    expect(state.nonce).toBe(1n);
    await state.rekey();
    expect(state.nonce, "Noise Rekey() must not reset n").toBe(1n);

    // Independent computation of the expected new key.
    const maxNonce = new Uint8Array(12);
    new DataView(maxNonce.buffer).setBigUint64(4, (1n << 64n) - 1n, false);
    const wide = await nobleBackend.seal(
      await nobleBackend.importAeadKey(key),
      maxNonce,
      EMPTY,
      new Uint8Array(32),
    );
    const expected = await CipherState.create(nobleBackend, wide.slice(0, 32));
    // Line the counters up, then check the two states agree on a ciphertext.
    await expected.encryptWithAd(EMPTY, fromHex("00"));
    const a = await state.encryptWithAd(fromHex("aabb"), fromHex("deadbeef"));
    const b = await expected.encryptWithAd(fromHex("aabb"), fromHex("deadbeef"));
    expect(toHex(a)).toBe(toHex(b));
  });
});
