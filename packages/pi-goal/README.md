# @lasercode/pi-goal

A reusable Pi-native durable-goal capability. It preserves the behavior of the
exact-pinned [`@narumitw/pi-goal`](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-goal)
engine and adds a small, stable state reader that hosts can use without reaching
into that package's private source files.

Native Pi hosts can pass `goalExtensionPath()` to Pi's
`additionalExtensionPaths`; Pi's own loader then loads the upstream extension.
Laser adds presentation and remote controls in its companion adapter; none of
that UI is part of this package.
