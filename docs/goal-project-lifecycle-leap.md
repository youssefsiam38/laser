# Goal: deliver the project lifecycle leap

Deliver the project lifecycle leap end to end, as specified. Do not stop until
every milestone below is `done` with evidence in `STATUS_DETAILED.md`,
`pnpm verify` and `pnpm identity:check` are green on main, and `STATUS.md` is
regenerated.

## Read first, in this order

1. `AGENTS.md`, `STATUS.md`.
2. `docs/project-lifecycle-leap.md` — the root source of truth. Its
   "Flexibility", "Embedded workspace" and "Companion contracts" sections bind
   everything else.
3. The companion contracts it indexes: `docs/model-profiles.md`,
   `docs/plain-chat.md`, `docs/ask-oracle.md`, `docs/external-work-links.md`,
   `docs/agent-tool-contract.md`, `docs/research-phase.md`,
   `docs/design-phase.md`.
4. Area docs before touching their code: `docs/architecture.md`,
   `docs/agents.md`, `docs/ux-fleet.md` (binding for anything that shows work
   in flight), `docs/source-control-leap.md`, `docs/ux-elements.md`,
   `docs/model-fallback-chains.md` (runtime record only).
5. Decisions D-329–D-333 and D-345–D-355 in `STATUS_DETAILED.md` are binding.

## Deliver in this order

Each milestone is released before the next starts.

1. **M22** Model profiles (breaking; migration on a real settings file)
2. **M23** Plain Chat (built-ins removed)
3. **M26** Tool contract conformance, alongside M21-T1–T5
4. **M21** The project lifecycle leap, including M21-T26 Research
5. **M24** Ask Oracle
6. **M25** External work links (Jira)

## Rules

- Follow the SDLC loop in `AGENTS.md` exactly: claim each task before code,
  checkpoint notes, `done` only with a commit hash or passing test command,
  regenerate `STATUS.md` before each stop.
- Every task's acceptance in `PLAN.md` is the contract. If a contract and code
  disagree, the contract wins; record a `D-<n>` if you must deviate.
- No browser tests or acceptance runs (D-342); screenshots for your own
  design check only.
- Every visual value is a token. No Pi vocabulary above the worker. Nothing
  above the worker imports Pi.
- Conventional commits, one per finished task, no AI attribution trailers.
- When a contract is genuinely ambiguous, choose the option that keeps Laser
  the single authority and links optional, write it down, and continue.

## Done means

- A new user reaches a working session through the profile onboarding.
- Chat renders exactly the three-field prompt.
- `/spec`, `/research`, `/design`, `/plan` work alone from any chat.
- The Work / Board / Needs you workspace lists keyed, badged entities.
- A Design Index builds parse-only and a Sketch grounds to a Tree.
- `ask_oracle` answers without history or tools.
- A Spec exports to a Jira issue from a previewed revision.
- The release pipeline has published each milestone.
