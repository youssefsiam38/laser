# The project environment command

A project can name one program that decides the environment its commands run
with. Laser runs that program and applies what it returns to everything it
executes for the project: foreground `bash`, background tasks, child agents and
their worktrees.

Laser has no knowledge of where the values come from. A secret manager, a
password store, a plain file on disk, an in-house service — all of them look the
same from here, because the contract is a program and a document, not a provider.

## Why this exists

Different projects use the same variable names with different credentials.
`DATABASE_URL` means one thing in one company's repository and another thing in
a personal one. Without this, both inherit whatever the terminal that launched
the app happened to export, which is at best the wrong environment and at worst
someone else's credentials.

## The contract, version 1

Laser spawns the configured program:

- working directory: the project root;
- `stdin`: closed;
- file descriptor **3**: open for writing;
- environment: the app's own, so the program can find its own credentials.

The program writes one JSON document to fd 3 and exits `0`:

```json
{ "version": 1, "set": { "DATABASE_URL": "…" }, "unset": ["STALE_TOKEN"] }
```

- `set` — variables to give the project's commands.
- `unset` — variables to remove, so a credential inherited from the launching
  terminal does not survive into a project that did not ask for it.

Bounds: 20 seconds, 1 MiB. Exceeding either kills the program's whole process
group, so a hook that leaves a child behind cannot keep a project waiting.

**stdout and stderr are treated as potentially sensitive.** They are drained and
discarded: never rendered, never logged, never put in a diagnostic. A program
that fails is described by how it failed — "exited with code 3" — and never by
quoting what it said, because what it said may contain the secret it failed on.

## What is refused

Validation happens before anything is applied, and refusals are collected rather
than fatal: one forbidden name does not cost the project its other forty.

| Refused | Why |
| --- | --- |
| Names that are not variable names; values containing NUL | Not usable as an environment |
| The product's own namespace, `ELECTRON_*`, `NODE_OPTIONS`, engine directory pins | `isProtectedEnvironmentKey`; these are the app's own wiring |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and the other provider credentials | See below |

### Model-provider credentials

Refused by default, with a per-project opt-in.

The reason is concrete. Real projects set `ANTHROPIC_API_KEY` in their
environment files, with different values per project. If a project hook could
set one, opening that project would silently repoint the agent's own
authentication — the agent would start billing, or failing, against a key the
person never chose for it. A project that genuinely wants to give its commands a
provider key (a test suite that calls an API) allows that name explicitly.

The same reasoning shapes where the values live. The worker holds them **in
memory** and injects them where a process is created; it never writes them into
its own `process.env`, because that is what the engine reads to authenticate a
model. The separation is structural rather than a rule someone has to remember.

## Trust and approval

Two gates, both refusals rather than warnings:

- **Trust.** A project whose trust decision is not `trusted` gets no environment
  command. The hook never runs before a person approves the project — the same
  rule `.laser/worktree-setup` follows.
- **Approval.** Saving the configuration in Settings **is** the approval: the
  person is looking at the command they are allowing. The `{command, args}`
  fingerprint is recorded then. Any later change to what would actually execute
  makes the stored value stale, and the hook does not run until it is approved
  again.

The configuration is **machine-local**, keyed by canonical project root, in the
host's state directory — deliberately **not** `<project>/.laser/settings.json`.
It names an executable, so a file inside a checkout must not be able to choose
one: cloning a repository would otherwise be enough to run a program of the
repository author's choosing with the person's credentials in reach.

## Lifecycle

- Resolved **once per worker lifetime**, before the first session opens.
  Concurrent callers share one run.
- **Refresh** re-resolves for later commands. Anything already running keeps the
  environment it started with, because a live process's environment cannot be
  rewritten. The UI says so rather than implying otherwise.
- One worker per project directory means the resolved environment *is* the
  project's: a second project runs in a second process and cannot see it.
  Child agents and worktrees share the worker deliberately, which is what "a
  worktree keeps its owning project's environment" means in practice.
- A failure with `required` set refuses command execution with a sentence that
  says what to do next. With `required` off, commands run without it.

## What a person sees

Settings → **Environment**: the program, its arguments, two switches, and
**Test** / **Refresh**. Status shows state, when it last ran, and the variable
**names** it sets and removes.

No value is ever shown, and no value crosses the protocol — status carries names
and counts only, so it is equally safe on a paired phone and in a screenshot.

## MCP servers

A stdio MCP server is started by the engine itself, not by the shell tool, so it
never passes the spawn hook the project's commands do. Its environment is
decided when its entry is built, under three rules:

- A server configured `inheritEnv: false` means "only what I configured", and is
  left exactly as it is.
- An inheriting server is given the environment the project's commands get.
  Laser takes the environment over in full for that server, because an `env` map
  can add a name but cannot remove one — and removing an inherited credential is
  half the point.
- The server's own configured `env` is applied last, so an explicit value still
  wins over the project's.

An HTTP or socket server starts no process and is untouched. A server that is
already connected keeps the environment it started with; picking up a refresh
needs **Settings → MCP servers → Reconnect**, exactly as
`docs/shell-environment.md` describes for the shell overlay.

## What this is not

Environment scoping prevents projects from mixing credentials **by accident**.
It is not a sandbox. An agent working in a project can read what the program
returns, exactly as it can read any file the person can read. Anything stronger
needs a different mechanism — separate accounts, separate machines — and this
document does not claim otherwise.

## Related

- `packages/protocol/src/project-env.ts` — the contract and its validation.
- `packages/worker/src/project-env.ts` — running the hook, holding the values.
- `packages/host/src/project-env.ts` — configuration, approval, trust gate.
- `docs/shell-environment.md` — the separate, additive overlay the desktop
  imports from a login shell at startup.
