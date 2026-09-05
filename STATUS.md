# STATUS.md — one screen, always current

Regenerated at the end of every work session from `STATUS_DETAILED.md`.
Rules in `AGENTS.md` §3.5. No dates or estimates here except "Last updated".

**Last updated:** 2026-09-05 · claude-2026-09-05-review4 · commit: `2329142`

**Current focus:** M10 reviewed three ways — clean machine, supply chain,
first five minutes — and the findings applied. `pnpm -r build`, `-r typecheck`
and `-r test` exit 0 with **760 tests**; `scripts/release/verify-install.sh`
now runs **63** installer assertions. The workspace is at **0.1.0**, one
version everywhere, enforced by `scripts/release/publish.sh`.

The review found one thing that made the headline claim false: `install.sh`
preferred electron-builder's `AppRun` over piorbit's own launcher, so on an
*installed* copy the launcher's `--no-sandbox` strip could never fire. piorbit
started unsandboxed with no message, and `piorbit doctor` opened a window
instead of printing a diagnosis. The installer now points at the launcher in
every format (D-43), and the fixture in `verify-install.sh` grew the shape a
real AppDir has, so the assertions test what ships.

Trust got stricter rather than more talkative. Build provenance is now
**required**: a release with none is refused unless the person types
`--allow-unattested`, the verify call names the release workflow rather than
accepting any workflow in the repository, and an old `gh` is a refusal instead
of a silent pass (D-42). Every action in the release workflow is pinned to a
commit SHA, and no `${{ }}` reaches a `run:` block.

Three holes closed around installing extensions: the bundled npm is found
beside the runtime whether the shell or a terminal `piorbit up` started the
host, a packaged build never reaches for the machine's own npm, and every
install runs with `--strict-allow-scripts` so a stranger's `postinstall` fails
by name instead of running (D-44). The `sha512` Settings prints is now one that
was actually checked against what npm installed (D-45).

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | in-progress | T1–T7 done; T8 CI blocked on GitHub billing (not code) |
| M1 Local loop | done | assistant-ui rebuild included |
| MP Panel system | done | the contract in `docs/ux-panels.md` is implemented and everything draws through it |
| M2 Many sessions, many projects | in-progress | T1–T4, T6 done; T5 needs a real desktop session to fire a notification |
| M3 Subagent tabs | in-progress | T1–T3, T5–T8 done; T4 resume needs a live bus; T9 upstream PRs unfiled |
| M4 Settings and logs | done | T7 closed: keybindings are editable through `pi/keybindings/*` |
| M5 Desktop shell | in-progress | T1–T3 done and proven on this machine; T4/T5 need macOS, Windows and credentials |
| M6 Relay and pairing | done | channel id via subprotocol (D-21); rotation deferred (D-22) |
| M7 Mobile PWA | in-progress | T1–T4 done; T5 push and T6 mic complete in code, unproven without a phone |
| M8 Package support | in-progress | T1, T3–T5 done; T2 dictation wired but this machine has only OAuth providers |
| M9 CLI | in-progress | T1–T8 done, `relay` proven end to end against a real relay |
| M10 Self-contained distribution | in-progress | **T1–T8 done, walked end to end, and reviewed three ways (D-42..D-47).** T9/T10 are updating, deliberately staged (D-31, D-35) |
| M11 Theme system | in-progress | T1–T4, T6–T8 done; T5 needs a network trace to close |
| MX Cross-cutting | in-progress | T6 done; **T7 now gates distribution** (see Blockers); seam green; pin 0.85.0 |

## Blockers

- **MX-T7 gates the first release, and nothing else does.** D-36 says the
  product may be renamed. `appId`, the `piorbit://` scheme, the data directory
  and every storage key are free today and stop being free the moment somebody
  installs a build — `appId` keys macOS TCC grants and the update feed's
  identity, so a rename afterwards orphans the install. Tag `v0.1.0` **after**
  one module defines the identity, not before.
- **No release signing key exists yet.** `RELEASE_PUBKEY` is empty on purpose
  (a fake key would turn "not configured" into "verification passed"), so the
  third trust layer is inert until `scripts/release/sign.sh --keygen` is run and
  the printed line is pinned. Provenance (layer 1) is required and carries the
  chain in the meantime.
- **No arm64 hardware here.** Every arm64 artifact is built by config and by
  the release matrix, and none has been run. The build refuses a cross-arch
  build by name rather than producing one that cannot start.
- `.rpm` builds on this machine but has not been installed on a Fedora/RHEL
  box; the deb, AppImage and tarball paths were installed and launched.
- M0-T8 CI: GitHub Actions refused to start (account billing). `pnpm verify`
  and `pnpm verify:install` locally.
- M7-T5 push: needs `HostRelayOptions.publicOrigin`; nothing sets it, so a
  notification's link points at loopback.
- M8-T2 dictation: needs a platform OpenAI API key; every provider signed in
  here is OAuth-backed.
- AppStream screenshots are deliberately absent: they are HTTPS URLs and there
  is no public host. `PIORBIT_SCREENSHOT_BASE_URL` picks them up with no code
  change.

## Next up (dependencies satisfied)

1. **MX-T7 product identity from one module**, then generate a release key,
   pin it in `install.sh`, tag `v0.1.0` and run the release workflow for real —
   the only step of the pipeline never executed is `gh release create`.
2. **Rebuild and re-walk the installed app.** Everything below was fixed in
   source and verified against the *stale* 0.1.0 artifact in
   `packages/desktop/out/`; the packaged asar still carries the old host and UI.
   One `dist:linux` and one install closes that gap.
3. **M10-T10** once the repository (or a releases repository) is public: set
   `publish`, and prove an AppImage self-updates in place. **M10-T9** after it.
4. A real phone and a real desktop session: push delivery, dictation end to
   end, and a transcript against a live provider. The sandbox has no
   credentials, so no message, tool row or run island has been seen with real
   content.

## Recently done

- **The installed copy runs piorbit's launcher, not AppRun** (D-43) — proved on
  the real 0.1.0 AppImage: `bin/piorbit`, `Exec=` and `TryExec=` all name
  `app/piorbit`, and `piorbit doctor` prints a diagnosis instead of opening a
  window. That also drops an accidental `bash` requirement and stops AppRun
  rewriting `PATH` and `LD_LIBRARY_PATH` for the agent and everything it spawns.
- **Provenance is required, and bound to this workflow** (D-42) — plus every
  release action pinned to a commit SHA and no `${{ }}` inside a `run:`, so the
  job holding the signing key and the Sigstore token cannot be steered by a
  dispatch input or a moved tag.
- **Extensions install safely and actually install** (D-44, D-45) — the bundled
  npm is found by sibling lookup for a terminal-started host too, a packaged
  build never uses the machine's npm, `--strict-allow-scripts` turns an
  unreviewed install script into a named failure, and a recorded `sha512` means
  it was checked against what npm wrote.
- **An interrupted upgrade puts the working version back**, the receipt is
  written the moment the app lands on disk, and `--yes` no longer deletes
  settings, the device identity or any pairing — that is `--purge`, on its own.
- **First run owns the window** (D-47) — one screen with one next step instead
  of four empty states in four vocabularies, skipping asks first, and
  Settings → This device → "Run setup again" is the way back. With no project
  the composer says so and is disabled, rather than swallowing a message that
  can never be sent.
- **The CLI and the window agree about the agent directory** (D-46) — the CLI
  no longer reads `PI_CODING_AGENT_DIR`, which the desktop deliberately strips,
  so `piorbit sessions` and the window can no longer show different sessions to
  the one person who has both installed.
