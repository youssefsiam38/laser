# STATUS.md — one screen, always current

Regenerated at the end of every work session from `STATUS_DETAILED.md`.
Rules in `AGENTS.md` §3.5. No dates or estimates here except "Last updated".

**Last updated:** 2026-09-05 · claude-2026-09-05-e · commit: `6c2a029`

**Current focus:** Wave 3's review findings are applied — `pnpm -r build`,
`-r typecheck` and `-r test` all exit 0 with **688 tests**. Two real defects
in the seq/resume layer are fixed and covered: a restarted worker's epoch was
undetectable (`replayFloor` never capped at the worker's own seq), and a
healthy reconnect rewound the dedupe watermark because `onResume` read live
state after the replay had been flushed. On the surfaces: Enter no longer
grants on any approval, the thinking control offers only the levels the
session's model accepts, overflowed islands are `inert` rather than merely
invisible, OS reduced motion now reaches the motion tokens, and there is one
loading vocabulary and one context ring. `DESIGN.md` is now the *shape* and
`docs/ux-theme.md` the *values* (D-33); the phone's two-instance island is a
recorded exception (D-34).

**Wave 3 has now been looked at in a browser** (sandbox, 1440px and 375px,
both themes). The theme system holds end to end: a cleared profile lands on
graphite dark with Inter, Appearance carries every control the contract names,
a preset change applies live with no reload and reaches the app behind the
panel, the light theme is clean, and the phone width has no overflow and
nothing under 12px. Zero console errors. Two suspected defects were chased
and both were artifacts of this session rather than bugs: a dark-on-dark row
was a mid-transition frame, and the "a new version is ready" prompt was a real
leftover worker from rebuilding mid-session — two settled loads show neither.
T1 holds: no hex, `oklch()` or raw px font size survives outside the palette.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | in-progress | T1–T7 done; T8 CI blocked on GitHub billing (not code) |
| M1 Local loop | done | assistant-ui rebuild included |
| MP Panel system | done | the contract in `docs/ux-panels.md` is implemented and everything draws through it |
| M2 Many sessions, many projects | in-progress | T1–T4, T6 done; T5 needs a real desktop session to fire a notification |
| M3 Subagent tabs | in-progress | T1–T3, T5–T8 done; T4 resume needs a live bus; T9 upstream PRs unfiled |
| M4 Settings and logs | in-progress | T1–T6 done; T7 trust and keyboard views shipped read-only, rebinding needs `pi/keybindings/*` |
| M5 Desktop shell | in-progress | T1–T3 done and proven on this machine; T4/T5 need macOS, Windows and credentials |
| M6 Relay and pairing | done | channel id via subprotocol (D-21); rotation deferred (D-22) |
| M7 Mobile PWA | in-progress | T1–T4 done; T5 push and T6 mic complete in code, unproven without a phone |
| M8 Package support | in-progress | T1, T3–T5 done; T2 dictation wired but this machine has only OAuth providers |
| M9 CLI | in-progress | T1–T8 done, `relay` proven end to end against a real relay |
| M11 Theme system | in-progress | T1–T5, T7, T8 done; T6 blocked on a host-owned preference channel |
| MX Cross-cutting | in-progress | T6 element inventory done; seam green; pin 0.85.0; upstream patches written, none filed |

## Blockers

- **M11-T6 themes persist**: `pi/settings/set` refuses any key the pinned Pi does not define, and there is no host-owned preference channel. Needs `pi/prefs/get|set` (protocol first). The theme lives in `localStorage` today.
- **M4-T7 keybindings**: rebinding needs `pi/keybindings/get|set` over Pi's own `KeybindingsManager`. The view ships read-only and says so rather than offering a dead control.
- **Stopped run / speaker identity**: both components are finished and mounted but can never render — no session update carries a stop reason or a child-run speaker. Protocol first.
- M0-T8 CI: GitHub Actions refused to start (account billing). `pnpm verify` locally.
- M7-T5 push: needs `HostRelayOptions.publicOrigin`; nothing sets it, so a notification's link points at loopback.
- M8-T2 dictation: needs a platform OpenAI API key; every provider signed in here is OAuth-backed.

## Next up (dependencies satisfied)

1. **M10 self-contained distribution** — the one-command install, every Linux package format, the bundled runtime and agent proven on a machine with nothing on it, and packages installed from Settings.
2. **The three protocol gaps that already have finished UI waiting**: a stop reason and per-turn usage on `message_end`, a child-run speaker, and `pi/prefs/*` for M11-T6.
3. `pi/commands/list`, `pi/project/files`, `pi/prompts/list` — the composer's `/` and `@` popovers and the prompt library are built and adapter-shaped for them.
4. A real phone and a real desktop session: push delivery, dictation end to end, and a transcript exercised against a live provider — the sandbox has no credentials, so no message, tool row or run island has been seen with real content.

## Recently done

- **Wave 3 integration** — twelve adopted-but-unmounted elements wired, eight homeless ones deleted with the reason in their inventory row, one styling pass across the whole UI. Evidence: 686 tests, exit 0.
- **The theme system made live** (M11-T1, M11-T8) — `globals.css` now carries the compiled default preset and no stale `.dark` palette; the type scale, both font stacks and the float shadows resolve through `var()` at runtime instead of being baked into the utilities; Inter and JetBrains Mono finally have `@font-face` rules, so the documented defaults load.
- **Three silent defects fixed** — regenerate and fork-with-edit were dead on every message (a raw NUL byte in `messages.tsx` split on a separator the writer never wrote); `piorbit settings` hung for two minutes against any untrusted directory and now says what to run; a ring's percentage could draw below the 12px floor.
- **M9-T7 `piorbit relay`** — pair / devices / revoke proven end to end against a real relay, including the six-emoji SAS and a from-scratch QR encoder checked module-for-module against `qrcode@1.5.4`.
- **M11-T4 Settings → Appearance** — presets, hues, fonts, text size, density, corners, contrast, motion and a token editor with a live contrast readout per row. Verified in a browser: live, instant, no reload.
- **pi-gpt-transcribe 0.3.0 / 0.3.1 / 0.4.0 released** and the worker pinned to `v0.4.0` (D-32) — the package now publishes its terminal-free core, so the dictation config is parsed once, by its owner, instead of twice.
