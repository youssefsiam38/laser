#!/usr/bin/env bash
# Exercise install.sh end to end, against a local release directory, so the
# install path is testable without publishing anything.
#
#   scripts/release/verify-install.sh                      synthesised fixture
#   scripts/release/verify-install.sh --release ./release  a real build
#
# It runs the installer the way a person does — download, verify, unpack, wire
# up the desktop entry — with `--from <dir>` standing in for the GitHub release,
# and then asserts the things that actually break: a tampered artifact must
# abort and leave nothing behind, an upgrade must replace rather than
# accumulate, --dry-run must change nothing, and --uninstall must remove
# exactly what was created and nothing else.
#
# Everything happens inside one temporary directory, with HOME pointed at it, so
# a failing run cannot touch the machine it runs on.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER="$REPO_ROOT/install.sh"
REAL_RELEASE=""
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --release)
      shift
      REAL_RELEASE="${1:-}"
      ;;
    --release=*) REAL_RELEASE="${1#--release=}" ;;
    --keep) KEEP=1 ;;
    --help | -h)
      sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'verify-install: unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

if [ ! -f "$INSTALLER" ]; then
  printf 'verify-install: %s does not exist\n' "$INSTALLER" >&2
  exit 1
fi

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/piorbit-verify.XXXXXX")"
cleanup() { [ "$KEEP" = 1 ] || rm -rf "$ROOT"; }
trap cleanup EXIT
[ "$KEEP" = 1 ] && printf 'workspace: %s\n' "$ROOT"

FAKE_HOME="$ROOT/home"
PREFIX="$FAKE_HOME/.local"
mkdir -p "$FAKE_HOME" "$ROOT/tmp"

# --------------------------------------------------------- assertions ----

PASS=0
FAIL=0
DETAIL=""

ok() {
  PASS=$((PASS + 1))
  printf '  \033[32mok\033[0m   %s\n' "$1"
}

bad() {
  FAIL=$((FAIL + 1))
  printf '  \033[31mFAIL\033[0m %s\n' "$1"
  if [ -n "$DETAIL" ]; then printf '%s\n' "$DETAIL" | sed 's/^/         | /'; fi
}

section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# expect <label> <command…> — the command is expected to succeed.
expect() {
  local label="$1"
  shift
  if "$@"; then ok "$label"; else bad "$label"; fi
}

# refute <label> <command…> — the command is expected to fail.
refute() {
  local label="$1"
  shift
  if "$@"; then bad "$label"; else ok "$label"; fi
}

contains() { printf '%s' "$1" | grep -q -- "$2"; }
matches() { printf '%s' "$1" | grep -qE -- "$2"; }
equals() { [ "$1" = "$2" ]; }

# The installer, with a sandboxed HOME: it never inherits the caller's, so a
# bug in the uninstall path cannot reach the machine running the test.
# `out` and `rc` are what the assertions below read.
out=""
rc=0
plain_installer() {
  set +e
  out="$(
    env -i \
      HOME="$FAKE_HOME" \
      PATH="$PATH" \
      TMPDIR="$ROOT/tmp" \
      TERM="${TERM:-dumb}" \
      sh "$INSTALLER" --prefix "$PREFIX" "$@" 2>&1
  )"
  rc=$?
  set -e
  DETAIL="$out"
}
# The signed-key section below swaps `installer` for one that runs a copy with a
# key pinned in it. `plain_installer` stays the unmodified script, for the
# sections after it that are not about signatures.
installer() { plain_installer "$@"; }

snapshot() { find "$1" -mindepth 1 2>/dev/null | LC_ALL=C sort | cksum; }

# ------------------------------------------------------------- fixture ----
#
# A stand-in AppImage: a self-extracting shell script that answers
# --appimage-extract exactly the way the real runtime does, carrying the AppDir
# shape electron-builder produces. Building the fixture rather than a 300 MB
# real artifact is what makes this runnable in a second, and every line of
# install.sh's unpack-and-wire-up path still runs for real.
make_fake_appimage() {
  # make_fake_appimage <output-path> <version>
  local out_path="$1" version="$2"
  cat >"$out_path" <<FIXTURE
#!/bin/sh
# stand-in for the AppImage runtime: only --appimage-extract is implemented.
set -eu
[ "\${1:-}" = "--appimage-extract" ] || { echo "fixture: only --appimage-extract" >&2; exit 1; }
mkdir -p squashfs-root/usr/share/icons/hicolor/256x256/apps
mkdir -p squashfs-root/usr/share/icons/hicolor/512x512/apps
# Both entry points, exactly as electron-builder produces them: its own AppRun
# wrapper, and piorbit's launcher beside it. install.sh must pick the launcher —
# AppRun exports nothing, needs bash, rewrites PATH and LD_LIBRARY_PATH for
# everything the agent spawns, and silently injects --no-sandbox.
cat > squashfs-root/AppRun <<'APPRUN'
#!/usr/bin/env bash
echo "AppRun (this is the wrapper, not the launcher)"
APPRUN
chmod +x squashfs-root/AppRun
cat > squashfs-root/piorbit <<'LAUNCH'
#!/bin/sh
echo "piorbit $version"
LAUNCH
chmod +x squashfs-root/piorbit
cat > squashfs-root/piorbit.desktop <<'DESKTOP'
[Desktop Entry]
Name=piorbit
Exec=AppRun %U
Terminal=false
Type=Application
Icon=piorbit
StartupWMClass=piorbit
Categories=Development;
MimeType=x-scheme-handler/piorbit;
DESKTOP
printf 'not-a-real-png-256' > squashfs-root/usr/share/icons/hicolor/256x256/apps/piorbit.png
printf 'not-a-real-png-512' > squashfs-root/usr/share/icons/hicolor/512x512/apps/piorbit.png
FIXTURE
  chmod +x "$out_path"
}

make_release() {
  # make_release <dir> <version> — one AppImage per architecture, and a manifest.
  local dir="$1" version="$2"
  mkdir -p "$dir"
  rm -f "${dir:?}"/*
  make_fake_appimage "$dir/piorbit-$version-x86_64.AppImage" "$version"
  make_fake_appimage "$dir/piorbit-$version-arm64.AppImage" "$version"
  (cd "$dir" && sha256sum ./*.AppImage | sed 's|\./||' >SHA256SUMS)
}

launcher_says() { equals "$("$PREFIX/bin/piorbit")" "$1"; }
desktop_file="$PREFIX/share/applications/piorbit.desktop"
icon_count() { find "$PREFIX/share/icons" -name 'piorbit.png' 2>/dev/null | wc -l; }

RELEASE_A="$ROOT/release-a"
RELEASE_B="$ROOT/release-b"
if [ -n "$REAL_RELEASE" ]; then
  RELEASE_A="$(cd "$REAL_RELEASE" && pwd)"
  printf 'using the real release directory %s\n' "$RELEASE_A"
else
  make_release "$RELEASE_A" "0.1.0"
  make_release "$RELEASE_B" "0.2.0"
fi

# --------------------------------------------------------------- tests ----

section "--dry-run changes nothing"
before="$(snapshot "$FAKE_HOME")"
installer --from "$RELEASE_A" --version v0.1.0 --dry-run
expect "dry run exits 0" equals "$rc" 0
expect "dry run says what it would do" contains "$out" 'would:'
expect "dry run left the filesystem untouched" equals "$before" "$(snapshot "$FAKE_HOME")"

section "a fresh install"
installer --from "$RELEASE_A" --version v0.1.0
expect "install exits 0" equals "$rc" 0
expect "bin/piorbit is a symlink" test -L "$PREFIX/bin/piorbit"
expect "the app is unpacked and executable" test -x "$PREFIX/lib/piorbit/app/piorbit"
expect "the launcher runs the app" launcher_says "piorbit 0.1.0"
expect "a .desktop entry is installed" test -f "$desktop_file"
DETAIL="$(cat "$desktop_file" 2>/dev/null || true)"
expect "Exec is absolute, names the launcher and keeps the packaged arguments" \
  grep -qx "Exec=$PREFIX/lib/piorbit/app/piorbit %U" "$desktop_file"
expect "TryExec is absolute" grep -qx "TryExec=$PREFIX/lib/piorbit/app/piorbit" "$desktop_file"
expect "nothing points at electron-builder's AppRun" \
  test ! -L "$PREFIX/bin/piorbit" -o "$(readlink "$PREFIX/bin/piorbit")" = "$PREFIX/lib/piorbit/app/piorbit"
expect "piorbit:// stays registered" grep -qx 'MimeType=x-scheme-handler/piorbit;' "$desktop_file"
DETAIL=""
expect "icons are installed at every packaged size" equals "$(icon_count)" 2
expect "the receipt records the version" grep -qx 'version=0.1.0' "$PREFIX/lib/piorbit/install-receipt"
expect "a copy of the installer is kept for --uninstall" test -f "$PREFIX/lib/piorbit/install.sh"
DETAIL="$out"
expect "it closes with one line saying what to do next" contains "$out" 'Open it from your application menu'
expect "it reports the checks it ran" contains "$out" 'checksum matched'

section "re-running is idempotent"
installer --from "$RELEASE_A" --version v0.1.0
expect "reinstall exits 0" equals "$rc" 0
expect "it says the version is already installed" contains "$out" 'already installed'
DETAIL=""
expect "no stale app directory is left behind" \
  equals "$(find "$PREFIX/lib/piorbit" -maxdepth 1 -name 'app*' | wc -l)" 1

if [ -z "$REAL_RELEASE" ]; then
  section "an upgrade replaces in place and says so"
  installer --from "$RELEASE_B" --version v0.2.0
  expect "upgrade exits 0" equals "$rc" 0
  expect "it names the version it moved from and to" contains "$out" 'Upgrading piorbit 0.1.0 -> 0.2.0'
  DETAIL=""
  expect "the launcher now runs the new version" launcher_says "piorbit 0.2.0"
  expect "the receipt is updated" grep -qx 'version=0.2.0' "$PREFIX/lib/piorbit/install-receipt"

  section "a tampered artifact aborts and installs nothing"
  TAMPER="$ROOT/release-tampered"
  make_release "$TAMPER" "0.3.0"
  printf '\n# an extra byte nobody signed for\n' >>"$TAMPER/piorbit-0.3.0-x86_64.AppImage"
  before="$(snapshot "$PREFIX")"
  installer --from "$TAMPER" --version v0.3.0
  refute "install refuses a checksum mismatch" equals "$rc" 0
  expect "it says which check failed" contains "$out" 'does not match the checksum'
  expect "it says nothing was installed" contains "$out" 'Nothing was installed'
  expect "it prints both hashes" matches "$out" 'expected +[0-9a-f]{64}'
  DETAIL=""
  expect "the previous install is untouched" equals "$before" "$(snapshot "$PREFIX")"

  section "a file missing from the manifest aborts"
  ORPHAN="$ROOT/release-orphan"
  make_release "$ORPHAN" "0.4.0"
  grep -v 'x86_64' "$ORPHAN/SHA256SUMS" >"$ORPHAN/SHA256SUMS.tmp"
  mv "$ORPHAN/SHA256SUMS.tmp" "$ORPHAN/SHA256SUMS"
  installer --from "$ORPHAN" --version v0.4.0
  refute "install refuses an unlisted artifact" equals "$rc" 0
  expect "it says the manifest does not cover it" contains "$out" 'not listed in the release'

  section "a release with no build for this machine says so"
  NOARCH="$ROOT/release-noarch"
  mkdir -p "$NOARCH"
  make_fake_appimage "$NOARCH/piorbit-0.5.0-riscv64.AppImage" "0.5.0"
  (cd "$NOARCH" && sha256sum ./*.AppImage | sed 's|\./||' >SHA256SUMS)
  installer --from "$NOARCH" --version v0.5.0
  refute "install refuses when no artifact matches this arch" equals "$rc" 0
  expect "it names the architecture problem" contains "$out" 'not for this machine'

  section "a format the release does not carry says what it does carry"
  installer --from "$RELEASE_B" --version v0.2.0 --format rpm
  refute "install refuses a missing format" equals "$rc" 0
  expect "it lists what the release does contain" contains "$out" 'It contains:'

  section "--format tar installs the same way"
  # The release tarball is the AppImage's own AppDir, so only the unpack step
  # differs and everything after it is shared. This proves it really is shared.
  TARREL="$ROOT/release-tar"
  mkdir -p "$TARREL" "$ROOT/tarwork"
  make_fake_appimage "$ROOT/tarwork/fixture" "0.7.0"
  (cd "$ROOT/tarwork" && ./fixture --appimage-extract >/dev/null && mv squashfs-root piorbit-0.7.0-linux-x64)
  tar -czf "$TARREL/piorbit-0.7.0-linux-x64.tar.gz" -C "$ROOT/tarwork" piorbit-0.7.0-linux-x64
  (cd "$TARREL" && sha256sum ./*.tar.gz | sed 's|\./||' >SHA256SUMS)
  installer --from "$TARREL" --version v0.7.0 --format tar
  expect "tar install exits 0" equals "$rc" 0
  DETAIL=""
  expect "the launcher runs the app from the tarball" launcher_says "piorbit 0.7.0"
  expect "the tarball's desktop entry is wired up identically" \
    grep -qx "Exec=$PREFIX/lib/piorbit/app/piorbit %U" "$desktop_file"
  installer --uninstall --yes

  section "a tarball with a plain launcher installs too"
  # The other shape a release tarball takes: no AppRun, a `piorbit` program at
  # the top, and the desktop entry under usr/share/applications — which is what
  # a tarball built from the unpacked app rather than from the AppImage looks
  # like. Both shapes have to land in the same place.
  PLAINREL="$ROOT/release-plain"
  PLAINDIR="$ROOT/plainwork/piorbit-0.8.0-linux-x64"
  mkdir -p "$PLAINREL" "$PLAINDIR/usr/share/applications" "$PLAINDIR/usr/share/icons/hicolor/256x256/apps"
  printf '#!/bin/sh\necho "piorbit 0.8.0"\n' >"$PLAINDIR/piorbit"
  chmod +x "$PLAINDIR/piorbit"
  cat >"$PLAINDIR/usr/share/applications/piorbit.desktop" <<'PLAIN'
[Desktop Entry]
Name=piorbit
Exec=piorbit %U
Type=Application
Icon=piorbit
MimeType=x-scheme-handler/piorbit;
PLAIN
  printf 'not-a-real-png' >"$PLAINDIR/usr/share/icons/hicolor/256x256/apps/piorbit.png"
  tar -czf "$PLAINREL/piorbit-0.8.0-linux-x64.tar.gz" -C "$ROOT/plainwork" piorbit-0.8.0-linux-x64
  (cd "$PLAINREL" && sha256sum ./*.tar.gz | sed 's|\./||' >SHA256SUMS)
  installer --from "$PLAINREL" --version v0.8.0 --format tar
  expect "install exits 0" equals "$rc" 0
  DETAIL=""
  expect "the launcher runs the app" launcher_says "piorbit 0.8.0"
  expect "Exec points at the plain launcher" \
    grep -qx "Exec=$PREFIX/lib/piorbit/app/piorbit %U" "$desktop_file"
  expect "the entry under usr/share/applications was found" \
    grep -qx 'MimeType=x-scheme-handler/piorbit;' "$desktop_file"
  expect "its icon was installed" equals "$(icon_count)" 1

  installer --uninstall --yes
  installer --from "$RELEASE_B" --version v0.2.0
  DETAIL=""
fi

if [ -z "$REAL_RELEASE" ] && command -v openssl >/dev/null 2>&1; then
  section "a pinned release key is enforced"
  # A copy of the installer with a key pinned in it, and the matching private
  # half — the shape a real signed release has.
  KEYDIR="$ROOT/keys"
  mkdir -p "$KEYDIR"
  export PIORBIT_RELEASE_KEY="$KEYDIR/release-key.pem"
  "$REPO_ROOT/scripts/release/sign.sh" --keygen >/dev/null
  PUB="$("$REPO_ROOT/scripts/release/sign.sh" --show-key | sed 's/^RELEASE_PUBKEY="//; s/"$//')"
  SIGNED_INSTALLER="$ROOT/install-signed.sh"
  sed "s|^RELEASE_PUBKEY=\"\"\$|RELEASE_PUBKEY=\"$PUB\"|" "$INSTALLER" >"$SIGNED_INSTALLER"
  expect "install.sh still declares the pinnable RELEASE_PUBKEY line" \
    grep -qx "RELEASE_PUBKEY=\"$PUB\"" "$SIGNED_INSTALLER"

  installer() {
    set +e
    out="$(
      env -i HOME="$FAKE_HOME" PATH="$PATH" TMPDIR="$ROOT/tmp" TERM="${TERM:-dumb}" \
        sh "$SIGNED_INSTALLER" --prefix "$PREFIX" "$@" 2>&1
    )"
    rc=$?
    set -e
    DETAIL="$out"
  }

  SIGNED="$ROOT/release-signed"
  make_release "$SIGNED" "0.6.0"
  installer --from "$SIGNED" --version v0.6.0
  refute "an unsigned release is refused when a key is pinned" equals "$rc" 0
  expect "it says the signature is missing" contains "$out" 'no SHA256SUMS.sig'

  "$REPO_ROOT/scripts/release/sign.sh" --dir "$SIGNED" >/dev/null
  installer --from "$SIGNED" --version v0.6.0
  expect "a correctly signed release installs" equals "$rc" 0
  expect "it reports the signature it checked" contains "$out" 'signed by the pinned release key'

  printf '# one more line\n' >>"$SIGNED/SHA256SUMS"
  installer --from "$SIGNED" --version v0.6.0
  refute "a manifest edited after signing is refused" equals "$rc" 0
  expect "it says the signature did not verify" contains "$out" 'does not verify'
  DETAIL=""
fi

section "--uninstall removes exactly what was installed"
mkdir -p "$FAKE_HOME/.config/piorbit"
printf 'settings\n' >"$FAKE_HOME/.config/piorbit/settings.json"
printf 'someone elses file\n' >"$PREFIX/bin/unrelated"
installer --uninstall --yes
expect "uninstall exits 0" equals "$rc" 0
DETAIL=""
refute "the launcher is gone" test -e "$PREFIX/bin/piorbit"
refute "the app directory is gone" test -e "$PREFIX/lib/piorbit/app"
refute "the desktop entry is gone" test -e "$desktop_file"
expect "the icons are gone" equals "$(icon_count)" 0
expect "nothing else in bin was touched" test -f "$PREFIX/bin/unrelated"
# --yes means "do not stop to ask me", never "delete my data". Settings, the
# device identity and every pairing survive it; only --purge removes them.
expect "settings survive --uninstall --yes" test -f "$FAKE_HOME/.config/piorbit/settings.json"

section "--purge is what deletes the data, and only that"
plain_installer --from "$RELEASE_A" --version v0.1.0
expect "reinstall for the purge case exits 0" equals "$rc" 0
DETAIL=""
plain_installer --uninstall --purge
expect "purge exits 0" equals "$rc" 0
DETAIL=""
refute "the settings directory is gone" test -e "$FAKE_HOME/.config/piorbit"
expect "it says so in the closing line" contains "$out" 'along with its settings'

section "--uninstall on a machine with nothing installed explains itself"
installer --uninstall --yes
refute "it exits non-zero" equals "$rc" 0
expect "it says there is nothing to remove" contains "$out" 'no record of a piorbit installation'

# --------------------------------------------------------------- result ----
printf '\n%d passed, %d failed\n\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ] || exit 1
