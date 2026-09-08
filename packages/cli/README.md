# `laser` — the command line

The optional terminal companion for Laser: it starts and stops the host, drives
sessions over the same protocol the app uses, and diagnoses a broken setup.

```bash
laser                       # start the host and open the app
laser doctor                # is everything actually working?
```

Two rules hold everywhere:

- **Data on stdout, everything else on stderr.** `laser sessions --json | jq`
  never sees a progress line.
- **Every command takes `--json`.** One JSON value on stdout, or NDJSON for the
  streaming ones (`tail`, and `send` while it waits). Errors are JSON on stderr
  too, and carry their fix.

Colour turns itself off when stdout is not a terminal, when `NO_COLOR` is set,
and when you pass `--no-color`.

## One name, two programs

On a machine where laser was installed with the one-line installer,
`~/.local/bin/laser` is the app's launcher, and it dispatches:

| What you type | What runs |
| --- | --- |
| `laser` | the window |
| `laser://…` | the window, on that link |
| `laser doctor`, `laser sessions`, any ordinary word | this command |
| `laser --help`, `-h`, `--version`, `-v` | this command |
| anything else starting with `-` | the window — those are Chromium's flags, and the app passes them to itself when it relaunches |

The command runs on the same bundled runtime as the app and resolves the same
directories, so a terminal and the window can never show different sessions.
Nothing about using laser requires this command; it is here for the things a
window is the wrong shape for.

---

## Commands

| Command | What it does |
| --- | --- |
| `laser` · `laser up` | Start the host, or attach to the one already running, and open the app. `--no-open`, `--foreground`, `--port` |
| `laser down` | Stop the host. Succeeds quietly when nothing is running |
| `laser status` | Where the host is, what it serves, how long it has been up. Exits 3 if nothing is running |
| `laser restart` | Stop and start, waiting for the port to actually free |
| `laser sessions` · `ls` | Sessions newest first. `--project`, `--limit`, `--all` |
| `laser new [cwd]` | Start a session in a directory |
| `laser open [session]` | Attach a session in the host and open the app at it |
| `laser send <text…>` | Prompt a session and stream the answer. `--steer`, `--follow-up`, `--no-wait`, `--thinking`, `--timeout` |
| `laser tail [session]` | Stream a session live. `--follow`, `--thinking` |
| `laser stop [session]` | Abort the current turn |
| `laser entries [session]` | Entry ids and previews — what `fork` needs |
| `laser fork <session> <entry>` | Fork before an entry; prints the entry's text to edit and resend |
| `laser rename [session] <name>` | Name a session |
| `laser compact [session]` | Compact the context. `--instructions`, `--no-wait` |
| `laser projects [list\|add\|remove\|trust] [dir]` | The project list the app shows, plus each project's worker status |
| `laser settings [get\|list\|set\|unset] […]` | Read and write Laser settings for a project. `--project`, `--scope <global\|project>`, `--raw`, `--all` |
| `laser relay [status\|login\|pair\|devices\|revoke]` | Link a phone to this desktop through a relay. `--origin`, `--name`, `--timeout`, `--invert`, `--yes` |
| `laser logs […]` | The host's provider, tool and session log store. `--follow`, `--section`, `--level`, `--search`, `--session`, `--project`, `--limit`, `--detail`, `--stats`, `--clear --yes` |
| `laser doctor` | Check everything and print a fix for what fails. `--skip-worker`, `--timeout` |
| `laser help [command\|topic]` | Topics: `host`, `sessions`, `relay`, `doctor`, `env`, `json` |
| `laser completions <bash\|zsh\|fish>` | A completion script, generated from the command table |

Global options — accepted before or after the command name: `--json`,
`--color <auto\|always\|never>` / `--no-color`, `--port`, `--agent-dir`,
`--session-dir`, `--state-dir`, `--subagents-temp-root`, `--help`.

Exit codes: `0` success · `1` it did not work (or `doctor` found a FAIL) ·
`2` bad command line · `3` no host running · `4` the host answered with an
error.

---

## Four real examples

### 1. Prompt a project from a script and act on the answer

```bash
laser status --json >/dev/null || laser up --no-open
laser new ~/code/api
laser send -P ~/code/api "run the test suite and summarise the failures"
```

`send` streams the answer and exits when the agent settles. For machines,
`--json` turns the same stream into NDJSON:

```bash
laser send --json "what changed in the last commit?" \
  | jq -rj 'select(.update.kind == "text_delta") | .update.delta'
```

### 2. Watch a long run you started in the app

```bash
laser sessions --project .          # find it
laser tail 01a06fd7 --follow        # every token, tool call and duration
```

`tail` exits when the agent settles; `--follow` keeps watching for the next
turn. An idle session with no `--follow` says so and exits instead of hanging.

### 3. Link a phone and reach the desktop from anywhere

```bash
laser relay login wss://relay.example.com/ws --origin https://app.example.com
laser relay pair --name "Youssef's iPhone"
```

`pair` prints a QR code in the terminal and waits. The phone scans it, both
screens show six emoji, and you answer `y` only if they are the same six — that
comparison is what stops a relay that also got hold of the QR from sitting in
the middle, and there is no flag to skip it. Then:

```bash
laser restart                 # the host opens the device's channel on start
laser relay devices           # what is linked
laser relay revoke iphone -y  # unlink it again
```

### 4. Diagnose a machine where nothing works

```bash
$ laser doctor
  PASS  node            v24.11.1
  PASS  pinned pi       0.85.0 at …/packages/worker/node_modules/@earendil-works/pi-coding-agent
  PASS  pi boots        0.85.0 (187ms)
  PASS  agent dir       /home/you/.pi/agent (469 GiB free)
  PASS  session dir     /home/you/.pi/agent/sessions (469 GiB free)
  PASS  state dir       /home/you/.laser (469 GiB free)
  PASS  providers       anthropic (oauth), openai; env: OPENAI_API_KEY
  FAIL  port            127.0.0.1:41441 is in use by another program
                        → See what holds it (`lsof -nP -iTCP:41441 -sTCP:LISTEN`), or run laser on another port (`--port`).
  PASS  subagents root  /home/you/.laser/subagents (469 GiB free)
  WARN  subagents uids  roots for another uid exist: /tmp/pi-subagents-uid-0
                        → Background subagent runs started under that uid are invisible to a laser running as uid 1000.
  PASS  worker          spawned, opened a session and closed it (4.9s)
  PASS  default model   anthropic/claude-sonnet-4-6 (312 available)
  PASS  model auth      anthropic is ready

11 passed, 1 warning, 1 failed
```

Exit code 1, because a row FAILed. `--json` gives the same rows with their
`fix` strings, so CI can print them.

---

## Where things live

Resolution order, used identically by every command:

| Thing | Order |
| --- | --- |
| agent dir | `--agent-dir` → `LASER_AGENT_DIR` → `PI_CODING_AGENT_DIR` → `<data>/agent` |
| session dir | `--session-dir` → `LASER_SESSION_DIR` → `PI_CODING_AGENT_SESSION_DIR` → `<agent>/sessions` |
| state dir | `--state-dir` → `LASER_STATE_DIR` → `<data>/state`, or `<agent>/laser` when the agent dir was overridden |
| subagents root | `--subagents-temp-root` → `LASER_SUBAGENTS_TEMP_ROOT` → `PI_SUBAGENTS_TEMP_ROOT` → `<state>/subagents` |
| port | `--port` → `LASER_PORT` → `41441` |

The subagents root, doctor's `subagents root`/`subagents uids` rows and the
`runs`, `plan` and `missions` commands observe the retired pi-subagents file
layer (D-140): Laser's own agent harness records its runs in
`<state>/agent-runs.json` and nothing writes to that root any more. They are
still present and will be removed by M13-T11.

`<data>` is laser's own directory — `$XDG_DATA_HOME/laser` (usually
`~/.local/share/laser`) on Linux, `~/Library/Application Support/laser` on
macOS, `%LOCALAPPDATA%\laser` on Windows. It is **not** the agent's. If you
already run the underlying agent from a terminal, its `~/.pi/agent` is never
opened and never written: uninstalling laser cannot damage it, and it cannot
break laser. `LASER_AGENT_DIR` (or `--agent-dir`) is the lever if you
genuinely want both to share one directory.

The app resolves the same directories from the same function, so a terminal and
the window always agree about which sessions exist.

An overridden agent directory gets its own state directory, so
`laser up --agent-dir /tmp/sandbox` can never adopt or stop the host serving
your real one.

In the state directory:

- `host.json` — the running host's pid, port and directories. Advisory: "is it
  running" is always decided by `GET /healthz`, so a record left by a crash is
  cleaned up rather than believed.
- `host.log` — the detached host's output. `laser status` prints its tail when
  the host is unreachable.
- `cli-recent-sessions.json` — the last session started per project. Pi writes a
  session file lazily, so a session created a second ago is not in the catalog
  yet; this is how `laser new && laser send …` finds it.
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
laser completions bash > /etc/bash_completion.d/laser
laser completions zsh  > "${fpath[1]}/_laser"   # then: compinit
laser completions fish > ~/.config/fish/completions/laser.fish
```

They are generated from the same table that generates `--help`, so a new command
completes the day it exists.

---

## Design notes

- **No dependency budget.** The parser, the colour helper, the table renderer,
  the completion generators and the QR encoder (`src/qr.ts`, pinned against an
  independent implementation in `test/qr.test.ts`) are all in this package.
  `ws` is the only third-party runtime dependency, and it is the one the host
  already uses; `@lasercode/crypto` is a workspace package, and the pairing
  handshake lives there rather than being reimplemented here.
- **One description per command.** `Command` in `src/command.ts` drives parsing,
  `--help`, completions and dispatch. There is nowhere for them to disagree.
- **No second path into a session.** Session verbs speak the same WebSocket
  JSON-RPC the app speaks, so the CLI can never do something the app cannot see.
- **Agent output is data.** Everything printed from a transcript, a tool result
  or an extension goes through `sanitize()` first: no escape sequence from an
  agent reaches your terminal. It is AGENTS.md invariant 9, applied to stdout.
- **This package never imports the engine.** Diagnostics resolve its bundled
  executable through `@lasercode/worker`; it is not a product command.

## Development

```bash
pnpm -F @lasercode/cli build
pnpm -F @lasercode/cli test
node packages/cli/dist/main.js --help      # without installing the bin
```
