# Isolated review environment

An isolated Docker environment that builds this checkout from a recorded source
snapshot and runs the resulting production application. It is not tied to any
feature or branch: use it for any change in this repository.

It never uses the installed application's command, process record, home,
credentials or daemon. The checkout is the only host bind mount, and it is
read-only. No Docker socket, host home, agent data, credential store, SSH agent,
host PID namespace or host network is available in the container.

```sh
node scripts/review-env/review.mjs prepare
node scripts/review-env/review.mjs up
```

Open the review app at <http://127.0.0.1:43187>. The first launch has no provider
credentials and no imported sessions; connect a provider through the normal
application settings. A disposable Git repository is available at
`/review/repositories/review-project`; its initial commit supports isolated child
worktree tests. The application is the production build, with no seeded panels
and no simulated state.

If the port is occupied, choose an unused `REVIEW_PORT` for **all** commands, for
example `REVIEW_PORT=49123 node scripts/review-env/review.mjs up`. Nothing stops
the process occupying a port. Only `127.0.0.1` is published. The production host
still binds its own container loopback at port 43188; a container-local TCP
forwarder exposes it at the single published port, preserving HTTP/WebSocket
traffic and explicit origin checking.

## Stop and reset

```sh
# Preserve this environment's configuration, sessions and test work.
node scripts/review-env/review.mjs stop

# Remove only this project's containers, network and named volumes.
node scripts/review-env/review.mjs reset
```

Reset deletes credentials added **inside this environment** and all its
disposable work. It does not remove the checkout or its Git history, the runtime
image, another Compose project, or installed application data. Run `prepare` and
`up` to recreate a fresh environment after reset.

## Build and test

`prepare` records the branch, source commit, whether it is dirty and a SHA-256
digest of every included source path and its content. It copies the tracked and
non-ignored untracked inputs into the private workspace volume. It rejects
credential filenames and symlinks escaping the checkout, excludes the source Git
directory and never follows a worktree's pointer into its original checkout. A
disposable Git index inside the copied workspace makes `pnpm identity:check`
inspect the copied source too.

Dependencies install from the lockfile with Node 24.13.0 / pnpm 10.34.5 into
private volumes; the complete production workspace then builds. The script
refuses to prepare while the app is running. Edits after preparation require a
new `prepare`; `up` compares the current source digest to the completed build
before launching. A failed build removes its completion record.

While edits continue, `up --prepared` explicitly starts the last recorded
snapshot for development inspection. It prints that newer edits are not included,
and the runtime still verifies every prepared artifact tree. Use plain `up` after
the final `prepare`, so current-source matching is required.

```sh
node scripts/review-env/review.mjs stop
node scripts/review-env/review.mjs prepare
node scripts/review-env/review.mjs verify

# One-off commands use the prepared snapshot and isolated environment.
node scripts/review-env/review.mjs run -- pnpm -F @lasercode/host test
node scripts/review-env/review.mjs run -- pnpm -F @lasercode/desktop build

# In a running app, use exec for read-only probes or application interaction.
node scripts/review-env/review.mjs exec -- node -e "console.log(process.env.HOME)"
node scripts/review-env/review.mjs logs
```

## Commands

| Command | What it does |
| --- | --- |
| `prepare` | Build isolated dependencies and the production application |
| `up` | Launch that exact prepared source build |
| `stop` | Stop only this app; retain its data |
| `reset` | Remove only this Compose project's containers, network and volumes |
| `verify` | Run `identity:check` and the complete repository checks in a stopped container |
| `run -- CMD` | Run a one-off command with isolated paths (app must be stopped) |
| `exec -- CMD` | Run a command in the running container |
| `provenance` | Print prepared and running build identity |
| `status` | Show only this project's container status |
| `logs` | Print the last 100 log lines |
| `config` | Print the generated Compose configuration |

## Files

| File | Role |
| --- | --- |
| `Dockerfile` | Digest-pinned Node 24.13.0 image; build tools, headless X and bubblewrap. Every writable path is a private volume under `/review`. |
| `config.mjs` | The Compose document, generated as plain JSON. Read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, one read-only `/source` bind, ten named volumes, loopback-only published port. |
| `review.mjs` | The host-side CLI. Records source provenance and drives Compose. |
| `container.mjs` | The container-side entry point: `prepare`, `check-source`, `verify`, `serve`. Refuses to run outside the environment. |
| `build-record.mjs` | Source and artifact digests, and the build completion marker. |
| `host.mjs` | Starts the production host inside the container and forwards its loopback port. |
| `artifacts.mjs` | Digest of a whole emitted artifact tree, not just its entry file. |
