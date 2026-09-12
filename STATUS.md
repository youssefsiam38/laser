# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-12T03:45:56Z · env-mcp-01a093aa · HEAD: 67e8a79

**Current focus:** v0.5.1 is public (files and images in the bubble, honest session opening, shell environment reaching the agent, MCP clients identifying as the product). No work in flight. Follow-ups recorded: profile long-transcript teardown on session switch; composer queue-until-ready needs destination-owned drafts; images as real `image` parts; saved-history search vs attached file bodies; file the adapter identity patch upstream.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | done | clean public CI verified |
| M1 Local loop | done | assistant-ui runtime |
| MP Panel system | dropped | replaced by fleet, D-147 |
| M2 Many sessions | in-progress | broader notification platform proof |
| M3 Subagent tabs | in-progress | superseded in substance by M13 |
| M4 Settings and logs | done | settings complete |
| M5 Desktop shell | in-progress | broader platform proof |
| M6 Relay and pairing | done | cryptographic foundations |
| M7 Mobile PWA | in-progress | remote control visibly Soon |
| M8 Package support | in-progress | real-device dictation proof |
| M9 CLI | done | planned tasks complete |
| M10 Distribution | in-progress | in-app updater seam |
| M11 Theme system | in-progress | cold-start network trace |
| M12 Product experience | done | 0.2.13 dispatched |
| M13 Agents Leap | in-progress | T117 parked |
| M14 MCP servers | in-progress | 0.4.0 public; T8 handed off |
| M15 After MCP release | done | 0.5.0 public |
| MX Cross-cutting | in-progress | engine 0.85.0; identity/seam gates |

## Blockers

None recorded. M14-T8 is unfixed; the person requested report-only handoff.

## Next up

1. Continue M14-T8 from H-11 when the next owner takes implementation.
2. M13-T117: land `chat-memory-fallback` (7d121ef) in a later release.
3. Remaining platform proofs and M14 follow-ups in `docs/mcp.md`.

## Recently done

- M15-T6: v0.5.0 public, 12 assets verified; GitHub release `v0.5.0`.
- M14-T7: v0.4.0 public, digests/provenance/notes verified.
- M15-T3: `b29843e`; fallback chains, worker 625/protocol 101 tests.
- M15-T1: `2e8a485`; file card/viewer, UI 1255 tests.
- M14-T3: `763dd52` + `0bb1a46`; MCP Settings, settings suites 116.
