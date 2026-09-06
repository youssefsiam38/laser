# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-06T04:58:04+03:00 · codex-2026-09-06-release · commit: `04625d7`

**Current focus:** Publish the local-desktop 0.1.0 release. Public HTTPS install,
mandatory offline provenance, maintainer signatures, real Linux packages and
signed APT/DNF feeds are locally proved. Phone remote control is visibly marked
Soon and tracked as M7-T7 (D-59).

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | in-progress | T1–T7 done; public-repo CI proof pending |
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
| M10 Distribution | in-progress | 0.1.0 publish and public native-feed verification remain |
| M11 Theme system | in-progress | T5 needs a cold-start network trace |
| MX Cross-cutting | in-progress | seam and identity gates green; Pi pin 0.85.0 |

## Blockers

- M5-T1: final manual click check of the native-frame Wayland build.
- M5-T5: macOS/Windows packaging needs those platforms and signing credentials.
- M7-T5: `HostRelayOptions.publicOrigin` is not configured.
- M8-T2: no usable key-based provider for a real transcription.

## Next up

1. Commit, publish the repository, enable GitHub Pages, and tag `v0.1.0`.
2. Verify the public release, signed APT/DNF feeds and exact install command.
3. Deploy the website with visible Soon flags for phone remote control.

## Recently done

- `pnpm verify`: 807 tests plus all builds and typechecks pass.
- Real x64 AppImage/deb/rpm/tar build passed the clean-machine gate.
- Signed APT feed selected Laser 0.1.0; RPM and DNF metadata signatures verified.
- Installer suite: 76 passed, 0 failed; native package is the default.
- Full-history secret scans: application 44 commits, website 6, zero findings.
