# STATUS.md — one screen, always current

Regenerated at the end of every work session from `STATUS_DETAILED.md`.
Rules in `AGENTS.md` §3.5. No dates or estimates here except "Last updated".

**Last updated:** 2026-09-06 · claude-2026-09-06-display · commit: `35a1b10` (working tree ahead: D-53)

**Current focus:** the desktop on real Linux hardware. The "Set up button is
only clickable on its left part" report was not CSS: the page hit-tests
correctly at every point in a plain browser. It was a **stale frame** — on an
NVIDIA GPU with no explicit sync the window shows the layout from a moment ago
while input goes to the current one. This machine cannot sync on either
backend: Ubuntu 24.04 ships Mutter 46.2 with the explicit-sync protocol
deliberately off, and Xwayland 23.2 has none. So the desktop now decides its
display backend on Linux (D-53, `packages/desktop/src/linux-display.ts`):
native Wayland, Chromium's `WaylandLinuxDrmSyncobj` on, and software
compositing only when the session's GPU is NVIDIA and the compositor does not
advertise `wp_linux_drm_syncobj_manager_v1` — asked directly, before Chromium
starts. The log now says what was decided (`display:` and `gpu:` lines).
The user has not yet confirmed the fix on screen.

Earlier this session: a dark desktop opens a dark window (the renderer's
`prefers-color-scheme` answers late; the theme re-resolves), and Chromium's
state is pinned to `~/.config/lasercode` in development runs too.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | in-progress | T1–T7 done; T8 CI blocked on GitHub billing (not code) |
| M1 Local loop | done | assistant-ui rebuild included |
| MP Panel system | done | the contract in `docs/ux-panels.md` is implemented and everything draws through it |
| M2 Many sessions, many projects | in-progress | T1–T4, T6 done; T5 needs a real desktop session to fire a notification |
| M3 Subagent tabs | in-progress | T1–T3, T5–T8 done; T4 resume needs a live bus; T9 upstream PRs unfiled |
| M4 Settings and logs | in-progress | T1–T7 done; T8: "All settings" still reads as Pi's `settings.json` with labels |
| M5 Desktop shell | in-progress | T1–T3 done and proven here; Linux display policy added (D-53); T4/T5 need macOS, Windows and credentials |
| M6 Relay and pairing | done | channel id via subprotocol (D-21); rotation deferred (D-22) |
| M7 Mobile PWA | in-progress | T1–T4 done; T5 push and T6 mic complete in code, unproven without a phone |
| M8 Package support | in-progress | T1, T3–T5 done; T2 dictation wired but this machine has only OAuth providers |
| M9 CLI | in-progress | T1–T8 done, `relay` proven end to end against a real relay |
| M10 Self-contained distribution | in-progress | T1–T8 done and reviewed (D-42..D-47, D-50). T9/T10 are updating, staged (D-31, D-35). Packaged artifacts predate the rename and D-53 |
| M11 Theme system | in-progress | T1–T4, T6–T8 done; T5 needs a network trace to close |
| MX Cross-cutting | in-progress | T6, T7 done; the identity check is a real gate (D-50); seam green; pin 0.85.0 |

## Blockers

- **No release signing key exists yet.** `RELEASE_PUBKEY` is empty on purpose;
  provenance (layer 1) is required meanwhile.
- **No arm64 hardware here.** Every arm64 artifact is built by config only.
- `.rpm` builds here but has not been installed on a Fedora/RHEL box.
- M0-T8 CI: GitHub Actions refused to start (account billing). `pnpm verify`
  and `pnpm verify:install` locally.
- M7-T5 push: needs `HostRelayOptions.publicOrigin`; nothing sets it.
- M8-T2 dictation: needs a platform OpenAI API key; only OAuth providers here.
- AppStream screenshots deliberately absent: no public HTTPS host yet.

## Next up (dependencies satisfied)

1. **Confirm D-53 on screen**, then **rebuild the Linux artifacts** under the
   `laser`/`lasercode` identity (`dist:linux`) and prove in the installed app's
   log that the Wayland probe runs from inside `app.asar` (`display:` line
   present). Then a real `install.sh` on a stripped PATH.
2. **Generate a release key, pin it, tag `v0.1.0`** and run the release
   workflow — the only step never executed is `gh release create`.
3. **App icons from the final mark** and window title aligned with the website.
4. **M4-T8**: rewrite "All settings" for a person.
5. **M10-T10** once the repository is public: set `publish`, prove an AppImage
   self-updates in place. **M10-T9** after it.

## Recently done

- **Stale frames on NVIDIA diagnosed and mitigated** (D-53) — the compositor
  is asked for explicit sync before Chromium starts; software compositing only
  where the bug would show; 59 desktop tests including the wire parser and the
  policy table.
- **A dark desktop opens a dark window; Chromium state pinned** (35a1b10).
- **The wire namespace renamed before anything shipped** (D-52) — `lasercode`,
  `formerNames` emptied, migration code kept and tested.
- **Three reviews applied** (D-49, D-50) — identity check widened; rename
  migration hardened; thirteen product defects fixed; 790 tests.
- **One module defines the product's identity** (MX-T7, D-48) — `product.json`
  is the only place the product is named.
