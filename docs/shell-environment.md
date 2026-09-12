# Shell environment

On Linux and macOS, desktop startup reads exported variables from your shell
before starting or attaching to the host. It runs `$SHELL` (or `/bin/bash`)
once with `-ilc`: interactive and login. This gets past the usual interactive
guard in `.bashrc` **when your login profile sources `.bashrc`**, as standard
Bash profiles do. If your custom `.bash_profile` does not source it, put exports
in the login profile or source `.bashrc` there. Shells that accept `-ilc`, such
as zsh and fish, follow their own interactive login startup rules. Nushell does
not parse `-ilc`; it falls back to the inherited environment with one generic
log line. Windows keeps its inherited environment.

This imports exports, not aliases, functions, job control or a terminal. Startup
files execute as they do at login, including their side effects. `-l` enables
login and logout files on every app start (for example `.bash_profile` and
`.bash_logout`, or `.zprofile` and `.zlogout`); do not rely on logout hooks
finishing before the resolver collects its subprocesses. Individual commands
remain non-interactive and do not rerun your startup files.

## Precedence and safety

- Shell values overlay inherited values. Missing keys do not delete older values.
- The app's environment namespace, `ELECTRON_*`, `NODE_OPTIONS` and engine data
  and session directory pins cannot be replaced by an imported environment.
- Shell `PATH` wins over inherited `PATH`. Workers still prepend the bundled
  Node/runtime launchers, so bundled commands work on a clean machine.
- Explicit MCP server `env` values override inherited values. With
  `inheritEnv: false`, a server receives only its configured environment and
  the transport's minimal defaults, not your shell exports.
- Startup runs with stdin ignored, app/runtime pins and non-interactive startup
  hooks (`BASH_ENV`, `ENV`) scrubbed. Output is private and bounded to 1 MiB;
  unique markers delimit NUL-separated entries despite startup chatter.
- There is a hard 10-second timeout. Failure, excessive output or timeout keeps
  the current environment and writes one generic log line. Success logs only a
  count and a few known variable **names**. Environment values are never logged
  or persisted by this mechanism.

To disable shell resolution, launch the desktop with
`LASERCODE_RESOLVE_SHELL_ENV=0` in its inherited environment (the product's
`envVar("RESOLVE_SHELL_ENV")` setting). Set this in your desktop/session launcher,
not only inside a startup file that the disabled resolver would have read.

## Already running

Opening the desktop sends its environment to an existing host of the same
version. `laser` / `laser up` started from a terminal sends that terminal's
already-resolved environment when it adopts a host. This uses the existing
local WebSocket origin gate plus a loopback, non-browser restriction; paired
phones and browser renderers cannot update the environment. Refresh is advisory:
if the running host is older or refresh fails, the launcher still attaches and
writes one generic note without restarting the host.

The host stores the overlay **in memory** for future workers and forwards it
privately to live workers. The next command and the next MCP server connection
see it. Running commands and MCP processes keep their original environment:
use **Settings → MCP servers → Reconnect** for an already connected server.

Environment refresh never restarts a host or worker, cancels work, or changes
saved MCP configuration. Reopening the app refreshes exports; it is not a file
watcher. If two local launchers refresh the same host, the last value received
wins for each unprotected key. Both launchers send their full environment: a
terminal or service with a minimal environment can replace a richer `PATH` or
other supplied values for future commands and workers; omitted keys remain.
Removing an export from a profile does not erase
an old value from a live host; explicit server isolation is the way to restrict
what a particular server receives.
