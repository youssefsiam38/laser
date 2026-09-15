# The bounded device tail cache (RP-10)

What a device keeps of a conversation, why it is allowed to, and what happens
when it cannot. Implementation: `packages/ui/src/runtime/tail-cache/**`. The
contract it consumes is RP-9's revision (`docs/environment-policy.md` §2) and
RP-13's environment policy; the paint that reads it is RP-11.

## The shape of it

```
version handshake → environment/describe → validated cache policy
  → the cache prepares, bounded → the connection publishes `open`
```

Preparation inside the handshake is the whole point. Opening a database, asking
the operating system for a key and decrypting a record are all asynchronous,
and the client used to publish `open` in the same turn as the app's
synchronous environment acceptance. A cache warmed *after* that would have made
local-first re-entry a race — winning on a warm page, losing on the cold start
where it matters. So `EnvironmentAcceptance` carries a `ready` promise
(`packages/ui/src/client.ts`), the client awaits it under `READY_BUDGET_MS`
(600 ms, clamped to 2 000), fenced to the socket it belongs to, and then opens.

A budget that expires, a promise that rejects, a locked keychain, a browser
that refuses storage or a database that cannot be established **all open the
connection anyway**, with the cache refused. A person's cache is allowed to
fail; their host is not.

## Identity

One record per conversation, keyed `(environmentKey, sessionId)`:

- `environmentKey` is RP-9's opaque public key (`e1.…`), the same one the
  `localStorage` namespace hangs from;
- `sessionId` is the session's own durable id, taken from authoritative session
  state — never derived from a path, never read out of an entry;
- `path` is an **index**, because that is what a navigation holds. A row whose
  environment is not the live one is never read, whatever its path says.
- The **actor is deliberately not part of the key**: a phone and a desktop in
  one environment hold the same cache under different actors, and keying by
  actor would throw a person's cache away on every device change
  (`docs/environment-policy.md` §7.4 keeps the same rule for the fingerprint).

Validation is by `revision` alone. It already folds the entry set and the
branch leaf, so an edit, a fork, a jump, a compaction or a deletion produces a
different revision and a cached view cannot validate. `epoch` and `seq` order
two *local* writes and never validate anything: `seq` restarts in a new worker
generation, so when the epoch differs the capture time decides.

## Admission

The environment's validated, already-clamped `CachePolicy` is the only source,
read through the one authority (`deviceStore.cachePolicy()`), and narrowed by
this device's own ceilings — never widened.

| Condition | Result |
| --- | --- |
| no environment yet | closed: no key, no read, no write |
| `transcripts: "disabled"` | refused `policy`, and everything already stored for that environment is deleted |
| any limit at zero | refused `bounds` (+ delete) |
| `requireDeviceEncryption` with no OS-backed key | refused `encryption` (+ delete) |
| no database (private window, blocked site data, an incompatible leftover, a blocked upgrade) | refused `storage`: nothing stored, nothing claimed, **never an in-memory substitute** |
| a scan/purge ceiling, or a purge that cannot be verified | refused `purge`: fail closed, with the one recovery that works |

## Bounds

`TAIL_HARD_LIMITS` — what may be kept: 24 records, 8 MiB, 256 KiB and 40
entries per record, 336 hours, 4 KiB inline picture, 8 records / 2 MiB held in
memory for a synchronous read. Every byte number is exact UTF-8, counted
through RP-5's allocation-free counter, and is plaintext: a cipher's overhead is
accounted separately and never spent against a policy number a person reads.

`TAIL_SCAN_LIMITS` — what may be *touched* while deciding: 2 000 rows, 24 MiB
read, 2 000 deletions, 500 ms, 100 rows per transaction with a macrotask yield
between batches, 250 ms for a blocked open or delete, 8 records warmed. Hitting
any of them fails closed: the cache does not open, nothing is read, nothing is
written over bytes whose provenance was never established, the ceiling is
recorded in the counters, and there is no automatic retry — a retry loop
against a hostile database is the failure mode, not the fix.

Bounds are enforced on write **and** re-enforced at every start, because a
policy can tighten between runs.

## Storage, and what it is honestly called

- **Desktop**: the main process holds a 32-byte key in the operating system's
  own secret store (`device-cache-key` under the existing keychain service), the
  renderer imports it non-extractable, and every body is sealed with AES-256-GCM
  and a fresh IV, with the record's identity as additional authenticated data —
  so a ciphertext lifted into another row does not open at all. **There is no
  key file fallback**: a key beside the ciphertext is not encryption, so a
  machine with no usable keyring is told so and stores its cache unencrypted,
  in those words.
- **Browser and PWA**: the browser's own origin storage, with no encryption
  claimed anywhere in code or copy, an explicit retention policy on screen, and
  a clear control. No storage-permission prompt is requested; what the browser
  reports about persistence is shown as-is.
- **Remote and enterprise**: the host's policy decides. Disabled, zeroed or
  encryption-required policies are enforced by the same admission table, and a
  client preference cannot loosen one.
- **Relay**: nothing. It forwards encrypted bytes and never sees a snapshot.

What encryption here protects: the bytes at rest in origin storage, against
another process, a backup or a file sync reading the profile. What it does not:
a compromised renderer (which holds the plaintext anyway) or a memory dump. On
a local desktop the session files are plaintext regardless, so the value is
that the cache adds no second plaintext copy somewhere nobody looks; on a
paired phone, where no session files exist, it is the whole story.

## Writes, damage and attachments

One IndexedDB `readwrite` transaction per record, so a write commits or does
not: there is no half-written row to read back. Writes are serialized per
session and never replace a newer record. A refused write makes room once and
retries, then gives up and says so in the counters.

Every row is validated field for field on the way in, with no cast, and
discarded — counted, never thrown — when the schema, the app version, the
identity, the checksum, the decryption, the size or the date is not exactly
right. The checksum is a corruption check, not a security boundary;
authentication is AES-GCM's job.

Pictures are references, never a second copy. A base64 payload over the inline
threshold keeps its part and its mime type, loses its bytes, and carries a
product-namespaced marker (`{ cached: "omitted", bytes }` under
`MESSAGE_METADATA_NS`) plus a bounded reference beside the record. Under
`attachments: "none"` not even the reference is kept. A consumer that meets an
empty `data` with that marker must draw a "not kept on this device"
placeholder — which is RP-11's, because **nothing paints from the cache in
RP-10**.

## Eviction, deletion and clearing

Least recently *used* first, where use is a read or a write and never a
background update. Records over the per-record byte bound go first, then expired
ones, then the tail. Drafts are not collateral: they live in `localStorage`
behind the draft API, and the cache never touches that key — proved by a source
scan, not a convention.

- A conversation the person deletes loses its tail immediately.
- A switched or narrowed environment loses everything derived from it before
  the namespace opens.
- Settings → This device → **Clear cached conversations** deletes this
  environment's records and proves it by re-counting.
- The environment-failure recovery (`clearBrowserStorage`) is now **awaited**:
  it closes this page's own connections, deletes the database, bounds a blocked
  delete, and reloads only once every store has reported. A blocked delete is
  reported as "this browser is still holding on", never as success.
- A product rename **deletes** a former name's database rather than migrating
  it, exactly as it drops a former name's path-bearing keys.

## Known properties, stated rather than discovered

- Origin storage is per origin, and the desktop renderer's origin is the host's
  `http://127.0.0.1:<port>`. A host on a non-default port therefore has its own,
  empty cache — never a wrong one, because the environment key still gates every
  read. This is already true of every device key (drafts, pins, folds).
- A record is discarded when the app version changes. The body is host JSON, but
  everything that derives blocks from it is this build's code, and a cache hit
  is not worth a cross-generation projection bug.
- Two tabs of one origin may both write. The record is keyed by session, IDB
  serializes the transactions, and the newer capture wins.

## Diagnostics

`deviceCache` in `RESOURCE_STORE_KEYS` (RP-3): records and exact plaintext
bytes, produced locally by the renderer that owns them — no wire, because one
device's cache is not another's. Counters also carry the refusal, which ceiling
stopped a pass, discard reasons by kind, evictions, refused writes, the
encryption state and whether the store is really durable.

## Tests

- `packages/ui/test/runtime/tail-cache/cache.test.ts` — admission, identity,
  bounds, damage, ciphertext replay, atomicity, attachments, `peek`, fences,
  hostile-database ceilings, deletion and clearing.
- `packages/ui/test/runtime/tail-cache/authority.test.ts` — one module opens a
  database; nothing shipped can reach the in-memory test store; the cache never
  touches a draft.
- `packages/ui/test/runtime/client-environment-ready.test.ts` — the bounded
  readiness gate, its budget, its failures and its socket fence.
- `packages/ui/test/settings/device-cache.test.tsx` — every state of the
  surface, including a clear that did not finish.
- `packages/desktop/test/device-cache-key.test.ts` — the OS key, its absence,
  and that nothing is ever written to a file or a log.
- `scripts/browser-check/test/device-tail-cache.mjs` — a real host, a real
  database: key shape, the readiness ordering, seeded damage, the service-worker
  rule, the surface at both widths and themes, and the clear.
