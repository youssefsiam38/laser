# @lasercode/relay

A WebSocket byte forwarder. It routes on an opaque 43-character channel id and
does nothing else: it links no crypto library, holds no key belonging to any
channel, and never looks inside a binary frame. If this process is compromised,
the attacker gets padded ciphertext and the metadata listed in
[`docs/security.md`](../../docs/security.md) — nothing more.

## The one rule

**Text frames are the relay's. Binary frames are the peers'.**

The relay reads and writes only text (its own control protocol) and copies binary
frames from one socket to the other, verbatim, or drops them.
`test/purity.test.ts` asserts this against the dependency graph and the source,
so it cannot drift.

## Wire protocol

```
GET  /healthz                aggregate counters, no per-channel data
GET  /                       one line of prose
WS   /ws                     the channel; optional ?cookie=<value> under load
     Sec-WebSocket-Protocol: laser.channel.<channel-id>
```

The channel id is a **header, never a path segment**. A request line is written
to every access log between the client and this process, and the id is a bearer
capability: a channel holds two sockets, so anyone who reads one id can occupy a
slot and lock the real device out of its own channel. The relay still treats the
value as an opaque route and selects it back verbatim as the subprotocol.

Relay → client (text):

| Frame | Meaning |
| --- | --- |
| `{"t":"hello","channel","slot":0\|1,"peer":bool,"pingIntervalMs","maxFrameBytes"}` | You are connected. `peer` says whether the other side is already here. |
| `{"t":"peer","present":bool}` | The other side arrived or left. **Hold your handshake until `present` is true** — bytes sent before then are dropped, not buffered. |
| `{"t":"ping","n":N}` | Answer with `{"t":"pong","n":N}`. Two unanswered pings close the socket. |
| `{"t":"error","code","message"}` | Something was refused. |

Client → relay (text): `{"t":"pong","n":N}` and nothing else.

Close codes: `4409` channel full · `4429` rate limited · `4408` ping timeout ·
`4400` bad request · `4001` relay shutting down. A refusal that happens before
the WebSocket upgrade comes back as plain HTTP with a JSON body, so a client can
read the reason (and, for a cookie challenge, the cookie).

## Configuration

Environment only — Railway has no config file worth trusting on an ephemeral
filesystem.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Railway sets this |
| `RELAY_HOST` | `0.0.0.0` | Bind address |
| `RELAY_MAX_CHANNELS` | `10000` | Channels held at once |
| `RELAY_MAX_FRAME_BYTES` | `65536` | Largest forwarded binary frame |
| `RELAY_ENFORCE_FRAME_SIZES` | `1` | Reject anything that is not a padded frame size |
| `RELAY_CHANNEL_CREATE_PER_MIN` | `30` | New channels per IP per minute |
| `RELAY_CONNECT_PER_MIN` | `240` | Connection attempts per IP per minute |
| `RELAY_COOKIE_THRESHOLD` | `600` | Upgrades per 10 s before cookies are demanded |
| `RELAY_PING_INTERVAL_MS` | `20000` | App-level ping period |
| `RELAY_SOLO_TIMEOUT_MS` | `0` | Close a peerless socket after this; `0` = never |
| `RELAY_TRUST_PROXY` | `1` | Trust `x-forwarded-for` (true behind Railway) |

Creation and connection limits are separate buckets on purpose: a phone on a
flaky train reconnects to the *same* channel constantly and must never be
throttled, while an attacker probing for channels has to create new ones.

`RELAY_SOLO_TIMEOUT_MS` defaults to off because a desktop legitimately parks on
its channel for hours waiting for its phone. Ping/pong reaps dead sockets.

## Deploying to Railway

`railway.json` is already correct. Two of its settings are architectural, not
preferences:

- **`numReplicas: 1`.** Railway does **no sticky routing**, and the two peers of
  a channel must land on the same process. Raising this silently breaks pairing
  and reconnection for whichever fraction of connections lands on the wrong
  replica. Scaling out needs a shared bus (Redis pub/sub or equivalent) so a
  frame can cross processes; that is a separate task, not a knob.
- **`sleepApplication: false`.** A sleeping relay is a desktop nobody can reach.

Also relevant, from the original relay research notes: Railway exempts WebSockets from
idle limits on paper but silent drops around 50 minutes are reported, which is
what the 20 s app-level ping is for. `permessage-deflate` is disabled in code —
compression over payloads the peers deliberately pad is a CRIME-class oracle, and
Railway's proxy handles it badly besides.

## Local run

```bash
pnpm -F @lasercode/relay build
PORT=8080 pnpm -F @lasercode/relay start
curl -s localhost:8080/healthz | jq
```
