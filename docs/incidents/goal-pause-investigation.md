# Goal pause investigation

## Finding

An active goal can stop without the model running `/goal pause`. The observed unattended pause on this machine was **not** the 25-response guard: it was caused by an assistant turn ending with `stopReason: "aborted"`; pi-goal unconditionally converts that result to `status: "paused"`.

The installed engine is the exact patched `@narumitw/pi-goal@0.54.4` resolved through `packages/pi-goal/node_modules/@narumitw/pi-goal`. Laser has no `/home/youssef/.local/share/lasercode/agent/pi-goal.json`, so the engine defaults apply: 25 automatic responses and 3 repeated tool-free/no-progress runs (`.../src/settings.ts:22-25`).

## Every state-changing path

| Trigger | Code | Caused by | Result | Intended today? |
|---|---|---|---|---|
| `/goal pause` typed in the transcript | `.../src/command-registration.ts:75-76`, `commands.ts:198-215` | Person or model/agent | `paused` | Yes, deliberate. |
| Goal bar Pause button | `packages/ui/src/components/thread/GoalBar.tsx:51-54` → `packages/ui/src/runtime/LaserProvider.tsx:1710-1713` → `packages/worker/src/drivers/stable-sdk.ts:1020-1041` | Person/UI | Sends `/goal pause`; `paused` | Yes, deliberate click. No keyboard shortcut, effect, timer, resync write, or transient handler was found. `GoalRecord.tsx` is read-only. |
| `session/goal/action {action:"pause"}` from another authorized client, including mobile | `packages/protocol/src/method-policy.ts:206`, `packages/worker/src/server.ts:870-880`, `stable-sdk.ts:1020-1041,2071-2084` | Person/client/UI | Sends `/goal pause`; `paused` | Yes if deliberately invoked. Relay disconnect itself cannot do this; relay is byte forwarding only. |
| Managed pi-goal RPC cancel (only when its separate RPC feature is enabled) | `.../src/run-protocol.ts:284-313` | External RPC caller | Calls `commands.pauseGoal`; `paused` | Deliberate external cancellation. RPC defaults disabled (`settings.ts:23`). |
| Any active goal turn ends `stopReason: "aborted"` | `.../src/lifecycle.ts:520-523`, helper `610-632`; transition in `runtime.ts:664-671` | Engine/worker cancellation; upstream cause may be person cancel, parent interrupt/stop, replacement/navigation, or failed control path | `paused`, reason “Goal paused after interruption” | **Unintended for unattended work. This is the observed path.** It loses the initiator/cause and treats every abort as a goal-pause decision. |
| Automatic response count reaches configured limit | `.../src/runtime.ts:794-804,825-832,843-868`; enforced during restore and errors at `lifecycle.ts:104,528` | Engine safety policy | `paused`, `safetyPauseCause:"continuation_limit"` | Intentional upstream safety, but contrary to the stated Laser product intent. Default is 25. |
| Repeated automatic runs make no measurable progress | `.../src/runtime.ts:806-823,834-840,843-868` | Engine heuristic | `paused`, `safetyPauseCause:"no_progress"` | Intentional upstream safety, but contrary to the stated product intent. Default is 3; tool use prevents/influences the repeat heuristic. |
| Goal tools are absent from the active allowlist | `.../src/runtime.ts:1306-1322`; checks at `lifecycle.ts:108,395,444,454,531,559` and `commands.ts:89,408` | Worker/extension/tool-configuration failure | `paused` | Defensive and intended today. D-146 explicitly says the engine pauses rather than runs broken. Laser normally pre-activates tools in `stable-sdk.ts:1020-1024,1760-1777`; companion sync errors are swallowed in `packages/pi-extension/src/modules/goal.ts:78-102`, making this plausible after a gating/load failure. |
| Restore finds another workflow holding pi-goal's mutex | `.../src/lifecycle.ts:83-94` | Engine/another workflow during reload | `paused` | Defensive and intended today, but it makes restart/update a conditional indirect trigger. |
| Activation of start/resume/edit fails and rolls back | `.../src/runtime.ts:673-678`; callers in `commands.ts` around activation paths | Engine/command failure | Restores prior goal and forces status `paused` | Defensive rollback. It can leave a just-resumed goal paused without an explicit pause. |
| Historical `budget_limited` state is loaded | `packages/pi-goal/src/index.ts:53`; policy regression `packages/pi-goal/test/policy.test.ts:47-52` | Legacy engine state | Presented as `paused` | Compatibility only. Current Laser patch removes budgets/accounting; it cannot newly fire from current code. |
| Model calls `goal_blocked` with a valid blocker report | `.../src/tools.ts:211-258`, `runtime.ts:656-663` | Model/agent | `blocked` (non-running) | Yes; explicit agent decision. |
| Model calls `goal_complete` | `.../src/tools.ts` completion tool; `packages/pi-goal/test/policy.test.ts:54-61` | Model/agent | `complete`, then canonical goal cleared | Yes; explicit agent decision. |
| Model calls `goal_wait` | `.../src/tools.ts:262-322` | Model/agent | Remains `active` with `waiting` and a wake timer | Yes. This is not paused. |
| Terminal provider/model error | `.../src/lifecycle.ts:526-552`, classifiers `errors.ts:76-104` | Provider/model failure | `usage_limited` for quota/billing; otherwise `blocked` after non-retryable failure | Intended classification, but non-running without an agent decision. Retryable network/429/5xx/context-overflow errors enter recovery first. |
| Provider retry recovery is exhausted | `.../src/runtime.ts:890-910` | Provider/model failure after retries | `blocked` | Intended defensive stop, non-running without an agent decision. |
| Explicit Clear or replacement Start | `stable-sdk.ts:2071-2084`, engine command paths | Person/client (or agent typing command) | `null`/cleared, or old goal replaced by a new active goal | Deliberate. |

## Events that do **not** implicitly pause

- **Compaction/context limit:** compaction persists and restores the active state, then requests continuation (`.../src/lifecycle.ts:171-222`). Context overflow is retryable (`errors.ts:99-104`) and goes through compaction recovery; only eventual failure becomes blocked.
- **Session unload, worker retirement, host/daemon restart, or update activation:** shutdown persists the active goal unchanged (`.../src/lifecycle.ts:143-168`). Worker release refuses while streaming, compacting, questions, approvals, runs, queued work, or tasks exist (`packages/worker/src/session-safety.ts:91-112`); it does not itself write goal state. An idle active/waiting goal is not a dedicated safety pin, so it may be unloaded/restarted, but restore remains active unless the workflow-mutex, configured safety-limit, or missing-tool checks above fire.
- **Relay/mobile disconnect or transport backpressure:** no goal-state writer was found. Host transport explicitly says it never cancels/pauses work (`packages/host/src/transport-pressure.ts:21-24`).
- **Tool approval or `needs_input`:** the run waits and is pinned (`session-safety.ts:99-100`; `packages/worker/src/agents/harness.ts:1012-1018,2565-2584`). There is no approval timeout that writes goal state. If an abort/cancel closes that waiting turn, the generic aborted-turn path then pauses the goal.
- **Idle/time elapsed/N turns generally:** no wall-clock idle pause exists. The only N-turn guards are `automaticTurns` and `noProgressTurns` above. `goal_wait` wake timers keep status active.
- **UI resync:** `packages/pi-extension/src/modules/goal.ts:20-57` and LaserProvider dispatch read/publish canonical state; they do not synthesize paused state.

## Observed incident on this machine

Session: `/home/youssef/.local/share/lasercode/agent/sessions/2026-09-14T13-52-32-557Z_01a0a030-df2d-73fe-8226-e6034f83cbc1.jsonl`.

1. `19:46:02.094Z`, line 9574: the agent deliberately called `goal_wait` for child run `run_8e275718`; lines 9575-9578 persisted the goal as **active**, waiting, with `automaticModelTurns: 0`.
2. `19:51:58.898Z`, line 9580: the child completion wake arrived as `agent.failed`, reason `Ended without complete_agent_run`.
3. `19:52:01.956Z`, line 9581: the wake-triggered assistant request ended empty with `stopReason:"aborted"`, `errorMessage:"Request aborted"` (Anthropic `claude-fable-5-1`).
4. `19:52:01.959Z`, line 9582: three milliseconds later the engine persisted the same goal as **paused**, iteration 291, with no `safetyPauseCause`.
5. Lines 9584-9585 still show paused. At `20:20:25.133Z`, line 9586, the person wrote “i continued it”.

This exactly matches `lifecycle.ts:520-523`; it refutes continuation/no-progress and tool-loss for this incident because `automaticModelTurns` was 0, `toolFreeRepeatCount` was 0, and there is no `safetyPauseCause`. It also was not an explicit pause: no `/goal pause` user message or `session/goal/action` artifact precedes the transition.

Two earlier pauses in the same session prove the separate configured-limit path: lines 5845-5846 at `2026-09-15T19:50:48.849-851Z` and lines 7266-7267 at `2026-09-16T01:55:15.597-598Z` transition active→paused exactly at `automaticModelTurns:25` with `safetyPauseCause:"continuation_limit"`. Other no-cause pauses immediately follow aborted assistant messages (for example lines 8124-8125 and 8402-8403).

### Most likely cause

The direct cause is proven: **the child-failure wake started a parent model turn; that turn was aborted; pi-goal interpreted the abort as a command to pause the whole goal.** The transcript does not retain the abort initiator, so it cannot prove whether the provider, worker control path, UI cancellation, or another concurrent wake generated the abort.

Evidence that would refute this diagnosis would be an earlier canonical paused `goal-state`, a `/goal pause` message/action, or a `safetyPauseCause` on line 9582. None exists. Raw host/provider logs could identify the abort initiator, but the durable session already proves which pi-goal branch changed state.

## Proposed fixes (do not implement here)

1. **Stop converting generic aborts into goal pauses.** In the pinned pi-goal patch (`src/lifecycle.ts:520-523`), distinguish an explicit goal-stop intent from an engine/provider/control abort. For a generic abort, cancel only the current continuation, persist the goal as active with interruption diagnostics, and resume only from the next legitimate goal wake/user action; do not immediately spin. Add upstream/policy tests for user cancel, parent interrupt, child completion wake racing cancellation, navigation, and provider abort. Assert no canonical `paused` entry unless a pause action was accepted.
2. **Disable automatic pause policy for Laser.** Patch `DEFAULT_GOAL_SETTINGS.continuationLimits` to `{automaticTurns:null,noProgressTurns:null}` (or inject validated Laser-owned overrides) and change `packages/pi-goal/test/policy.test.ts` from “preserving continuation safety” to pin unlimited autonomous work. Keep counters/telemetry but make any guard advisory. Add a >25 automatic-turn soak and repeated tool-free-output regression.
3. **Repair missing tools instead of pausing.** Make goal-tool activation an invariant checked and repaired by the worker before every goal-owned request; if registration itself is absent, classify the session runtime as failed with an actionable error while preserving active goal state. Stop swallowing the only diagnostic in `packages/pi-extension/src/modules/goal.ts:78-102`; emit a durable module log. Add reload/extension-failure/D-146 integration tests.
4. **Make restore workflow contention retryable.** On mutex collision (`lifecycle.ts:83-94`), retain active state and defer activation until the owning workflow settles, rather than writing paused. Test host restart/update, idle unload, a waiting goal, and concurrent workflow restore.
5. **Instrument every stop transition.** Extend canonical goal-state (or an adjacent `goal-transition` custom entry) with `cause`, `initiator` (`person|agent|engine|worker|host|ui|failure`), triggering invocation/run ID, previous status, and abort reason. Thread cancellation initiator through worker/driver instead of persisting only “Request aborted”. Surface the cause in GoalRecord. This is required to identify the upstream abort source next time without consulting volatile logs.

Provider failure states (`blocked`, `usage_limited`) and explicit `goal_blocked`/`goal_complete` should remain distinct from pause. If the product rule is literally “only the agent may stop autonomous work,” provider failures should become durable active/retry-wait states with backoff and attention rather than terminal states; that is a separate policy decision from fixing the proven abort→pause defect.
