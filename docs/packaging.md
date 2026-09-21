# Packaged builds and running generations

Rules learned from shipped failures. Each one escaped a local green check.

## Executable dependency source in packaged builds

**Problem:** a dependency's `.ts` files are not necessarily development files.
Pi extensions may export TypeScript directly and Pi's resource loader transpiles
it at runtime. A broad electron-builder exclusion removed `pi-subagents/index.ts`
and its `src/**/*.ts`; Electron launched and Pi's compiled core imported, but
every new/opened session failed, leaving the new chat model picker unavailable.
`asarUnpack` cannot restore a file excluded by `files`.

**Fix:** preserve executable dependency source in `node_modules`. Read the
package's `exports`, `files` and Pi manifest before excluding an extension or
file type. Never classify code as disposable solely from its extension.

**Prevention:** every new or bumped curated feature must be tested from
`packages/desktop/out/*-unpacked` with the bundled Node and an empty `PATH`.
The clean-machine gate must open a real session with all default features and
exercise a capability reached only after session creation (currently the model
list). Checking that files exist, that `require.resolve` succeeds, or that Pi's
compiled top-level module imports is insufficient. The distribution must also
carry the project's legal files; the same packaged gate verifies them.

Packaged probes must explicitly isolate the product home, state and agent
directories as well as `HOME`/XDG paths; inherited state pins can otherwise adopt
the person's installed host. Adoption refreshes that host's environment even
without UI interaction. Use the shared isolated harness, verify the selected
host record before connecting, and never stop a host a probe did not start.

## A running service is not the installed version

**Problem:** replacing package files left a 0.2.0 host running beneath 0.2.4
files. New UI quota refresh reached its old in-memory protocol and returned
`unknown method pi/account-usage/refresh`. Reading package.json on disk cannot
prove the running process has the new code.

**Prevention:** check `host.json`'s recorded `cliVersion` before desktop adoption.
Never silently attach different versions or kill a shared service to upgrade it.
Explain full quit (including tray) after finishing work. Test new public methods
through a real host and built worker, not only worker dispatch. Quota credential
failures must leave loading and remain retryable without leaking auth details.

**Native update regression:** this machine also retained an Electron 0.2.5 main
around a 0.2.9 daemon. Inspect the renderer's `--desktop-env` version as well as
the host record; installed manifests alone prove neither process. Native install
hooks must never signal/restart the host. Publish the atomic completion marker,
let the person choose a full app/host restart, and block spawning or adopting a
different generation. Frontends must handshake their compiled release before
hydration/resume; mismatches block requests and offer a user-chosen view refresh.
Remote refresh must not stop/cancel any host work. Do not promise uninterrupted
agents during a full host restart. Preserve drafts before frontend reload.

An update replaces the running generation, not the protocol. Do not fix UI/host
version skew by teaching new features old request schemas: that hides a broken
process lifecycle and makes every future protocol permanent.
