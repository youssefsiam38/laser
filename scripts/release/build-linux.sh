#!/usr/bin/env bash
# Build every Linux artifact for one architecture, into scripts/release's
# staging directory. This is the whole of what the release workflow runs on a
# build machine, so it has to work identically when a person runs it by hand.
#
#   scripts/release/build-linux.sh --arch x64
#   scripts/release/build-linux.sh --arch arm64 --out /tmp/release
#
# It does not tag, sign, or publish anything. See publish.sh for that.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
DESKTOP="$REPO_ROOT/packages/desktop"
. "$REPO_ROOT/scripts/identity/identity.sh"

ARCH=""
OUT="$REPO_ROOT/release"
SKIP_INSTALL=0

die() {
  printf '\nbuild-linux: %s\n' "$1" >&2
  [ $# -gt 1 ] && printf '%s\n' "$2" >&2
  printf '\n' >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --arch)
      shift
      ARCH="${1:-}"
      ;;
    --arch=*) ARCH="${1#--arch=}" ;;
    --out)
      shift
      OUT="${1:-}"
      ;;
    --out=*) OUT="${1#--out=}" ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --help | -h)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

if [ -z "$ARCH" ]; then
  case "$(uname -m)" in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) die "cannot guess the architecture from $(uname -m)" "Pass --arch x64 or --arch arm64." ;;
  esac
fi
case "$ARCH" in
  x64 | arm64) ;;
  *) die "unknown architecture: $ARCH" "$product_name builds x64 and arm64." ;;
esac

# electron-builder cross-compiles nothing useful here: the bundled Node, the
# prebuilt keyring binding and the AppImage runtime are all per-architecture,
# and the ones for the *host* are what end up in the package. Building x64 on
# an arm64 machine produces an artifact that cannot run.
HOST_ARCH=""
case "$(uname -m)" in
  x86_64 | amd64) HOST_ARCH=x64 ;;
  aarch64 | arm64) HOST_ARCH=arm64 ;;
esac
if [ -n "$HOST_ARCH" ] && [ "$HOST_ARCH" != "$ARCH" ]; then
  die "this is an $HOST_ARCH machine and you asked for $ARCH" \
    "Each architecture is built on a machine of that architecture: the bundled
Node, the prebuilt keyring binding and the AppImage runtime are all native.
Run this on an $ARCH machine, or let the release workflow do it."
fi

command -v node >/dev/null 2>&1 || die "node is not installed" "Install Node 24 and run this again."
command -v pnpm >/dev/null 2>&1 || die "pnpm is not installed" "Install pnpm 10 (\`corepack enable pnpm\`) and run this again."

VERSION="$(node -p "require('$DESKTOP/package.json').version")"
[ -n "$VERSION" ] || die "packages/desktop/package.json has no version"

printf '\n%s release build\n' "$product_name"
printf '  version   %s\n' "$VERSION"
printf '  arch      %s\n' "$ARCH"
printf '  staging   %s\n\n' "$OUT"

if [ "$SKIP_INSTALL" = 0 ]; then
  # The same install everyone else runs, from the committed lockfile. It used to
  # be a hoisted one, on the belief that electron-builder cannot read pnpm's
  # symlinked store; that turned out to be two undeclared dependencies rather
  # than a linker problem, both now declared and both guarded by
  # packages/desktop/build/before-pack.cjs. One install shape means a release is
  # built from the tree that was tested, which is what "reproducible from a tag"
  # has to mean.
  printf '==> pnpm install --frozen-lockfile\n'
  (cd "$REPO_ROOT" && ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile)
fi

printf '==> pnpm -r build\n'
(cd "$REPO_ROOT" && pnpm -r build)

# @lasercode/desktop owns how the Linux formats are produced. When it exposes a
# `dist:linux` script — the one that also builds the tarball, which
# electron-builder cannot make on its own — that is the build. Otherwise fall
# back to electron-builder's own Linux targets. Either way this script only
# collects and hashes; it never second-guesses the packaging.
if node -e "process.exit(require('$DESKTOP/package.json').scripts['dist:linux'] ? 0 : 1)"; then
  printf '==> pnpm -F @lasercode/desktop dist:linux --%s\n' "$ARCH"
  (cd "$REPO_ROOT" && pnpm -F @lasercode/desktop dist:linux -- --arch "$ARCH")
else
  printf '==> electron-builder --linux --%s\n' "$ARCH"
  (cd "$REPO_ROOT" && pnpm -F @lasercode/desktop dist -- --linux "--$ARCH" --publish never)
fi

# The packaged tree, checked the way a stranger's machine will use it: nothing
# on PATH, a throwaway HOME, a decoy agent directory that must be seen and not
# touched. Two shipped-and-broken bugs got past `pnpm -r test` and past `doctor`
# run from a checkout, and only this found them — so it runs before anything is
# copied out, not after.
printf '==> clean-machine check\n'
(cd "$REPO_ROOT" && node "$DESKTOP/scripts/clean-machine.mjs") ||
  die "the packaged app failed the clean-machine check" \
    "The artifacts were built but are not fit to publish: something in them
resolves from this machine rather than from inside the package. The lines above
say which claim failed. Nothing was copied to $OUT."

mkdir -p "$OUT"

# Copy out only the artifacts, and only the ones for this architecture.
# electron-builder's names differ per format on purpose (a .deb says amd64, an
# .rpm says x86_64), which is why install.sh matches names rather than
# reconstructing them.
copied=0
shopt -s nullglob
for artifact in "$DESKTOP"/out/*.AppImage "$DESKTOP"/out/*.deb "$DESKTOP"/out/*.rpm "$DESKTOP"/out/*.tar.gz "$DESKTOP"/out/*.pacman; do
  cp -f "$artifact" "$OUT/"
  printf '    %s\n' "$(basename "$artifact")"
  copied=$((copied + 1))
done
shopt -u nullglob

[ "$copied" -gt 0 ] || die "electron-builder produced no Linux artifacts" \
  "Check packages/desktop/electron-builder.yml: the linux.target list is what
decides which formats exist."

# The tarball, only when the desktop package did not already build one. It is
# the same AppDir the AppImage carries, so a machine that cannot or will not run
# an AppImage installs from exactly the same bytes, with the .desktop entry and
# the icons already inside it — one thing to verify, and one code path in
# install.sh for both formats.
EXISTING_TARBALL="$(find "$OUT" -maxdepth 1 -name '*.tar.gz' -type f | head -n1)"
APPIMAGE="$(find "$OUT" -maxdepth 1 -name '*.AppImage' -type f | LC_ALL=C sort | head -n1)"
if [ -n "$EXISTING_TARBALL" ]; then
  printf '==> tarball already built by the desktop package\n'
elif [ -n "$APPIMAGE" ]; then
  printf '==> tarball from the AppImage\n'
  TARBALL="$OUT/$product_binary-$VERSION-linux-$ARCH.tar.gz"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  chmod +x "$APPIMAGE"
  (cd "$work" && "$APPIMAGE" --appimage-extract >/dev/null)
  mv "$work/squashfs-root" "$work/$product_binary-$VERSION-linux-$ARCH"
  tar -czf "$TARBALL" -C "$work" "$product_binary-$VERSION-linux-$ARCH"
  printf '    %s\n' "$(basename "$TARBALL")"
fi

printf '\nArtifacts are in %s\n' "$OUT"
printf 'Next: scripts/release/manifest.sh --dir %s\n\n' "$OUT"
