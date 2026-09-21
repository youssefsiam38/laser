# @lasercode/worker

One process per project directory: the Pi host. This package and
`pi-extension` are the only ones allowed to import Pi, and the Pi version is
pinned here exactly.

- `SessionDriver` is the seam: a real driver over the Pi SDK, and a stub that
  proves the seam stays honest.
- Owns agent execution — child sessions, worktree isolation, parent events,
  the harness bridge handed to the companion extension.
- Speaks `@lasercode/protocol` outward. Nothing above it learns about Pi.
