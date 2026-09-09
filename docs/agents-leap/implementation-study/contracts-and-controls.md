# Contracts, communication and control

The [product responsibility contract](../agents-responsibility-contract.md) remains authoritative. This file connects it to actual source mechanisms and identifies the new contracts the replacement must supply.

## Child launch, progress and completion

The upstream [delegation API](upstream/src/api/delegation.ts) defines correlated request/started/update/response/cancel events. Requests carry `requestId`, owner/node identity, agent/task/context/cwd and execution options. Updates expose current tool/arguments, recent output/tools, model, duration, counts and tokens. Terminal responses distinguish completion, cancellation, interruption, timeouts, invalid requests, unavailable context, structured-output and acceptance failures. The [launch digest](upstream/src/shared/launch-contract.ts) binds the resolved attempt to its definition and inputs.

Laser needs the following neutral records. Names below are proposed schema names, not existing protocol methods.

| Contract | Required fields/semantics |
| --- | --- |
| Launch intent | Idempotency key, requester identity/origin, parent session and assignment, target agent ID/revision, role, task, context manifest, allowed capabilities, relationship revision, committed base SHA, expected outputs and outcome checks |
| Admission result | Accepted/denied/awaiting approval; policy reasons; resolved immutable launch snapshot; approval reference where required; reserved attempt/session identity |
| Runtime progress | Ordered event ID, run/attempt/session, tool-call identity/status, observed activity, source timestamp and observation timestamp; no invented progress percentage |
| Child checkpoint | Structured milestone/blocker/question, summary, evidence/artifact/change references, request correlation; durable acknowledgement to child and parent |
| Child result | Execution outcome distinct from acceptance, final report/schema value, result commit and patch references, validation provenance, partial-work disposition, continuation lineage, exact terminal reason |
| Parent receipt | Event accepted into the owner's durable inbox, then supplied/consumed status when actually observed; duplicate delivery cannot repeat its effect |

Do not replace child checkpoints with streamed tool previews. Conversely, a child saying “finished” cannot suppress still-running tools or establish verification. All records must remain viewable in the session/control UI, with complete retained conversations retrievable beyond bounded summaries.

## Communication is not a single relationship enum

[native-supervisor-channel.ts](upstream/src/intercom/native-supervisor-channel.ts) provides `contact_supervisor` for progress, decisions and interviews. Requests/replies are files scoped to the exact orchestrator session; replies are correlated. Native parent `send` and `ask` reject. Generic intercom depends on an explicitly supplied external provider. [steering.ts](upstream/src/runs/background/steering.ts) is parent-to-child input delivery, not a universal peer mailbox.

**Recommended connector model, subject to the existing one-editor contract:** one visible connection can summarize several independent clauses. Its inspector edits delegation permission, message directions/channels/schema, context bindings, shared-resource rights, dependency/outcome rules and control authority. Keep these distinct in the schema; a visual line does not grant every privilege. Explicit dependency/resource nodes remain available when clearer. This expands the earlier connector discussion without declaring the prototype's single enum an implementation constraint.

Our durable message router must:

- Address exact sessions/assignments and user-defined channels, not ambiguous agent display names.
- Validate schema/version/payload size and permitted sender/recipient relationships at dispatch.
- Persist message ID, correlation/reply ID, source identity and authority, recipient snapshot, attachments/revisions and delivery receipts.
- Distinguish queued, delivered to session, supplied as context, observed read where instrumented, replied, expired, cancelled and failed. Never label delivered text “understood.”
- Define broadcast recipients at send time and return per-recipient outcomes; partial delivery must be visible and retries idempotent.
- Let direct user input reach any running child through its current session owner. It must not create a second writer or silently transfer parent ownership.
- Keep custom protocol payloads as validated data. Instructions can implement negotiation rules, but cannot create nonexistent tools or grant stop/delegation authority.

User-visible conversations, parent summaries and graph events are projections of these same records. Do not hide side conversations in private runtime-only files.

## Shared state must be stronger than upstream mission JSON

[workflow-state.ts](upstream/src/missions/workflow-state.ts), `createMissionWorkflowState`, stores a maximum 256 KiB JSON object under a mission. `set` takes a file lock, rereads disk, changes one key and atomically writes. `get` uses a lazily cached object; another writer's changes need not appear until that instance reloads through a write. There is no compare-and-set revision in the public `get/set` API and no participant read ledger.

Our shared-resource service needs stable resource IDs, owner, content/schema, revision, change history, grants and expected-revision writes. A stale update returns a conflict with the current revision; it must not silently overwrite another agent's decision. Atomic commits can cover related keys when required by a configured protocol.

Record independently: **can access**, **was supplied revision N**, **read revision N through an observed operation**, and **latest available revision**. The Context inspector shows the actual values/snapshots, source and revision—not only paths or access badges. A snapshot passed at launch does not become “live shared state” merely because a new value exists. User edits and agent edits use the same revision checks and event stream.

## Stop, interrupt, steer, resume and dismissal

[control-channel.ts](upstream/src/runs/background/control-channel.ts) uses a portable file inbox, with watch plus polling fallback. `StopRequest` includes optional reason/source/child ID; steer requests have IDs, modes and target indexes. Control consumption and application occur separately. A file write alone is not a delivered stop receipt. Some upstream convenience methods do not forward every field in the underlying request shape.

[session-lease.ts](upstream/src/runs/shared/session-lease.ts) blocks conflicting direct revival; [async-resume.ts](upstream/src/runs/background/async-resume.ts) handles retained state. A prefix lookup used for human convenience must resolve uniquely before any mutation; exact IDs should cross our protocol boundary.

| User intention | Required Laser behavior |
| --- | --- |
| Chat with child | Route to existing writer; show queued/delivered input and resulting turns; preserve parent relationship |
| End child | Required reason modal; durable command records user actor, origin, reason, target and descendant disposition; parent receives reason/outcome even if offline |
| Ask parent to end child | User instruction reaches parent; parent's actual stop command records parent as issuer and the initiating user request as provenance |
| End via parent reasoning | Owned-child control policy governs; record parent reason; peer messaging permission alone grants no cancellation authority |
| Interrupt/pause | Preserve partial evidence and explicit resumability; distinguish an idle paused assignment from an uncertain running process |
| Resume | Validate retained attempt/definition/input revision and acquire writer ownership; record a new attempt/continuation rather than erasing terminal history |
| Dismiss notification | Acknowledge presentation; do not cancel work, answer an approval or delete retained evidence |

No silent respawn after a user stop. A stale completion cannot reverse a recorded stop or restart a completed `/goal`. Concurrent input, stop and completion must be serialized/deduplicated per session and attempt. Cancellation-tree ownership is separate from communication links.

Genie may inspect freely. **Every effectful Genie action and every Genie agent launch requires explicit UI confirmation at the effect boundary**, bound to the concrete target and revision. Tool choice, a nested launch, a workflow host command or a custom protocol cannot bypass that rule. This is not a new blanket approval requirement for every ordinary agent operation; those follow their configured grants and the existing contract.

Do not copy upstream's small [permission wrapper](upstream/src/runs/shared/permissions.ts) as a complete policy engine. It explicitly leaves Bash policy to `pi-guard`, reserves coordination tools from its rules, and merges agent rules over defaults. Capability ceilings and provider-specific enforcement are separate. Our enforced restrictions and Genie approval policy must cover all actual effects independently of this upstream division of responsibility.

## Git state and changes

[worktree.ts](upstream/src/runs/shared/worktree.ts), `resolveRepoState`, checks source cleanliness, resolves a ref to a commit and provisions a worktree at that commit. Native creation uses a new branch; another provider path supports Worktrunk. Setup hooks and synthetic paths can add environment artifacts. The ref validator rejects raw full hashes as caller refs, even though an internal resolved base is a SHA—another upstream API detail our product must not inherit blindly.

The LEAP requires launches from the **selected committed Git state**, including when the source checkout has unrelated uncommitted edits. Resolve/pin the commit before dispatch; never auto-stash/commit/copy those edits. Record requested ref, resolved SHA, workspace root and setup provenance. A validator starts from the committed implementation result it is validating, not the original baseline by accident. Repository absence/unresolvable state must produce an actionable launch result, not a silent shared-directory fallback.

`captureWorktreeDiff` removes recorded synthetic paths, invokes `git add -A`, captures cached binary-safe patch/stat/numstat against the base, saves and validates a patch. **This is effectful finalization, not live observation.** Live Changes must not stage or commit. It needs safe read-only capture of tracked, staged and untracked changes, binary/rename support, bounds and full artifact access. Final commit/capture is an explicit runtime operation with configured authority and provenance.

[worktree-cleanup-plan.ts](upstream/src/runs/shared/worktree-cleanup-plan.ts), [parallel-handoff.ts](upstream/src/runs/shared/parallel-handoff.ts) and cleanup in `worktree.ts` preserve uncaptured or uncertain work. Upstream's “preserve” path may still remove a changed workspace once a validated handoff patch proves capture; “preserve” does not always mean retain the directory. Laser must state its own retention policy plainly. Removing a workspace, discarding work and integrating a result are separate authorized operations. Preview/opening Changes must never trigger them.

## Acceptance and recovery

[structured-output.ts](upstream/src/runs/shared/structured-output.ts) creates a `structured_output` tool schema, validates values and handles local schema-reference rewriting. Missing tool output is a distinct failure. [acceptance.ts](upstream/src/runs/shared/acceptance.ts), `evaluateAcceptance`, separates child attestations, structural checks, executed verification and independent review; a child cannot make itself independently reviewed merely by claiming it. Source acceptance reports from observed child writes can be attributed more reliably than arbitrary shared-file contents.

Laser should retain those distinctions without copying fixed role names or inferring permissions from prose. Evidence must bind to assignment/attempt, artifact revision, tested commit, command result and reviewer identity. Invalid report metadata must not erase a useful patch; verification failure must not become success because process exit was zero. Required evidence persistence failure blocks accepted success and exposes retained work plus recovery options.

## Goals and competing continuation

[missions/goal-driver.ts](upstream/src/missions/goal-driver.ts), `collectGoalContinuationNotices`, scans owned goal missions, checks their token budget/linked runs and emits another ready-action notice at parent `agent_end` through [extension/index.ts](upstream/src/extension/index.ts). This is real independent continuation machinery, not just a label.

Do not import it. Our workflow registry owns dependencies, results and waits. Existing `/goal` owns autonomous objective continuation. Result arrival durably updates dependencies, but a paused goal cannot use it to dispatch more goal-owned work; resume reconciles it once. User-created non-goal work still works without a goal. Goal completion remains terminal, based on current objective requirements and required evidence, with no goal budgets or separate usage accounting.
