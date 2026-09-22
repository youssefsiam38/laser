# M21-T24 — end-to-end project lifecycle acceptance

Acceptance for M21 has two halves and they do not overlap.

| Half | Owner | What it settles |
| --- | --- | --- |
| The deterministic matrix | agents | that every lifecycle rule in `docs/project-lifecycle-leap.md` holds against the real store, the real host authority, the real worker server and real git |
| The browser matrix | **the person** (D-342) | that the surfaces are worth shipping: both themes, both widths, pointer and touch, reduced motion, and every state that has no assertion |

No agent opens a browser, runs an acceptance flow or claims a visual result.
Where a deterministic test uses a proxy for something visual, it says so below
under "what it does not prove".

---

## 1 · The deterministic matrix

Three files, one per layer, each scenario named for the acceptance row in
`PLAN.md` M21-T24.

| # | Scenario | Test | What it proves | What it does **not** prove |
| --- | --- | --- | --- | --- |
| 1 | Established **React** project, whole ladder | `packages/host/test/project-work/lifecycle.e2e.test.ts` › *an established React project goes the whole way* | Spec `SPEC-1` through the brief gate; standalone Research `RES-1` where the confidence rule allows `declared` only for a quoted official source and an `answered` question is refused without a citation; Design `DES-1` through the design gate; Plan `PLAN-1` and Task `TASK-1` with `implements`/`depends_on` edges at exact revisions; the build gate over the covers it names; Work and Board lists keyed and counted by kind; an attempt whose base commit and checkpoint ref are what git really holds; verification derived from four authorities that reaches `needs_review` and never `done`; the person's completion with acceptance evidence. The whole run touches no worker (`workerAttempts() === 0`). | The workspace's rendering of any of it: rows, badges, board drag, gate cards. The Design Index build and the Sketch ladder (scenario 1w). |
| 1w | …its Design leg | `packages/worker/test/project-work/lifecycle.e2e.test.ts` › *an established React project indexes parse-only and grounds a sketch* | the index is built from a real copy of the React fixture and the fixture's `tailwind.config.js`/`postcss.config.js` **side-effect markers never appear** (D-353), `fetch` is never called, the stack is the manifest's, and a Sketch grounds into a validated Tree whose Mapped nodes name entries that build produced, whose unmapped parts are Proposed and listed, and from which no script survives (D-354). | That the canvas draws that Tree correctly; Prototype mode; the sandboxed Sketch frame's CSP in a real browser. |
| 2 | Established **non-React** project, same ladder | host file › *an established non-React project runs the same ladder* | the same ladder converges on a Nunjucks/Node project: the Design's `hostPage.files` are the project's own templates, the stored body mentions no React/JSX/TSX, verification converges with no blockers and the Task reaches `done`. | Anything about how the stack was detected — that is 2w. |
| 2w | …its honest stack | worker file › *an established non-React project is reported honestly* | the Rails fixture's index reports Rails and **not** React, its eras root at `app/views`, no component entry comes from a `.tsx`, static host grounding reports `stack: "rails"` with the real `.erb` template, and a Sketch grounded against that index is entirely Proposed rather than inventing components. | Visual review of the Design Index panel and its Accept/Rename/Merge/Reject actions. |
| 3 | **Greenfield** project | host file › *a greenfield project approves a foundation before any source exists* | the project folder is the repository; Foundation mode's proposed tokens, principles and component contracts are stored with `fidelity: "proposed"`, approved through the design gate, and **the repository does not move**: same `HEAD`, `git status` still empty, the only new entry on disk is Laser's own ignored `.laser/project.json` marker and nothing else — no source, no draft. Build then waits for an explicit Start: a `ready` Task has no execution link, `start` is its own transition, and the attempt appears only after it. | The Foundation wizard's steps, copy and approval card. |
| 4 | **Backend-only skip** | host file › *a backend-only Spec skips Design and converges on commands alone* | the design gate is skipped with a recorded reason, the build gate passes on `design_skip`, verification gathers three authorities (no Design), owes **no** `design_state`, `design_token`, `browser_matrix` or visual criterion, and converges on commands alone to `needs_review` with an empty blocker list. | Nothing visual — by construction there is nothing visual in this path. |
| 5 | **Design revision during Build** | host file › *a Design revised during Build pauses only what it reaches* | revising the approved `DES-1` stales exactly the reachable graph (`PLAN-1`, with `staleBecauseKey: DES-1`) and leaves the unreachable `PLAN-2` approved; the affected Task is refused its start by name with `refused: "stale_upstream"` and joins the Needs-you queue with reason `stale` while staying `ready` — paused, not failed; the unaffected Task still converges and completes; filing acceptance evidence does not un-stale anything. | The stale banner, the conflict banner and the Needs-you queue as drawn. |
| 6 | **Multiple sessions** | host file › *work outlives the conversations it was made in* | created in session A, revised in session B, executed in session C, then the host is closed and a new store is opened over the same file: same `projectId`, same key, same `currentRevisionId`, same digest, same backlog and the same execution link with its target. | Session archive/delete and project relocation (covered by `continuity.test.ts`, M21-T20). |
| 7 | **Cross-project mention** | host file › *a session in one project may read another's work and may not change it* | from project P's worker bridge, Q's Spec reads back with its body; a revise aimed at Q is refused with `refused: "wrong_project"`, the owning project named in the sentence, and Q's Spec unchanged at one revision. | — |
| 7w | …the packet the model reads | worker file › *a mention reaches the packet the model reads* | through a real `WorkerServer`, the host's projections for this project's Task and another project's Spec are carried to the driver and rendered as one provenance-labelled block (`[from acme TASK-44@3]`, `[from beta SPEC-7@3]`) beside that exact message, with no opaque entity id or digest in the text, and no block for a message that mentioned nothing. | That a specific model then uses it. Live engine behaviour is `packages/worker/test/mention-context*.live.test.ts`. |
| 8 | **The four commands, alone, from any chat** | `packages/ui/test/project-work/lifecycle-commands.e2e.test.ts` | `/spec`, `/research`, `/design`, `/plan` exist and `/task` deliberately does not; the text beside the command is the whole input (`/plan <text>` writes that text as the Plan's own brief and creates **nothing** above it); each kind's first revision comes from that one field; from a projectless chat nothing is written anywhere until a project is chosen, and the same text is then written there. | The picker dialog itself, the `/` popover, the palette and the morph into the workspace — all in the person's matrix below. |

### The "Done means" list, and where each line is settled

| Goal line (`docs/goal-project-lifecycle-leap.md`) | Deterministic evidence | Still the person's |
| --- | --- | --- |
| A new user reaches a working session through the profile onboarding | M22: `packages/ui/test/onboarding/setup-model.test.ts` (`resumeStep` walks welcome → provider → profiles → project → ready), `packages/ui/test/onboarding/profiles-step.test.tsx` (seeded Smart/Balanced/Fast, skip writes nothing), `packages/worker/test/profiles/migrate.test.ts` | running the first-run flow on a fresh machine |
| Chat renders exactly the three-field prompt | `packages/worker/test/agents/chat-prompt.test.ts` — `CHAT_INSTRUCTION_TEMPLATE === "{{availableTools}}\n\n{{toolGuidelines}}\n\n{{availableSkills}}"` and the rendered field order, byte for byte | — |
| `/spec`, `/research`, `/design`, `/plan` work alone from any chat | scenario 8 above | the popover, palette and picker as surfaces |
| Work / Board / Needs you list keyed, badged entities | scenario 1 (host list keys, per-kind counts, Board rows by state) and scenario 5 (attention queue reasons) | badges, colours, drag, empty/loading/stale states |
| A Design Index builds parse-only and a Sketch grounds to a Tree | scenarios 1w and 2w | the canvas |
| `ask_oracle` answers without history or tools | **out of scope here** — M24, contract only (`docs/ask-oracle.md`). No M21-T24 test asserts it, and none should. |
| A Spec exports to a Jira issue from a previewed revision | **out of scope here** — M25, contract only (`docs/external-work-links.md`). |
| The release pipeline has published each milestone | M21-T25 | — |

### Running it

```bash
# frozen install first; then, per package:
env -i PATH="$PATH" HOME="$HOME" npx vitest run test/project-work --root packages/host
env -i PATH="$PATH" HOME="$HOME" npx vitest run test/project-work test/design --root packages/worker
env -i PATH="$PATH" HOME="$HOME" npx vitest run test/project-work --root packages/ui
```

Everything is `env -i` safe, needs no network, no live user store and no
browser. The git-backed scenarios skip themselves where there is no `git`.

### Red-check

Every scenario was shown to fail against a deliberately broken invariant in
**source** (each break applied alone and reverted; the tree is clean):

| Scenario | Break | Assertion that went red |
| --- | --- | --- |
| 1 | `convergeTask` completes the Task instead of asking for review | *a passing run reaches needs_review and never done* |
| 2, 4 | revert the superseded-approval fix in `verification/authorities.ts` | *blockers* no longer empty on a converged run |
| 3 | the project-marker writer also drops a `draft.json` in the project folder | *the marker directory holds only `project.json`* |
| 5 | `applyStale` stales nothing after a material change | *expected 'approved' to be 'stale'* |
| 6 | `ProjectIdentity.resolve` mints a fresh identity for every open | the restarted host cannot read the work at all (`That project is not one this app has project work for`) |
| 7 | `fenceProject` returns the request instead of refusing it | *that call should have been refused* |
| 1w | `groundSketch` defaults a node to `mapped` | *every kit node is proposed* |
| 2w | `stackSummary` always reports React | *no framework this project does not ship* |
| 7w | the worker drops `projectWork` on the prompt | *the mention context is what the engine is handed* |
| 8 | a projectless command falls back to some project | *ownership is the one hard rule: nothing is written nowhere* |

### One defect found and fixed

**A Spec that was ever revised could never converge again.** `blockersOf` in
`packages/host/src/project-work/verification/authorities.ts` treated *any*
invalidated approval on an authority as a `stale_approval` blocker. The
lifecycle's own path — approve the Brief, write the full Spec, approve the
Brief again — always leaves the superseded decision on the record, so every
Task under a gated Spec was permanently unconvergeable. The fix skips an
invalidated approval when the same gate has a later valid decision; a gate
whose *only* decisions are invalidated still blocks. Regression test:
`packages/host/test/project-work/verification.test.ts` › *stops calling it
stale once the same gate has been decided again (M21-T24)* — red before the
fix (`blockers` contains `stale_approval`, task stays `in_progress`), green
after, with the original stale-approval test still passing.

---

## 2 · The browser matrix — the person's half

Build and start the sandbox:

```bash
cd ~/projects/laser
pnpm -r build && pnpm sandbox        # http://127.0.0.1:41441
```

Do each surface below in **both themes** (Appearance → theme), at **both
widths** (a full window, and a window narrowed to about 380px or the phone
view over the relay), with **pointer and touch**, and once more with
**reduced motion** on (OS setting). The three checks that apply everywhere:

- nothing below 12px, no clipped text, no horizontal page scroll;
- every action reachable by keyboard alone, with a visible focus ring, and
  **Enter never approves and never confirms a deletion**;
- with reduced motion, transitions lose movement and nothing else — no
  content, no position, no scroll.

| # | Surface | Steps | What good looks like |
| --- | --- | --- | --- |
| B1 | **Project work control** | Open a project. Read the control in the top bar. Open it. Press "← Back to the conversation". | Live counts (`n items · n need you`). It opens inside the shell, not a window or a panel. The conversation underneath keeps its scroll, its draft and any stream. Opening is a morph, not a pop. |
| B2 | **Work** | Filter by type chips, then by text, then by "needs you". Save a view. Sort by updated, key and status. Narrow the window until the backlog collapses to a drawer and the inspector becomes a sheet. | Every row shows key, type badge, title, status chip and when it changed. Filters compose. A saved view comes back by name. Nothing reflows into overflow at the narrow width. |
| B3 | **Board** | Drag a Task between columns. Drag one whose dependency is not done. Drag one from `running` straight to `done`. Do the same with the keyboard. On a phone width, scroll the board sideways. | A legal move performs the real transition. An illegal one is refused **by key** ("TASK-3 must be done first"), not by a shrug. `done` refuses without acceptance evidence. The page itself never scrolls sideways — only the board. |
| B4 | **Needs you** | Read the queue. Approve a gate from it. Resolve a blocking comment. | The tab badge equals the queue length, and both drop the moment the thing is answered. Every row says *why* it is waiting: gate, blocking comment, handed over, blocked, index review, stale. |
| B5 | **Create and the four commands** | `+ Create` and pick each kind. Then, in a project chat, type `/plan ship the relay rate limit` and press Enter. Then do the same in a **projectless** Chat. | Create shows the next key before creating. The command's text becomes the brief and the workspace opens on exactly what was made. In a projectless Chat the project picker comes first (current project first, most recent next, "New project…" last), the chat stays projectless, and the artifact lands in the chosen project. |
| B6 | **Design workspace** | Open a Design. Pan and zoom the canvas, select a node, read the inspector, open Prototype mode, then Full screen and press Esc. Open the Design Index panel; Accept, Rename, Merge and Reject an entry; start a Re-index and stop it. Open a Sketch and press "Ground it". | Frames and edges stay legible at both widths; the phone canvas is read-only with tap-to-inspect. Every node says Mapped or Proposed, and a screen shows the conservative aggregate. Re-index is a Command in the fleet with a budget and a working Stop. Ground it produces a Tree and says what it could not map. |
| B7 | **Native acceptance** | Take a Task through a Build attempt that produces a checkpoint. Open the checkpoint preview and accept it. Then try to accept one as the agent, and try to accept a preview for a revision that has moved on. | Native evidence appears only after **you** accept a real checkpoint preview, links `verified_at` to the exact revision, and says which commit it was. An agent cannot accept. A moved revision refuses rather than inheriting. |
| B8 | **ProofTrail / evidence reader** | Open a completed Task's evidence. Page through a long captured source. Open a decision's binding page. | The retained source opens as text, pages without losing position, and split multi-byte characters are never mangled. Nothing claims proof it does not have. |
| B9 | **IdentityNotice** | Move a project folder and reopen it. Copy a project folder and open the copy. | Relocation offers to reconnect the same project and says what it is reconnecting. A copy is never silently merged into the original's history; the notice explains the choice in a sentence. |
| B10 | **Verification panel** | Start a verification on a Task with a failing command, then with all commands passing, then with a declared browser matrix. | Progress is by files/commands, never a percentage. A failure names the command and leaves the Task where it was. A passing run reaches `needs_review` — never `done`. Each browser-matrix cell is listed as **yours**, with its steps ("Open the changed screen in the dark theme at 320px…"), and is never run for you. |
| B11 | **Transcript and mentions** | Mention `@TASK-n` and an entity from another project. Send. Click the chip. Answer an approval card. | The stored message keeps the typed reference; the chip opens the workspace at that exact revision. A cross-project chip is labelled with its project. The approval card sits above the composer and Enter does not approve it. |
| B12 | **Empty, loading, error, offline, stale, damaged** | Open a project with no work. Disconnect the host mid-read. Open a deep link to a deleted revision. | Every one of these states is written for a person: what happened and what to do next. None of them is a spinner with no words, and none of them is an empty box. |

Record what you find as comments on the entities themselves, or in
`STATUS_DETAILED.md` under M21-T24. Anything you reject is a defect or a
recorded decision — never a quiet exception (`AGENTS.md`, "The bar").
