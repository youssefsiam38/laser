/**
 * @lasercode/crypto — everything the relay is deliberately unable to do.
 *
 * Fixed design (D-10, docs/research/findings.md "Relay and mobile"):
 *  - Noise_IK for first contact after a QR scan; Noise_KK once both statics are known.
 *  - Suite 25519_AESGCM_SHA256 so browser keys can be non-extractable WebCrypto CryptoKeys.
 *  - Prologue = channel id. Per-frame AAD = channel_id ‖ direction ‖ seq. One CipherState per
 *    direction. Counter nonces. Reject gaps. Rekey every 120 s.
 *  - Channel id = HKDF(shared_secret, "relay_token"): only the two peers can compute it.
 *  - Pairing QR carries an ephemeral public key in the URL fragment; the paired side encrypts
 *    real key material to it. A photographed QR is useless after use.
 *  - Device list: desktop root Ed25519 key signs { version, devices[] }; revoke = re-sign.
 *
 * This entry point is browser-safe. Node-only stores live in `@lasercode/crypto/node`.
 */
export * from "./bytes.js";
export * from "./backend.js";
export * from "./noise.js";
export * from "./framing.js";
export * from "./session.js";
export * from "./sas.js";
export * from "./pairing.js";
export * from "./device-list.js";
export * from "./identity.js";
export * from "./timing.js";

/** The two suite names, spelled out. `noiseProtocolName(pattern)` builds them. */
export const NOISE_PROTOCOL_IK = "Noise_IK_25519_AESGCM_SHA256";
export const NOISE_PROTOCOL_KK = "Noise_KK_25519_AESGCM_SHA256";
