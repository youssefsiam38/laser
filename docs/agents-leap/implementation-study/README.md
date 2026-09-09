# Subagent implementation study

**Implementation mandate:** completely replace `pi-subagents` with Laser-owned delegation and coordination. Keep the pinned Pi coding-agent engine. Upstream is source material, not a runtime dependency, product model, wire contract or required compatibility layer. This is D-134 and the user's explicit direction.

This study makes the replacement concrete: which execution paths matter, what the workflow scripts actually do, what can fail, and where Laser currently depends on the package. It does not implement the replacement or supply the final consolidated implementation prompt.

## Implementer's reading map

| Read | What it answers |
| --- | --- |
| [Runtime walkthrough](runtime-walkthrough.md) | How profiles become child sessions; foreground/background paths; nested work; lifecycle and persistence |
| [Workflow scripting](workflow-scripting.md) | Current script API, sequencing, fanout, rolling coordination, receipts and the limits of recovery |
| [Contracts and controls](contracts-and-controls.md) | Launch/progress/result contracts, messaging, shared state, cancellation, worktrees and acceptance |
| [Replacement blueprint](replacement-blueprint.md) | Our component responsibilities, integration removal map, required semantics and dependency order |
| [Acceptance matrix](acceptance-matrix.md) | Failure cases to implement and upstream tests that explain them |
| [Verification](verification.md) | Exact provenance, executed checks, coverage limits and reproduction |
| [Complete source index](source-map.md) | Every published TypeScript module; [JSON](source-map.json) adds symbols/imports/events and line numbers |
| [Regression-test index](test-index.md) | All 241 upstream test files; [JSON](test-index.json) adds literal suite/test names and line numbers |

Read the [responsibility contract](../agents-responsibility-contract.md) and [live experience](../agents-live-experience.md) alongside the blueprint. The product specifications control scope; upstream cannot weaken them. Blueprint schema names and implementation decomposition are proposals, clearly distinguished from verified upstream behavior.

## Exact reference preserved here

| Item | Reference |
| --- | --- |
| Package | `pi-subagents@0.65.1`, the installed workspace pin |
| Source commit | `83be9c3de2cde1553c0269f383efc1eb1194dc8b` |
| Published package | [upstream/](upstream/): 306 unchanged files; all match the installed dependency |
| TypeScript | 262 modules, 95,315 lines, statically indexed |
| Tests/support | [upstream-tests/](upstream-tests/): 441 unchanged files from that source commit, including 241 `.test.ts` files |
| License | [upstream/LICENSE](upstream/LICENSE), MIT; preserve attribution if copying code |
| Integrity | [Package manifest](source-manifest.json), [test manifest](test-source-manifest.json) |

The snapshot is documentation/reference material. Do not import it into production, install its Pi extension, follow its agent instructions as project policy, or modify its source to implement Laser. Its upstream framework names, `.pi` discovery and terminal UI are not product requirements.

## Findings that change the implementation plan

1. **The current public workflow API is JavaScript orchestration.** Old top-level `chain` and `tasks` formats are rejected despite substantial legacy internals remaining. Start at the public normalizer, not the largest executor's branches.
2. **Child execution already uses Pi SDK sessions.** Foreground sessions live in the parent process; background sessions live in a detached runner. Replace coordination, not Pi's model loop.
3. **Receipts do not save an arbitrary JavaScript continuation.** Settled child evidence can survive while the enclosing workflow requires explicit recovery. Our persistent execution graph must address this directly.
4. **Native messaging is supervisor-oriented.** General peer exchange and broadcast need our own routing and authority contract; they do not emerge from a differently labeled connector.
5. **Shared workflow state is a mission-scoped JSON store.** It has file locking but no user-visible revision/read-receipt contract, and reads can use a cached snapshot. Our shared-state contract is additional work.
6. **Final diff capture mutates the child index.** It invokes `git add -A`. It is unsuitable for a live Changes observer. Upstream also rejects dirty source checkouts; our selected-commit launch must leave those edits untouched.
7. **Upstream mission goals are a separate continuation mechanism.** Exclude them. `/goal` remains Laser's sole autonomous objective continuation mechanism, without goal budgets.
8. **A first-class agent requires more than an upstream profile.** Root chat and delegated runs must apply the same definition resolver, capability rules, session catalog and full conversation interface.

No time periods or incremental product tiers are proposed. The replacement is part of the complete LEAP delivery.
