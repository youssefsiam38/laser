# @lasercode/pi-goal

A reusable Pi-native durable-goal capability. It preserves the behavior of the
exact-pinned [`@narumitw/pi-goal`](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-goal)
engine and adds a small, stable state reader that hosts can use without reaching
into that package's private source files.

Native Pi hosts can pass `goalExtensionPath()` to Pi's
`additionalExtensionPaths`; Pi's own loader then loads the upstream extension.
Laser adds presentation and remote controls in its companion adapter; none of
that UI is part of this package.

The workspace's exact-version pnpm patch applies three product policies: no
goal budgets, no goal usage collection, and literal objective parsing (quotes,
internal spaces and newlines are task data, not shell syntax). Upstream's
persistence validator still receives neutral zero accounting fields; no session
usage is read or accumulated and these fields never enter the product protocol.
Legacy saved budgets are ignored. The engine's completion tool, turn termination,
pause/resume/wait, compaction and automatic-response safety guards are unchanged.

`test/policy.test.ts` exercises the patched installed dependency directly. When
bumping upstream, port and verify the policy patch explicitly; do not remove it
to make a dependency update pass. Laser projects the actual completion summary
and canonical goal-state history into its chat; this package adds no UI and does
not manufacture a final assistant response.
