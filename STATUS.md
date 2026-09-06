# STATUS.md — one screen, always current

Regenerated at the end of every work session from `STATUS_DETAILED.md`.
Rules in `AGENTS.md` §3.5. No dates or estimates here except "Last updated".

**Last updated:** 2026-09-06 · claude-2026-09-06-display · commit: `f3639b2`

**Current focus:** the desktop window is unusable on the maintainer's machine
and the cause is **not established**. Buttons are not clickable, or clickable
only across part of their area, and the cursor does not become a pointer. The
same page in an ordinary browser tab behaves correctly. Two fixes were shipped
this session on two different theories; the symptom survived both. Read
`HANDOFF.md` (untracked, in the repository root) before touching this: it holds
every measurement taken, what they rule out, the seven questions left open, the
web sources already read, and the scripts left in the scratchpad.

One of the two fixes was a **real, separately verified bug**: the preload script
failed to load with `module not found: ./ipc.generated.cjs`, because a sandboxed
preload's `require` resolves only `electron` and a few Node builtins. Electron
loaded the page anyway, so the window had no bridge on it and every
desktop-backed control did nothing (D-54). The channel table is now written into
the preload by `pnpm identity:generate`, and two tests hold it — one forbidding
any runtime specifier but `electron`, one launching the real binary and
asserting the bridge is on `window`. That fix is sound. It did not resolve the
reported symptom.

The other fix (D-53) rested on a stale-frame theory that the evidence does not
support; its software-compositing fallback was **removed** in D-55 rather than
left in to cost hardware acceleration. What remains from it is
`ozone-platform-hint=auto`, Chromium's `WaylandLinuxDrmSyncobj` feature, and a
log line naming the GPU and whether the compositor offers explicit sync.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | in-progress | T1–T7 done; T8 CI blocked on GitHub billing (not code) |
| M1 Local loop | done | assistant-ui rebuild included |
| MP Panel system | done | the contract in `docs/ux-panels.md` is implemented and everything draws through it |
| M2 Many sessions, many projects | in-progress | T1–T4, T6 done; T5 needs a real desktop session to fire a notification |
| M3 Subagent tabs | in-progress | T1–T3, T5–T8 done; T4 resume needs a live bus; T9 upstream PRs unfiled |
| M4 Settings and logs | in-progress | T1–T7 done; **T8 todo**: "All settings" still reads as the agent's `settings.json` with labels |
| M5 Desktop shell | **blocked in practice** | T1–T3 built and the bridge is proven by test, but the window is unusable on the one machine it has been tried on; T4/T5 need macOS, Windows and credentials |
| M6 Relay and pairing | done | channel id via subprotocol (D-21); rotation deferred (D-22) |
| M7 Mobile PWA | in-progress | T1–T4 done; T5 push and T6 mic complete in code, unproven without a phone |
| M8 Package support | in-progress | T1, T3–T5 done; T2 dictation wired but this machine has only OAuth providers |
| M9 CLI | in-progress | T1–T8 done, `relay` proven end to end against a real relay |
| M10 Self-contained distribution | in-progress | T1–T8 done and reviewed (D-42..D-47, D-50); x64 artifacts rebuilt with the preload fix but **never installed or launched**. T9/T10 staged (D-31, D-35) |
| M11 Theme system | in-progress | T1–T4, T6–T8 done; T5 needs a network trace to close |
| MX Cross-cutting | in-progress | T6, T7 done; the identity check is a real gate (D-50, and now D-54's inlined block); seam green; pin 0.85.0 |

## Blockers

- **The desktop window is unusable and the cause is unknown.** This gates any
  claim that the product works. `HANDOFF.md` is the entry point. Nobody has yet
  tried `--ozone-platform=x11` by hand, checked whether the frameless window's
  input region and geometry origin agree with the renderer's coordinate space,
  or run the packaged build.
- **The packaged app has never been launched as an app.** The install path
  itself is now proven against today's x64 artifacts: `verify-install.sh
  --release` passes 44 checks with none failing, the packaged `preload.cjs`
  inside `app.asar` requires only `electron` and carries the inlined channel
  table, and the Wayland probe runs from inside the archive under the packaged
  binary. What has not happened is starting the installed app: it binds port
  41441 and would collide with the running development host.
- **No release signing key exists yet.** `RELEASE_PUBKEY` is empty on purpose;
  provenance (layer 1) is required meanwhile.
- **No arm64 hardware here.** `dist:linux` refuses to cross-build arm64 by
  design, because only the x64 keychain binding is installed.
- `.rpm` builds here but has not been installed on a Fedora/RHEL box.
- M0-T8 CI: GitHub Actions refused to start (account billing). `pnpm verify`
  and `pnpm verify:install` locally.
- M7-T5 push: needs `HostRelayOptions.publicOrigin`; nothing sets it.
- M8-T2 dictation: needs a platform OpenAI API key; only OAuth providers here,
  and the one key-based provider has no credit left.
- AppStream screenshots deliberately absent: no public HTTPS host yet.

## Next up (dependencies satisfied)

1. **Establish why the window is unusable.** Everything else is downstream of
   this. Start at `HANDOFF.md` §"Open, unexplained".
2. **Launch the installed app** (the only distribution step left; the install
   path, the packaged preload and the packaged Wayland probe are all verified).
   It needs the development host stopped first, or a free port.
3. **M4-T8**: rewrite "All settings" for a person. It is the one screen that
   still requires knowing which agent runs underneath: raw key names under every
   label, sections named for the file rather than the job, free-text provider and
   model boxes beside pickers that already exist.
4. **Generate a release key, pin it, tag `v0.1.0`.** The only step never
   executed is `gh release create`.
5. **M10-T10** once the repository is public: set `publish`, prove an AppImage
   self-updates in place. **M10-T9** after it.

## Recently done

- **The bridge reaches the window** (D-54) — a sandboxed preload cannot require
  a sibling file; the channel table is generated into the preload, and a smoke
  test launches the real binary to prove the bridge arrives. Verified by
  reintroducing the bad require and watching the test fail.
- **The stale-frame fallback removed, the GPU log made honest** (D-55) — no
  software compositing anywhere; `getGPUFeatureStatus()` is read on
  `gpu-info-update`, not at ready, where every feature reads `disabled_software`
  before Chromium has decided.
- **A dark desktop opens a dark window; Chromium state pinned** (`35a1b10`).
- **The wire namespace renamed before anything shipped** (D-52).
- **One module defines the product's identity** (MX-T7, D-48).
