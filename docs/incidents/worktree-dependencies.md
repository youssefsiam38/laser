# Worktree dependencies: why child agents keep stalling on `node_modules`

Status: analysis for a decision. Nothing implemented.

## What happens

`start_agent` with `worktree: true` (the default) creates `<toplevel>/.worktrees/<slug>` and then, best effort, **symlinks the parent checkout's root `node_modules` into the worktree** (`packages/worker/src/agents/worktrees.ts:220`, documented in `docs/agents.md` §"When a child does get one"). That single link is the whole provisioning story.

In a pnpm workspace it is the wrong shape:

| What the link gives | What a workspace needs |
| --- | --- |
| `<worktree>/node_modules` → parent's root store (`.pnpm/`, hoisted deps) | `<worktree>/packages/*/node_modules` (per-package deps, absent) |
| `node_modules/@lasercode/cli` → **parent's** `packages/cli` | the worktree's own `packages/cli` |
| `node_modules/.bin/pnpm`… (not there: pnpm lives in nvm) | a PATH with pnpm |

Consequences observed today (33 log rows since yesterday mention it):

1. `pnpm -r build` in the worktree fails: `packages/protocol` cannot resolve `handlebars`/`zod` (package-local `node_modules` missing).
2. If the child runs `pnpm install` through the link, pnpm **rewrites the parent checkout's** `node_modules/@lasercode/*` links to point at the worktree — the main checkout then builds and tests the child's branch. This bit the orchestrator once; the brief now forbids `pnpm install` in worktrees, so children stop and ask instead.
3. Children that try to self-repair (ad-hoc links, `.vite-temp` self-references) make it worse and burn their three-failure budget.
4. Every affected run costs one round trip: child blocks → parent removes the link, runs an isolated `pnpm install --offline` + `pnpm -r build` (~2–3 min) → child resumes. Five of seven worktree runs today needed it.

Additionally children lack `pnpm` on PATH (exit 127) because the host is launched from the desktop, not a shell — partially addressed by the shell-environment feature (0.5.1) for new host generations.

## Why the symlink was chosen

It makes a child usable instantly for projects with a single flat `node_modules` (most apps), costs nothing, and "a missing link costs an install, never a run". It was never validated against a pnpm workspace — this repository.

## The principle (decided by the person)

Laser is a coding agent for every stack — including languages that do not exist yet. The harness therefore **knows nothing about package managers**. It never symlinks, installs, or guesses. What it owes the child is the truth about its environment, and what it owes the person is that a child can never damage the parent checkout.

## The design that follows

1. **No symlink, no install.** A worktree is a clean git checkout of the parent's commit — exactly what `git worktree add` produces. Nothing else is copied or linked. (Removes `linkNodeModules` and the parent-corruption path entirely.)
2. **Tell the child the truth, in its role block**, generated from facts the harness can observe without knowing any stack:
   - "You are in a fresh worktree at `<path>` on branch `<branch>`. It is a clean checkout of `<commit>`: build outputs, dependency directories and caches from the parent checkout are **not** here."
   - "The parent checkout is at `<path>`; do not modify it."
   - "Untracked/ignored directories present in the parent but absent here: `node_modules/`, `target/`, `.venv/`, `dist/` …" — read from `git status --ignored` of the parent, listed verbatim, no interpretation.
   - "Project instructions (`AGENTS.md`, `CLAUDE.md`, `README`) describe how this project installs and builds; follow them inside this worktree."
3. **The project says how to set up a worktree, if it wants to.** One optional, stack-neutral hook: `<project>/.laser/worktree-setup` (an executable) or a `worktreeSetup` command in `.laser/config`. When present, the harness runs it inside the new worktree before the child's first turn (bounded time, output captured, failure reported to the child and the parent — never fatal). Laser's own repo would put `pnpm install --frozen-lockfile --offline && pnpm -r build` there. A Rust project puts nothing (cargo just works). A language from 2031 puts whatever it needs.
4. **The parent's brief can add specifics** (the orchestrator already knows the stack); the harness does not.
5. **`start_agent`'s result and `inspect_agent`** carry the same environment facts and the setup hook's outcome, so the parent can brief and diagnose without guessing.

This is one worker milestone: `packages/worker/src/agents/worktrees.ts` (drop the link; run the hook), the role block (`session-config.ts`/harness), protocol result fields, `docs/agents.md`, tests with a git fixture that has an ignored directory and a setup hook that succeeds/fails/times out.

## Options considered before the principle was set

| | Option | Child sees | Cost per worktree | Risks |
| --- | --- | --- | --- | --- |
| A | Keep the symlink (status quo) | broken workspace | 0 | every run stalls; a `pnpm install` corrupts the parent |
| B | **Detect the package manager and provision properly**: for pnpm workspaces (`pnpm-workspace.yaml` present) run `pnpm install --frozen-lockfile --offline --prefer-offline` in the worktree with an isolated store path (pnpm's content-addressable store makes this seconds, not minutes; it hard-links from the global store); npm/yarn: symlink is fine for a flat root, else `npm ci --offline`; no manifest: nothing | a real workspace | pnpm: ~20–60 s cold, ~10 s warm (measured 2–3 min today only because it included `pnpm -r build`) | must never write outside the worktree; runs before the child's first turn (or in the background with the child told when it is ready) |
| C | Symlink **per package** instead of the root: link every `packages/*/node_modules` and the root, but replace `node_modules/@lasercode/*` links with links into the worktree's own packages | almost a workspace | 0 | fragile: pnpm's `.pnpm` layout resolves workspace packages through the root links; partial links produce the `.vite-temp` self-reference failures seen today |
| D | Do not provision; tell the child plainly | nothing | 0 | every child reinvents provisioning; the parent-corruption risk remains unless `pnpm install` is refused |

Recommendation: **B**, with the child told the truth either way.

## Transparency (the part that matters regardless of A–D)

The child is told "you have your own worktree" and nothing else. It discovers the state of `node_modules` by failing. Whatever we provision, the child's role block should carry a **dependency line** that the harness fills in from what it actually did:

- "Dependencies: installed in this worktree (pnpm, frozen lockfile, offline)." or
- "Dependencies: this worktree shares the parent checkout's `node_modules` by symlink — workspace packages resolve to the parent's sources; do not run `pnpm install` here." or
- "Dependencies: not provisioned (no manifest recognised)."

plus one line for the tool PATH ("`pnpm`/`node` available at …" or "not on PATH"). The `start_agent` result to the parent should carry the same field so the orchestrator can brief precisely, and `inspect_agent` should show it.

Guard: the harness refuses (or warns, once) a child's `pnpm install`/`npm install` inside a worktree whose root `node_modules` is a symlink into the parent — that is the one command that damages the parent.

## Decision needed

1. Adopt B (proper provisioning per package manager, isolated store, offline-first) — yes/no.
2. Provision synchronously before the child's first turn (simple; adds ~10–60 s to `start_agent` for pnpm workspaces) or in the background with a "ready" note delivered to the child (faster start, one more state).
3. Add the dependency/PATH line to the child's role block and the `start_agent` result — yes/no.
4. Refuse install commands through a shared symlink — yes/no.

If yes to all: one worker milestone in `packages/worker/src/agents/worktrees.ts` + harness role block + tests with a real pnpm workspace fixture and an npm flat fixture; the orchestrator's briefs stop carrying the "do not `pnpm install`" warning.
