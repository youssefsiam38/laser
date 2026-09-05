# STATUS.md — one screen, always current

Regenerated at the end of every work session from `STATUS_DETAILED.md`.
Rules in `AGENTS.md` §3.5. No dates or estimates here except "Last updated".

**Last updated:** 2026-09-06 · claude-2026-09-06-review5 · commit: `1c1bee2` (working tree ahead)

**Current focus:** three reviews applied — the rename lane, the desktop runtime
lane and a product review of a real install. Nothing code-shaped gates the tag.

The identity check now scans **every name the product has answered to**, the
**JSX text** a person actually reads, and **JSON values**. It used to scan only
today's name and only quoted strings, which meant it reported success on a
half-finished rename and blanked seventeen sentences on the first-run flow, the
sign-in sheet, the trust dialog and the update banner. 24 real strays were found
and fixed — one of which (`appId: "piorbit"` in a test) would have failed
`pnpm -r build` and `pnpm -r test` on the first commit, because the new files
were still untracked and invisible to `git ls-files`.

A rename also can no longer orphan anyone: an **empty** destination directory is
treated as no destination (one `piorbit doctor` before first start used to make
the migration refuse forever), the cross-filesystem copy stages into a sibling
this process owns rather than into the destination, and the **CLI** migrates as
well as the daemon.

The desktop keeps its own Node (D-49). Running the host on the app binary under
`ELECTRON_RUN_AS_NODE` works and would save 121 MB, and is rejected: same
`process.version` with a different `NODE_MODULE_VERSION` (137 vs 149),
pi-subagents resolving its interpreter to whatever `node` is on PATH, and
BoringSSL instead of OpenSSL. No cheap size win was found to move to.

Then the product itself, walked as a first-time person: the Add-project dialog
could be pushed 520px wider than the window by one long path; a failed turn
vanished on reload; a provider's raw JSON was the error message and "Continue"
was its only action; sessions were named `01a07364`; a reload forgot the open
session; a project could only be removed from a terminal; `--yes` turned a
home install into a sudo one. All fixed.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | in-progress | T1–T7 done; T8 CI blocked on GitHub billing (not code) |
| M1 Local loop | done | assistant-ui rebuild included |
| MP Panel system | done | the contract in `docs/ux-panels.md` is implemented and everything draws through it |
| M2 Many sessions, many projects | in-progress | T1–T4, T6 done; T5 needs a real desktop session to fire a notification |
| M3 Subagent tabs | in-progress | T1–T3, T5–T8 done; T4 resume needs a live bus; T9 upstream PRs unfiled |
| M4 Settings and logs | in-progress | T1–T7 done; **T8 added**: "All settings" still reads as Pi's `settings.json` with labels |
| M5 Desktop shell | in-progress | T1–T3 done and proven here; T4/T5 need macOS, Windows and credentials |
| M6 Relay and pairing | done | channel id via subprotocol (D-21); rotation deferred (D-22) |
| M7 Mobile PWA | in-progress | T1–T4 done; T5 push and T6 mic complete in code, unproven without a phone |
| M8 Package support | in-progress | T1, T3–T5 done; T2 dictation wired but this machine has only OAuth providers |
| M9 CLI | in-progress | T1–T8 done, `relay` proven end to end against a real relay |
| M10 Self-contained distribution | in-progress | T1–T8 done and reviewed four ways (D-42..D-47, D-50). T9/T10 are updating, deliberately staged (D-31, D-35) |
| M11 Theme system | in-progress | T1–T4, T6–T8 done; T5 needs a network trace to close |
| MX Cross-cutting | in-progress | T6, T7 done; the identity check is now a real gate (D-50); seam green; pin 0.85.0 |

## Blockers

- **No release signing key exists yet.** `RELEASE_PUBKEY` is empty on purpose
  (a fake key would turn "not configured" into "verification passed"), so the
  third trust layer is inert until `scripts/release/sign.sh --keygen` is run and
  the printed line is pinned. Provenance (layer 1) is required meanwhile.
- **No arm64 hardware here.** Every arm64 artifact is built by config and by
  the release matrix, and none has been run.
- `.rpm` builds here but has not been installed on a Fedora/RHEL box; the deb,
  AppImage and tarball paths were installed and launched.
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

1. **Decide the name, then tag.** One edit to `product.json`, `pnpm
   identity:generate`, and the old name into `formerNames`. The check now fails
   on a half-finished rename instead of passing, so this is safe to do. Then
   generate a release key, pin it in `install.sh`, tag `v0.1.0` and run the
   release workflow — the only step never executed is `gh release create`.
2. **Rebuild and re-install from a fresh artifact.** Every product fix in this
   wave was verified in the browser against the sandbox host; the packaged
   `.tar.gz` in `packages/desktop/out/` predates them. One `dist:linux` and one
   `install.sh --from ./release` closes that gap.
3. **M4-T8**: rewrite "All settings" for a person. It is the one screen that
   still requires knowing which agent runs underneath.
4. **M10-T10** once the repository (or a releases repository) is public: set
   `publish`, and prove an AppImage self-updates in place. **M10-T9** after it.
5. A real phone and a real desktop session: push delivery, dictation end to
   end, and a transcript against a live provider. No message, tool row or run
   island has been seen with real provider content.

## Recently done

- **Three reviews applied** (D-49, D-50) — the identity check widened to former
  names, JSX text and JSON values (24 strays, one a build-breaker); the rename
  migration hardened against a `doctor`-created empty directory and against a
  half-copied tree; the CLI migrates too; `ELECTRON_RUN_AS_NODE` rejected with
  measurements; and thirteen product defects fixed. 790 tests, `verify-install.sh`
  74/0.
- **One module defines the product's identity** (MX-T7, D-48) — `product.json`
  is the only place the product is named, sixteen files derive from it, and
  `pnpm identity:check` fails `pnpm -r build` and `pnpm -r test` on drift.
- **A rename cannot orphan anyone's data.** The host moves a former name's
  directories on start, the browser moves its storage keys on boot without ever
  throwing, and the desktop adopts a keychain entry from a former service name.
- **The installed copy runs piorbit's launcher, not AppRun** (D-43) — proved on
  the real 0.1.0 AppImage.
- **First run owns the window** (D-47) — one screen with one next step, and the
  finish line is now the same card as every other step rather than a second
  three-page tour about a screen you cannot see yet.
