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
  `approval`, `work_control`, `settings`, `features`, `diagnostics`, `device`.
  Scopes are what a policy or a grant may take away.
- **reach** — `any`, `local` (this machine, page or not) or `native` (a local
  process with no browser origin: the app shell or the command line). Reach
  belongs to the method. Nobody narrows it and nobody widens it.

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

- **`HostServerOptions.policy`** is authoritative. It comes from whatever
  started this host — the desktop shell, a hosted workspace's supervisor, an
  organisation's deployment — and it is the only source that may name the
  deployment.
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

Host → client notifications go through the same scopes
(`NOTIFICATION_SCOPE`, also compiler-complete). Transcript admission
(`TranscriptDelivery`) is a separate, earlier filter and is unchanged.

## 5. The audit

One record per decision, in the log store's `host` section
(`packages/host/src/access-audit.ts`):

- `access_refused` — always written, one row per refusal;
- `access_allowed` — one row per allowed call that is not a read;
- `access_reads` — a per-actor count of reads per window (`audit.reads: "each"`
  records them individually);
- `access_dropped` — how many records a rate bound discarded.

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

Volume is bounded per actor **and** host-globally per window, with a bounded
actor table that flushes an evicted actor's counters on its way out.
Reconnecting mints a new connection, not a new actor, and never a new
allowance. Rows are stored `quiet`: queryable, but not streamed as
`pi/logs/append`, so a boundary decision never becomes notification traffic or
tells one connection what another is doing as it happens.

## 6. What Milestone A does not do — the handoff to RP-10/RP-11

Milestone A is the host-authoritative half. The client half (M18-T13
Milestone B) must, when it lands:

- fetch the descriptor inside the existing version handshake, and treat client
  capability data as **presentation only** — the host stays authoritative;
- **on descriptor failure, disable transcript and draft persistence and clear
  environment-derived state.** A client that cannot learn its environment must
  not keep writing content to the device "just in case";
- namespace every device-local key that carries conversation content or a
  session path by `environmentKey`, and purge foreign namespaces on change;
- **not** migrate legacy path-bearing or content-bearing keys (today's
  `<prefix>-draft:<path>`, folds, pins, destinations). They have no provenance:
  assigning them to whichever environment connects first would be exactly the
  leak this task exists to close. They are purged. Only environment-neutral
  preferences (theme, panel sizes) may migrate;
- consume `cache` as the single admission point RP-10 reads, and treat a
  `contract` change or a capability that was true and is now false as an
  invalidation of everything derived from it.

None of that is implemented yet, and nothing in Milestone A claims it is.
