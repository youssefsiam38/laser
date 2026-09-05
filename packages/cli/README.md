# `piorbit` — the command line

The terminal half of piorbit: it starts and stops the host, drives sessions over
the same protocol the app uses, reaches the **pinned** Pi without going through
your global install, and tells you why a broken setup is broken.

```bash
piorbit                       # start the host and open the app
piorbit doctor                # is everything actually working?
piorbit pi --help             # Pi's own help, from the copy piorbit pins
```

Two rules hold everywhere:

- **Data on stdout, everything else on stderr.** `piorbit sessions --json | jq`
  never sees a progress line.
- **Every command takes `--json`.** One JSON value on stdout, or NDJSON for the
  streaming ones (`tail`, and `send` while it waits). Errors are JSON on stderr
  too, and carry their fix.

Colour turns itself off when stdout is not a terminal, when `NO_COLOR` is set,
and when you pass `--no-color`.

---

## Commands

| Command | What it does |
| --- | --- |
| `piorbit` · `piorbit up` | Start the host, or attach to the one already running, and open the app. `--no-open`, `--foreground`, `--port` |
| `piorbit down` | Stop the host. Succeeds quietly when nothing is running |
| `piorbit status` | Where the host is, what it serves, how long it has been up. Exits 3 if nothing is running |
| `piorbit restart` | Stop and start, waiting for the port to actually free |
| `piorbit sessions` · `ls` | Sessions newest first. `--project`, `--limit`, `--all` |
| `piorbit new [cwd]` | Start a session in a directory |
| `piorbit open [session]` | Attach a session in the host and open the app at it |
| `piorbit send <text…>` | Prompt a session and stream the answer. `--steer`, `--follow-up`, `--no-wait`, `--thinking`, `--timeout` |
| `piorbit tail [session]` | Stream a session live. `--follow`, `--thinking` |
| `piorbit stop [session]` | Abort the current turn |
| `piorbit entries [session]` | Entry ids and previews — what `fork` needs |
| `piorbit fork <session> <entry>` | Fork before an entry; prints the entry's text to edit and resend |
| `piorbit rename [session] <name>` | Name a session |
| `piorbit compact [session]` | Compact the context. `--instructions`, `--no-wait` |
| `piorbit projects [list\|add\|remove\|trust] [dir]` | The project list the app shows, plus each project's worker status |
| `piorbit settings [get\|list\|set\|unset] […]` | Read and write Pi settings for a project. `--project`, `--scope <global\|project>`, `--raw`, `--all` |
| `piorbit packages [list\|install\|remove\|update\|check] […]` | Pi's package manager. `--project`, `--scope <user\|project>`, `--no-progress` |
| `piorbit relay [status\|login\|pair\|devices\|revoke]` | Link a phone to this desktop through a relay. `--origin`, `--name`, `--timeout`, `--invert`, `--yes` |
| `piorbit logs […]` | The host's provider, tool and session log store. `--follow`, `--section`, `--level`, `--search`, `--session`, `--project`, `--limit`, `--detail`, `--stats`, `--clear --yes` |
| `piorbit pi […]` | Run the pinned Pi with piorbit's environment. `--global-pi` |
| `piorbit doctor` | Check everything and print a fix for what fails. `--skip-worker`, `--timeout` |
| `piorbit help [command\|topic]` | Topics: `pi`, `host`, `sessions`, `relay`, `doctor`, `env`, `json` |
| `piorbit completions <bash\|zsh\|fish>` | A completion script, generated from the command table |

Global options — accepted before or after the command name: `--json`,
`--color <auto\|always\|never>` / `--no-color`, `--port`, `--agent-dir`,
`--session-dir`, `--state-dir`, `--subagents-temp-root`, `--help`.

Exit codes: `0` success · `1` it did not work (or `doctor` found a FAIL) ·
`2` bad command line · `3` no host running · `4` the host answered with an
error. `piorbit pi` exits with Pi's own code instead.

---

## Four real examples

### 1. Prompt a project from a script and act on the answer

```bash
piorbit status --json >/dev/null || piorbit up --no-open
piorbit new ~/code/api
piorbit send -P ~/code/api "run the test suite and summarise the failures"
```

`send` streams the answer and exits when the agent settles. For machines,
`--json` turns the same stream into NDJSON:

```bash
piorbit send --json "what changed in the last commit?" \
  | jq -rj 'select(.update.kind == "text_delta") | .update.delta'
```

### 2. Watch a long run you started in the app

```bash
piorbit sessions --project .          # find it
piorbit tail 01a06fd7 --follow        # every token, tool call and duration
```

`tail` exits when the agent settles; `--follow` keeps watching for the next
turn. An idle session with no `--follow` says so and exits instead of hanging.

### 3. Link a phone and reach the desktop from anywhere

```bash
piorbit relay login wss://relay.example.com/ws --origin https://app.example.com
piorbit relay pair --name "Youssef's iPhone"
```

`pair` prints a QR code in the terminal and waits. The phone scans it, both
screens show six emoji, and you answer `y` only if they are the same six — that
comparison is what stops a relay that also got hold of the QR from sitting in
the middle, and there is no flag to skip it. Then:

```bash
piorbit restart                 # the host opens the device's channel on start
piorbit relay devices           # what is linked
piorbit relay revoke iphone -y  # unlink it again
```

### 4. Diagnose a machine where nothing works

```bash
$ piorbit doctor
  PASS  node            v24.11.1
  PASS  pinned pi       0.85.0 at …/packages/worker/node_modules/@earendil-works/pi-coding-agent
  PASS  pi boots        0.85.0 (187ms)
  PASS  agent dir       /home/you/.pi/agent (469 GiB free)
  PASS  session dir     /home/you/.pi/agent/sessions (469 GiB free)
  PASS  state dir       /home/you/.piorbit (469 GiB free)
  PASS  providers       anthropic (oauth), openai; env: OPENAI_API_KEY
  FAIL  port            127.0.0.1:41441 is in use by another program
                        → See what holds it (`lsof -nP -iTCP:41441 -sTCP:LISTEN`), or run piorbit on another port (`--port`).
  PASS  subagents root  /home/you/.piorbit/subagents (469 GiB free)
  WARN  subagents uids  roots for another uid exist: /tmp/pi-subagents-uid-0
                        → Background subagent runs started under that uid are invisible to a piorbit running as uid 1000.
  PASS  worker          spawned, opened a session and closed it (4.9s)
  PASS  default model   anthropic/claude-sonnet-4-6 (312 available)
  PASS  model auth      anthropic is ready

11 passed, 1 warning, 1 failed
```

Exit code 1, because a row FAILed. `--json` gives the same rows with their
`fix` strings, so CI can print them.

---

## `piorbit pi`

`piorbit pi` runs the Pi that `@piorbit/worker` pins — the same copy the app
runs — not whatever `pi` is on your `PATH`. It sets:

| Variable | To |
| --- | --- |
| `PI_CODING_AGENT_DIR` | piorbit's agent directory |
| `PI_CODING_AGENT_SESSION_DIR` | piorbit's session directory |
| `PI_SUBAGENTS_TEMP_ROOT` | piorbit's pi-subagents temp root |
| `PIORBIT` | `1` |

so a session or a background subagent run you start from a terminal shows up in
the app.

Everything after `pi` is Pi's, including `--help` and `--version`. piorbit eats
only the flags that *lead*: `--global-pi`, `--agent-dir`, `--session-dir`,
`--subagents-temp-root`. Use `--` to force even those through to Pi.

stdio is inherited, so the TUI works. The exit code is Pi's, and a Pi killed by
a signal kills the wrapper with the same signal — `$?` is what it would be if
you had run `pi` yourself.

---

## Where things live

Resolution order, used identically by every command:

| Thing | Order |
| --- | --- |
| agent dir | `--agent-dir` → `PIORBIT_AGENT_DIR` → `PI_CODING_AGENT_DIR` → `~/.pi/agent` |
| session dir | `--session-dir` → `PIORBIT_SESSION_DIR` → `PI_CODING_AGENT_SESSION_DIR` → `<agent>/sessions` |
| state dir | `--state-dir` → `PIORBIT_STATE_DIR` → `~/.piorbit`, or `<agent>/piorbit` when the agent dir was overridden |
| subagents root | `--subagents-temp-root` → `PIORBIT_SUBAGENTS_TEMP_ROOT` → `PI_SUBAGENTS_TEMP_ROOT` → `<state>/subagents` |
| port | `--port` → `PIORBIT_PORT` → `41441` |

An overridden agent directory gets its own state directory, so
`piorbit up --agent-dir /tmp/sandbox` can never adopt or stop the host serving
your real one.

In the state directory:

- `host.json` — the running host's pid, port and directories. Advisory: "is it
  running" is always decided by `GET /healthz`, so a record left by a crash is
  cleaned up rather than believed.
- `host.log` — the detached host's output. `piorbit status` prints its tail when
  the host is unreachable.
- `cli-recent-sessions.json` — the last session started per project. Pi writes a
  session file lazily, so a session created a second ago is not in the catalog
  yet; this is how `piorbit new && piorbit send …` finds it.
- `relay.json` — the relay URL, the origin the phone opens, and the **signed**
  device list. Public by design: the list is signed rather than hidden, and a
  list that does not verify is refused rather than replaced.
- `identity.key` — the Ed25519 root seed that signs that list, mode 0600.
  Created on first use and never rotated here: every paired phone verifies the
  list against it, so replacing it unlinks every device.
- `relay-static.key` — the durable X25519 key each device runs its Noise_KK
  handshake against, mode 0600.

---

## Installing completions

```bash
piorbit completions bash > /etc/bash_completion.d/piorbit
piorbit completions zsh  > "${fpath[1]}/_piorbit"   # then: compinit
piorbit completions fish > ~/.config/fish/completions/piorbit.fish
```

They are generated from the same table that generates `--help`, so a new command
completes the day it exists. Completion stops at `pi`: the arguments there are
Pi's, and guessing at them would be wrong.

---

## Design notes

- **No dependency budget.** The parser, the colour helper, the table renderer,
  the completion generators and the QR encoder (`src/qr.ts`, pinned against an
  independent implementation in `test/qr.test.ts`) are all in this package.
  `ws` is the only third-party runtime dependency, and it is the one the host
  already uses; `@piorbit/crypto` is a workspace package, and the pairing
  handshake lives there rather than being reimplemented here.
- **One description per command.** `Command` in `src/command.ts` drives parsing,
  `--help`, completions and dispatch. There is nowhere for them to disagree.
- **No second path into a session.** Session verbs speak the same WebSocket
  JSON-RPC the app speaks, so the CLI can never do something the app cannot see.
- **Agent output is data.** Everything printed from a transcript, a tool result
  or an extension goes through `sanitize()` first: no escape sequence from an
  agent reaches your terminal. It is AGENTS.md invariant 9, applied to stdout.
- **This package never imports Pi.** It resolves the pinned Pi's *path* through
  `@piorbit/worker` and spawns it. A test asserts both halves of that.

## Development

```bash
pnpm -F @piorbit/cli build
pnpm -F @piorbit/cli test
node packages/cli/dist/main.js --help      # without installing the bin
```
