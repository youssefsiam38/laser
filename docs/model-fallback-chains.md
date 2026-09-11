# Model fallback chains

Status: **binding design for M15-T3** (`PLAN.md` "M15 · After the MCP release";
the person's specification is recorded verbatim in the `M15-T3` notes of
`STATUS_DETAILED.md` and is the contract this document implements). Read
[`AGENTS.md`](../AGENTS.md) §4 (invariants 1, 3, 6a, 6b), [`architecture.md`](architecture.md)
and [`ux-fleet.md`](ux-fleet.md) first. Nothing here changes the engine's retry
machinery; everything here begins where that machinery gives up.

A fallback chain is an ordered list of models a person writes down once:
*"when Sonnet cannot answer, use DeepSeek; when DeepSeek cannot answer, use
OpenRouter."* It is not load balancing, not routing, not a cheaper-model
policy. It exists for one moment: the model a conversation is on stops being
usable — the provider is down, the credit ran out, the subscription window is
spent — and the work in flight must not die with it.

## The shape of the feature in one page

| Question | Answer |
| --- | --- |
| Where is a chain configured? | Settings → Providers and models → **Fallback chains**, written to the product-owned `fallbackChains` key of the global settings file through the existing `pi/settings/*` methods |
| When does a chain activate? | Only when the session's **selected model equals the chain's first model** — at session start, and on a manual model change. Never on a fallback-caused switch |
| What triggers a fallback? | One turn ending with a **recognised model-access failure** after the engine's own retries are finished (`agent_end` with `willRetry: false`, last assistant message `stopReason: "error"`) |
| What continues the work? | The same `AgentSession`: `setModel()`, drop the trailing error message, `agent.continue()` — the engine's own idiom for continuing an interrupted turn |
| Where does the traversal state live? | A `lasercode/fallback` custom entry in the session file, appended on every transition, restored with `findLast` on open |
| What does a person see? | The status line while switching, one durable transcript record per transition, the model selector showing the model that is actually active, and a chain badge beside it |
| Who else gets this? | Every session in the worker, including child agents: the controller lives in the driver, and a child agent is a session with its own driver (`docs/agents.md`) |

---

## 1. Settings: where a chain lives and what it looks like

### 1.1 The key and the file

`fallbackChains` is a **product-owned settings key** (invariant 6b), added to
`LASER_SETTINGS_KEYS` beside `disabledModels`
(`packages/worker/src/settings.ts:137`). It is written to the global settings
file inside Laser's private agent directory through the existing
`pi/settings/set` path, which already takes Pi's own lock, merges rather than
rewrites, and reloads live sessions
(`packages/worker/src/settings.ts` header; `pi/settings/set` at
`packages/protocol/src/messages.ts:1028`). Product keys never cross into the
engine: `engineSettingsOnly()` (`settings.ts:1098`) strips them from the
in-memory overrides the driver applies.

**Global scope only**, unlike `disabledModels`. A chain is a statement about
*the person's provider accounts* — which of their credentials can stand in for
which — and not about a repository. Scoping it per project would mean a
checked-in `.laser/settings.json` could name models a teammate has no
credential for, and would make "one chain per starting model" ambiguous across
two files. The descriptor therefore declares `scopes: ["global"]`, and the
worker reads chains with a dedicated `readFallbackChains(agentDir)` over
`readGlobalSettingsFile()` (`settings.ts:1127`) rather than through
`readEffectiveProductSettings()`, so a hand-edited project file cannot silently
change a session's chain. A future project layer is additive and needs no
change to anything in §2–§4.

### 1.2 The schema

```ts
// packages/protocol/src/fallback.ts
/** One model in a chain. Only the identity is stored; names come from the catalogue. */
export interface FallbackModelRef { provider: string; id: string; }

export interface FallbackChain {
  /** Two or more models. The first activates the chain; the rest are its fallbacks, in order. */
  models: FallbackModelRef[];
}

export const FALLBACK_CHAINS_SETTING = "fallbackChains";      // the settings path
export const MAX_FALLBACK_CHAIN_MODELS = 12;                  // a list, not a program
export const MAX_FALLBACK_CHAINS = 50;

/** `provider/id`, lower-cased. The identity every table in this document is keyed by. */
export function modelKey(model: FallbackModelRef): string;

/** The chain whose first model is `model`, or undefined. Never a partial match. */
export function chainFor(chains: FallbackChain[], model: FallbackModelRef): FallbackChain | undefined;

export interface FallbackChainIssue { chain: number; model?: number; message: string; }
/** Every rule below, as sentences for a person. Empty means valid. */
export function validateFallbackChains(value: unknown): FallbackChainIssue[];
```

Rules `validateFallbackChains` enforces — the worker runs it before writing
(authoritative) and the Settings screen runs the same function to draw
messages, so the two cannot disagree:

1. Each chain has at least two models ("A chain needs a model to fall back to").
2. No duplicate model inside one chain ("DeepSeek is already in this chain").
3. No two chains share a first model ("DeepSeek already starts a chain").
   A model may appear in several chains as a *fallback*, and may also start its
   own chain.
4. `provider` and `id` are non-empty strings; at most `MAX_FALLBACK_CHAIN_MODELS`
   models per chain and `MAX_FALLBACK_CHAINS` chains.
5. Nothing is required to exist in the catalogue at save time. A model whose
   provider is later signed out stays in the file and is skipped at runtime
   with a recorded reason (§2.4) — deleting a person's configuration because a
   credential expired would be worse than carrying it.

The initial value is **absent**, not an example. No default chains, ever.

### 1.3 Protocol

No new namespace. The catalogue can carry it: `SETTINGS_FIELDS` gains one
descriptor with `type: { control: "json" }` — a control that already exists and
already validates as "any JSON value" (`settings.ts:1244`) — and the worker adds
the domain check above in its `set` path. `pi/settings/list` therefore advertises
it, `pi/settings/get` returns it inside the snapshot, and `pi/settings/set`
writes it, all unchanged:

```ts
{
  path: "fallbackChains",
  key: "fallbackChains",
  label: "Fallback chains",
  description: "Ordered lists of models. The first model of a list activates it; the rest take over when it cannot answer.",
  section: "model",
  type: { control: "json" },
  scopes: ["global"],
  advanced: true,           // the Advanced list shows the raw value; the editor is the real surface
}
```

A `fallback/*` namespace was considered and rejected: it would duplicate the
lock, the merge, the reload-live-sessions behaviour and the snapshot plumbing
that `pi/settings/*` already has, for one key.

---

## 2. The runtime state machine

Everything in this section lives in the worker, inside `StableSdkDriver`'s
session, and is expressed as a pure policy module (`packages/worker/src/fallback/policy.ts`)
driven by a thin engine adapter, so every rule is unit-testable without a
provider.

### 2.1 Vocabulary

- **Activation** — a chain snapshot bound to this session: `{ id, chainKey,
  models[], position, startedAt }`. `chainKey` is the first model's key and
  never changes; `models` is the list *as it was when the chain activated*, so
  a later settings edit cannot re-order a conversation mid-flight; `position`
  is the index of the model that is active now.
- **Failover event** — one traversal, opened by one eligible failure of the
  active model and closed by a candidate producing a normal model response or
  by exhaustion. It holds the per-candidate attempt records.
- **Activation memory** — per model, for the life of the activation:
  `lastFailure`, `cooldownUntil`, `knownResetAt`, `nonTransient`.

### 2.2 Activation — and when it must not happen

A chain activates only when the session's selected model **equals a chain's
first model**:

| Moment | Behaviour |
| --- | --- |
| Session open (new or resumed) with no stored activation | Resolve `chainFor(chains, state.model)`. Found → activate at `position: 0`. Not found → no activation; the session behaves exactly as today |
| Session open with a stored activation | Restore it verbatim (§4). **Never** re-resolve from the currently selected model, which after a fallback is not the chain's first model |
| `setModel()` by a person (`pi/model/set`, the picker, the first-turn choice) | Fence (§2.8), clear the activation, then resolve a fresh one from the newly selected model. `Chain A → B → C` active at `B`, person picks `B`: `B`'s *own* chain activates if one exists, otherwise no chain. This is the specification's non-merging, non-recursive rule |
| `setModel()` by the fallback controller | **Never** resolves a chain. The activation continues with its own snapshot and `position` |
| An agent definition's model, or the engine's default model | Same rule as session open: the selected model is what matters, not where it came from. Child agents therefore get chains with no extra code (§3.4) |

Chains are **never merged and never entered recursively**. The only list that
exists during a failover is `activation.models`.

### 2.3 The trigger

The engine's turn ends. The driver already sees everything it needs on its own
event stream (`stable-sdk.ts:1261`):

1. `message_end` for an assistant message carries `stopReason` and
   `errorMessage` (`mapEvent`, `stable-sdk.ts`), so the failed attempt's text
   is in hand.
2. `agent_end` carries `willRetry`, which the engine computes from *its* retry
   budget and *its* classifier (`_willRetryAfterAgentEnd`,
   `core/agent-session.js:429`). **`willRetry: false` is the signal that the
   engine has finished**; while it is `true`, Laser does nothing at all and
   D-180's quiet-retry presentation is untouched.
3. The companion's `provider-log` module forwards a provider response's
   **status and headers** as `lasercode/provider/response`
   (`packages/pi-extension/src/modules/provider-log.ts:28`, from Pi's
   `after_provider_response` hook, `core/extensions/types.d.ts:534`). The driver
   keeps the last one seen since the current attempt started, and a new request
   clears it.

   **Correction, proven in implementation (M15-T3, step 3):** that hook does
   *not* fire for a failed request. The provider SDKs throw on an error status
   inside the adapter, before the engine reaches `onResponse`
   (`core/sdk.js`), so a 429, a 402 or a 500 arrives with **no status and no
   headers at all**. The hook is still read — an adapter that does deliver one
   gives the strongest signal available — but the design must not depend on it,
   and in practice classification runs on the text the engine flattened into
   `errorMessage`. This is why `classifyProviderFailure` matches both, and why
   a provider's *stated* delay ("Please try again in 20s") is parsed out of
   that text: it is the only reset time most failures carry.

What the engine does **not** expose: `AssistantMessage` has `stopReason` and a
flattened `errorMessage: string` and nothing else
(`@earendil-works/pi-ai/dist/types.d.ts:307`). The HTTP status is extracted
inside the provider adapters (`utils/error-body.js:36`) and formatted into that
string (`formatProviderError`, `error-body.js:111`); `retry-after` is consumed
inside the provider SDK layer (`utils/provider-retry.js:30`) and never reaches
the message. `diagnostics[]` exists but is populated by only four adapters
(codex-responses, bedrock, anthropic, pi-messages) and carries no status.
**So the classification is: the observed HTTP status and headers when there was
a response, and a pattern match over `errorMessage` when there was not.**

### 2.4 Classification — what is a model-access failure

`packages/protocol/src/provider-failure.ts` (new, engine-neutral, pure):

```ts
export type ProviderFailureClass =
  | "credential"        // the key/session is not accepted
  | "permission"        // accepted, but not for this model
  | "credits"           // the account has no money left
  | "allowance"         // a subscription/usage window is spent
  | "rate_limit"        // throttled, try later
  | "provider_down"     // 5xx / overloaded
  | "connection"        // no response at all
  | "model_missing"     // this provider does not serve this model
  | "context_overflow"  // the conversation is too long
  | "safety"            // the provider refused the content
  | "aborted"           // the person or the harness stopped it
  | "unknown";

export interface ProviderFailureSignal {
  errorMessage?: string;
  stopReason?: string;
  /** From `after_provider_response`, only when observed during this attempt. */
  response?: { status: number; headers: Record<string, string> };
}
export function classifyProviderFailure(signal: ProviderFailureSignal): {
  class: ProviderFailureClass;
  /** A provider-stated reset instant, only when one was actually sent. */
  resetAt?: string;
};
```

| Class | Signals | Fallback? | Why |
| --- | --- | --- | --- |
| `credential` | status 401; `authentication_error`, `invalid_api_key`, `api key is invalid`, `unauthorized` | **yes** | The model cannot be reached at all. Non-transient for this activation: the key will not fix itself mid-conversation |
| `permission` | status 403 without usage-limit wording; `permission_error`, `forbidden` | **yes** | Same: another model may have access |
| `credits` | status 402; `insufficient_quota`, `credit balance`, `billing`, `quota exceeded`, `out of budget` | **yes** | The specification names exhausted credits explicitly. Non-transient |
| `allowance` | status 429 or 403 **with** subscription wording (`GoUsageLimitError`, `FreeUsageLimitError`, `Monthly usage limit reached`, `available balance`, `usage limit reached`) | **yes** | The specification names exhausted subscription allowance. Non-transient unless a reset instant was sent, in which case cooldown to it |
| `rate_limit` | status 429 without that wording; `rate limit`, `too many requests` | **yes** | Transient. Cooldown from `retry-after`/reset headers when present, otherwise the default (§2.6) |
| `provider_down` | status 500/502/503/504/529; `overloaded`, `service unavailable`, `internal error`, `bad gateway` | **yes** | The specification names provider downtime |
| `connection` | no response observed **and** `fetch failed`, `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `socket hang up`, `ECONNRESET`, `timed out`, `stream ended`, `terminated` | **yes** | The specification names connection failures |
| `model_missing` | status 404; `model_not_found`, `unknown model`, `does not exist` | **yes**, and non-transient | The chain's other models may exist |
| `context_overflow` | `isContextOverflow`-shaped text: `context length`, `maximum context`, `too many tokens` | **no** | The engine answers this with compaction, not with another model. Switching would hide a growing conversation behind a bigger window and then fail again |
| `safety` | `content_filter`, `refused to complete`, `Provider stopped with: sensitive` | **no** | The specification excludes safety refusals. This is an answer, not an outage |
| `aborted` | `stopReason: "aborted"` | **no** | The person or the harness stopped the turn. The specification excludes user cancellation |
| `unknown` | anything else | **no** | The specification says to prefer structured information and avoid broad matching. An error we cannot name is not evidence that another provider would do better; it stays the actionable warning it is today |

Never reached, and named here so the tests can prove it: a **tool failure** is a
`toolResult` with `isError`, the assistant turn itself succeeded and
`stopReason` is `toolUse`/`stop`; an **ordinary task error** is a normal
assistant answer; a **successful completion** is `stopReason: "stop"`. None of
them produce `stopReason: "error"`, so none of them can open a failover event.

### 2.5 Traversal

One failover event, with the active model at `position`:

```
failure(active) is eligible
  └─ candidates, in this exact order:
       1. earlier models: indices 0 … position-1, in chain order (= priority order)
          each: ONE bounded attempt — one request, no retry cycle
       2. later models:   indices position+1 … end, in chain order
          each: a normal attempt — the full engine retry policy
  each candidate is filtered by eligibility (below) before it is attempted
  a candidate that produces a normal model response ends the event; it becomes
  the selected model and `position` moves to its index
  no candidate left ⇒ exhaustion (§2.7)
```

A candidate is **eligible** when all of these hold; each failure writes a
recorded reason and moves on (never a throw, never a stall):

| Check | Reason recorded when it fails |
| --- | --- |
| Not attempted yet **in this event** | `already tried in this switch` |
| Not the model that just failed | — |
| Present in the engine catalogue (`modelRuntime.getModel`) | `not in the model catalogue` |
| Provider has a credential (`hasConfiguredAuth`, then `checkAuth`) — the same test `setModel()` itself applies (`core/agent-session.js:1254`) | `not signed in` |
| Not switched off in Providers and models (`disabledModels`) | `switched off in Settings` |
| No `cooldownUntil`/`knownResetAt` in the future | `tried too recently` / `available again at <time>` |
| Not `nonTransient` for this activation | `no credit left` / `not accepted` … (the class's sentence) |
| The conversation fits: `contextUsage.tokens ≤ candidate.contextWindow` | `the conversation is longer than this model can hold` |

The "one bounded attempt" for an earlier model is not a health check and not a
synthetic prompt: it is **the pending agent work, through the normal request
path**. Concretely (§3.1) it is the same `agent.continue()` the engine uses to
resume an interrupted turn, run with a retry budget of `0`. If it answers, its
answer is the conversation's answer — kept, streamed, persisted, never
discarded.

### 2.6 Cooldowns, reset times, and non-transient marks

- **Default cooldown: 5 minutes** for `rate_limit`, `provider_down` and
  `connection`. Derived from the engine's own convention rather than invented:
  the engine spends `maxRetries: 3` with `baseDelayMs: 2000` and exponential
  backoff (`core/settings-manager.js:595`), i.e. ~14 s of retrying before it
  gives up, and each fallback model repeats that. Five minutes is ~20× the
  window the engine itself considers "long enough to know", long enough that a
  failing provider cannot be re-attempted several times in one conversation,
  and short enough that a blip does not cost the person their preferred model
  for the afternoon. It is a named constant, `FALLBACK_DEFAULT_COOLDOWN_MS`,
  not a setting: a setting here would be a dial nobody can calibrate.
- **Known reset times win.** When the response carried `retry-after`,
  `retry-after-ms`, `x-ratelimit-reset`, `x-ratelimit-reset-requests`,
  `x-ratelimit-reset-tokens` or `anthropic-ratelimit-unified-reset`, the parsed
  instant becomes `knownResetAt` and replaces the default. Parsing is
  conservative — seconds, milliseconds, `1m30s`, epoch seconds, HTTP dates —
  and anything unparseable or further away than 6 hours is ignored in favour of
  the default. **A reset time is never invented**: a model with no header gets
  the default cooldown and nothing is claimed about when it recovers.
- **Non-transient marks** (`credential`, `permission`, `credits`, `allowance`
  without a reset, `model_missing`) last for the **activation**, not forever: a
  manual model change starts a fresh activation and clears them, which is the
  specification's "unless there is evidence the condition changed". Nothing
  else clears them, and nothing schedules a re-check.
- **A success does not clear failure history.** Cooldowns and marks survive a
  successful switch; only their own expiry or a new activation ends them. This
  is what stops A→B→A→B ping-pong.

### 2.7 Exhaustion

No eligible candidate remains: the controller stops, writes the `exhausted`
record (§4), leaves the session on the model that failed last, and lets the
turn end the way it already ends — as the one attention-toned, actionable
warning D-180 defines, with the reason the chain could not help added to it:

> The provider is rate-limiting this key.
> Fallback could not help: DeepSeek has no credit left, Gemini is not signed in.

The pending work is preserved: the user message, every completed tool result
and the partial assistant content are already in the session file, and the
person's next prompt (or "Continue") resumes from there. **Nothing is
scheduled**: no probe, no timer, no background recovery job. The next
reconsideration happens only when a later turn fails.

### 2.8 Fencing against the person

Every activation carries an `id`, and the controller keeps a monotonic
`generation` counter in memory. A failover step re-reads both before and after
every `await`:

- `setModel()` by a person bumps `generation`, cancels the failover in flight
  (its pending continuation is aborted through `session.abort()` if a request is
  already out, its pending cooldown wait is resolved), clears the activation and
  resolves a fresh one. A late failover step whose `generation` is stale exits
  without touching the model, and records nothing.
- `abort()` / `session/cancel` cancels the failover event the same way and marks
  it `aborted`, which is not a failure of any candidate.
- `dispose()` drops everything; nothing is written after disposal.
- While a failover event is in flight the session **reports as streaming**
  (`state().isStreaming` ORs the controller's flag, and `prompt()`'s
  busy check does the same), so no second prompt can enter the gap between the
  engine settling and the continuation starting. Steering and follow-up
  messages queue exactly as they do mid-turn.

---

## 3. Task continuity

### 3.1 The exact engine mechanism

`AgentSession.prompt()` resolves only after the whole turn, retries included
(`core/agent-session.js:772`):

```js
async _runAgentPrompt(messages) {
  await this.agent.prompt(messages);
  while (await this._handlePostAgentRun()) await this.agent.continue();
}
```

and `_handlePostAgentRun` → `_prepareRetry` continues an interrupted turn by
doing exactly two things (`core/agent-session.js:2300`):

```js
const messages = this.agent.state.messages;
if (messages.at(-1)?.role === "assistant") this.agent.state.messages = messages.slice(0, -1);
// … backoff …
return true;   // caller runs `await this.agent.continue()`
```

The compaction path does the same (`agent-session.js:1856`), with a comment
naming the rule: `agent.continue()` rejects a transcript whose last message is
an assistant message, so the failed attempt is removed from **agent state**
while remaining in the **session file** as history.

Laser's failover uses that identical pair after the engine has given up:

```ts
await session.setModel(candidate);                // engine-owned: state.model + a `model_change` entry
dropTrailingErrorAssistant(session.agent.state);  // the engine's own idiom, above
await session.agent.continue();                   // same transcript, same tools, same session file
```

`agent.continue()` (`pi-agent-core/dist/agent.js`) resumes from the current
transcript. The messages, the completed tool results and the agent state are
the ones already in memory and already on disk, so:

- **no tool is replayed** — a completed `toolResult` is a message in the
  transcript; the continuation starts after it;
- **no message is duplicated** — no user message is added, no synthetic prompt
  is sent; the only new entries are the ones the new model produces;
- **no concurrent request** — the engine's own run lifecycle refuses to start a
  second run (`Agent.continue` throws while `activeRun` is set), and the
  controller runs strictly between runs anyway.

`session.setModel()` is the whole model change: it validates the credential,
sets `agent.state.model`, appends a `model_change` entry to the session file and
re-clamps the thinking level for the new model (`agent-session.js:1254`).
`replaceRuntime()` (`stable-sdk.ts:482`) is **not** used and must not be: it
disposes the runtime, rebuilds it and re-binds every extension, which is
correct for choosing an agent before the first turn and catastrophic in the
middle of one — it would tear down the harness bridge and the background-work
state the companion holds.

### 3.2 What the continuation must reproduce, and what it deliberately does not

The engine's post-run loop is private, so a continuation started outside
`_runAgentPrompt` does not inherit it. The controller reproduces the part that
is policy and refuses the part that is not:

| Engine post-run behaviour | In the controller's continuation |
| --- | --- |
| Retry of a retryable error, `settings.retry` budget, exponential backoff | **Reproduced.** Budget and delays come from `settingsManager.getRetrySettings()`, the same source the engine reads; the decision uses `isRetryableAssistantError` imported from the exact-pinned `@earendil-works/pi-ai/compat`, the same function the engine uses (`agent-session.js:18`), so there is no second classifier to drift. The same `auto_retry_start`/`auto_retry_end` updates are emitted, so D-180's quiet presentation applies unchanged. A **return attempt** runs this with a budget of `0` — one request, as specified |
| Auto-compaction / overflow recovery between attempts | **Not reproduced** (`_checkCompaction` is private). Instead, a candidate whose context window cannot hold the conversation is ineligible (§2.5), and a `context_overflow` failure never opens a failover event. If the continuation itself overflows, the controller stops and hands the turn back as an ordinary error; the person's next prompt goes through `session.prompt()`, which compacts before sending |
| Draining queued steering/follow-up messages after the run | **Reproduced**: after the continuation settles, `agent.hasQueuedMessages()` drives one more `agent.continue()`, exactly as the engine's last line does |
| `agent_settled` emission | **Deferred, not duplicated.** The engine emits `agent_settled` when the *failed* turn ends, before the failover starts. The driver holds that update while a failover event is in flight and releases one when the event closes. This matters: the harness treats the `agent_settled` update as "the run settled" (`packages/worker/src/agents/harness.ts:931`), so forwarding the premature one would end a child's run in the middle of its own failover |
| `_flushPendingBashMessages` / `_flushPendingCustomMessages` | Not reproduced; they flush on the next prompt as they do today |

Every entry point that starts a native turn in the driver wraps it in the
controller: `prompt()` (`stable-sdk.ts:816`), `goalAction()`
(`stable-sdk.ts:781`) and the extension model-work path, so no model turn in a
session is outside the policy. The controller runs **inside** the invocation
context (`extensionAdmission.runInvocation`), so every update the continuation
emits carries the original invocation's stamp and the harness's fencing keeps
working unchanged.

### 3.3 Cross-provider content — the engine already owns this

Switching from Anthropic to Gemini mid-conversation is not a Laser problem; the
pinned engine normalises it on every request, keyed on "same provider/api/model
as the message that produced this content":

- **Thinking blocks**: redacted thinking is dropped for a foreign model, signed
  thinking is kept only for the same model, and other thinking becomes plain
  text (`pi-ai/dist/api/transform-messages.js:66`, and the per-adapter rules in
  `google-shared.js:138` and `anthropic-messages.js:1041`).
- **Tool-call ids**: normalised per target API, with foreign ids re-derived to
  the shape the target requires (`openai-responses-shared.js:80`).
- **Images**: `downgradeUnsupportedImages(messages, model)` runs before every
  conversion (`transform-messages.js:50`), so a model without vision receives a
  description instead of an image.

Laser adds nothing here, and must not: the correct behaviour is whatever the
pinned engine does, and a Pi bump re-verifies it (MX-T2). What Laser adds is the
*eligibility* check that the engine cannot make — context window — because a
conversation that does not fit is a failure the person would see as a second
outage.

### 3.4 Child agents

A child agent run is a session in the same worker with its own
`StableSdkDriver` (`packages/worker/src/agents/harness.ts` reaches it through
`host.driver(sessionPath)`), and its model is chosen the same way: an agent
definition's model (`resolveAgentModel`, `stable-sdk.ts`) or the default. So the
controller covers children with no harness change, and the rules fall out
correctly:

- a child whose selected model starts a chain gets that chain;
- a child's switch is its own; the parent's activation is untouched;
- the parent hears nothing special — a run that continues on another model is
  simply a run that is still working, which is what `docs/ux-fleet.md` says a
  run is;
- the `agent_settled` deferral above is what keeps a child's run alive across
  its own failover.

---

## 4. Persistence

One new custom entry type, named from the frozen wire namespace rather than a
literal (`packages/protocol/src/identity.ts:80`), beside the existing session
entry types in `packages/protocol/src/agents.ts:446`:

```ts
// packages/protocol/src/fallback.ts
export const SESSION_FALLBACK_ENTRY_TYPE = `${WIRE_NAMESPACE}/fallback`;

export interface SessionFallbackEntry {
  version: 1;
  /** Why this entry was written. The visible record renders from these. */
  event: "activated" | "switched" | "returned" | "attempt_failed" | "exhausted" | "cleared";
  at: string;                                   // ISO
  from?: FallbackModelRef;                      // the model left behind
  to?: FallbackModelRef;                        // the model now selected
  failure?: { class: ProviderFailureClass; at: string };
  /** Null when a manual selection cleared the activation without resolving a new one. */
  activation: {
    id: string;
    chainKey: string;                           // `provider/id` of the chain's first model
    models: FallbackModelRef[];                 // the snapshot, never re-read from settings
    position: number;
    startedAt: string;
  } | null;
  /** The failover event in flight or just closed; absent between events. */
  failover?: {
    id: string;
    startedAt: string;
    attempts: Array<{
      model: string;                            // key
      at: string;
      outcome: "failed" | "succeeded" | "skipped";
      class?: ProviderFailureClass;
      reason?: string;                          // why it was skipped, in a person's words
    }>;
  };
  /** Activation memory, keyed by `provider/id`. */
  models: Record<string, {
    lastFailure?: { class: ProviderFailureClass; at: string };
    cooldownUntil?: string;
    knownResetAt?: string;
    nonTransient?: boolean;
  }>;
}
```

- **Written** through the session manager the same way the first-turn overrides
  and the harness's run moments are (`appendCustomEntry`, `stable-sdk.ts:1013`
  and the driver's `appendEntry`), at exactly these moments: a chain activates,
  a candidate is skipped or fails, the model switches (forward or back), the
  chain is exhausted, a manual selection clears or replaces the activation.
  Append-only: history is the log, and the **last** entry is the state.
- **Read** in `open()` with the same `findLast` the overrides use
  (`stable-sdk.ts:408`). Restoring takes `activation`, `models` and any
  unfinished `failover` verbatim. It **never** calls `chainFor()` on the
  restored model: after a fallback the selected model is not the chain's first
  model, and re-resolving would either find nothing (losing the chain) or find
  that model's *own* chain (the recursion the specification forbids).
- **Cooldowns survive restarts** because they are absolute instants, and they
  are re-evaluated against the clock at the moment a candidate is considered —
  a worker restart neither extends nor bypasses one.
- An unfinished `failover` restored from disk is **closed as aborted**, not
  resumed: the turn it belonged to did not survive the restart. Its attempt
  records stay, so a resumed conversation does not re-attempt a model that
  already failed a minute ago.
- Nothing here contains a credential, a token, a header value or a provider's
  raw body. The class and the person-facing sentence are all that is stored.
- The entry is invisible to the model: a `custom` entry is not a message, and
  the engine's `defaultConvertToLlm` keeps even custom *messages* out of the
  LLM context (`pi-agent-core/dist/agent.js:3`).

**Protocol surface for the live UI** (so a client never has to parse entries):

```ts
// SessionState
fallback?: {
  chain: ModelRef[];          // the activation snapshot, resolved to catalogue entries
  position: number;
  switching?: boolean;        // a failover event is in flight
  lastSwitch?: { from: ModelRef; to: ModelRef; class: ProviderFailureClass; at: string };
};

// SessionUpdate
| { kind: "model_fallback";
    phase: "switching" | "switched" | "attempt_failed" | "exhausted";
    from?: ModelRef; to?: ModelRef;
    reason: ProviderFailureClass;
    detail?: string;          // the person-facing sentence; never a provider payload
    position: number }
```

`session/load` already replays state, so a client that reconnects mid-failover
sees `switching: true` and the same status line as everyone else.

---

## 5. The experience

### 5.1 Settings → Providers and models → Fallback chains

A third tab beside **Models** and **Web search** in `ModelsTab.tsx`
(`packages/ui/src/components/settings/ModelsTab.tsx:81` composes the tab set),
because a chain is a statement about models and the models are already there.

**Empty state** (the only state most people see first) — not a blank panel: one
sentence saying what a chain is, one saying the rule that surprises people, and
the action.

> **Fallback chains**
> When a model cannot answer — the provider is down, the credit is gone, the
> subscription window is spent — the conversation continues on the next model
> you name here, with its history and tool results intact.
> **Only the first model in a list starts it.** A conversation on Sonnet uses
> Sonnet's list; switching to DeepSeek mid-conversation does not start
> DeepSeek's list.
> [ Add fallback chain ]

**A chain row** is the ordered list itself: the starting model first, marked
**Starts the chain**, then its fallbacks numbered in order. Each model row
carries the provider mark and name (`ProviderLogo`, the same
`model-selector` element the composer's picker uses,
`packages/ui/src/components/assistant-ui/elements/model-selector.tsx`), a
reorder handle, and a remove control. The row footer has **Add model**, and the
chain's ⋯ menu has **Delete chain**.

- **Adding a model** opens the existing provider-first model picker, restricted
  to **connected providers** (`connectedProviderIds`, already used by the
  composer's picker, D-145): a chain entry that can never be used is not a
  choice, it is a trap. A model already in this chain is shown disabled with
  "already in this chain".
- **Reordering** is keyboard-first: each model row has Move up / Move down
  buttons with `aria-label`s, and pointer drag is an enhancement on top, never
  the only way (`DESIGN.md`, "keyboard paths for everything the mouse can do").
  Order changes animate with the shared motion tokens and respect
  `prefers-reduced-motion`.
- **Validation** is inline and preventive, using the shared
  `validateFallbackChains`: choosing a starting model that already starts a
  chain offers *"DeepSeek already starts a chain — open it"* instead of a
  refusal; a one-model chain is saved only once a fallback is added, and until
  then the row says *"Add a model to fall back to"*.
- **The second rule, written where it applies** — under the fallback list:
  *"If a fallback also stops answering, the models above it are tried once each
  before the next one, unless they failed too recently."*
- Saving is one `pi/settings/set` with the whole `fallbackChains` value, the
  same shape every other settings write uses. Edits affect **future
  activations**; a sentence says so, and a session with a live activation keeps
  the list it started with.

Both widths: on a phone the chain is a stacked list with full-width rows and
the same controls, no horizontal scroll, no text below 12px.

### 5.2 In-session, while it happens

Per invariant 6a there are exactly three places anything may appear, and a
model switch is none of an extension's business — it is **the session's own
state**, which is why it goes where session state already goes:

| Surface | What it shows |
| --- | --- |
| **Status line** (`thread/StatusLine.tsx`, the words beside the composer) | `switching to Gemini 2.5 Pro` in the existing lower-case vocabulary, `status: "working"`, while `state.fallback.switching` is true. This is the transient status the specification asks for, and it is already the place a person reads "what is going on" |
| **Model selector** (`SessionModelSelector`, composer) | Always the model that is *actually* active. When an activation exists, a compact badge beside it reads `chain 2/3`, with a tooltip naming the chain's models in order and the person's ability to pick any model at any time, which starts a fresh activation |
| **Transcript** | One durable record per transition (below) |
| **Fleet** | Nothing. A failover is not a unit of work outliving a turn; it is one turn continuing. Adding a row would be the third road `ux-fleet.md` exists to refuse |

**The durable record** is a transcript notice, projected from the
`lasercode/fallback` entry the same way `store.ts` already projects harness
entries, plus the live `model_fallback` update for the session that is
watching. It is quiet, informational-toned, one line, and it says the two
things a person needs:

> Continued on DeepSeek V3 · Sonnet 4.5 is being rate-limited.

**Implemented differently from the first draft, deliberately (M15-T3, step 5):**
an exhausted chain gets its **own** attention-toned record directly under the
stopped run, rather than its sentence being spliced into that row. A spliced
sentence exists only in the live update and would vanish on reload, and a
record that disappears when you reopen the conversation is not a record. The
two lines are complementary, not duplicates: the stopped row says what the
provider said, the record says what the chain could and could not do. For the
same reason a return reads with the same wording as a forward switch
("Continued on …"): the record is composed from the durable entry, which stores
identities and a failure class, not a direction-specific sentence.

Skipped candidates are **not** records: they are attempts inside the failover
event, carried in the entry's own `failover.attempts`, so a chain of five
models does not produce five rows. Trying a candidate and a candidate failing
emit `model_fallback` updates but write nothing into the conversation — they
are transient control state, exactly as a provider retry is under D-180.

**No credentials, no raw provider payloads.** The record renders the class's
sentence through the same person-first vocabulary `provider-error.ts` already
owns (`packages/ui/src/components/thread/provider-error.ts`); the provider's own
words stay behind the same disclosure they do today, on the failed attempt.

---

## 6. Test plan

Every bullet of the specification's Verification list, mapped to a file and a
mechanism. `▸` marks a test that drives the **real engine** through the stub
provider.

### 6.1 The stub provider gains status control

`packages/worker/test/agents/stub-provider.ts` today always answers `200` with
an SSE stream (`startStubProvider(respond)` → `res.writeHead(200, …)`). It gains
one member in `StubAnswer` and nothing else changes:

```ts
export type StubAnswer =
  | { text: string }
  | { toolCall: { name: string; args: Record<string, unknown>; id?: string } }
  /** An HTTP failure, answered before any SSE frame. `drop` closes the socket instead. */
  | { status: number; body?: unknown; headers?: Record<string, string>; drop?: boolean };
```

That is enough to drive everything: `{ status: 429, headers: { "retry-after": "120" } }`,
`{ status: 402, body: { error: { code: "insufficient_quota" } } }`,
`{ status: 500 }`, `{ status: 401 }`, `{ drop: true }` for a connection reset.
`respond(request, index)` already receives the request index, so a test scripts
"fail three times, then answer" without any new plumbing. A second stub provider
instance registered as `stub-b` in `writeStubModels` gives a real cross-provider
chain.

### 6.2 The map

| Verification bullet | Where | How |
| --- | --- | --- |
| Empty settings, unmatched models | `packages/worker/test/fallback/settings.test.ts` | No `fallbackChains` key → no activation, no entry written, behaviour byte-identical to today ▸ |
| Chain editing, validation | `packages/protocol/test/fallback.test.ts` (pure rules, round-trip sample in `test/schemas.test.ts`), `packages/ui/test/settings/fallback-chains.test.tsx` (add, reorder by keyboard **and** pointer, remove, delete, every validation message) | |
| Persistence of settings | `packages/worker/test/settings.test.ts` | `pi/settings/set` writes and reads the key; the catalogue advertises it; an invalid value is refused with a sentence and the file is untouched |
| Existing retries finish before fallback | `packages/worker/test/fallback/trigger.test.ts` ▸ | Stub answers `500` four times: the engine's three retries are observed as `auto_retry_*`, and the first `setModel` happens only after `agent_end { willRetry: false }`. Asserted by request count per provider |
| Eligible failures vs cancellation, tool failures, other excluded conditions | `packages/protocol/test/provider-failure.test.ts` (table-driven over every row of §2.4) and `packages/worker/test/fallback/trigger.test.ts` ▸ | A cancelled turn (`session/cancel` mid-stream), a tool that returns `isError`, an assistant answer describing a failure, a `content_filter` finish reason and an unclassifiable error each leave the model unchanged and write no entry |
| Cross-provider continuation without duplicated tools/messages/lost context | `packages/worker/test/fallback/continuity.test.ts` ▸ | Stub A answers with a tool call, the tool runs, stub A then fails; stub B's first request is asserted to contain the same user message **once**, the assistant tool call and its result, and the tool is asserted to have executed exactly once |
| Independent chains, non-recursive traversal | `packages/worker/test/fallback/activation.test.ts` ▸ | `A→B→C` and `B→D`: a session on A that falls back to B keeps `[A,B,C]`; on B's failure it goes to C, never to D. A session started on B uses `[B,D]` |
| Earlier-model recovery succeeding / failing / skipped | `packages/worker/test/fallback/return.test.ts` ▸ | Three scenarios with the same script; skipping is driven by a cooldown and by a signed-out provider |
| Priority order among several eligible earlier models | same file ▸ | `A→B→C→D` failing at D: A is attempted before B before C |
| Bounded return attempts without full retry cycles | same file ▸ | An earlier model that fails during a return attempt is requested **exactly once** (request count on that stub), while a forward move to a new fallback shows `1 + maxRetries` requests |
| Cooldowns, known reset times, non-transient failures | `packages/worker/test/fallback/policy.test.ts` (pure, fake clock) + one integration ▸ | `retry-after: 120` yields a 120 s reset; no header yields 5 minutes; `402` marks non-transient for the activation; an unparseable header falls back to the default and invents nothing |
| Repeated failures without cycling or unbounded requests | `packages/worker/test/fallback/exhaustion.test.ts` ▸ | Every model fails, twice over: total provider requests are bounded and asserted exactly; no model is attempted twice in one event; a second failover after a successful switch still honours the first event's cooldowns |
| Complete chain exhaustion | same file ▸ | The turn ends once, with the actionable error, on the last-failed model; the session is idle and re-promptable; the user message and tool results are intact in the session file |
| Reload/restart preserving selection, traversal, eligibility | `packages/worker/test/fallback/persistence.test.ts` ▸ | Dispose the driver mid-activation and re-open the same session file: the activation id, `models`, `position`, cooldowns and non-transient marks all survive; `chainFor` is never called on the restored model (asserted through a chain whose first model differs from the restored one); an unfinished failover is closed, not resumed |
| Manual selection resets activation and wins races against stale fallback work | `packages/worker/test/fallback/fencing.test.ts` ▸ | `setModel()` during a failover: the person's model is the one that ends up selected and persisted, the stale step writes nothing, and the new activation is resolved from their choice (or is absent) |
| No background checks or return attempts while the active model works | `packages/worker/test/fallback/no-background.test.ts` ▸ | A failover to B, then ten successful turns on B with a timer advanced past every cooldown: A receives **zero** requests. Plus a static check that the controller registers no timer other than the abortable backoff sleep |
| Same behaviour wherever agents execute model calls | `packages/worker/test/agents/fallback-child.test.ts` ▸ | A child run whose model fails continues on the fallback, the parent sees a run that is still working (no premature `agent_settled`), and the child's completion is unaffected |
| Protocol coverage | `packages/protocol/test/schemas.test.ts`, `packages/host/test/*` | Round-trip samples for the new `SessionState.fallback`, the `model_fallback` update and the settings value; host routing unchanged (the settings methods already route) |
| The experience | Browser review at 1360 and 390 widths, both themes, before the task is done | Settings editor (add/reorder/remove/delete/validation, keyboard only), the status line while switching, the transcript record, the model selector badge. Recorded in `STATUS_DETAILED.md` with screenshots |

Required commands at a stable point: `pnpm -F @lasercode/protocol test`,
`pnpm -F @lasercode/worker test`, `pnpm -F @lasercode/ui test`,
`pnpm identity:check`, then `pnpm verify`.

---

## 7. Risks and open questions

1. **The continuation runs outside the engine's post-run loop.** This is the
   one structural risk. `agent.continue()` and `agent.state.messages` are
   public, and the trailing-error-message idiom is the engine's own, used in two
   places — but the retry budget and the queue drain are reproduced by Laser
   rather than inherited, and auto-compaction is not reproduced at all (§3.2).
   Mitigations: the context-window eligibility check, `context_overflow` never
   triggering a failover, and a Pi-bump checklist item under MX-T2. If a later
   Pi exposes a public "continue this turn" entry point, the controller should
   switch to it and delete its own loop.
2. **Classification is text-based for nearly every real failure.** The engine
   flattens the status into `errorMessage` before Laser sees it, and
   `after_provider_response` does not fire for an error status at all (§2.3):
   the provider SDK throws first. So a 429, a 402, a 500 and a dropped socket
   are all matched on text (the same patterns the engine itself uses,
   `pi-ai/dist/utils/retry.js`), and a reset time exists only when the provider
   wrote one into its message. The narrow-by-default rule — `unknown`
   never triggers a fallback — is what keeps this from misfiring; the cost is
   that an unusual provider's outage may not trigger a chain until its wording
   is added.
3. **`@earendil-works/pi-ai` becomes a direct worker dependency** (exact pin
   `0.85.0`, the version the engine already resolves) so the continuation's
   retry decision uses `isRetryableAssistantError` rather than a copy. It is
   inside the worker, so invariant 1 holds, and the pin must move with the
   engine's (MX-T2). The alternative — copying the classifier — was rejected as
   guaranteed drift. **This needs the orchestrator's approval before phase 2
   touches `packages/worker/package.json` and the lockfile.**
4. **Thinking level across a switch.** `setModel()` re-clamps the thinking level
   to what the new model supports, and a switch back re-clamps again, so a
   person's `high` on a model that supports it can come back as `medium` after a
   round trip through a model that does not. This is the engine's behaviour for
   every model change, and the proposal is to leave it alone and record the
   chosen level in the fallback entry so a return restores the person's explicit
   choice when the model supports it. Flagged rather than decided.
5. **Scope of the chain when a session is forked or a branch is navigated.** A
   fork copies the session file, so the last `lasercode/fallback` entry comes
   with it and the fork inherits the activation. That looks right (the fork is
   the same conversation on the same model) and is what the proposal does, but
   it is a decision worth recording rather than a fact the code should discover.

## 8. Open questions for the person

None are blocking; phase 2 can proceed on the answers proposed here.

1. **Should a chain be offerable per project?** This design says no (§1.1).
   If a person wants a different chain for a work project than for a personal
   one, the descriptor becomes `scopes: ["global", "project"]` and
   `readFallbackChains` reads the effective merge. Nothing else changes.
2. **Should the transcript record be foldable away?** The proposal shows one
   quiet line per transition. In a conversation that switches four times that is
   four lines. If they should collapse into one "switched models 4 times" row
   with a disclosure, say so before the UI milestone.
