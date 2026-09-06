# Licensing

Laser uses a split license so the product can remain open source while its
reusable integration boundaries stay easy to adopt.

## Laser application

Unless a path is listed below, the source in this repository is licensed under
the GNU Affero General Public License, version 3 only (`AGPL-3.0-only`). The
complete terms are in [`LICENSE`](LICENSE).

The AGPL applies to the desktop application, web interface, host, worker, CLI,
relay, cryptography package, and Laser's Pi adapter. In particular, operating a
modified version over a network does not remove the AGPL source-availability
obligation.

## Reusable packages

These packages are licensed under the Apache License 2.0:

- `packages/protocol/`
- `packages/pi-goal/`

Each package contains its own `LICENSE` file, so its license remains clear when
the package is distributed independently.

## Commercial license

The AGPL-covered parts are also available under a separate commercial license
from the copyright holder. See [`COMMERCIAL.md`](COMMERCIAL.md). The commercial
option does not change the Apache-2.0 license of the reusable packages above.

## Third-party software and metadata

Dependencies and incorporated third-party assets remain under their own
licenses; the package manager's lockfile records the exact dependency graph.
Linux AppStream metadata generated from `product.json` is `CC0-1.0`.

Software licenses do not grant rights to the Laser name or logo. See
[`TRADEMARKS.md`](TRADEMARKS.md).
