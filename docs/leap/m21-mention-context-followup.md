# M21-T9/T17 follow-up · the mention projection reaches the model

Owner: worker "Complete mention context delivery", branch
`agents/complete-mention-context-delivery-1d9184ae`, base `446c7c99`.
Binding text: [`../project-lifecycle-leap.md`](../project-lifecycle-leap.md)
("Cross-session mentions and context", "Execution and convergence",
"Flexibility"), [`../project-mentions.md`](../project-mentions.md)
("Send time, and what the worker gets"), [`../agents.md`](../agents.md)
(prompt admission and queue invariants), [`../plain-chat.md`](../plain-chat.md),
[`../upstream.md`](../upstream.md) (the patch register),
[`m21-workspace-plan.md`](m21-workspace-plan.md) (T9),
[`m21-tools-plan.md`](m21-tools-plan.md) (T17).

**Status: revision 4, approved and implemented.** The engine seam is its own
commit (`98bd11f4`); the consumer path follows it. "What landed" and
"Evidence" at the foot record the result.

## Rejected revisions, kept as evidence

| Rev | Proposal | Why it is wrong |
| --- | --- | --- |
| 1 | FIFO over accepted prompts, matched against the model's message list by text equality-or-containment | An old identical message, an earlier prompt containing the new text, a template expansion, a retry or a compaction can each present a row the delivery would claim; an accepted message with no mentions changes the row count |
| 2 | Per-lane slot = queue depth after push; due when depth drops below the slot | Absolute depth is not identity. A at slot 1, B at slot 2, dequeue A → depth 1 marks **B** due (1 < 2) and leaves A pending (1 < 1 false): reversed. A consume-then-enqueue returns the same depth while the lane moved |
| 3 | Per-lane FIFO mirror advanced by observed `queue_update` deltas | The engine's own dequeue bookkeeping is **text matching**: on any user `message_start` it computes `contentText(...)` and does `_steeringMessages.indexOf(messageText)`, else `_followUpMessages.indexOf(messageText)`, splices **that index** and emits `queue_update` (`agent-session.js:363-382`). Identical text across direct/steer/follow-up shrinks the wrong lane, and an interior splice is not a FIFO shift. Mirroring those counts inherits the SDK's text matching instead of removing it |

Revisions 1–3 are all inference. Revision 4 stops inferring and carries an
explicit identity.

## The gap this closes

`host/src/router.ts:1523` validates every mention of a `session/prompt` and
hands the worker a bounded `ProjectWorkMentionProjection[]`. No production
worker code reads it (`server.ts:2784` → `:2887` → `:2925` forward `content`
and `streamingBehavior` only), and three of the four ways a person sends a
message are not projected at all. So `@TASK-44` reaches the model as prose and
never as the projection the host read, bounded and provenance-labelled.

## 0. The four user send entry points (traced)

`ui/src/runtime/adapter.ts:271-335` (`sendToSession`), chosen by
`composerSendPlan`:

| Person's action | Method | Worker | Projected today |
| --- | --- | --- | --- |
| Enter, idle (and first turn) | `session/prompt` | `promptRequest` → `promptLive` → `harness.promptUser` → `driver.prompt` | yes, unused |
| Cmd/Ctrl+Enter while running | `pi/session/steer` | `server.ts:638` → `driver.steer` / `queueIntoChild` | no |
| follow-up send | `pi/session/follow_up` | `server.ts:648` → `driver.followUp` / `queueIntoChild` | no |
| Enter while running | `session/pending/add` | `server.ts:718` → `PendingTray` → `drain()` / `steer(id)` | no |
| a refused prompt's fallback | `pi/session/steer` (adapter.ts:334) | as above | no |

All five (including `session/pending/edit`, a row whose text changed) are in
this milestone.

## 1. The seam: one opaque correlation id, carried by the engine

**Problem statement.** Pi gives an admitted user message no identity an
extension can read: `UserMessage` is `{ role, content, timestamp }`
(`pi-ai/dist/types.d.ts:302`), `emitContext` hands extensions a
`structuredClone` (so object identity is gone), and the engine's own queue
bookkeeping is text-based (rev 3 above). There is no existing exact
correlation between "the message the worker admitted" and "the message the
model is about to read".

**Proposal.** Add the missing field, upstream-shaped, through the repository's
existing patch mechanism (`pnpm-workspace.yaml` `patchedDependencies`;
`patches/@earendil-works__pi-coding-agent@0.85.0.patch` already carries
behavioural changes to `agent-session.js`, `sdk.js`, `session-manager.js` and
their typings). The patch is **one optional opaque string threaded through the
three public send verbs onto the message object they create**:

```ts
// dist/core/agent-session.d.ts  (patched signatures)
prompt(text: string, options?: { …; correlationId?: string }): Promise<void>;
steer(text: string, images?: ImageContent[], options?: { correlationId?: string }): Promise<void>;
followUp(text: string, images?: ImageContent[], options?: { correlationId?: string }): Promise<void>;
```

```js
// dist/core/agent-session.js  (patched, ~6 short edits)
// prompt(): the direct user message
messages.push({ role: "user", content: userContent, timestamp: Date.now(),
                ...(correlationId ? { correlationId } : {}) });
// _queueSteer(text, images, correlationId) / _queueFollowUp(...)
this.agent.steer({ role: "user", content, timestamp: Date.now(),
                   ...(correlationId ? { correlationId } : {}) });
// appendMessage(message): the id is in-memory only
const { correlationId: _drop, ...persisted } = message;   // nothing new on disk
```

Nothing else changes: no private field is poked, no `Session.prompt` workflow
is bypassed, no queue behaviour is altered, no version is bumped. The engine
already carries whatever object it was given through its queues, its
injection and `structuredClone`, so the id arrives in the `context` hook
attached to **exactly** the message it was minted for.

The patch needs its own approval and review; it is recorded in
`docs/upstream.md` as a candidate upstream change (`correlationId` is useful
to any embedder that must correlate an admitted message with a model call)
and re-applied when the pin moves, like every other patch here.

### Effects, checked

| Area | Effect |
| --- | --- |
| **Provider payload** | none. Every API module rebuilds its request messages explicitly (`pi-ai/dist/api/*.js`, e.g. `{ role: "user", content: … }`); an unknown field on an `AgentMessage` is never forwarded. Asserted in the live test against the stub provider's captured body |
| **Session transcript** | none. `appendMessage` strips the id before `_appendEntry`, so the JSONL entry, the in-memory entry store, `driver.entries()`, the host's projection, the search index and the durable revision fold all see the bytes they see today. No body, no excerpt and now no id reaches disk |
| **Recall / reload / second device** | nothing to recall: the id lives only while the message is in flight, and a reloaded session has no envelopes to match, so it simply has no mention context to replay (the projection was ephemeral by contract) |
| **Compaction** | the summary is generated through `convertToLlm`, which drops the field with everything else it does not map; an id never reaches a summary |
| **Queue replay / `clearQueue`** | `clearQueue()` returns the queued **texts** to the composer, never the id; a resend is a new send, re-validated and re-projected by the host, with a new id |
| **Templates / skills / slash commands** | the id rides beside the text, not inside it, so expansion, `/skill:` substitution and `expandPromptTemplate` cannot damage or duplicate it |
| **Copy, fork, edit, forward** | the person's text is untouched, so nothing opaque is ever visible, copied or forwarded. A forked or edited message is a new send with a new id |
| **Engine upgrade** | one more hunk in an already-patched file; `pnpm install` fails loudly if it no longer applies, which is the existing contract for the pin (AGENTS.md invariant 4) |
| **Other drivers** | `ChordDriver` ignores the option; the seam is `StableSdkDriver`-local |

### Rejected alternatives to the seam

- **An opaque footer in the message text**, beside the existing
  `[TASK-44]: laser://…` definitions. It would need stripping in the
  transcript renderer, the search projection, the composer's restored draft
  (`clearQueue` hands the text back to the person), the compaction summary and
  anything a person copies or forwards; it puts an opaque token in the words
  the person wrote and in the session file forever; and an edited or forked
  message would replay a stale id. Strictly worse than a field the engine
  carries and we never persist.
- **Descoping queued sends** (context for a direct prompt only). Honest but a
  product gap: Cmd/Ctrl+Enter and a queued message would name an artifact the
  model cannot see. Listed as the fallback if the patch is refused.
- **Routing mention-carrying steers through Laser's tray** so they arrive as
  direct prompts. Changes what the person asked for (a steer lands mid-turn, a
  tray row waits), so it is not on the table.

**If the patch is refused**, the exact blocker is: *the pinned engine exposes
no per-message identity to an extension, and its own queue bookkeeping is
text-based, so no sound association exists for a queued message without either
this seam or a text footer.* The options are then (a) the footer with the
surface listed above, or (b) descope queued sends and record the gap.

## 2. Canonical owner of the transient state — and it is not the project bridge

One **`SessionMentionContext`** per live session
(`worker/src/project-work/mentions.ts`, new): the envelopes, the two ceilings
and the renderer. In memory, never serialised, never shared; two sessions have
two of them, so simultaneous sessions are isolated by construction.

It is created for **every** session, independently of the project-work bridge
and of `options.projectWork`. Reading a mention is not a project capability: a
projectless Plain Chat, and any session discussing another project's work,
receive the host-validated projection. (Revision 1's "no bridge ⇒ projections
dropped" is withdrawn.)

| | `ProjectWorkSession` (writable bridge) | `SessionMentionContext` (carrier) |
| --- | --- | --- |
| Exists when | the worker has a host link; tools gated further on a project | always |
| Can | lifecycle/Design/Research tools, host calls, writes routed to the owning project | format host-validated projections into ephemeral context |
| Cannot | — | no host call, no tool, no project resolution, no cwd change, no write, no re-read, no re-resolve |

One companion module still (AGENTS.md invariant 11): `project-work` registers
tools when `ctx.projectWork` is present and mounts the `context` hook when
`ctx.mentionContext` is present, each independently.

An envelope is `{ id, state, projections, labels }`: the opaque id, and the
host's projections. No message text, no position, no host handle.

## 3. Algorithm and invariants

```
send (any of the five entry points, projections present)
  server: live.mentions.refuseIfFull(projectWork)   — before the engine is asked
  driver: id = mentions.reserve(projectWork)        — before the engine call,
                                                     because a queued message can
                                                     reach the model before the
                                                     call that submitted it returns
  driver: session.prompt/steer/followUp(text, { correlationId: id })
  on the engine's acceptance:            mentions.admitted(id, lane)
  on refusal or a throw before it:       mentions.discard(id)

user message_start carrying that id (driver) → mentions.activate(id)
context hook (module → carrier, before every model call)
  a message whose correlationId names an envelope gets that envelope's block
  immediately after it; an active envelope whose message the window no longer
  holds leaves its block at the end, labelled — never against another message

agent_settled (after the fallback hold releases) → active envelopes retire
driver.clearQueue()                             → queued envelopes removed
replaceRuntime()                                → queued removed, active kept
dispose()                                       → everything removed
prompt() returned, envelope still pending-direct → removed: it started no turn
tray row removed / cleared / edited / accepted   → its projections go with it
```

Invariants:

1. **I1** An envelope is created only when the engine accepted the message,
   and only for the message whose id it holds.
2. **I2** An envelope becomes live only by its own id appearing in the list
   the model is about to read — i.e. the engine has actually delivered that
   message. No text, no count, no position, no lane bookkeeping.
3. **I3** A block is rendered immediately after its own message, so
   association is positional *and* identified, and unrelated prompts, retries,
   compactions and duplicates cannot attract it.
4. **I4** A live envelope is retired at the `agent_settled` of the activity
   that read it (taken after the fallback chain releases its held settle, so a
   failover retry keeps its context).
5. **I5** An admitted-but-unseen envelope is retained for as long as the
   engine holds its message: cancel does not drop it, a settle does not drop
   it, no timer drops it. It is removed only by a clear, a runtime
   replacement, disposal, or the tray dropping its row.
6. **I6** An id the carrier does not know (a resumed session, a fork, another
   session's message) contributes nothing.

## 4. Delivery: the ephemeral seam (approved earlier)

The module's `context` hook is Pi's `transformContext`: it runs before every
LLM call, its result builds the provider request only, and `context.messages`
— what becomes the session file — is never touched
(`pi-agent-core/agent-loop.js:179-183`). Blocks are inserted as `custom`
messages, which `convertToLlm` renders as user content and which exist only in
the transformed copy. `before_agent_start` (Task packet, `/design implement`
hand-off) is untouched, and Chat's instruction template stays exactly three
fields: this is explicit contextual data on a message, not a prompt field.

## 5. Bounds: refused at the door, never accepted and forgotten

> Both bounds below were corrected after review; the text is kept as written
> and what actually shipped is ["Corrections after the first
> inspection"](#corrections-after-the-first-inspection) at the foot.


1. **Admission.** At most `MENTION_CONTEXT_MESSAGES_MAX` = 16 live envelopes
   per session. A send that would exceed it is refused **before the engine is
   asked**, with an actionable sentence and no partial effect: "You have 16
   messages waiting that mention project work. Let the agent read some, or
   clear the queue, then send this again." A send with no mentions is never
   refused and consumes nothing. The pending tray keeps its existing
   `PENDING_MAX` admission max — no new queue policy.
2. **Render.** One model call renders at most 24 KB of mention context, oldest
   first. An envelope that does not fit renders its own line, after its own
   message — "This message named TASK-44 and SPEC-7; their details are not in
   this call. Read them with `inspect_project_work`." — and **keeps its full
   projection** for the next call. Nothing is degraded in storage, nothing is
   dropped, nothing is silent.

Per-message bounds are the host's own (≤20 mentions, ≤1 200-char excerpt,
≤8×400-char fields) and are not re-applied.

## 6. The pending tray, end to end

The host projects every content a person sends, at the moment it sends it; the
worker carries that projection with that exact message.

- `session/pending/add` and `session/pending/edit` gain a host-supplied
  `projectWork` param and a `projectWork` outcome result, exactly like
  `session/prompt`: same helper, same refusals, same sentences, client value
  dropped.
- `PendingTray` stores the projections beside the row, keyed by row id, and
  never publishes them: `PendingMessage` on the wire is unchanged, so no
  excerpt reaches the UI, the sidebar or the search index.
- `drain()` and `steer(id)` pass the row's projections into
  `deps.prompt`/`deps.steer`, which mint the id at that send.
- No re-projection at delivery: a projection is of the exact revision the
  message pinned and a stored revision is immutable; the row keeps the pinned
  ref and the outcome sentence the sender was already shown. `edit`
  re-projects because the message changed.
- `pi/session/steer` / `pi/session/follow_up` get the same params and
  outcomes, threaded to `driver.steer/followUp` or, for a child session,
  through `queueIntoChild` → `harness.promptUser` options, which the harness
  already parks and replays for a successor.
- `withDictation` may fold a transcribed phrase in after the host projected;
  it appends words and removes no mention.

## 7. Interfaces

| Where | Change |
| --- | --- |
| `patches/@earendil-works__pi-coding-agent@0.85.0.patch` | the `correlationId` seam above (**separate approval**), plus a row in `docs/upstream.md` |
| `protocol` | additive host-supplied `projectWork` params and `projectWork` outcome results on `pi/session/steer`, `pi/session/follow_up`, `session/pending/add`, `session/pending/edit`. No serialized id, so no protocol type for it |
| `host/src/router.ts` | `promptWithMentions` generalised into one helper used by the five methods |
| `worker/src/driver.ts` | `PromptOptions.projectWork`; `steer`/`followUp` options; `DriverOpenOptions.mentionContext` (the carrier, separate from `projectWork`) |
| `worker/src/drivers/stable-sdk.ts` | mint and pass `correlationId`, register at the engine's acceptance, feed `agent_settled`, bracket `clearQueue`, explicit teardown on replacement and dispose |
| `worker/src/server.ts` | the five method paths and the admission refusal |
| `worker/src/pending.ts` | projections beside the row |
| `worker/src/project-work/mentions.ts` (new) | `SessionMentionContext`: envelopes, ceilings, deterministic renderer |
| `pi-extension` | read-only `ProjectMentionContext { blocks(messages): { afterIndex, text }[] }` capability and the `context` hook; tools and context gated independently |
| `ui/src/runtime/adapter.ts` | the existing outcome-toast loop reused for the three other verbs (≈6 lines) |

## 8. Tests

The counterexamples run against the **real pinned engine** with the existing
stub-provider harness (`worker/test/stable-sdk.prompt.test.ts`), not a
simulator:

| File | What it proves |
| --- | --- |
| `worker/test/stable-sdk.mentions.live.test.ts` | **the identity counterexample**: one session, three sends with byte-identical text — a direct prompt, a steer and a follow-up queued behind a held response — each carrying a *different* projection; every provider request body carries each block after its own message and never another's. Plus: the session file on disk has the person's words, no excerpt and no id; the provider body has no id; the next unrelated prompt's request is clean; a refused prompt delivers nothing; a cancelled turn keeps a still-queued message's context for the turn that later reads it; a **projectless session with no project-work bridge** still gets its projection, registers no lifecycle tool and keeps its cwd |
| `worker/test/project-work/mentions.test.ts` | the carrier's own rules: unknown id contributes nothing; live retires at settle; unseen survives settle and cancel; clear removes unseen; replacement and dispose remove everything; admission refusal at 16; the render ceiling's per-message line; two sessions independent; rendering makes no host call |
| `worker/test/server.mentions.test.ts` | all five methods thread the right projections and a fresh id, including first turn, a child successor requeue and two sessions in one worker |
| `worker/test/pending.test.ts` (extended) | a row carries its projections through drain and `session/pending/steer`; `edit` replaces; `remove`/`clear`/failed delivery drop; `PendingMessage` on the wire unchanged |
| `host/test/project-work/mentions.test.ts` (extended) | steer, follow-up and pending-add are validated and projected exactly as a prompt is; a client-supplied `projectWork` is dropped; same outcome sentences |
| `pi-extension/test/project-work.test.ts` (extended) | the `context` hook inserts each block after its own message and leaves every other message byte-identical; nothing is written to the transcript; a throwing carrier costs the turn nothing |
| `worker/test/seam` (patch guard) | a focused test that the pinned engine still carries `correlationId` from `prompt`/`steer`/`followUp` to the `context` hook, so a pin bump that drops the patch fails loudly |

Validation: `pnpm -F @lasercode/protocol test`, `-F @lasercode/host test`,
`-F @lasercode/worker test`, `-F @lasercode/pi-extension test`,
`-F @lasercode/ui test`, `pnpm -r build`, `pnpm -r typecheck`,
`pnpm identity:check`.

## 9. Residual limits, named

- **The seam is a patch.** It survives only while the patch applies; a pin
  bump that drops it fails `pnpm install`, and the seam test fails loudly if
  the field stops arriving. The failure direction is "no mention context",
  never "someone else's context".
- **A resumed session** has no envelopes, so a message sent before a restart
  and read after it carries its identity in the transcript and no projection.
- **A steer queued while idle** waits in the engine's lane; its context waits
  with it and is delivered in the call that first reads the message.
- **No private engine state is read** and no engine behaviour is altered: the
  patch only carries a field the caller supplied.

## What landed

| File | What it owns |
| --- | --- |
| `patches/@earendil-works__pi-coding-agent@0.85.0.patch` | the seam: `PromptOptions.correlationId`, `QueuedMessageOptions` for `steer`/`followUp`, the field on the message those calls create, and `appendMessage` stripping it from a **copy** so the live message keeps its identity and no session file ever holds one |
| `packages/worker/src/project-work/mentions.ts` | `SessionMentionContext`: the envelopes and their states, the two ceilings, the deterministic renderer |
| `packages/worker/src/driver.ts` | `PromptOptions.projectWork`, `QueuedSendOptions` on `steer`/`followUp`, `DriverOpenOptions.mentionContext` — separate from `projectWork` |
| `packages/worker/src/drivers/stable-sdk.ts` | reserve/admit/discard around every send, `activate` from the engine's own user `message_start`, `settled` at `agent_settled` and at the fallback chain's released settle, `dropQueued` on `clearQueue`, `rebaseline` on `replaceRuntime`, `dropAll` on `dispose` |
| `packages/worker/src/server.ts` | the five send paths, the pre-acceptance refusal, `live.mentions` |
| `packages/worker/src/pending.ts` | a row's projections beside the row, by row id, never on the wire |
| `packages/pi-extension/src/{project-work-bridge,index}.ts`, `src/modules/{project-work,index}.ts` | the read-only `ProjectMentionContext` capability and the `context` hook; tools and mention context gated independently |
| `packages/protocol/src/{messages,schemas,pending}.ts` | host-supplied `projectWork` params and outcome results on steer, follow-up, pending add and pending edit |
| `packages/host/src/router.ts` | `sendWithMentions`: one helper, five routes |
| `packages/ui/src/runtime/adapter.ts` | the same outcome sentences on the other three verbs |

## Evidence

- `packages/worker/test/pi-correlation-seam.live.test.ts` (2) pins the seam
  against the real engine, and was verified to fail when the patch is removed.
- `packages/worker/test/mention-context.live.test.ts` (4) — real engine, stub
  provider: a prompt, a steer and a follow-up of byte-identical words each get
  their own projection beside their own message; the session file holds the
  words and no projection; the next prompt carries none of it; a session with
  no project-work bridge still gets its mention context; a stop does not lose a
  queued message's context; a cleared queue drops exactly what it held.
- `packages/worker/test/project-work/mentions.test.ts` (13),
  `packages/worker/test/server.mentions.test.ts` (5),
  `packages/worker/test/pending.test.ts` (33, five new),
  `packages/host/test/project-work/mentions.test.ts` (25, thirteen new),
  `packages/pi-extension/test/project-work.test.ts` (14, five new).
- Suite totals and gates are in the task's handoff note.

## Corrections after the first inspection

Owner: worker "Finish mention budget corrections", branch
`agents/finish-mention-budget-corrections-e90c1ce4`, which merged the whole of
`agents/complete-mention-context-delivery-1d9184ae` (`98bd11f4`, `e7ec426d`)
onto `d405e5d5` with no conflicts. Four findings from the parent's inspection,
and the lifecycle evidence D-362 was accepted on and the first pass did not
produce. Nothing else in the path changed.

### C1 · The render ceiling is bytes, and every message is paid for first

`blocks()` compared `text.length` against `MENTION_CONTEXT_RENDER_MAX`, which
is a **character** count: a Japanese title or an Arabic excerpt costs three
bytes a character, so a "24 000" render could be 60 KB on the wire. It also
emitted the keys-only fallback whether or not the budget had room for it, so a
call with sixteen overflowing messages could exceed the ceiling by the whole
of fifteen fallbacks.

What it does now, in `packages/worker/src/project-work/mentions.ts`:

1. Every active envelope is first rendered as its **own short summary**,
   bounded by its share of the ceiling
   (`RENDER_MAX / max(active, MESSAGES_MAX)` = 1 500 bytes), so the summaries
   of even sixteen messages cannot exceed the ceiling.
2. What is left over is spent upgrading summaries to the complete projection,
   oldest message first, one whole message at a time — never a projection cut
   in half to fill the last bytes.
3. The sum of every block returned is therefore `≤ 24 000` UTF-8 bytes by
   construction, with no message omitted, evicted or silently shortened, and
   every envelope keeps its complete projection for the next call.

A summary that has to drop keys names as many as its share pays for and says
"and N more"; the clamp that guarantees the bound never splits a character.

### C2 · The sixteen-message ceiling is enforced at the slot, not only before it

`refuseIfFull()` is called by the five send routes, and every one of them
awaits afterwards — a phrase still being transcribed, a first-turn runtime
replacement and its lease, the tray's drain. Two sends could both pass it and
both reserve, so a seventeenth envelope could exist. `reserve()` now refuses at
the mutation itself with the same sentence; `refuseIfFull()` stays as the early,
friendly word. Both refusals happen before the engine is asked anything on
every path, and a refused reservation leaves nothing behind.

### C3 · The overflow line no longer names a tool the session may not have

It said "Read them with `inspect_project_work`". A projectless chat, and any
session discussing another project's work, receive mention context and
register **no lifecycle tool at all** (§2), so that was an instruction the
model could not follow — and giving it the tool would hand a session authority
over a project it was never given. The line now ends: "If you need them, say
so: the person can send them again, a few at a time." No tool, no new
capability, no change to the rest of the render or to any send contract.

### C4 · A reserved slot is owed only to a message that was really sent

`StableSdkDriver.prompt()` reserved its correlation id before the preflight
fence, and two exits jumped over the cleanup: the bare concurrent-prompt
refusal (`return { accepted: false }` from inside the `while` loop) and a
caller's `onInvocation` observer that throws. Both leaked a slot, and sixteen
of them would have closed the door on the next real message. The reservation's
lifetime now covers every pre-engine exit: the goal-command activation, the
fence refusal and the observer are inside a guard that returns the slot, and a
throwing observer also releases the fence that call installed. Admission and
first-turn semantics are untouched.

### C5 · The lifecycle proof against the real engine

D-362 required real pinned-engine evidence for compaction and for a held
fallback settle; the first pass proved those synthetically.
`packages/worker/test/mention-context-lifecycle.live.test.ts` (5) now drives
both through public seams only — `driver.open`, `prompt`, `steer`, `followUp`,
the session's own updates, and what the stub provider received:

- **An in-activity compaction.** The engine's own threshold compaction runs
  inside the activity, its cut falls inside the turn being read, and the
  person's message is summarised out of the window. The turn then calls the
  model again — a message the person sent *while the summary was being
  written* is waiting in the engine's queue — and that call carries the
  compacted-away message's projection at the end of the list, labelled "no
  longer in the window", beside the queued message's own projection in its own
  place. Nothing is owed after the final settle, and the summarisation request
  itself carries no mention context.
- **A fallback retry.** The first model dies mid-turn, the chain moves the
  same turn to the next model, and the retry carries the same projection
  beside the same message: the settle a fallback holds is not the settle that
  retires it.
- **Refusals.** A seventeenth mentioning message is refused with no provider
  request and nothing on disk; a message that mentions nothing is never
  refused and holds no slot; the two leaking exits of C4 give their slot back.

### Evidence for the corrections

```
pnpm -r build                                   # required: the live tests run the built workspace
pnpm -F @lasercode/worker exec vitest run \
  test/project-work/mentions.test.ts test/server.mentions.test.ts \
  test/pending.test.ts test/pi-correlation-seam.live.test.ts \
  test/mention-context.live.test.ts test/mention-context-lifecycle.live.test.ts
#   6 files, 67 tests, all passing
pnpm -F @lasercode/worker test                  # 1682 passed, 4 skipped (137 files)
pnpm -F @lasercode/worker typecheck             # clean
pnpm identity:check                             # clean
```

Each correction was checked against the behaviour it fixes: with the ceiling
restored to characters two carrier tests fail; with the atomic refusal removed
the carrier test and the two-simultaneous-sends server test fail; with either
guard removed in the driver the two "gives the slot back" live tests fail.

One observation left for the reviewer, not changed here: the merged branch's
live tests only pass against a **built** workspace — a fresh checkout that runs
`vitest` before `pnpm -r build` sees the pre-merge `dist` of `protocol` and
`pi-extension` and six of these tests fail for that reason alone.

## Parent correction after independent review

- Review `484f9854` found routing metadata on the raw `message_end` wire. Its negative-probe paragraph is not evidence of wire absence: the same report's positive probe and the parent's actual pinned-engine regression reproduce the field. `mapEvent` now strips `correlationId` from a copy only when present; the live message and ordinary envelopes are untouched.
- Parent also found a coupled persisted-identity regression: `persistedEntryOf` expected the original envelope reference, but the pinned persistence seam deliberately stores a shallow copy. All three identical direct/steer/follow-up frames had **no entry id or body identities**. The driver now recognizes that copy by the exact SDK-created content-array object shared with it, restricted to routed user messages. This is object identity, never text/timestamp/FIFO inference; no SDK API/patch change or extra retained map. Provider context still uses the explicit correlation seam because its structured clone has no object identity.
- Red: `/tmp/laser-mention-wire-red.log` shows leaked field, three `undefined` entry ids against three actual JSONL ids, and missing bodies. Green: real-engine regression compares all three emitted entry ids to the persisted records in order, requires body identities, excludes routing metadata, and retains the complete projection/cleanup assertions.
- Final focused gate: `env -i PATH="$PATH" HOME="$HOME" pnpm -F @lasercode/worker exec vitest run test/map-event.test.ts test/mention-context.live.test.ts test/mention-context-lifecycle.live.test.ts test/pi-correlation-seam.live.test.ts test/project-work/mentions.test.ts test/server.mentions.test.ts test/pending.test.ts` — **71 passed**. Worker typecheck and identity check passed. Log `/tmp/laser-mention-final-focused.log`. Full merged verification remains the integration owner's gate.
