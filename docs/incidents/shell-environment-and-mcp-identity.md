# Handoff: shell environment loading and MCP client branding

## Summary

**Two distinct defects/limitations were confirmed. Neither has been fixed.**

1. **The agent's Bash tool runs non-interactively (`bash -c`).** It does not normally load `~/.bashrc`. On this machine, even explicitly sourcing `.bashrc` from that tool immediately returns because the file has an interactive-shell guard. The Playwright extension token is exported by interactive Bash but absent from the agent's normal command environment.
2. **The MCP adapter advertises the wrong client identity.** It constructs `pi-mcp-${serverName}` for the MCP initialization handshake. This explains the browser extension's `pi-mcp-playwright` label. It is independent of the shell/environment problem.

A third, confirmed lifecycle behavior explains why reopening the desktop can fail to refresh variables: **the desktop adopts an existing same-version host, and normal Quit leaves an adopted host running.** That host retains its original environment.

The person's latest request is a report for another coding agent, not continued implementation. Resume implementation only under the next owner's instructions.

## Investigation context

- Repository: `/home/youssef/projects/laser`.
- Reviewed source: `67e8a79` on `main`; installed frontend/host reported `0.5.0`.
- Engine dependency: `@earendil-works/pi-coding-agent@0.85.0`.
- MCP dependency: `pi-mcp-adapter@2.33.0`.
- Task: **M14-T8**, investigation owner `env-mcp-01a093aa`.
- Incident observed on Linux, using the installed app under `/opt/Laser`.
- The person tried `source ~/.bashrc` followed by `laser`; it did not fix their experience.

## 1. The agent command shell does not load .bashrc

### Actual execution path

`packages/pi-extension/src/modules/background-work.ts:291–311` builds `createLocalBashOperations(...)`, wraps its output callback, and passes those operations into `createBashToolDefinition(...)`. It does not load a profile or make the shell interactive.

The pinned engine implements the rest:

- `packages/worker/node_modules/@earendil-works/pi-coding-agent/dist/utils/shell.js:12–13`: ordinary Bash receives `args: ["-c"]`.
- `.../dist/utils/shell.js:58–101`: Unix resolution prefers an explicitly configured shell, otherwise `/bin/bash`, then Bash on PATH, then `sh`. It is not automatically the person's interactive terminal shell.
- `.../dist/core/tools/bash.js:50–55`: spawns that shell with the command, supplied/inherited environment, and ignored stdin. No PTY is created.
- `.../dist/utils/shell.js:117–128`: `getShellEnv()` copies `process.env` and augments PATH; it does not source shell startup files.
- `.../dist/core/tools/bash.js:119–140`: session-specific `PI_*` values are added to the spawn environment; this is not general shell-profile loading.

Thus, the normal agent command is effectively:

```sh
/bin/bash -c '<tool command>'
```

Calling it an "interactive shell inside Laser" would be inaccurate. The interactive conversation launches non-interactive command processes.

### Machine-specific .bashrc guard

`/home/youssef/.bashrc:6–9` contains:

```bash
case $- in
    *i*) ;;
      *) return;;
esac
```

The token export is below that guard, at line 214 during this investigation. Consequently, this command **does not load that export** when run inside the normal agent Bash tool:

```bash
source ~/.bashrc
```

Sourcing changes the current shell but does not make it interactive. The guard returns before the export.

### Safe live results

Only presence/absence was printed, never credential values:

| Probe | Result |
| --- | --- |
| Normal agent tool, `$-` | non-interactive |
| Normal agent tool, exported `PLAYWRIGHT_MCP_EXTENSION_TOKEN` | absent |
| Normal agent tool, exported `BASH_ENV` | absent |
| `bash -c 'source ~/.bashrc; …'`, exported token | absent |
| `bash -ic '…'`, exported token | present |

Several other literal `.bashrc` exports were also absent from the tool environment, including `NVM_DIR`, `ANDROID_HOME`, and `NDK_HOME`.

`BASH_ENV` was present inside the interactive-shell probe, but was **not** equal to `~/.bashrc`; its target was not investigated. Do not assume that file's content. The relevant proven fact is that the normal tool process did not inherit `BASH_ENV` at all.

### Bash semantics

The [GNU Bash startup-file manual](https://www.gnu.org/software/bash/manual/html_node/Bash-Startup-Files.html) confirms:

- Interactive non-login Bash reads `~/.bashrc`.
- Non-interactive Bash normally uses an inherited `BASH_ENV`, not `.bashrc`.
- Login Bash reads login startup files; `bash -lc` does not guarantee `.bashrc` is sourced.

Exporting `BASH_ENV` only inside `.bashrc` cannot bootstrap a process that never reads `.bashrc` and did not inherit that export.

## 2. Desktop restart can retain the old environment

### Actual startup path

- `/usr/bin/laser` resolves to `/opt/Laser/laser`, the generated POSIX launcher.
- Source template: `packages/desktop/build/linux/launcher.sh.tpl`.
- Bare `laser` ultimately executes `laser-bin`; CLI verbs execute bundled Node and the CLI entry. No shell-profile import was found in the launcher.
- `packages/desktop/src/main.ts:70,181`: captures `desktopEnv(process.env)` and passes it as the host's base environment.
- `packages/desktop/src/host-process.ts:400–424`: derives the spawned host environment from that base. It removes `ELECTRON_*` and `NODE_OPTIONS`; it does not deliberately remove ordinary token variables.
- `packages/host/src/worker-client.ts:76–82`: the worker inherits the host's `process.env` plus explicit overrides.
- `packages/cli/src/host-control.ts:67–87`: CLI startup also reuses an existing host; only a newly spawned daemon inherits the invoking process's environment.

### Confirmed adoption behavior

`packages/desktop/src/host-process.ts:128–155` attaches to an already-running same-version host instead of spawning one. No environment update accompanies that attachment.

`packages/desktop/src/host-process.ts:367–374` defaults `stop(includeAttached = false)`. With no owned child, it stops an adopted host only when explicitly asked.

`packages/desktop/src/main.ts:394–410` calls:

```ts
await host.stop(options.relaunch || options.install);
```

Normal Quit therefore does not necessarily stop an adopted host; explicit relaunch/install follows a different path.

### Machine evidence

Host record: `/home/youssef/.local/share/lasercode/state/host.json`.

- Host PID **2650511**, started **2026-09-12T03:25:57.832Z**, version **0.5.0**.
- Desktop PID **2665281**, started later; its renderer also reported **0.5.0**.
- Project worker PID **2663159** was a child of the older host.

The desktop log contains:

```text
2026-09-12T03:27:21.631Z attached to the host already running ... (pid 2650511)
2026-09-12T03:32:41.601Z quitting
2026-09-12T03:32:46.604Z attached to the host already running ... (pid 2650511)
```

The old host and worker lacked the token in their `/proc/<pid>/environ` snapshots, and the real command-tool probe confirmed it was unavailable to commands.

**Important uncertainty:** `/proc/<pid>/environ` is a startup-environment observation, not a reliable view of every later `setenv`/shell export. We did not instrument the person's exact terminal command at launch. Do not claim to have proved why their newly launched desktop itself lacked the token, or that they failed to source the file. What is proved is host reuse and a missing token in the actual tool execution path.

The previous advice, "quit including the tray, source .bashrc, run laser", was incomplete: an adopted host can survive normal Quit.

## 3. MCP inherits an environment; it does not read .bashrc

`packages/worker/src/mcp/adapter-config.ts:76–83` maps configured stdio environment values and preserves `inheritEnv: false` when explicitly requested.

`packages/worker/node_modules/pi-mcp-adapter/server-manager.ts:1742–1761` implements `resolveEnv()`:

1. Copy the adapter process environment when inheritance is enabled (default).
2. Overlay explicitly configured server environment values.
3. Respect disabled inheritance.

Therefore, missing shell exports upstream can affect both command tools and stdio MCP servers. **Changing only the Bash tool to `bash -ic` would not update its parent worker or separately spawned MCP servers.** Child environment changes cannot propagate upward.

We did not inspect the person's actual resolved Playwright server configuration/secrets, and did not prove whether a server-specific override or `inheritEnv: false` contributes. Check those using names and booleans only.

There is no evidence that an MCP initialize request itself is responsible for losing environment variables. The initialization defect below concerns only client identity.

## 4. Wrong MCP client branding

`packages/worker/node_modules/pi-mcp-adapter/server-manager.ts:1087–1094` constructs:

```ts
client = new Client(
  { name: `pi-mcp-${serverName}`, version: "1.0.0" },
  // ...
);
```

The screenshot says `pi-mcp-playwright` because the client identifies itself that way. It is **client identity**, not necessarily the configured server name. Renaming the UI row will not fix this correctly.

The same manager is used across transports; this is not a Playwright-specific problem.

Other outgoing engine-branded identities found:

- `mcp-auth-flow.ts:301`: OAuth discovery's initialize body uses `pi-mcp-adapter` / `2.11.0`.
- `mcp-probe.ts:29`: legacy probe initialize uses `pi-mcp-probe` / `2.1.2`.
- `mcp-oauth-provider.ts:387,403`: dynamic registration uses a configurable OAuth `clientName` or its default. The current Laser mapping does not set `clientName`.

Relevant integration seams:

- `packages/worker/src/mcp/engine.ts`: loads the pinned adapter through jiti; exposes its factory, manager, and auth functions.
- `packages/worker/src/mcp/session.ts:58`: creates the session adapter from in-memory config.
- `packages/worker/src/mcp/inspector.ts:90–99`: constructs the standalone inspector manager.
- Upstream `init.ts:148`: constructs the session manager.
- Upstream `types.ts:669–672`: current factory options expose config/configPath, no client-identity option.
- `packages/protocol/src/identity.ts` and `product.json`: product identity must derive from these, not new hard-coded `laser` strings.

A durable fix must cover inspector and session clients, authentication/probe paths, and future configured servers—not string-replace just `pi-mcp-playwright`. Preserve server-owned names, protocol namespaces, dependency names, and upstream legal attribution.

## 5. Suggested implementation and regression plan (not implemented)

### Environment

1. Define the product contract: exported shell environment versus interactive shell features (aliases/functions/job control). The reported need is exported variables.
2. Prefer bounded environment resolution at an appropriate shared startup boundary so command tools **and** stdio MCP servers receive exports. Choose/record shell selection, startup mode, PATH precedence, explicit inherited-variable precedence, and refresh policy.
3. Do not blindly add `-i` to every command: startup scripts can block, prompt, print noise, change command behavior, or execute side effects. A login shell alone is not sufficient either.
4. If considering `BASH_ENV`, test an environment-only file and the interactive guard case; do not modify the person's shell files without consent.
5. Handle an already-running host truthfully. Do not silently kill it or replace live worker environments. A deliberate app/host restart interrupts active work.
6. Preserve explicit MCP environment overrides and `inheritEnv: false`; do not broaden secret exposure for isolated servers.
7. Keep bundled runtime/npm PATH handling in `packages/worker/src/runtime-env.ts` intact.

### Branding

1. Add/use an upstream-compatible programmatic client-identity seam rather than editing installed node_modules in place.
2. Supply product-derived identity from the worker to every relevant factory/manager/auth/probe path.
3. Use a tracked, exact-version pnpm patch or pinned upstream release; document upstream work in `docs/upstream.md`.
4. Verify actual MCP `initialize.params.clientInfo`, and OAuth `client_name`, not only helper strings.

### Required tests

- Real command subprocess with fake HOME and `.bashrc` containing the standard early-return guard.
- Ordinary foreground, explicit background, and promoted commands; cancellation/process-tree cleanup unchanged.
- Noisy, failing, hanging startup scripts; bounded output/time; secrets never logged.
- Explicit startup exports and PATH precedence; missing shell; supported platform behavior.
- Existing same-version host adoption: verify unchanged PID/environment and truthful restart handling.
- Real stdio MCP fixture reports only synthetic-variable presence; inheritance enabled/disabled/explicit overrides.
- Inspector and real-session client identities for multiple server names over stdio, Streamable HTTP, and SSE; auth/probe identities too.
- Packaged clean-machine gate using bundled Node and empty PATH, without user credentials.

Existing relevant suites: `packages/pi-extension/test/background-work.test.ts`, `packages/desktop/test/host-compatibility.test.ts`, `packages/worker/test/mcp/{inspector,stable-sdk.mcp,adapter-config,oauth,worker-start}.test.ts`, `packages/worker/test/runtime-env.test.ts`. Host adoption/environment behavior may need additional dedicated process tests.

## 6. Repository and safety handoff

- **No application source, dependency pin, shell file, installed file, or server configuration was changed.** No host/worker was stopped. No release/build/fix was claimed.
- Planning files were updated to claim M14-T8 and record D-226; this report and the status/handoff complete the investigation.
- `pnpm patch pi-mcp-adapter@2.33.0 --edit-dir /tmp/mcp-identity-patch` prepared an **unedited** temporary package copy. No patch was committed/applied; no install was run afterward. Ignore/remove only this owned scratch copy when appropriate.
- The repository already had many user-owned deletions under `docs/agents-leap/`, plus untracked `.laser/`, `RELEASE_NOTES.md`, screenshots, `temp.md`, and `todo.md`. Preserve them. Do not commit/stage unrelated work.
- The Playwright extension token is visible in the person's screenshot. Do not reproduce it. Recommend regeneration after the investigation; never include it in this report, tests, commits, command arguments, or logs.
- Development changes will not update the running installed `/opt/Laser` generation. Final acceptance must distinguish source tests from installed behavior and obtain permission before a restart that could stop agents.
