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
. "$REPO_ROOT/scripts/identity/identity.sh"
SOURCE_INSTALLER="$REPO_ROOT/install.sh"
INSTALLER="$SOURCE_INSTALLER"
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

if [ ! -f "$SOURCE_INSTALLER" ]; then
  printf 'verify-install: %s does not exist\n' "$SOURCE_INSTALLER" >&2
  exit 1
fi

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/$product_name-verify.XXXXXX")"
cleanup() { [ "$KEEP" = 1 ] || rm -rf "$ROOT"; }
trap cleanup EXIT
[ "$KEEP" = 1 ] && printf 'workspace: %s\n' "$ROOT"

FAKE_HOME="$ROOT/home"
PREFIX="$FAKE_HOME/.local"
mkdir -p "$FAKE_HOME" "$ROOT/tmp"

# Synthetic releases use a throwaway signing key later in this test, so start
# them with an unpinned copy. A real release always runs the production
# installer and therefore enforces the permanent key committed in install.sh.
if [ -z "$REAL_RELEASE" ]; then
  INSTALLER="$ROOT/install-unpinned.sh"
  sed 's|^RELEASE_PUBKEY="[^"]*"$|RELEASE_PUBKEY=""|' "$SOURCE_INSTALLER" >"$INSTALLER"
fi

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
      sh "$INSTALLER" --prefix "$PREFIX" --format appimage "$@" 2>&1
  )"
  rc=$?
  set -e
  DETAIL="$out"
}
# The signed-key section below swaps `installer` for one that runs a copy with a
# key pinned in it. `plain_installer` stays the unmodified script, for the
# sections after it that are not about signatures.
installer() { plain_installer "$@"; }

native_installer() {
  set +e
  out="$(
    env -i HOME="$FAKE_HOME" PATH="$PATH" TMPDIR="$ROOT/tmp" TERM="${TERM:-dumb}" \
      sh "$INSTALLER" --prefix "$PREFIX" "$@" 2>&1
  )"
  rc=$?
  set -e
  DETAIL="$out"
}

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
# wrapper, and the product's own launcher beside it. install.sh must pick the launcher —
# AppRun exports nothing, needs bash, rewrites PATH and LD_LIBRARY_PATH for
# everything the agent spawns, and silently injects --no-sandbox.
cat > squashfs-root/AppRun <<'APPRUN'
#!/usr/bin/env bash
echo "AppRun (this is the wrapper, not the launcher)"
APPRUN
chmod +x squashfs-root/AppRun
cat > "squashfs-root/$product_binary" <<'LAUNCH'
#!/bin/sh
echo "$product_display $version"
LAUNCH
chmod +x "squashfs-root/$product_binary"
cat > "squashfs-root/$product_desktop_file" <<'DESKTOP'
[Desktop Entry]
Name=$product_display
Exec=AppRun %U
Terminal=false
Type=Application
Icon=$product_binary
StartupWMClass=$product_display
Categories=Development;
MimeType=x-scheme-handler/$product_scheme;
DESKTOP
printf 'not-a-real-png-256' > "squashfs-root/usr/share/icons/hicolor/256x256/apps/$product_binary.png"
printf 'not-a-real-png-512' > "squashfs-root/usr/share/icons/hicolor/512x512/apps/$product_binary.png"
FIXTURE
  chmod +x "$out_path"
}

make_release() {
  # make_release <dir> <version> — one AppImage per architecture, and a manifest.
  local dir="$1" version="$2"
  mkdir -p "$dir"
  rm -f "${dir:?}"/*
  make_fake_appimage "$dir/$product_binary-$version-x86_64.AppImage" "$version"
  make_fake_appimage "$dir/$product_binary-$version-arm64.AppImage" "$version"
  printf 'deb-fixture\n' >"$dir/${product_binary}_${version}_amd64.deb"
  (cd "$dir" && sha256sum ./*.AppImage ./*.deb | sed 's|\./||' >SHA256SUMS)
}

# Running what was just installed is the one place this script executes
# something it did not write, so it gets the same sandboxed HOME the installer
# does. With the synthesised fixture the "launcher" is an `echo` and it makes no
# difference; with `--release` it is the real app, and without this it opened a
# window on the machine running the test and wrote to the caller's own
# `~/.local/share`, which is exactly what the header of this file promises can
# never happen.
run_launcher() {
  env -i \
    HOME="$FAKE_HOME" \
    PATH="$PATH" \
    TMPDIR="$ROOT/tmp" \
    TERM="${TERM:-dumb}" \
    "$PREFIX/bin/$product_binary" "$@" 2>/dev/null
}
launcher_says() { equals "$(run_launcher)" "$1"; }
# The real launcher answers `--version` and prints nothing else; asking a GUI
# for its stdout is a fixture-only question.
launcher_version_is() { equals "$(run_launcher --version)" "$1"; }
desktop_file="$PREFIX/share/applications/$product_desktop_file"
icon_count() { find "$PREFIX/share/icons" -name "$product_binary.png" 2>/dev/null | wc -l; }
# What the artifact actually carries, so "every packaged size" is measured
# against the package rather than against a number typed in here — the fixture
# ships two sizes and a real build ships seven.
packaged_icon_count() {
  find "$PREFIX/lib/$product_binary/app/usr/share/icons" -name "$product_binary.png" 2>/dev/null | wc -l
}

RELEASE_A="$ROOT/release-a"
RELEASE_B="$ROOT/release-b"
RELEASE_A_VERSION="0.1.0"
if [ -n "$REAL_RELEASE" ]; then
  RELEASE_A="$(cd "$REAL_RELEASE" && pwd)"
  RELEASE_A_VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_ROOT/package.json" | head -1)"
  [ -n "$RELEASE_A_VERSION" ] || {
    printf 'verify-install: could not read the workspace version from package.json\n' >&2
    exit 1
  }
  printf 'using the real release directory %s\n' "$RELEASE_A"
else
  make_release "$RELEASE_A" "0.1.0"
  make_release "$RELEASE_B" "0.2.0"
fi
RELEASE_A_TAG="v$RELEASE_A_VERSION"

# --------------------------------------------------------------- tests ----

section "--dry-run changes nothing"
before="$(snapshot "$FAKE_HOME")"
installer --from "$RELEASE_A" --version "$RELEASE_A_TAG" --dry-run
expect "dry run exits 0" equals "$rc" 0
expect "dry run says what it would do" contains "$out" 'would:'
expect "dry run left the filesystem untouched" equals "$before" "$(snapshot "$FAKE_HOME")"

section "the default uses the operating system update channel"
native_installer --from "$RELEASE_A" --version "$RELEASE_A_TAG" --dry-run
expect "Debian-family machines select the deb package" contains "$out" '(x64, deb)'
expect "the native default still changes nothing in a dry run" equals "$before" "$(snapshot "$FAKE_HOME")"

section "a fresh install"
installer --from "$RELEASE_A" --version "$RELEASE_A_TAG"
expect "install exits 0" equals "$rc" 0
expect "the bin symlink exists" test -L "$PREFIX/bin/$product_binary"
expect "the app is unpacked and executable" test -x "$PREFIX/lib/$product_binary/app/$product_binary"
if [ -n "$REAL_RELEASE" ]; then
  expect "the launcher answers as the version that was installed" launcher_version_is "$RELEASE_A_VERSION"
else
  expect "the launcher runs the app" launcher_says "$product_display $RELEASE_A_VERSION"
fi
expect "a .desktop entry is installed" test -f "$desktop_file"
DETAIL="$(cat "$desktop_file" 2>/dev/null || true)"
expect "Exec is absolute, names the launcher and keeps the packaged arguments" \
  grep -qx "Exec=$PREFIX/lib/$product_binary/app/$product_binary %U" "$desktop_file"
expect "TryExec is absolute" grep -qx "TryExec=$PREFIX/lib/$product_binary/app/$product_binary" "$desktop_file"
expect "nothing points at electron-builder's AppRun" \
  test ! -L "$PREFIX/bin/$product_binary" -o "$(readlink "$PREFIX/bin/$product_binary")" = "$PREFIX/lib/$product_binary/app/$product_binary"
expect "the URL scheme stays registered" grep -qx "MimeType=x-scheme-handler/$product_scheme;" "$desktop_file"
DETAIL=""
expect "icons are installed at every packaged size" equals "$(icon_count)" "$(packaged_icon_count)"
expect "the receipt records the version" grep -qx "version=$RELEASE_A_VERSION" "$PREFIX/lib/$product_binary/install-receipt"
expect "a copy of the installer is kept for --uninstall" test -f "$PREFIX/lib/$product_binary/install.sh"
DETAIL="$out"
expect "it closes with one line saying what to do next" contains "$out" 'Open it from your application menu'
expect "it reports the checks it ran" contains "$out" 'checksum matched'

section "re-running is idempotent"
installer --from "$RELEASE_A" --version "$RELEASE_A_TAG"
expect "reinstall exits 0" equals "$rc" 0
expect "it says the version is already installed" contains "$out" 'already installed'
DETAIL=""
expect "no stale app directory is left behind" \
  equals "$(find "$PREFIX/lib/$product_binary" -maxdepth 1 -name 'app*' | wc -l)" 1

if [ -z "$REAL_RELEASE" ]; then
  section "an upgrade replaces in place and says so"
  installer --from "$RELEASE_B" --version v0.2.0
  expect "upgrade exits 0" equals "$rc" 0
  expect "it names the version it moved from and to" contains "$out" "Upgrading $product_name 0.1.0 -> 0.2.0"
  DETAIL=""
  expect "the launcher now runs the new version" launcher_says "$product_display 0.2.0"
  expect "the receipt is updated" grep -qx 'version=0.2.0' "$PREFIX/lib/$product_binary/install-receipt"

  section "a tampered artifact aborts and installs nothing"
  TAMPER="$ROOT/release-tampered"
  make_release "$TAMPER" "0.3.0"
  printf '\n# an extra byte nobody signed for\n' >>"$TAMPER/$product_binary-0.3.0-x86_64.AppImage"
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
  make_fake_appimage "$NOARCH/$product_binary-0.5.0-riscv64.AppImage" "0.5.0"
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
  (cd "$ROOT/tarwork" && ./fixture --appimage-extract >/dev/null && mv squashfs-root "$product_binary-0.7.0-linux-x64")
  tar -czf "$TARREL/$product_binary-0.7.0-linux-x64.tar.gz" -C "$ROOT/tarwork" "$product_binary-0.7.0-linux-x64"
  (cd "$TARREL" && sha256sum ./*.tar.gz | sed 's|\./||' >SHA256SUMS)
  installer --from "$TARREL" --version v0.7.0 --format tar
  expect "tar install exits 0" equals "$rc" 0
  DETAIL=""
  expect "the launcher runs the app from the tarball" launcher_says "$product_display 0.7.0"
  expect "the tarball's desktop entry is wired up identically" \
    grep -qx "Exec=$PREFIX/lib/$product_binary/app/$product_binary %U" "$desktop_file"
  installer --uninstall --yes

  section "a tarball with a plain launcher installs too"
  # The other shape a release tarball takes: no AppRun, the product's program at
  # the top, and the desktop entry under usr/share/applications — which is what
  # a tarball built from the unpacked app rather than from the AppImage looks
  # like. Both shapes have to land in the same place.
  PLAINREL="$ROOT/release-plain"
  PLAINDIR="$ROOT/plainwork/$product_binary-0.8.0-linux-x64"
  mkdir -p "$PLAINREL" "$PLAINDIR/usr/share/applications" "$PLAINDIR/usr/share/icons/hicolor/256x256/apps"
  printf '#!/bin/sh\necho "%s 0.8.0"\n' "$product_display" >"$PLAINDIR/$product_binary"
  chmod +x "$PLAINDIR/$product_binary"
  cat >"$PLAINDIR/usr/share/applications/$product_desktop_file" <<PLAIN
[Desktop Entry]
Name=$product_display
Exec=$product_binary %U
Type=Application
Icon=$product_binary
MimeType=x-scheme-handler/$product_scheme;
PLAIN
  printf 'not-a-real-png' >"$PLAINDIR/usr/share/icons/hicolor/256x256/apps/$product_binary.png"
  tar -czf "$PLAINREL/$product_binary-0.8.0-linux-x64.tar.gz" -C "$ROOT/plainwork" "$product_binary-0.8.0-linux-x64"
  (cd "$PLAINREL" && sha256sum ./*.tar.gz | sed 's|\./||' >SHA256SUMS)
  installer --from "$PLAINREL" --version v0.8.0 --format tar
  expect "install exits 0" equals "$rc" 0
  DETAIL=""
  expect "the launcher runs the app" launcher_says "$product_display 0.8.0"
  expect "Exec points at the plain launcher" \
    grep -qx "Exec=$PREFIX/lib/$product_binary/app/$product_binary %U" "$desktop_file"
  expect "the entry under usr/share/applications was found" \
    grep -qx "MimeType=x-scheme-handler/$product_scheme;" "$desktop_file"
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
  export "${product_env_prefix}_RELEASE_KEY=$KEYDIR/release-key.pem"
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
        sh "$SIGNED_INSTALLER" --prefix "$PREFIX" --format appimage "$@" 2>&1
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
mkdir -p "$FAKE_HOME/.config/$product_dir"
printf 'settings\n' >"$FAKE_HOME/.config/$product_dir/settings.json"
printf 'someone elses file\n' >"$PREFIX/bin/unrelated"
installer --uninstall --yes
expect "uninstall exits 0" equals "$rc" 0
DETAIL=""
refute "the launcher is gone" test -e "$PREFIX/bin/$product_binary"
refute "the app directory is gone" test -e "$PREFIX/lib/$product_binary/app"
refute "the desktop entry is gone" test -e "$desktop_file"
expect "the icons are gone" equals "$(icon_count)" 0
expect "nothing else in bin was touched" test -f "$PREFIX/bin/unrelated"
# --yes means "do not stop to ask me", never "delete my data". Settings, the
# device identity and every pairing survive it; only --purge removes them.
expect "settings survive --uninstall --yes" test -f "$FAKE_HOME/.config/$product_dir/settings.json"

section "--purge is what deletes the data, and only that"
plain_installer --from "$RELEASE_A" --version "$RELEASE_A_TAG"
expect "reinstall for the purge case exits 0" equals "$rc" 0
DETAIL=""
plain_installer --uninstall --purge
expect "purge exits 0" equals "$rc" 0
DETAIL=""
refute "the settings directory is gone" test -e "$FAKE_HOME/.config/$product_dir"
expect "it says so in the closing line" contains "$out" 'along with its settings'

section "--uninstall on a machine with nothing installed explains itself"
installer --uninstall --yes
refute "it exits non-zero" equals "$rc" 0
expect "it says there is nothing to remove" contains "$out" "no record of a $product_name installation"

# The .deb and .rpm receipts carry a `package=` line, and that branch used to
# print `sudo apt remove …` for the person to run, delete the receipt, and then
# say the app was removed — while it was still installed, and with nothing left
# on disk to tell a second run what to take away. Every other uninstall
# assertion above runs on an AppImage receipt, so nothing covered it.
#
# A stand-in `apt` and `sudo` on the installer's PATH keep this a test of the
# script rather than of the machine: nothing privileged runs, and the fixture
# records what it was asked to do.
section "--uninstall of a system package removes it, and says so honestly"
FAKE_BIN="$ROOT/fakebin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/sudo" <<'FAKE_SUDO'
#!/bin/sh
exec "$@"
FAKE_SUDO
cat >"$FAKE_BIN/apt" <<FAKE_APT
#!/bin/sh
printf '%s\n' "\$*" >>"$ROOT/apt-calls"
[ -f "$ROOT/apt-refuses" ] && exit 1
exit 0
FAKE_APT
chmod +x "$FAKE_BIN/sudo" "$FAKE_BIN/apt"

write_package_receipt() {
  mkdir -p "$PREFIX/lib/$product_binary"
  cat >"$PREFIX/lib/$product_binary/install-receipt" <<PACKAGE_RECEIPT
version=0.1.0
tag=v0.1.0
format=deb
arch=x64
asset=${product_binary}_0.1.0_amd64.deb
prefix=$PREFIX
package=$product_name
PACKAGE_RECEIPT
}

write_package_receipt
: >"$ROOT/apt-calls"
saved_path="$PATH"
PATH="$FAKE_BIN:$PATH"
installer --uninstall --yes
PATH="$saved_path"
expect "removing a system package exits 0" equals "$rc" 0
expect "it ran the package manager itself" contains "$(cat "$ROOT/apt-calls")" "remove -y $product_name"
expect "it says which package it is removing" contains "$out" "removing the $product_name system package"
refute "it does not just print a command and stop" contains "$out" 'Remove it with your package manager'
refute "the receipt is gone once the package is" test -f "$PREFIX/lib/$product_binary/install-receipt"

# --purge is the flag that means "leave nothing of mine behind", so it has to
# clear dpkg's own record too — `apt remove` alone leaves the package in
# `deinstall ok config-files`.
write_package_receipt
: >"$ROOT/apt-calls"
PATH="$FAKE_BIN:$PATH"
installer --uninstall --purge
PATH="$saved_path"
expect "--purge asks the package manager to purge" contains "$(cat "$ROOT/apt-calls")" "purge -y $product_name"

# And when the package manager refuses, nothing may claim the app is gone.
write_package_receipt
: >"$ROOT/apt-calls"
: >"$ROOT/apt-refuses"
PATH="$FAKE_BIN:$PATH"
installer --uninstall --yes
PATH="$saved_path"
rm -f "$ROOT/apt-refuses"
refute "a package manager that refuses is not reported as success" equals "$rc" 0
expect "it says the package manager did not remove it" contains "$out" "did not remove $product_name"
refute "it never claims the app is gone" contains "$out" "$product_name is removed"
expect "the receipt survives, so a second run can finish the job" test -f "$PREFIX/lib/$product_binary/install-receipt"
expect "it names the command to run by hand" contains "$out" "remove $product_name"
rm -f "$PREFIX/lib/$product_binary/install-receipt"

# --------------------------------------------------------------- result ----
printf '\n%d passed, %d failed\n\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ] || exit 1
