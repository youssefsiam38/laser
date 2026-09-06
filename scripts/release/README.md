# Cutting a release

The release scripts below are the workflow's entire implementation.
`.github/workflows/release.yml` runs exactly these and nothing
else, so a release never depends on CI being available — it only depends on CI
for the one thing a laptop cannot mint, the build attestation.

| Script | What it does |
| --- | --- |
| `set-version.sh` | Sets one version across every `package.json` in the workspace |
| `build-linux.sh` | Builds every Linux artifact for **one** architecture into a staging directory, gates on the clean-machine check, and derives the tarball from the AppImage so both carry identical bytes |
| `manifest.sh` | Writes `SHA256SUMS` over a staging directory, in `sha256sum` format, sorted |
| `sign.sh` | Creates the release key, and signs `SHA256SUMS` with it |
| `package-repositories.sh` | Signs RPMs and builds the signed APT and DNF repositories used by native OS updaters |
| `publish.sh` | Re-runs the manifest over the final set, adds `install.sh`, and uploads the lot to a GitHub release; CI adds the offline provenance bundle |
| `verify-install.sh` | Runs `install.sh` end to end against a local directory: install, upgrade, tamper, uninstall |

## By hand

Each architecture is built on a machine of that architecture. There is no
cross-compile: the bundled Node, the prebuilt keyring binding and the AppImage
runtime are all native to the build host, so an x64 machine cannot produce a
working arm64 app.

```bash
# 1. Set the version, commit it, tag it. The tag and EVERY package.json in the
#    workspace must agree or publish.sh refuses — a release whose tag and
#    version disagree cannot be reproduced from the tag, and a workspace whose
#    packages disagree gives `laser --version` and the AppStream release entry
#    two different answers.
scripts/release/set-version.sh 0.1.0
git commit -am "chore: v0.1.0"
git tag v0.1.0 && git push origin v0.1.0

# 2. On an x86_64 machine
scripts/release/build-linux.sh --arch x64 --out release

# 3. On an aarch64 machine, into the same directory (rsync it over)
scripts/release/build-linux.sh --arch arm64 --out release

# 4. Once, from either
scripts/release/publish.sh --tag v0.1.0 --dir release
```

`build-linux.sh` runs `packages/desktop/scripts/clean-machine.mjs` against the
packaged tree before it copies a single artifact out: `PATH` emptied, a
throwaway `HOME` holding a decoy agent installation, ten claims about what is
inside the package and what it refuses to touch. Two shipped-and-broken bugs got
past `pnpm -r test` and past `doctor` run from a checkout; only that found them.
A failure there stops the release rather than staging artifacts nobody can run.

`publish.sh` writes the manifest, signs it when a key is configured, copies
`install.sh` in beside the artifacts, and uploads everything. Re-running it
replaces the assets on an existing release rather than failing.

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
