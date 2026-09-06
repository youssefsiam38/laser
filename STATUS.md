# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-06T05:28:15+03:00 · codex-2026-09-06-release · commit: `a1a1674`

**Current focus:** Laser 0.1.0 is public, stable and Latest. The website follows
the latest stable release; clean CI, the public installer and signed native
update feeds are green. Phone remote control remains visibly marked Soon.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | done | CI passed on a clean public GitHub runner |
| M1 Local loop | done | assistant-ui rebuild included |
| MP Panel system | done | panel contract implemented |
| M2 Many sessions, many projects | in-progress | T5 needs a real notification |
| M3 Subagent tabs | in-progress | T4 live-bus resume and T9 upstream PRs remain |
| M4 Settings and logs | in-progress | T8 “All settings” remains |
| M5 Desktop shell | in-progress | T1 native-frame fix awaits final manual confirmation; other-platform proof remains |
| M6 Relay and pairing | done | cryptographic and relay foundations complete |
| M7 Mobile PWA | in-progress | phone `/link` entry and paired browser transport are Soon |
| M8 Package support | in-progress | dictation lacks a usable API key |
| M9 CLI | in-progress | T1–T8 done; relay CLI proven end to end |
| M10 Distribution | in-progress | 0.1.0 and native OS updates shipped; in-app updater remains T10 |
| M11 Theme system | in-progress | T5 needs a cold-start network trace |
| MX Cross-cutting | in-progress | seam and identity gates green; Pi pin 0.85.0 |

## Blockers

- M5-T1: final manual click check of the native-frame Wayland build.
- M5-T5: macOS/Windows packaging needs those platforms and signing credentials.
- M7-T5: `HostRelayOptions.publicOrigin` is not configured.
- M8-T2: no usable key-based provider for a real transcription.

## Next up

1. Confirm every click target in the running native-frame Linux app.
2. Design and prove the separate in-app updater path (M10-T10).
3. Implement the phone `/link` pairing flow when the Soon feature resumes.

## Recently done

- CI run 34006391926: build, typecheck, all tests and installer verification passed.
- Release run 34005922135: x64, ARM64, publication, provenance and Pages passed.
- v0.1.0 is a stable GitHub Release and the repository's Latest release.
- Public APT and RPM repository signatures verify; APT advertises Laser 0.1.0.
- laser.hubtrix.com installs through the latest-stable release route.
