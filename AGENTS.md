# AGENTS.md — how to work in this repo

laser is a web-tech desktop app and remote-control relay layered on top of the
Pi coding agent (`@earendil-works/pi-coding-agent`). It visualizes Pi sessions,
agents and subagents, settings and low-level logs, and exposes the same UI to
phones through an end-to-end encrypted relay. Pi owns the logic; we own the
experience, and the experience is the product.

This file is the contract for every agent, human or model. It is deliberately
short. Every area of the system has a document beside its code under `docs/`
or in its package — read the one for the area you are about to change, before
you change it.

## The bar

laser is not a dashboard over Pi. It is meant to be the experience that makes
developers choose an agent because of how it feels to work with.

- **Nothing ships as a placeholder.** Empty, loading, error and first-run
  states are designed with the same care as the main path.
- **No static visual values, ever.** Every colour, font, size, radius, shadow,
  spacing step and duration comes from a token the person can change in
  Settings. A hex literal or a raw `px` font size in a component is a bug.
- **Motion is a material.** Things morph, they do not pop. Identity, position
  and scroll survive every transition, with a `prefers-reduced-motion`
  fallback that loses the movement and nothing else.
- **The person never needs a terminal.** Everything is installed and
  configured from the UI, and the copy never names the engine underneath.
- **Legibility is a floor.** Nothing below 12px, no overflow, no clipped text,
  no horizontal page scroll. A component that cannot fit shows less content,
  never smaller text.
- **Errors are written for a person.** What went wrong, and what to do next.
- **Both themes, both pointers, both widths**, with equal care.

"It builds" is not the bar. "I would show this to someone I respect" is. A UI
change that does not fit the design is either a bug or a decision
recorded in `STATUS_DETAILED.md` — never a quiet exception.

**Acceptance in a browser belongs to the person, not to an agent.** An agent
may open the app in a browser for one purpose only: taking screenshots to check
its own visual work against the design. No clicking through flows, no
functional or acceptance testing, no browser test suites, no
`scripts/browser-check/` (D-342). Functionality is proven by unit tests and by
the person. When UI work is finished, the agent reports; the person runs
`pnpm -r build && pnpm sandbox` (http://127.0.0.1:41441) and tests it. A
behaviour you cannot prove from unit tests and from reading the code is
reported as an open item with the exact steps to check it. Never claim it
works, and never pass off a class-name or string assertion as behavioural
proof without naming it as the proxy it is.

## The SDLC

Three planning files, dependency-ordered and never time-ordered. There are no
dates, estimates, sprints or deadlines in any of them.

| File | Role |
| --- | --- |
| `PLAN.md` | What we are building, in what order, and why. Milestones and tasks with permanent IDs. |
| `STATUS.md` | The one-screen answer to "where are we right now". Regenerated every session. |
| `STATUS_DETAILED.md` | Per-task ledger: state, evidence, notes, handoffs, decisions, open questions. Append-only history. |

Every session, in this order:

1. Read this file, then `STATUS.md` in full.
2. Find your task: `grep -n "M1-T3" STATUS_DETAILED.md PLAN.md`. Read its row,
   its notes block, and any handoff that names it.
3. Read the document for the area you are touching. If the last session left no
   finish or handoff note, assume it died mid-task: check `git status` and
   `git log` and write a handoff describing what you found.
4. **Claim** the task before the first code change — state `in-progress`, your
   session label in Owner, one note line saying what you intend to do first.
5. **Checkpoint** into the notes block whenever you finish a sub-step, hit a
   surprise, or are about to run something long. A crashed session must lose
   nothing important.
6. **Finish or hand off.** `done` needs evidence: a commit hash, a passing test
   command, or a file path. Anything else needs a handoff note.
7. **Regenerate `STATUS.md`** before you stop. A session that changed code and
   left it stale has failed its task.

Formats for rows, notes, handoffs, decisions and the status rewrite live at the
top of `STATUS_DETAILED.md`; the rules for editing the plan live at the top of
`PLAN.md`. Task IDs are `M<milestone>-T<n>`, decisions `D-<n>`, handoffs
`H-<n>`. Never renumber.

## Architecture invariants

Violations are bugs, not style. `docs/architecture.md` has the layer diagram.

1. **Nothing above the worker imports Pi.** Only `packages/worker` and
   `packages/pi-extension` may import `@earendil-works/*`; everything else
   speaks `@lasercode/protocol`.
2. **The protocol is ACP-shaped**, plus `pi/*` extras. New capabilities land in
   `packages/protocol` first, then get implemented.
3. **Two drivers behind one interface.** `SessionDriver` has `StableSdkDriver`
   and the `ChordDriver` stub; a change must keep both compiling and the seam
   test green.
4. **Pi is pinned inside the worker**, exactly. The user's global Pi install is
   never the runtime. Bumping the pin is a task with its own row.
5. **One worker process per project directory.** A worktree under
   `<project>/.worktrees/` belongs to that project, never to a second one.
6. **Laser is the product; Pi is an internal engine.** No normal surface
   mirrors Pi's settings, packages, vocabulary or branding. People enable
   Features, never install packages. Project configuration lives in
   `<project>/.laser`; `.pi` is neither read nor migrated. Pi-native logic
   belongs in a reusable workspace package; `packages/pi-extension` adapts it
   into engine-neutral protocol data.
7. **The relay is a byte forwarder.** It links no crypto library and parses
   nothing beyond the channel id.
8. **Never two writers on one Pi session file.**
9. **Phone output is untrusted data.** Everything from agent output is escaped;
   no raw HTML from the transcript.
10. **An update replaces the running generation, not the protocol.** Never fix
    UI/host version skew by teaching new features old request schemas.
11. **One companion extension, many modules.** Glue for a package is a module in
    `packages/pi-extension/src/modules/*`, never a new bridge package. Modules
    never import each other, detect their package at `session_start`, and fail
    individually.
12. **The agent harness is Laser's own** (D-140). Its tool surface, identities
    and isolation rules are a fixed contract, not an implementation detail.

## Commands

```bash
pnpm install                        # workspace install
pnpm verify                         # full gate: build, then typecheck + all tests
pnpm -r build                       # build all packages
pnpm -F @lasercode/worker test      # one package while iterating
pnpm -F @lasercode/worker dev       # watch mode
pnpm identity:check                 # product identity guard
```

TypeScript strict, ESM everywhere, relative imports use `.js` specifiers,
Node 24, pnpm, exact-pinned dependencies. Run the suite with `pnpm verify`,
not `pnpm -r test`.

## Commits

- Commit when the task owner asks, or when a task reaches `done`.
- Conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`), scope = package.
- No AI attribution trailers of any kind, in commit messages or PR bodies.
- Never commit secrets, `auth.json`, session transcripts, or `.env` files.
- Run `pnpm identity:check` after adding source files, not only before staging
  them: a new file that hard-codes product identity fails CI, not your laptop.

## Do not

- Do not add dates or estimates to the planning files, outside history notes.
- Do not start a task without claiming it, or mark `done` without evidence.
- Do not delete rows, notes, handoffs, or decisions.
- Do not import Pi outside the worker and the pi-extension package.
- Do not use the user's global Pi as the runtime.
- Do not write to `~/.pi/agent/settings.json` outside `SettingsManager`.
- Do not run two laser workers against the same project directory.
- Do not run the browser acceptance harness or test functionality in a browser;
  that is the person's. Screenshots for design review are the one exception.
