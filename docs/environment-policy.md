# The environment descriptor and the host boundary

RP-13 (`docs/resource-and-loading-plan.md`), task M18-T13. This document is the
contract for who may do what, in which environment, and what is written down
about it. It is binding on every new protocol method.

Local desktop, a self-hosted host reached over the end-to-end encrypted relay,
a hosted workspace and an organisation's managed host all speak **the same
protocol** and answer **the same descriptor shape**. What differs is the label
an environment declares and the authority it narrows to. The relay is never
part of any of it: it forwards padded ciphertext and cannot read a method name,
a scope or a descriptor.

---

## 1. One descriptor: `environment/describe`

`environment/describe` takes no parameters and answers
`{ environment: EnvironmentDescriptor }` for **the connection that asked**
(`packages/protocol/src/environment-policy.ts`).

| Field | Meaning |
| --- | --- |
| `contract` | `"ep1"`. A client holding another generation discards what it derived from it rather than reconciling two shapes. |
| `version` | This host's compiled release. The version handshake (`pi/host/version`) remains the gate; this is informational. |
| `environmentKey` | RP-9's public, opaque environment key (`e1.…`). The device cache namespace, and the only name this environment has on the wire. |
| `deployment` | `local`, `self_hosted`, `cloud` or `enterprise`. A label: no deployment narrows anything by itself. |
| `actor` | `{ class, id }` — what the host **proved** about this connection, and an opaque salted id for it. |
| `capabilities` | What this connection can actually use: revisions, deltas, snapshots, durable reads, search, diagnostics, logs, push. The intersection of what the host has wired and what this actor is allowed. |
| `cache` | The device cache policy (RP-10 consumes it): on/off, per-session and global bounds, attachment handling, whether encrypted device storage is required. |
| `scopes` | The scopes this actor may use, after table → policy → grant narrowing. |
| `localOnly` | The methods refused to this actor **only** because they are local to the machine, so a client can say "on this computer" instead of discovering it by failing. |

The descriptor is per connection and immutable for that connection's life. A
policy change applies to connections opened afterwards; there is deliberately
no live-mutating grant, because that would be a second authority racing the
requests already in flight.

## 2. One table: reach and scope

`packages/protocol/src/method-policy.ts` holds one row per client method, and
`METHOD_POLICY satisfies Record<ClientMethod, MethodPolicy>` makes a method
without a row a compile error. A method the table does not know is refused —
`methodPolicy()` answers `undefined` and the boundary returns
`MethodNotFound`, exactly as an unknown method always did.

Two independent dimensions:

- **scope** — the kind of authority: `handshake`, `read`, `session_write`,
  `approval`, `work_control`, `execution`, `settings`, `features`,
  `diagnostics`, `device`. Scopes are what a policy or a grant may take away.
- **reach** — `any`, or `native` (a local process with no browser origin: the
  app shell or the command line). Reach belongs to the method. Nobody narrows
  it and nobody widens it. There are deliberately only two values: a third
  "this machine, browser or not" level has no row today, and an authority
  level nothing uses is a thing to get wrong rather than a thing that protects
  anybody.

### `execution` is not `settings`

Configuring something and running it are different authorities, so they are
different scopes:

| Scope | Methods | What it lets a connection do |
| --- | --- | --- |
| `execution` | `mcp/call`, `pi/project/env/set`, `pi/project/env/test`, `pi/project/env/refresh` | Run an MCP server's tool, or the command a project's environment helper runs. |
| `settings` | `mcp/save`, `mcp/inspect`, `mcp/ping`, provider sign-in, preferences, agent definitions, … | Describe and change configuration that outlives a turn. |

An environment that grants `settings` and not `execution` can let a connection
manage the product without letting it run an executable through `mcp/call` or
a project's environment command. Both scopes are in the default policy, so a
host nobody narrowed behaves exactly as it did before this split.

**Residual, stated rather than implied:** `mcp/save` plus `mcp/inspect` still
let a `settings`-scoped connection define a server and have this machine start
it for inspection. Splitting *that* is a separate change with its own
user-visible consequences (an inspected server is how the UI validates one
before saving it); until then, `execution` is the boundary for *calling a
tool*, not a promise that `settings` can start no process at all.

Exactly three methods are not `any`, and all three were already refused for a
remote caller before the table existed:

| Method | Reach | Why |
| --- | --- | --- |
| `pi/host/environment` | `native` | The private variable overlay a shell hands down. A page must never be able to repoint a worker's environment. |
| `resource/report` | `native` | The desktop shell's own Electron measurements — an *input* to the host's inventory, which only a process on this machine can produce. |
| `agents/sync` | `native` | Host → worker plumbing that happens to share the client vocabulary. |

`resource/snapshot`, `resource/history` and `resource/export` stay reachable
from anywhere: what a phone reads is the redacted inventory the host built
itself, and a summary a person can see on their desktop is one they can see
from their phone (RP-3). A policy may still take the `diagnostics` scope away.

## 3. Narrowing, and why nothing widens

```
authoritative scopes for the actor class      (the table)
  ∩ environment policy (local / remote)       (the operator)
  ∩ the device's own grant                    (the pairing)
  then, per method, reach                     (never overridable)
```

Cache limits compose the same way: `clampCachePolicy` takes the smaller of
every bound, and `disabled`, `none` and `requireDeviceEncryption` are sticky.
A grant or a policy that names *more* than the environment allows is exactly
equivalent to one that names less.

### Where a policy comes from

- **`HostServerOptions.policy`** is authoritative and is the only source that
  may name the deployment. **No launcher that ships today supplies it.** The
  implemented producers are (a) a program that embeds `HostServer` directly —
  a hosted workspace's supervisor or an organisation's deployment wrapper —
  and (b) the local narrowing file below. `laser up`, the packaged daemon and
  the desktop shell pass no policy, so they run the default: nothing narrowed,
  deployment `local`. Teaching a launcher to read a managed policy (a file it
  trusts, a flag, an MDM payload) is Milestone B/deployment work and is listed
  in §6; nothing in Milestone A claims a product surface for it.
- **`<stateDir>/policy.json`** is an optional **local** narrowing. The state
  directory belongs to the person running the app, so a file in it can only
  take authority away from that same person's own connections. It is **not**
  managed enforcement: deleting it returns the host to the configured policy,
  and nothing in the product claims otherwise. It may not set `deployment`.

A source that is present and unusable **fails host initialisation**, before the
host listens, with a sentence that names the field and never its value. Falling
back to defaults would answer a narrowing nobody can see with an environment
wider than the one that was asked for.

## 4. Where the decision happens

`Router.handle(raw, { actor })` — the actor is required, so a call site cannot
silently default to trusted. The order is:

1. read the method name from the envelope (no schema parse yet);
2. look it up in the table — unknown means refused;
3. check reach, then scope;
4. **then** `parseClientRequest`, the version check, and dispatch.

Everything that spawns a worker, opens a file, reaches a registry or changes
anything lives in dispatch, so a refusal cannot have a side effect. The
regression test drives a denied request with deliberately invalid params and
asserts the answer is the refusal and not `InvalidParams`, with a worker pool
that records every attempt to reach a worker.

`RouterDeps.access` is **required**. A Router cannot be constructed without a
boundary, so a wiring mistake is a compile error rather than a host running on
whatever a fallback allowed. The unknown-method answer is built in one place
(`unknownMethodError` in `@lasercode/protocol`), so the boundary's refusal and
the parser's are the same error and a caller cannot tell from the answer how
far its method name travelled.

### Who may open a socket at all

A direct WebSocket is admitted only from this machine: `verifyClient` checks
the peer address (`isLoopbackAddress`, both families and the IPv4-mapped form
a dual-stack listener reports) **before** the origin check, and refuses
anything else with `403` and one sentence. A TCP peer is not a pairing, so it
is never admitted with reduced authority — the only way in from elsewhere is
the relay's authenticated Noise session, which is where `pairedActor` is
built. There is no "unproven socket" actor class.

### One way out

Host → client notifications reach a direct socket through a single private
path (`HostServer.emit`), used by both broadcast and the replay a client gets
when it connects. In order: the socket must be open and have a **proved**
actor (no actor is a drop, never a send), its scopes must cover the
notification (`NOTIFICATION_SCOPE`, also compiler-complete), the transcript
filter must admit it, and a `session/load` in flight may hold it for ordering.
Only then is it sent. Transcript admission remains its own, separate filter.

## 5. The audit

One record per decision, in the log store's `host` section
(`packages/host/src/access-audit.ts`):

- `access_refused` — one row per refusal, up to the reserved capacity below;
- `access_allowed` — one row per allowed call that is not a summarised read or
  a summarised stream;
- `access_error` — one row per call that ended in an error, **including a
  read**: an errored read is never counted as a successful one, because a
  counter cannot say what went wrong;
- `access_reads` — a per-actor count of *successful* reads and handshakes per
  window (`audit.reads: "each"` records them individually);
- `access_stream` — a per-actor count of a high-frequency method's successful
  calls per window (`MethodPolicy.audit: "summary"`; today only
  `pi/transcribe/chunk`, so two minutes of dictation is one row rather than
  several hundred, and it spends neither the ordinary allowance nor the
  refusal reserve);
- `access_dropped` — how many records a rate bound discarded, and how many of
  those were refusals;
- `access_rollup` — at most one per window, saying how many summaries did not
  fit.

A record names the actor, the method, the scope, the outcome, the JSON-RPC
error code and a duration. It has **no field** that could carry a conversation,
a path, a project, a provider payload, a command line, an environment variable,
a session id, an artifact or an inspector URL — a closed record type rather
than redaction at the sink. A method the table does not know is recorded as
`(unknown method)` plus a short digest, never verbatim.

Actor identity is opaque: `l1.app` and `l1.browser` for this machine, and
`d1.<22 chars>` for a paired device, derived by hashing the device's public key
with this environment's **private** identity. It is stable for the life of the
pairing, irreversible to somebody holding the public key, and different in
another environment. The signed list's device id, the raw key and the
environment UUID never enter a record.

### What is bounded, honestly

An audit that can be made to grow without limit is a denial-of-service surface
and a privacy problem of its own, so **everything** here is bounded — and the
price of that is stated rather than hidden:

- **Refusals have reserved capacity.** Per actor and host-globally, part of
  each window's allowance (`perActorRefusals`, `globalRefusals`) can only be
  spent by refusals, so however much ordinary allowed traffic there is, it
  cannot crowd out the security-relevant records.
- **Refusals past that reserve are counted, not silent**: they roll into that
  actor's `access_dropped` row, which says how many of the discarded records
  were refusals. It is therefore *not* true that every refusal is a row, and
  this document does not claim it.
- **Summaries are bounded too**, host-wide per window (`summaries`); past that
  they roll into a single `access_rollup` row. Actor churn — a fresh opaque id
  per connection attempt — cannot turn LRU eviction into unbounded rows.
- **The ceiling, per window, is `global + summaries + 1`.** That holds under
  reconnect loops and actor churn, and `access.test.ts` drives 400 invented
  actors through a window to prove it, in two consecutive windows.

Reconnecting mints a new connection, not a new actor, and never a new
allowance. Rows are stored `quiet`: queryable, but not streamed as
`pi/logs/append`, so a boundary decision never becomes notification traffic or
tells one connection what another is doing as it happens.

## 6. The client half: the handshake and this device's memory

Milestone A is the host-authoritative half; Milestone B is what a client does
with it. Both have landed.

### 6.1 The handshake

`HostClient` (`packages/ui/src/client.ts`) opens a connection in three steps,
in this order and no other:

1. `pi/host/version` — an **exact** match with this view's compiled release, or
   the existing version notice and no connection;
2. `environment/describe` — validated against `environmentDescriptorSchema`,
   the `contract` generation this build knows, and the version the handshake
   just accepted;
3. the app scopes this device to that environment and only then does the
   connection count as `open`.

Nothing precedes step 3: no request is accepted (`request()` rejects while the
connection is not open), no attached session is resumed, and notifications that
arrive during the handshake are held and delivered afterwards, in order. Every
reconnect repeats the whole sequence, because a policy is immutable only for
the life of one connection.

The descriptor is **presentation only** on the client: it tells a person what
this environment is and what this view may keep. It never decides whether an
action is allowed — the host answers that, per request, every time (§4).

### 6.2 When the environment cannot be established

A refused, malformed, mis-generation or mis-versioned descriptor — or an app
that cannot make this device safe for it — leaves the connection **closed**,
with one sentence written for a person on the existing connection line. It is
deliberately not reported as a version mismatch: the build is fine, the
environment is not. The ordinary reconnect backoff keeps trying (visible, not a
hidden permanent stop), and the sentence is reported once per distinct reason
rather than once per attempt. While it lasts, device persistence is off and
everything derived from an environment has been cleared.

## 7. What this device keeps, and for whom

`packages/ui/src/runtime/device-storage.ts` is the only thing in the app that
builds a browser storage key. It starts **disabled**: before a descriptor
arrives every read answers `undefined` and every write does nothing, so
"nothing before the environment is known" is a property of the code rather than
a rule each call site has to remember.

### 7.1 One namespace per environment

`laser-env:<environmentKey>:<suffix>`, with RP-9's opaque environment key and
nothing else — no path, no session id, no device identity, not in the key and
not in the descriptor fingerprint stored beside it. Local browser storage is
**not encrypted**; that is precisely why what lands in it is namespaced,
bounded, admission-gated, and never logged or exported.

| Suffix | What it holds |
| --- | --- |
| `destination` | the remembered tab and code destination |
| `sessions`, `project` | the last session per project, and the last project |
| `beam-session` | the Beam chat this device was in |
| `archived`, `session-groups`, `session-pins`, `session-folds` | client-local list state, all of it session paths or project directories |
| `activity-detail`, `activity-disclosure` | per-session disclosure choices, each one bounded |
| `fleet-cleared` | this viewer's "I have read these" mark |
| `drafts` | **content**: unsent composer text, per session and per landing |
| `descriptor` | the contract/capabilities/cache fingerprint this namespace was written under |

Environment-neutral values stay outside the namespace, and they are the only
ones that may: the theme (`laser.theme`, read by the pre-paint boot script),
panel geometry, which tab was last shown, the onboarding step, and the mobile
dismissal timestamps. None of them names a conversation, a project or a
machine, which is the whole test.

### 7.2 Purged, never adopted

The pre-environment keys (`laser-draft:<path>`, `laser-archived`,
`laser-session`, `laser-project`, `laser-session-tab-last`, `laser-beam-session`,
`laser-session-groups`, `laser-session-pins`, `laser-session-folds`,
`laser-activity-detail:<path>`, `laser-activity-disclosure-overrides`,
`laser-fleet-cleared`, and the dead pre-M2 `laser-projects` list) recorded
paths and content without recording which environment they came from. Handing
them to whichever environment connects first would be exactly the leak this
task closes, so activation removes them. A product rename does the same: the
storage migration carries neutral keys forward and **drops** anything
path-bearing, content-bearing or environment-scoped.

A foreign environment's namespace is purged the same way, when another
environment opens.

**A purge that could not finish does not open the door.** The scan is bounded
(`MAX_SCANNED_KEYS`) and verified afterwards; if it hits its ceiling or a
removal fails, activation *fails*, the store stays disabled and the person sees
the connection failure of §6.2. A browser that refuses storage outright (a
private window) is different and not a failure: there is nothing to read and
nothing to purge, so the environment opens and simply remembers nothing.

### 7.3 `cache` is the admission point

Drafts are the only content Milestone B keeps, and they live or die by the
environment's cache policy. Content is admissible only when `transcripts` is
`allowed`, every bound (`maxBytes`, `maxSessions`, `maxEntriesPerSession`,
`maxAgeHours`) is above zero, and `requireDeviceEncryption` is false — no
browser storage can prove it is encrypted at rest, so that flag disables
content here rather than pretending `localStorage` qualifies. When content is
inadmissible, drafts cannot be read or written **and what is already stored is
purged**. Within the policy, drafts obey its bounds: byte and count ceilings
with oldest-first eviction, and expiry by `maxAgeHours`. Attachments are never
written to device storage. This is the API RP-10's transcript cache will
consume; B implements no transcript cache and adds no second transcript
authority.

### 7.4 Switching, downgrading, failing

| What changed | What is invalidated |
| --- | --- |
| A different `environmentKey` | the whole previous namespace on disk, plus every in-memory store derived from it |
| A new `contract`, or a capability that was `true` and is now `false` | the whole namespace |
| A tightened `cache` | the content in it |
| The same descriptor again | nothing — a reconnect into the same environment keeps the live session, its transcript and the list state |

The in-memory half is `resetEnvironmentState` in `LaserProvider`: the reducer
drops sessions, open transcripts, loads, workers, toasts, agent runs and
background tasks; the module-level stores (fleet mark, Beam session, collapsed
groups and pins, folds, archive, landing drafts) are cleared **and re-read from
the newly opened namespace**, so an environment a person comes back to still
remembers what it knew; and the client's attachment/resume map is dropped
synchronously, before the connection opens, so no session path can be resumed
against a different host. The first environment of a page's life is not a
switch: there is nothing from elsewhere in memory, and clearing there would
throw away the connection's own setup.

## 8. Still to do

- **RP-10/RP-11**: the bounded transcript tail cache and immediate paint, on
  top of §7.3's admission API.
- **Launcher wiring for a managed policy** — teach `laser up`, the packaged
  daemon and the desktop shell to read a policy they trust and pass it as
  `HostServerOptions.policy`. Today they pass none (§3). The host half is done
  and tested: an unusable policy stops the daemon before it listens
  (`packages/cli/test/daemon-policy.test.ts`).
  **Residual risk to close with that work:** the daemon's refusal is a startup
  failure, so a person who supplies a bad managed policy sees "the host did not
  start" from whichever launcher they used, with the sentence in the daemon's
  log rather than in a window. The sentence is written for a person and names
  the field, never its value — but no UI presents it yet.
- **Browser acceptance for §6 and §7** — the shared browser harness is owned by
  M18-T2 while that work is in flight, so the matrix run for the handshake and
  the namespace is deferred rather than skipped. Everything above is covered by
  unit and integration tests with a fake `Storage` and a fake socket
  (`packages/ui/test/runtime/device-storage.test.ts`,
  `environment-handshake.test.ts`, `environment-switch.test.ts`).
