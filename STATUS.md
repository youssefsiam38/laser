# STATUS.md — one screen, always current

**Last updated:** 2026-09-19T15:20:00+03:00 · orchestrator-2026-09-19 · HEAD: db4cd12f
**Current focus:** M16 — the transcript copies a shipping chat client (D-305): images are references (T89 merged), a page is a count of turns (T90 ready), the list owns the reader's position (T91), the client reads a reference (T92).

| Milestone | State |
| --- | --- |
| M0 Foundation | done |
| M1 Local loop | done |
| MP Panel system | done |
| M2 Many sessions | in-progress |
| M3 Subagent tabs | in-progress |
| M4 Settings and logs | done |
| M5 Desktop shell | in-progress |
| M6 Relay and pairing | done |
| M7 Mobile PWA | in-progress |
| M8 Package support | in-progress |
| M9 CLI | done |
| M10 Distribution | in-progress |
| M11 Theme system | in-progress |
| M12 Product experience | done |
| M13 Agents Leap | in-progress |
| M14 MCP servers | done |
| M15 After MCP release | done |
| M16 Conversation experience | in-progress |
| M17 Coding experience | todo |
| M18 Resource containment | done |
| M19 Runtime recovery/update activation | done |
| MX Cross-cutting | in-progress |

**Blockers:** M16-T92 — main regresses images of 16 KiB or less on reload (the client still reads `image.data`, which T89 emptied). Not shippable to a person until it lands. Terminal worker-session resumption stays unreliable; explicit clean transfers preserve progress.
**In flight:** T90 turn paging ready at `6615d35b` (11 pages to root instead of 20/56); T91 `@legendapp/list` running; producer correction batch C1–C8 and client milestone T92 queued to their owners. Review `run_2d62f39f` on T89: protocol half correct, three consumer blockers.
**Published:** v0.9.2 from `dc7a8979` — CI 35396133026, release 35396492469, 12 assets, Latest, checkpoint `verified`. Two attempts abandoned first on load-only test flakes (host access.e2e timeout, UI image macrotask wait), both now wait for state.
**Next up:** merge T90 → review it → land T91 and T92 → rebuild the person's sandbox on all four → acceptance → 0.9.5. Then M16-T76 final poisoned gate and the `auto-follow-live-edge` thumb-drag threshold on an idle machine.
**Recently done:** T89 images are references (`27cac1cd`, failing page 6,439,755 B → 3,735 B); T88 no page refused for one large record (`63330a5f`, `d4731f18`, `434f249a`, 56 pages to the root of the person's 27 MB session); T87 transcript rebuilt on a virtualizer (`e787e652`); T86 finished mentions (`a8bb8737`); D-304 space ends a mention query (`29ea5361`).

**Published:** v0.9.4 (`6d50a050`) is Latest. Autonomous completion/commits/push authorized; the person performs browser acceptance on a parent-built sandbox before any release. Active history outranks soft cache targets (D-295); MCP forms stay modal (D-296); Agents mutations name their location (D-297); project agent files are trust-gated (D-298); Backspace only deletes (D-299); the mention picker browses the machine (D-300); T82 deferred to 0.9.3 (D-301); the transcript copies a shipping chat client (D-305, superseding D-303).
