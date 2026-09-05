# Security model

piorbit gives a phone the same control over a coding agent that the desktop has:
reading the transcript, sending prompts, approving tool calls. That is a large
amount of authority to carry over the public internet, so the relay is built on
the assumption that it will eventually be hostile — compromised, subpoenaed, or
simply run by someone curious.

This document is the threat model for the relay path (M6). It states what the
relay can and cannot learn, what is left over after the encryption, and where the
sharp edges are. It is written to be falsifiable: every claim maps to code.

Related: `AGENTS.md` invariants 7 and 9, `docs/architecture.md`,
`docs/research/findings.md` ("Relay and mobile"), decision D-10.

---

## 1. What we are protecting

| Asset | Why it matters |
| --- | --- |
| Session transcripts | Source code, secrets pasted into prompts, internal design |
| Prompts and steering text | The same, plus what the user is thinking |
| Tool-call approvals | Authority to run commands on the developer's machine |
| Provider credentials | Never leave the desktop; the phone never sees them |
| The desktop itself | A device with relay access can drive the agent |

## 2. Who we are protecting against

| Adversary | Capability assumed | Covered? |
| --- | --- | --- |
| The relay operator | Reads and modifies every byte, forever; keeps logs | Yes for content, no for metadata (§5) |
| A network observer (café Wi-Fi, ISP) | Sees TLS-wrapped relay traffic | Yes; also sees §5 metadata |
| Someone who photographs the QR **after** pairing | Has the QR image | Yes (§4.1) |
| Someone who photographs the QR **during** pairing | Has the QR image, can reach the relay first | Partly: detected by the SAS, not prevented (§4.2) |
| A lost or stolen paired phone | Holds a valid device key | Yes, by revocation (§6) |
| A malicious agent output | Controls transcript text | Yes: escaped, never HTML (invariant 9) |
| Malware on the desktop | Root on the machine running the agent | **No.** Out of scope; it already has the agent |
| A hostile Pi extension | Runs in the worker process | **No.** Pi extensions are unsandboxed upstream |

## 3. The cryptographic core

`@piorbit/crypto` implements the Noise Protocol Framework (revision 34) with
patterns **IK** and **KK** over `25519_AESGCM_SHA256`.

- **Why Noise and not TLS.** TLS terminates at the relay. We need a channel the
  relay cannot read, inside the TLS it also sees. Noise is small enough to
  implement correctly (~450 lines) and its patterns state their security
  properties formally.
- **Why AES-GCM and not ChaCha20-Poly1305.** So a browser can hold the static
  private key as a **non-extractable WebCrypto `CryptoKey`**. WebCrypto has
  AES-GCM and X25519; it does not have ChaCha20-Poly1305. A scripting bug in the
  PWA therefore cannot exfiltrate a device identity, only borrow it while the
  page is open. Node and any engine without WebCrypto X25519 fall back to
  `@noble/curves` + `@noble/ciphers` (`src/backend.ts`), and the known-answer
  tests run over **both** backends so they cannot silently diverge.
- **Conformance.** `test/vectors/noise-ik-kk-25519-aesgcm-sha256.json` holds the
  Noise project's own cacophony vectors for exactly these two suites. The tests
  check every handshake message, every transport message, and the handshake hash.
  A Noise bug is silent by nature; this is the one place in piorbit where broad
  test automation earns its keep.

### 3.1 Handshake

| Situation | Pattern | Why |
| --- | --- | --- |
| First contact after a QR scan | `Noise_IK` | The phone already knows the desktop's (ephemeral) key from the QR, so it can encrypt its own identity in message 1 rather than sending it in the clear |
| Every reconnection afterwards | `Noise_KK` | Both sides hold each other's statics: mutual authentication in one round trip, and neither identity ever appears on the wire again |

A **fresh handshake runs on every attachment**, so a compromise of today's keys
does not decrypt yesterday's captured traffic (forward secrecy through the
ephemerals), and no counter is ever reused across connections.

### 3.2 Transport

- **Prologue = channel id.** Both peers mix the 32-byte channel id into the
  handshake hash before anything else. A handshake recorded on one channel cannot
  be replayed onto another.
- **AAD = `channel_id ‖ direction ‖ seq`** (41 bytes) on every frame. Channel
  binds the frame to its route; direction stops a frame being reflected back at
  its sender; seq stops silent reordering and truncation.
- **One `CipherState` per direction, counter nonces.** `n` is the frame sequence
  number, so a (key, nonce) pair is never reused.
- **Sequence gaps are fatal, never buffered.** A gap means tampering or a bug;
  buffering would be a second, weaker resume path that could disagree with the
  protocol's own (§7).
- **Rekey every 120 s** (WireGuard's constant), signalled rather than negotiated:
  the sender bumps a 4-byte `epoch` in the frame header and the receiver applies
  Noise `Rekey()` that many times. No clock agreement is needed, and a peer that
  talks rarely never rekeys. `epoch` is not in the AAD: tampering with it only
  derives the wrong key, which fails authentication — the same outcome as
  flipping a ciphertext bit.
- **Padded frame buckets** of 64 / 256 / 1024 / 4096 bytes (then multiples of
  4096). Plaintext carries a type byte and a length, then zeros. The relay
  rejects any binary frame that is not a legal padded size.

## 4. Pairing

### 4.1 The QR carries nothing durable

The desktop's "Link a device" screen generates a **single-use X25519 ephemeral**
and puts its public key in the **fragment** of the pairing URL:

```
https://app.example/link#v1.<base64url(relay url)>.<base64url(ephemeral pub)>
```

The fragment is chosen deliberately: browsers never put it in a request line, a
`Referer` header, or a server log. The phone runs `Noise_IK` with that ephemeral
standing in for the desktop's static and sends its own real static, encrypted, in
message 1. The desktop replies with the **grant**: its real static public key, its
root Ed25519 public key, and the signed device list.

Consequences, and this is the property Paseo's and Happy's designs are compared
against:

- A photograph of the QR taken **after** the pairing is worthless. The ephemeral
  is destroyed on first use and expires after 3 minutes regardless
  (`PairingResponder`, tested in `test/pairing.test.ts`).
- The desktop's durable identity never appears in the QR, so the QR cannot be
  used to impersonate the desktop later.

### 4.2 The window that remains

Anyone holding the QR **while it is live** can compute the pairing channel id —
it is `HKDF(salt = "piorbit-pairing-channel-v1", ikm = ephemeral pub,
info = "relay_token")` — and race the real phone to the relay. This is inherent:
two strangers must rendezvous somewhere before they share a secret.

Defences, in order of strength:

1. **The SAS.** Both screens show six emoji and an eight-character code derived
   from the completed handshake hash. Two different handshakes give two different
   values, so a machine-in-the-middle is visible. It is optional; skipping it
   leaves you where every first-party product in this category already sits (none
   of Claude Code Remote Control, Codex Remote, or Cursor is end-to-end
   encrypted at all).
2. **Single use and a 3-minute TTL.**
3. **Exactly two sockets per channel** — a squatter and the real phone cannot both
   be present.
4. **Revocation** (§6) if the SAS turns out not to match after the fact.

### 4.3 The steady-state channel id

After pairing, the routing key is

```
channel_id = HKDF(salt = "piorbit-channel-v1",
                  ikm  = X25519(device static, desktop static),
                  info = "relay_token" ‖ epoch)
```

Only the two peers can compute it, so the relay cannot enumerate channels or
guess one. One channel exists per paired device, which also means one device's
traffic is never routed anywhere near another's. `epoch` exists so a later task
can rotate the id on an agreed schedule; today it is always 0, which is why
linkability is on the residual list (§5).

## 5. What the relay can and cannot see

**Cannot** (`packages/relay` links no crypto library — asserted by
`test/purity.test.ts`, which reads the dependency graph and the source, not the
prose):

- Any transcript, prompt, tool call, approval, file path, or setting
- Which project or session is in use
- Whether a message is a request, a response, a notification, or chaff
- Either peer's public key, device name, or the desktop's root identity
- Whether a frame it forwarded was accepted or rejected by the far side

**Can** — the residual metadata list, stated plainly because a threat model that
omits it is marketing:

| Leak | Detail | Mitigation today |
| --- | --- | --- |
| **Channel-id linkability** | The channel id is stable for the life of a pairing, so the relay can link every session of one device over months | None enabled. `deriveChannelId` takes an `epoch` so rotation is a small change, not a redesign |
| **IP addresses** | Both peers' IPs, and therefore rough location and ISP, and that they are talking to each other | None. Use a VPN or Tor in front of the relay if this matters |
| **Timing** | When a device connects, how long a session lasts, and — absent §8 — the timing of individual frames | 20 ms send grid plus a chaff tail on the sending side (§8) |
| **Frame sizes** | Which of four buckets each message fell into, and hence roughly how much text moved | Bucket padding; sizes above 4096 still reveal a multiple |
| **Volume** | Total bytes and frame counts per channel | None |
| **Presence** | That a desktop is online and reachable, and for how long | None; the desktop parks on its channel by design |
| **Liveness of pairing** | That a pairing is in progress on some channel | None |

The relay also keeps the operational counters on `/healthz`: channel and socket
counts, frames and bytes forwarded, refusal reasons. None of it is per-channel.

## 6. Device list and revocation

The desktop holds one **Ed25519 root identity** in the OS keychain
(`@napi-rs/keyring`; `keytar` is archived and unmaintained). It signs a versioned
list:

```json
{ "version": 7, "updatedAt": "...", "rootPublicKey": "...", "devices": [ ... ] }
```

- Signed over a **canonical JSON** encoding with a domain-separating prefix
  (`piorbit-device-list-v1\n`), so a signature can never be reinterpreted as a
  signature over something else.
- Each device's `id` is derived from its public key, so an entry cannot be
  rewritten to point at a different key without invalidating the signature.
- **Revocation is re-signing the list without the device and bumping `version`.**
  There is no revocation list to distribute and nothing to expire.
- A phone **refuses any list at or below the version it already holds**
  (`DeviceListStore`), so the relay cannot undo a revocation by replaying an old
  one. Two different lists claiming the same version is reported as a possible
  key compromise, not silently resolved.
- A revoked device also fails at the transport: the host stops running a relay
  client for its channel, and `RelayClient.isAuthorized` is re-checked on every
  reconnection attempt.

`@piorbit/crypto` deliberately does **not** depend on `@napi-rs/keyring` — it also
runs in a browser, where a native addon cannot resolve. The desktop injects a
keyring entry satisfying `KeyringEntryLike`. A `FileRootIdentityStore`
(mode 0600, atomic write) exists in `@piorbit/crypto/node` for headless hosts
with no Secret Service.

Rotating the root identity invalidates every pairing. That is stated by
`loadOrCreateRootIdentity`'s `created` flag so the UI can say so rather than
silently orphaning phones.

## 7. Resume, and why there is no second one

Every `session/update` carries a per-session `seq`, and a reattaching client
replays with `session/load { fromSeq }`. The relay client therefore **drops**
notifications produced while a device is away instead of queueing them: a queue
would be a second resume mechanism that could disagree with the first, and
disagreement between two resume paths is how output goes missing.

Transport sequence numbers are a separate counter and are *not* the protocol's
`seq`. A reconnection is a fresh Noise session starting at 0.

## 8. Keystroke-timing defence

Modelled on OpenSSH 9.5's `ObscureKeystrokeTiming`. **Both halves matter**;
shipping only one is close to worthless:

1. A fixed **20 ms send grid**, so inter-frame gaps are quantised and stop
   encoding the digraph timings that make typed text recoverable.
2. A **random-length chaff tail** after the last real frame (8–64 ticks by
   default), so the end of a burst — and therefore the number of keystrokes —
   is not marked. Chaff frames are ordinary encrypted frames of the same padded
   size; only the peer can tell them apart, and it drops them.

The grid runs only while there is something to send plus the tail: an idle
session sends nothing.

It is **off by default on the host** (`RelayClient.shapeTiming`). Agent output is
bulk, not keystrokes, and permanent chaff would cost a phone real bandwidth for
no analytic benefit. The phone turns it on for its own outbound traffic, which is
where typing happens.

## 9. Relay hardening

`packages/relay` is a byte forwarder and nothing else.

| Control | Behaviour |
| --- | --- |
| Two sockets per channel | A third is refused with HTTP 409 before any WebSocket state exists |
| No forwarding without a peer | Binary frames arriving with no peer are dropped, never buffered; the sender gets a `no_peer` control frame |
| Per-IP channel **creation** limit | 30/min by default, a bucket separate from connection attempts, so a phone on a flaky train is never throttled for reconnecting while a squatter creating channels is cut off |
| Per-IP connection limit | 240/min by default |
| WireGuard-style cookies | Once upgrades exceed a threshold in a 10 s window, the relay answers with HTTP 429 and a MAC of the source IP under a secret it rotates every 2 minutes. Verified by recomputation, so a flood costs one HMAC and **zero responder state** |
| Frame-size enforcement | Only legal padded sizes are forwarded; anything else closes the socket |
| `permessage-deflate` disabled | Compression over payloads we deliberately pad is a CRIME-class oracle, and Railway's proxy handles it badly besides |
| App-level ping every 20 s | Railway drops silent WebSockets at around 50 minutes; unanswered pings reap the socket |
| `/healthz` | Aggregate counters only |

`node:crypto`'s HMAC is used for the cookie and nowhere else — a Node built-in
over a source IP, not a linked crypto library, and it holds no key related to any
channel. `test/purity.test.ts` asserts that this stays true.

**Railway constraints, which are architectural, not knobs.** There is no sticky
routing, so the two peers of a channel must land on the same process:
`railway.json` pins `numReplicas: 1`. Scaling out requires a shared bus (Redis
pub/sub or equivalent) and is a separate task, not a configuration change.
`sleepApplication` stays `false`: a sleeping relay is a desktop nobody can reach.

## 10. Known gaps

- **A live QR is a live secret.** §4.2. Mitigated by the SAS, not eliminated.
- **Channel ids do not rotate.** §5. The derivation already takes an epoch.
- **Metadata is not hidden.** IP, timing, volume and presence are visible to the
  relay operator. Cover traffic between bursts would cost a phone's battery for a
  threat model most users do not have.
- **The desktop is trusted.** Malware or a hostile Pi extension on the developer's
  machine defeats everything here; Pi extensions are unsandboxed upstream.
- **No forward secrecy for the device list.** A stolen root key lets an attacker
  sign a list adding their own device. Recovery is rotating the root identity and
  pairing again.
- **The SAS is optional.** Making it mandatory would be more secure and is a
  product decision, not a technical one.

## 11. Reporting

Security issues in piorbit go to the repository owner privately, not to a public
issue. Findings from the pre-ship review (MX-T4) are tracked in
`STATUS_DETAILED.md` against MX-T4 and must be closed before M6 ships.
