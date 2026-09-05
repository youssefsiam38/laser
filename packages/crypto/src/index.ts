/**
 * @piorbit/crypto (M6-T1..T3)
 *
 * Fixed design (D-10, docs/research/findings.md "Relay and mobile"):
 *  - Noise_IK for first contact after QR scan; Noise_KK once both statics are known.
 *  - Suite 25519_AESGCM_SHA256 so browser keys are non-extractable WebCrypto CryptoKeys.
 *  - Prologue = channel id. Per-frame AAD = channel_id ‖ direction ‖ seq. One CipherState per
 *    direction. Counter nonces. Reject gaps. Rekey every 120 s.
 *  - Channel id = HKDF(shared_secret, "relay_token"): only the two peers can compute it.
 *  - Pairing QR carries an ephemeral public key in the URL fragment; the paired side encrypts
 *    real key material to it. A photographed QR is useless after use.
 *  - Device list: desktop root Ed25519 key signs { version, devices[] }; revoke = re-sign.
 */
export const NOISE_PROTOCOL_IK = "Noise_IK_25519_AESGCM_SHA256";
export const NOISE_PROTOCOL_KK = "Noise_KK_25519_AESGCM_SHA256";
export const RELAY_TOKEN_INFO = "relay_token";
export const REKEY_INTERVAL_MS = 120_000;
export const FRAME_BUCKETS = [64, 256, 1024, 4096] as const;
