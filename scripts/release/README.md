# Cutting a release

The release scripts below are the workflow's entire implementation.
`.github/workflows/release.yml` runs exactly these and nothing
else, so a release never depends on CI being available — it only depends on CI
for the one thing a laptop cannot mint, the build attestation.

| Script | What it does |
| --- | --- |
| `release.mjs` | Orchestrates an authorized reviewed release through isolated versioning, exact-source CI, an immutable tag carrying the release notes, the release workflow and an API-side check of the public release |
| `set-version.sh` | Sets one version across every `package.json` in the workspace; it never commits, tags or pushes |
| `build-linux.sh` | Builds every Linux artifact for **one** architecture into a staging directory, gates on the clean-machine check, and derives the tarball from the AppImage so both carry identical bytes |
| `manifest.sh` | Writes `SHA256SUMS` over a staging directory, in `sha256sum` format, sorted |
| `sign.sh` | Creates the release key, and signs `SHA256SUMS` with it |
| `package-repositories.sh` | Signs RPMs and builds the signed APT and DNF repositories used by native OS updaters |
| `publish.sh` | Finalizes the manifest and installer, uploads both architectures and offline provenance to a draft, verifies remote sizes/digests, then publishes |
| `verify-install.sh` | Runs `install.sh` end to end against a local directory: install, upgrade, tamper, uninstall |

## Routine authorized release

Once the person has authorized a release and the complete source is reviewed and
committed, use its full SHA, and write the release notes first: a Markdown
file for the people who install the release. The first command is read-only;
inspect its frozen source, remote main, tag, release, exact-SHA CI and notes
facts before executing the second:

```bash
node scripts/release/release.mjs 0.1.0 --source FULL_REVIEWED_SHA --notes RELEASE_NOTES.md
node scripts/release/release.mjs 0.1.0 --publish --source FULL_REVIEWED_SHA --notes RELEASE_NOTES.md
```

`--notes FILE` is required for `--publish` and refused when empty. The notes
become the body of the annotated tag (`git tag -a --cleanup=verbatim`, so
Markdown headings survive), and `publish.sh` reads that body as the release
page's text, so the notes are part of the tagged object rather than typed into
a form. A resume must present the same notes; a changed file is refused.

Routine execution needs no release-preparation agent and no second feature
review. Changes to the orchestrator itself still require review. The command
leaves the caller's branch, index and unrelated dirty/deleted/untracked files
alone: it prepares in a detached temporary worktree, stages only version
metadata, pushes the exact candidate directly to remote `main`, waits for that
SHA's `ci.yml` push run, and only then creates the immutable tag. If interrupted,
inspect the printed checkpoint and rerun with `--publish --resume`; a crashed
lock additionally requires the explicit, validated `--recover-stale-lock`.

`pnpm install --frozen-lockfile` is the isolated default. `--offline` is
available when the pnpm store is already complete. A version already synchronized
at the reviewed source is a no-op: no extra commit is made, and an existing
unambiguous successful exact-SHA CI run is adopted.

The tag-triggered workflow remains the builder and publisher. Each architecture
is built on native hardware; there is no cross-compile because bundled Node,
prebuilt keyring bindings and AppImage runtime are architecture-specific. The
workflow runs the packaged clean-machine and installer gates, uploads to a draft,
attests the exact assets, publishes only after remote verification, and deploys
native package repositories. The orchestrator then reads the public release
through the API — not a draft, the recorded tag, the exact inventory with every
asset uploaded, Latest promotion — and reports success. It downloads nothing:
the workflow already verified and attested the bytes it uploaded.

The lower-level helpers remain useful for local staging and diagnosis, but they
do not replace the CI-before-tag transaction:

```bash
scripts/release/build-linux.sh --arch x64 --out release
scripts/release/build-linux.sh --arch arm64 --out release   # on arm64 hardware
scripts/release/publish.sh --tag v0.1.0 --dir release --stage-only
scripts/release/verify-install.sh --release release
```

Never restore the old version/commit/tag shortcut. If the orchestrator cannot
run, stop and repair or review it rather than creating a tag before exact-source
CI.

`build-linux.sh` runs `packages/desktop/scripts/clean-machine.mjs` against the
packaged tree before it copies a single artifact out: `PATH` emptied, a
throwaway `HOME` holding a decoy agent installation, ten claims about what is
inside the package and what it refuses to touch. Two shipped-and-broken bugs got
past `pnpm -r test` and past `doctor` run from a checkout; only that found them.
A failure there stops the release rather than staging artifacts nobody can run.

`publish.sh` writes the manifest, signs it when a key is configured, copies
`install.sh` in beside the artifacts, and uploads everything to a **draft**.
Both architectures' AppImage, tarball, DEB and RPM, the installer, checksum
manifest and offline provenance are required. Every uploaded asset must have
the expected size, SHA-256 digest and completed upload state before the draft
becomes public. Configured signatures are included in the same check.
An upload or verification failure leaves the release private. A retry can repair
a draft; it cannot overwrite an already published release.

Never manually publish an empty release page after pushing a tag. Early notes
may be saved in a draft. If asked not to monitor builds, report **tag pushed;
release building**, not **published**. The publisher owns public visibility and
Latest promotion. Native repository deployment follows publication separately.
Run `pnpm test:release` to verify these failure and ordering guards.

This follows GitHub's [draft release flow](https://cli.github.com/manual/gh_release_create)
and [asset digest metadata](https://docs.github.com/en/rest/releases/assets).

In CI, `package-repositories.sh` runs before the manifest and attestation so the
signed RPM bytes are the bytes both the release and DNF receive. It signs APT's
`Release` metadata and DNF's `repomd.xml`, then GitHub Pages publishes the two
feeds. A `.deb` or `.rpm` installation registers the matching feed; the normal
operating-system updater handles all later notifications and upgrades.

Check the result the way a person will:

```bash
scripts/release/verify-install.sh --release release
```

## The signing key

Optional, and worth doing. The checksum manifest and the artifacts travel
together, so whoever can replace one can replace both; a signature made with a
key that never leaves your machine is the link a compromised release cannot
forge, and its public half lives in `install.sh`, in git.

```bash
scripts/release/sign.sh --keygen        # once, ever
scripts/release/sign.sh --show-key      # paste the line into install.sh
```

Then commit that `RELEASE_PUBKEY=` line. From that moment `install.sh` treats a
release **without** a signature as tampering rather than as a missing feature,
so publish every release with the key available — or with `LASER_RELEASE_KEY`
set as a repository secret so the workflow can do it.

Back the key up somewhere you will still have it in five years. Rotating it
invalidates every published signature and every copy of `install.sh` that pins
the old public half.

## What a release contains

```
laser-0.1.0-x86_64.AppImage        one file, no root, no package manager
laser-0.1.0-arm64.AppImage
laser-0.1.0-linux-x64.tar.gz       the same AppDir, for machines that will not run an AppImage
laser-0.1.0-linux-arm64.tar.gz
laser_0.1.0_amd64.deb              when electron-builder.yml builds them
laser-0.1.0.x86_64.rpm
SHA256SUMS                           every file above, plus install.sh
SHA256SUMS.sig                       maintainer signature over SHA256SUMS
install.sh                           the installer this release was tested against
provenance.jsonl                     GitHub's signed offline build-provenance bundle
```

`install.sh` ships **with** the release as well as living at the repository
root, so installing an old version uses the installer that version was tested
against.

## Why `install.sh` matches filenames instead of building them

electron-builder names each format the way that format's ecosystem does: a
`.deb` says `amd64`, an `.rpm` says `x86_64`, an AppImage says `x86_64`, and
arm64 is `arm64` in two of them and `aarch64` in the third. Reconstructing that
table in the installer would be a second copy of a rule that already lives in
electron-builder, and the first mismatch would be a 404 on a stranger's machine.
So the installer lists the release's assets, filters by extension and by the
architecture tokens that format could plausibly use, and insists on exactly one
match — anything else is an error with the actual list in it.
