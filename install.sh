#!/bin/sh
# laser installer — one command, no root, no Node, no package manager.
#
# GENERATED from install.sh.tpl by `pnpm identity:generate`. Every name in this
# file comes from product.json (MX-T7, D-36); edit the template, not this copy.
#
#   gh api repos/youssefsiam38/laser/contents/install.sh \
#     -H 'Accept: application/vnd.github.raw' > laser-install.sh \
#     && sh laser-install.sh
#
# What this script is allowed to assume about the machine: a POSIX shell, the
# GNU/BusyBox coreutils every distribution ships, and `gh`. Nothing else. In
# particular NOT: node, npm, pnpm, python, curl, jq, fuse, or a package manager
# it recognises.
#
# ---------------------------------------------------------------- trust ----
# Three layers, strongest first. The script says which ones actually ran.
#
#   1. Build provenance. `gh attestation verify` checks a Sigstore signature
#      that binds the bytes to the release workflow, this repository and the
#      commit that produced them. This is the only check that still means
#      something if the release itself is tampered with after the fact — the
#      manifest below travels in the same release as the artifact, so anyone
#      who can replace one can replace the other. It is therefore **required**:
#      a failed check is fatal, and a *missing* one is fatal too, unless you
#      say `--allow-unattested` out loud for a release built by hand.
#   2. The checksum manifest. Every downloaded file is hashed and compared
#      against SHA256SUMS from the release. A mismatch aborts before a single
#      byte is written outside the temporary directory.
#   3. A maintainer signature over SHA256SUMS, when RELEASE_PUBKEY below is set
#      (see scripts/release/sign.sh). The key lives in this file, in git; the
#      signature travels with the release. A pinned key that has no signature to
#      check is treated as tampering, not as a missing feature.
#
# The bootstrap itself is anchored on `gh`: an authenticated TLS connection to
# GitHub, as you, to a private repository. That is the same channel that handed
# you this file, so it is the root of the chain rather than a weak link in it.
# Nothing here is ever piped from a download straight into a shell.
#
# POSIX sh only: no [[, no arrays, no $'…', no `local -r`, no <<<, no echo -e.
set -eu

# --------------------------------------------------------------- config ----

REPO_DEFAULT="youssefsiam38/laser"
PRODUCT="laser"
BINARY="laser"
APP_ID="com.hubtrix.laser"
URL_SCHEME="lasercode"
DESKTOP_NAME="laser.desktop"

# Ed25519 public key, PEM, base64 of the DER SubjectPublicKeyInfo body, as
# printed by `scripts/release/sign.sh --show-key`. Empty until a release key
# exists; see scripts/release/README.md. It is deliberately not a placeholder
# value: a fake key would turn "not configured yet" into "verification passed".
RELEASE_PUBKEY=""

# ------------------------------------------------------------- plumbing ----

PROGRAM="laser installer"
DRY_RUN=0
ASSUME_YES=0
MODE="install"
REPO="${LASERCODE_REPO:-$REPO_DEFAULT}"
TAG=""
FORMAT="appimage"
# 1 once `--format` was given. An explicit choice is an instruction, and nothing
# below may quietly replace it with a different package and a sudo prompt.
FORMAT_CHOSEN=0
PREFIX="${HOME}/.local"
FROM_DIR=""
# Provenance is required by default. Only a release assembled by hand has none,
# and installing one is a decision a person makes out loud with
# --allow-unattested, not a note they skim past.
REQUIRE_ATTESTATION=1
PURGE_DATA=0
SCRATCH=""

# The workflow the attestation has to name. Without this, `gh attestation
# verify --repo` accepts *any* workflow in the repository, so anyone who can
# push a workflow file can mint provenance for their own bytes.
SIGNER_WORKFLOW=".github/workflows/release.yml"

say() { printf '%s\n' "$*"; }
step() { printf '  %s\n' "$*"; }

warn() {
  printf '\n%s: %s\n' "$PROGRAM" "$1" >&2
  if [ $# -gt 1 ]; then shift; printf '%s\n\n' "$*" >&2; else printf '\n' >&2; fi
}

# die <what went wrong> [<what to do next>]
die() {
  printf '\n%s: %s\n' "$PROGRAM" "$1" >&2
  if [ $# -gt 1 ]; then
    shift
    printf '%s\n' "$*" >&2
  fi
  printf '\n' >&2
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# Every mutating action goes through run(), so --dry-run is one branch and not
# a promise sprinkled through the script.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  would: %s\n' "$*"
    return 0
  fi
  "$@"
}

# Set while the old install is parked at app.old and the new one is not yet in
# place. Anything that ends the script in that window — ENOSPC on a cross-device
# move, a Ctrl-C, a killed terminal — has to put the working copy back, or the
# person is left with a receipt describing an app that is not there, a dangling
# `laser` on PATH, and a menu entry that TryExec hides.
ROLLBACK_APP=""

cleanup() {
  if [ -n "$ROLLBACK_APP" ] && [ -d "${LIB_DIR-}/app.old" ] && [ ! -d "$ROLLBACK_APP" ]; then
    mv "${LIB_DIR-}/app.old" "$ROLLBACK_APP" 2>/dev/null &&
      printf '\n%s: the upgrade did not finish, so the version you had is back in place.\n\n' "$PROGRAM" >&2
  fi
  [ -n "$SCRATCH" ] && [ -d "$SCRATCH" ] && rm -rf "$SCRATCH"
  return 0
}
trap cleanup EXIT HUP INT TERM

scratch_dir() {
  if [ -z "$SCRATCH" ]; then
    SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/laser-install.XXXXXX") ||
      die "could not create a temporary directory under ${TMPDIR:-/tmp}" \
        "Set TMPDIR to a directory you can write to and run this again."
  fi
  printf '%s' "$SCRATCH"
}

ask() {
  # ask <question> — yes/no, default no. --yes answers yes; with no terminal to
  # ask on, the answer is no, because every caller's "yes" branch is the one
  # that changes something and a script that cannot ask must not assume it.
  if [ "$ASSUME_YES" = 1 ]; then return 0; fi
  # `-r` is not enough: a container or a detached session has a /dev/tty node
  # that cannot be opened. Try it, quietly, and treat a failure as "no". In a
  # subshell, because a redirection that fails on a special built-in (`:`) is
  # fatal to a POSIX shell, and this is exactly the case that fails.
  ( : >/dev/tty ) 2>/dev/null || return 1
  printf '%s [y/N] ' "$1" >/dev/tty
  read -r reply </dev/tty || reply=""
  case "$reply" in
    y | Y | yes | YES | Yes) return 0 ;;
    *) return 1 ;;
  esac
}

usage() {
  cat <<'EOF'
laser installer — installs the Laser desktop app for the current user.

  sh install.sh                     install or upgrade to the latest release
  sh install.sh --uninstall         remove exactly what a previous run installed

Options
  --version <tag>       a specific release tag (default: the latest release)
  --format <fmt>        appimage | tar | deb | rpm   (default: appimage)
  --prefix <dir>        where to install (default: ~/.local)
  --repo <owner/name>   the GitHub repository to install from
  --from <dir>          a local directory of release files, instead of GitHub
  --allow-unattested    install a release that carries no GitHub build
                        provenance (one assembled by hand). Provenance is
                        required without this flag
  --dry-run             print every action, change nothing
  --yes                 answer yes to every question
  --uninstall           remove the app
  --purge               with --uninstall: delete settings, paired devices and
                        logs as well, without asking
  --help                this text

appimage and tar install under your home directory and need no root. deb and
rpm are system packages and will ask for sudo. Nothing is installed to, or read
from, a global Node, npm, or agent installation — the app carries its own.
EOF
}

# --------------------------------------------------------------- argv ------

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) MODE="uninstall" ;;
    --dry-run) DRY_RUN=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --purge) PURGE_DATA=1 ;;
    # Kept because earlier copies of this script documented it, and a person
    # who asks for the default should not be told their flag does not exist.
    --require-attestation) REQUIRE_ATTESTATION=1 ;;
    --allow-unattested) REQUIRE_ATTESTATION=0 ;;
    --version)
      shift
      [ $# -gt 0 ] || die "--version needs a release tag, for example --version v0.1.0"
      TAG="$1"
      ;;
    --version=*) TAG="${1#--version=}" ;;
    --format)
      FORMAT_CHOSEN=1
      shift
      [ $# -gt 0 ] || die "--format needs a value: appimage, tar, deb or rpm"
      FORMAT="$1"
      ;;
    --format=*)
      FORMAT="${1#--format=}"
      FORMAT_CHOSEN=1
      ;;
    --prefix)
      shift
      [ $# -gt 0 ] || die "--prefix needs a directory, for example --prefix \$HOME/.local"
      PREFIX="$1"
      ;;
    --prefix=*) PREFIX="${1#--prefix=}" ;;
    --repo)
      shift
      [ $# -gt 0 ] || die "--repo needs an owner/name, for example --repo youssefsiam38/laser"
      REPO="$1"
      ;;
    --repo=*) REPO="${1#--repo=}" ;;
    --from)
      shift
      [ $# -gt 0 ] || die "--from needs a directory holding the release files"
      FROM_DIR="$1"
      ;;
    --from=*) FROM_DIR="${1#--from=}" ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1" "Run \`sh install.sh --help\` to see what this script accepts."
      ;;
  esac
  shift
done

FORMAT=$(printf '%s' "$FORMAT" | tr '[:upper:]' '[:lower:]')
case "$FORMAT" in
  appimage | tar | deb | rpm) ;;
  tar.gz | tarball) FORMAT="tar" ;;
  *) die "unknown format: $FORMAT" "Choose one of: appimage, tar, deb, rpm." ;;
esac

case "$PREFIX" in
  /*) ;;
  *) die "--prefix needs an absolute path, and got: $PREFIX" "Try --prefix \"\$HOME/.local\"." ;;
esac

BIN_DIR="$PREFIX/bin"
LIB_DIR="$PREFIX/lib/$BINARY"
APPS_DIR="$PREFIX/share/applications"
ICONS_DIR="$PREFIX/share/icons/hicolor"
RECEIPT="$LIB_DIR/install-receipt"

# ------------------------------------------------------------ platform ----

detect_platform() {
  kernel=$(uname -s 2>/dev/null || echo unknown)
  if [ "$kernel" != "Linux" ]; then
    die "this installer is for Linux, and this machine reports \"$kernel\"" \
      "On macOS and Windows, download the installer for your platform from
  https://github.com/$REPO/releases/latest"
  fi
  machine=$(uname -m 2>/dev/null || echo unknown)
  case "$machine" in
    x86_64 | amd64) ARCH="x64" ;;
    aarch64 | arm64) ARCH="arm64" ;;
    *)
      die "$PRODUCT has no build for this processor: $machine" \
        "$PRODUCT is built for 64-bit Intel/AMD (x86_64) and 64-bit ARM (aarch64) only.
32-bit and other architectures are not supported, and there is no workaround
short of building from source."
      ;;
  esac
}

# The distribution's own way to install gh, so the person is never handed a
# command their machine does not have.
gh_install_hint() {
  distro_id=""
  distro_like=""
  # shellcheck disable=SC1091
  if [ -r /etc/os-release ]; then
    distro_id=$(. /etc/os-release 2>/dev/null && printf '%s' "${ID:-}")
    distro_like=$(. /etc/os-release 2>/dev/null && printf '%s' "${ID_LIKE:-}")
  fi
  for candidate in $distro_id $distro_like; do
    case "$candidate" in
      ubuntu | debian | linuxmint | pop | elementary | raspbian)
        printf 'sudo apt update && sudo apt install gh'
        return
        ;;
      fedora | rhel | centos | rocky | almalinux)
        printf 'sudo dnf install gh'
        return
        ;;
      arch | manjaro | endeavouros | cachyos)
        printf 'sudo pacman -S github-cli'
        return
        ;;
      opensuse* | suse | sles)
        printf 'sudo zypper install gh'
        return
        ;;
      alpine)
        printf 'sudo apk add github-cli'
        return
        ;;
      nixos)
        printf 'nix-env -iA nixpkgs.gh'
        return
        ;;
      void)
        printf 'sudo xbps-install -S github-cli'
        return
        ;;
      gentoo)
        printf 'sudo emerge dev-vcs/github-cli'
        return
        ;;
    esac
  done
  printf ''
}

require_gh() {
  [ -n "$FROM_DIR" ] && return 0
  if ! have gh; then
    hint=$(gh_install_hint)
    if [ -n "$hint" ]; then
      die "$PRODUCT is published to a private repository, so this installer needs GitHub's \`gh\` command, and it is not installed" \
        "Install it with:

  $hint

then run this script again. If that package is not found on your release, the
per-distribution instructions are at
  https://github.com/cli/cli/blob/trunk/docs/install_linux.md"
    fi
    die "$PRODUCT is published to a private repository, so this installer needs GitHub's \`gh\` command, and it is not installed" \
      "Install it for your distribution — the instructions are at
  https://github.com/cli/cli/blob/trunk/docs/install_linux.md
— then run this script again."
  fi
  if ! gh auth status >/dev/null 2>&1; then
    die "\`gh\` is installed but not signed in to GitHub" \
      "Sign in with:

  gh auth login

and choose the account that has access to $REPO, then run this script again."
  fi
}

# --------------------------------------------------------------- hashes ----

sha256_of() {
  if have sha256sum; then
    sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif have openssl; then
    openssl dgst -sha256 "$1" | sed 's/.*= *//'
  else
    die "no way to compute a SHA-256 on this machine" \
      "$PRODUCT refuses to install a file it cannot verify. Install coreutils
(which provides sha256sum) or openssl, then run this script again."
  fi
}

# The expected hash for one file, out of a sha256sum-format manifest. Both
# `<hash>  name` and `<hash> *name` are accepted, which is the difference
# between sha256sum's text and binary modes.
expected_hash() {
  awk -v want="$2" '
    { name = $2; sub(/^\*/, "", name); if (name == want) { print $1; exit } }
  ' "$1"
}

verify_file() {
  # verify_file <path> <name-in-manifest> <manifest>
  vf_expected=$(expected_hash "$3" "$2")
  if [ -z "$vf_expected" ]; then
    die "$2 is not listed in the release's SHA256SUMS" \
      "The release is incomplete or was assembled by hand. Nothing was installed.
Ask whoever published it to re-run scripts/release/publish.sh, or install a
different release with --version <tag>."
  fi
  vf_actual=$(sha256_of "$1")
  if [ "$vf_expected" != "$vf_actual" ]; then
    die "$2 does not match the checksum published with the release" \
      "  expected  $vf_expected
  got       $vf_actual

Nothing was installed and nothing was changed. This means the download was
corrupted in transit, or the file is not the one that was published. Try again;
if it fails a second time, do not install it, and report it."
  fi
}

# ---------------------------------------------------------- provenance ----

# `gh attestation verify` binds the bytes to the workflow that built them.
# Verified -> say so. Anything else is fatal unless --allow-unattested was
# given *and* the reason is that there is no attestation at all.
#
# --signer-workflow is what makes this mean "built by laser's release
# workflow" rather than "built by some workflow in that repository": without
# it, anyone who can push a workflow file to the repo can mint provenance for
# bytes of their own choosing and this check would pass.
check_attestation() {
  if [ -n "$FROM_DIR" ]; then
    TRUST_PROVENANCE="not applicable — installed from a local directory ($FROM_DIR)"
    return 0
  fi
  if ! gh attestation --help >/dev/null 2>&1; then
    if [ "$REQUIRE_ATTESTATION" = 1 ]; then
      die "this copy of \`gh\` is too old to check the build provenance of a release" \
        "$PRODUCT verifies that a build came from its own release workflow before
installing it, and this \`gh\` has no \`attestation\` command. Update it —

  gh version   (2.49 or newer has it)

— and run this script again. To install without that check, knowing the
checksum manifest travels in the same release as the file it describes:

  sh install.sh --allow-unattested"
    fi
    TRUST_PROVENANCE="NOT CHECKED — this copy of gh is too old to check build provenance"
    return 0
  fi
  att_out=$(gh attestation verify "$1" --repo "$REPO" --signer-workflow "$REPO/$SIGNER_WORKFLOW" 2>&1) && {
    TRUST_PROVENANCE="attested to $REPO $SIGNER_WORKFLOW by GitHub Actions"
    return 0
  }
  # gh's exact wording for "this file has none", and nothing looser: a network
  # blip or an expired token must not be read as an honest hand-built release.
  case "$att_out" in
    *no\ attestations\ found* | *No\ attestations\ found*)
      if [ "$REQUIRE_ATTESTATION" = 1 ]; then
        die "this release carries no GitHub build provenance, so nothing proves where it came from" \
          "Every release built by $PRODUCT's release workflow is attested: the
signature binds the bytes to the workflow, the repository and the commit. This
one was assembled by hand, and the checksum manifest cannot stand in for that —
it travels in the same release as the file it describes.

If you trust whoever published this release, install it anyway with:

  sh install.sh --allow-unattested

Otherwise ask for a release built by CI. Nothing was installed."
      fi
      TRUST_PROVENANCE="NONE — assembled by hand, and you passed --allow-unattested"
      ;;
    *)
      die "the build provenance for $(basename "$1") did not verify" \
        "gh said:

$att_out

Nothing was installed. A provenance check that fails is a stronger signal than
one that is missing: do not install this file. If gh is simply not signed in,
run \`gh auth status\` and sign in, then try again."
      ;;
  esac
}

# A maintainer signature over the manifest, when a key is pinned in this file.
check_signature() {
  # check_signature <manifest> <signature-or-empty>
  if [ -z "$RELEASE_PUBKEY" ]; then
    TRUST_SIGNATURE="no release key is pinned in this installer"
    return 0
  fi
  if [ -z "$2" ] || [ ! -f "$2" ]; then
    die "this installer pins a release signing key, and the release has no SHA256SUMS.sig" \
      "Every signed release ships its signature. A release without one is either
incomplete or not the release it claims to be. Nothing was installed."
  fi
  if ! have openssl; then
    die "this installer pins a release signing key and openssl is not installed, so the signature cannot be checked" \
      "Install openssl and run this script again. $PRODUCT will not install a
file whose signature it was told to check and could not."
  fi
  cs_key="$(scratch_dir)/release.pub.pem"
  {
    printf -- '-----BEGIN PUBLIC KEY-----\n'
    printf '%s\n' "$RELEASE_PUBKEY"
    printf -- '-----END PUBLIC KEY-----\n'
  } >"$cs_key"
  if openssl pkeyutl -verify -pubin -inkey "$cs_key" -rawin -in "$1" -sigfile "$2" >/dev/null 2>&1; then
    TRUST_SIGNATURE="SHA256SUMS signed by the pinned release key"
    return 0
  fi
  die "the signature on SHA256SUMS does not verify against the key pinned in this installer" \
    "Nothing was installed. Either this release was signed with a different key
than the one this installer knows about — in which case you need a newer
install.sh — or the manifest has been altered. Do not install it."
}

# ------------------------------------------------------------- release ----

# Prints one asset name per line.
list_assets() {
  if [ -n "$FROM_DIR" ]; then
    ls -1 "$FROM_DIR"
    return 0
  fi
  if [ -n "$TAG" ]; then
    gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name' 2>/dev/null ||
      die "there is no release tagged \"$TAG\" in $REPO, or you cannot see it" \
        "List what is there with:

  gh release list --repo $REPO

then run this script again with --version <tag>, or without --version for the
latest release."
  else
    gh release view --repo "$REPO" --json assets --jq '.assets[].name' 2>/dev/null ||
      die "$REPO has no published release yet, or your account cannot see it" \
        "Check access with:

  gh release list --repo $REPO

If the list is empty, nothing has been released yet. If it says you are not
authorised, ask for read access to the repository."
  fi
}

resolve_tag() {
  if [ -n "$FROM_DIR" ]; then
    TAG="${TAG:-local}"
    return 0
  fi
  [ -n "$TAG" ] && return 0
  TAG=$(gh release view --repo "$REPO" --json tagName --jq '.tagName' 2>/dev/null) || TAG=""
  [ -n "$TAG" ] || die "$REPO has no published release yet, or your account cannot see it" \
    "Check with:

  gh release list --repo $REPO"
}

# The filename patterns each packaging format uses, per architecture. These are
# electron-builder's names, which differ per format on purpose (a .deb says
# amd64, an .rpm says x86_64), so they are matched rather than reconstructed.
asset_pattern() {
  case "$FORMAT.$ARCH" in
    appimage.x64) printf '\.AppImage$|x86_64|x64' ;;
    appimage.arm64) printf '\.AppImage$|arm64|aarch64' ;;
    tar.x64) printf '\.tar\.gz$|x86_64|x64' ;;
    tar.arm64) printf '\.tar\.gz$|arm64|aarch64' ;;
    deb.x64) printf '\.deb$|amd64|x86_64|x64' ;;
    deb.arm64) printf '\.deb$|arm64|aarch64' ;;
    rpm.x64) printf '\.rpm$|x86_64|x64' ;;
    rpm.arm64) printf '\.rpm$|aarch64|arm64' ;;
  esac
}

select_asset() {
  sa_ext=$(printf '%s' "$(asset_pattern)" | cut -d'|' -f1)
  sa_arches=$(printf '%s' "$(asset_pattern)" | cut -d'|' -f2-)
  sa_all=$(list_assets)
  sa_by_ext=$(printf '%s\n' "$sa_all" | grep -E "$sa_ext" || true)
  if [ -z "$sa_by_ext" ]; then
    die "release $TAG has no $FORMAT build" \
      "It contains:

$(printf '%s\n' "$sa_all" | sed 's/^/  /')

Install a format that is there with --format <appimage|tar|deb|rpm>."
  fi
  sa_match=$(printf '%s\n' "$sa_by_ext" | grep -E "($sa_arches)" || true)
  if [ -z "$sa_match" ]; then
    die "release $TAG has a $FORMAT build, but not for this machine's processor ($ARCH)" \
      "It contains:

$(printf '%s\n' "$sa_by_ext" | sed 's/^/  /')

There is no workaround: the app ships a compiled runtime per architecture."
  fi
  sa_count=$(printf '%s\n' "$sa_match" | wc -l | tr -d ' ')
  if [ "$sa_count" != "1" ]; then
    die "release $TAG has more than one $FORMAT build for $ARCH, so this script cannot choose" \
      "They are:

$(printf '%s\n' "$sa_match" | sed 's/^/  /')

This is a mistake in the release rather than on your machine. Report it."
  fi
  printf '%s' "$sa_match"
}

fetch() {
  # fetch <asset-name> <destination-dir>
  if [ -n "$FROM_DIR" ]; then
    [ -f "$FROM_DIR/$1" ] || die "$FROM_DIR/$1 does not exist" "Check --from."
    cp "$FROM_DIR/$1" "$2/$1"
    return 0
  fi
  gh release download "$TAG" --repo "$REPO" --pattern "$1" --dir "$2" --clobber >/dev/null 2>&1 ||
    die "could not download $1 from release $TAG" \
      "Check the network and that you are still signed in:

  gh auth status

then run this script again. Nothing was installed."
}

fetch_optional() {
  if [ -n "$FROM_DIR" ]; then
    [ -f "$FROM_DIR/$1" ] || return 1
    cp "$FROM_DIR/$1" "$2/$1"
    return 0
  fi
  gh release download "$TAG" --repo "$REPO" --pattern "$1" --dir "$2" --clobber >/dev/null 2>&1
}

# -------------------------------------------------------------- receipt ----

# The receipt is what makes the uninstall exact: it records every path this
# script created, so removal is "undo what I did" and never "delete anything
# that looks like the product".
receipt_get() {
  [ -f "$RECEIPT" ] || return 1
  awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$RECEIPT"
}

RECEIPT_BODY=""
receipt_add() {
  RECEIPT_BODY="${RECEIPT_BODY}$1=$2
"
}

receipt_write() {
  if [ "$DRY_RUN" = 1 ]; then
    step "would: write the install receipt to $RECEIPT"
    return 0
  fi
  printf '%s' "$RECEIPT_BODY" >"$RECEIPT"
}

# ------------------------------------------------------- desktop wiring ----

# Reuse the .desktop file the app was packaged with rather than inventing one:
# it already carries the MimeType line that makes lasercode:// links work, the
# StartupWMClass that stops the window from getting its own taskbar group, and
# the translated names. Only the paths are rewritten, because they were relative
# to a mount point that no longer exists.
install_desktop_entry() {
  # install_desktop_entry <source.desktop> <exec-path>
  ide_out="$APPS_DIR/$DESKTOP_NAME"
  if [ "$DRY_RUN" = 1 ]; then
    step "would: install $ide_out pointing at $2"
    receipt_add file "$ide_out"
    return 0
  fi
  ide_args=$(grep -m1 '^Exec=' "$1" 2>/dev/null | sed 's/^Exec=[^ ]*//')
  [ -n "$ide_args" ] || ide_args=" %U"
  mkdir -p "$APPS_DIR"
  {
    sed -e "s|^Exec=.*|Exec=$2$ide_args|" \
      -e "s|^TryExec=.*|TryExec=$2|" \
      "$1"
    grep -q '^MimeType=' "$1" || printf 'MimeType=x-scheme-handler/%s;\n' "$URL_SCHEME"
    # TryExec is what makes a menu hide an entry whose program is not there, so
    # a half-removed install shows nothing rather than a launcher that fails.
    grep -q '^TryExec=' "$1" || printf 'TryExec=%s\n' "$2"
    printf 'X-Laser-Installed-By=install.sh\n'
  } >"$ide_out.new"
  mv "$ide_out.new" "$ide_out"
  chmod 644 "$ide_out"
  receipt_add file "$ide_out"
}

install_icons() {
  # install_icons <appdir> <icon-name>
  ii_src="$1/usr/share/icons/hicolor"
  [ -d "$ii_src" ] || return 0
  for ii_size_dir in "$ii_src"/*; do
    [ -d "$ii_size_dir/apps" ] || continue
    ii_size=$(basename "$ii_size_dir")
    for ii_icon in "$ii_size_dir"/apps/*; do
      [ -f "$ii_icon" ] || continue
      ii_ext="${ii_icon##*.}"
      ii_dest="$ICONS_DIR/$ii_size/apps/$2.$ii_ext"
      if [ "$DRY_RUN" = 1 ]; then
        step "would: install icon $ii_dest"
      else
        mkdir -p "$ICONS_DIR/$ii_size/apps"
        cp "$ii_icon" "$ii_dest"
        chmod 644 "$ii_dest"
      fi
      receipt_add file "$ii_dest"
    done
  done
}

# These two exist on most desktops and on none of the minimal ones. Refresh the
# caches when they are there; a desktop without them picks the entry up on its
# own, so their absence is not worth a word.
refresh_desktop_caches() {
  if have update-desktop-database; then
    run update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
  fi
  if have gtk-update-icon-cache; then
    run gtk-update-icon-cache -f -t "$ICONS_DIR" >/dev/null 2>&1 || true
  fi
}

# Claim lasercode:// links. Install only — on uninstall the entry is gone and the
# association goes with it, and rewriting the mimeapps list on the way out would
# touch a file this script did not create.
claim_url_scheme() {
  if have xdg-mime; then
    run xdg-mime default "$DESKTOP_NAME" "x-scheme-handler/$URL_SCHEME" >/dev/null 2>&1 || true
  fi
}

# --------------------------------------------------- home-directory install ----

# AppImage and tar land in the same place and are wired up identically. The
# AppImage is *extracted* rather than kept as one file, which is deliberate:
# a type-2 AppImage needs libfuse2 to mount itself, and libfuse2 is not
# installed by default on Ubuntu 22.04 and later. `--appimage-extract` works
# without it, so extracting at install time removes the one dependency the
# format would otherwise impose on a clean machine.
install_appdir() {
  # install_appdir <path to an unpacked app directory>
  ia_new="$1"
  ia_target="$LIB_DIR/app"
  # laser's own launcher is the entry point, in every format. An AppImage
  # also carries electron-builder's AppRun, and that one must NOT be used here:
  #
  #   - it is the AppImage *runtime's* wrapper, written for a mounted image. It
  #     assigns APPDIR without exporting it, so nothing downstream can tell it
  #     ran, and when its `unshare -Ur true` probe fails — or `unshare` is
  #     simply absent — it silently prepends --no-sandbox. On an extracted copy
  #     that means laser starts unsandboxed and says nothing;
  #   - it is `#!/usr/bin/env bash`, so a machine without bash cannot start the
  #     app at all;
  #   - it rewrites PATH, LD_LIBRARY_PATH and XDG_DATA_DIRS for laser and for
  #     every process the agent goes on to spawn.
  #
  # The launcher beside it does the same three jobs deliberately and says what
  # it decided. So: the launcher first, AppRun only if a build somehow has no
  # launcher at all.
  if [ -f "$ia_new/$PRODUCT" ]; then
    ia_apprun="$ia_target/$PRODUCT"
  elif [ -f "$ia_new/AppRun" ]; then
    ia_apprun="$ia_target/AppRun"
  else
    die "the unpacked build has no launcher this installer recognises" \
      "Expected a $PRODUCT program at the top of it. Nothing was installed.
This is a mistake in the release rather than on your machine."
  fi

  if [ "$DRY_RUN" = 1 ]; then
    step "would: replace $ia_target with the new build"
  else
    mkdir -p "$LIB_DIR"
    rm -rf "$LIB_DIR/app.old"
    # The move below is a cross-device copy of ~400 MB whenever /tmp is a tmpfs
    # and $HOME is a disk, which is the common layout. It can run out of space,
    # and a Ctrl-C lands in the middle of it just as easily. Either way the old
    # install is already out of the way, so ROLLBACK_APP arms the exit trap to
    # put it back: an interrupted upgrade leaves the version that was working,
    # never a hole where the app used to be.
    if [ -d "$ia_target" ]; then
      mv "$ia_target" "$LIB_DIR/app.old"
      ROLLBACK_APP="$ia_target"
    fi
    mv "$ia_new" "$ia_target"
    ROLLBACK_APP=""
    rm -rf "$LIB_DIR/app.old"
  fi
  receipt_add dir "$ia_target"

  # The launcher is a symlink and not a copy, so an upgrade never leaves a
  # stale binary behind on PATH.
  if [ "$DRY_RUN" = 1 ]; then
    step "would: link $BIN_DIR/$BINARY -> $ia_apprun"
  else
    mkdir -p "$BIN_DIR"
    rm -f "$BIN_DIR/$BINARY"
    ln -s "$ia_apprun" "$BIN_DIR/$BINARY"
  fi
  receipt_add file "$BIN_DIR/$BINARY"
  # The app is on disk and on PATH from here, so the receipt has to exist from
  # here: anything that fails below (a read-only share/applications, a full
  # disk while copying icons) must still leave `--uninstall` able to undo this.
  receipt_write

  # From here on the AppDir is read at its installed path, not at the temporary
  # one: it was moved a moment ago, and the .desktop entry has to name where it
  # ended up rather than where it was unpacked.
  #
  # electron-builder puts the entry at the AppDir root and a copy under
  # usr/share/applications; either will do.
  ia_desktop=""
  for ia_candidate in "$ia_target"/*.desktop "$ia_target"/usr/share/applications/*.desktop; do
    if [ -f "$ia_candidate" ]; then
      ia_desktop="$ia_candidate"
      break
    fi
  done
  if [ -n "$ia_desktop" ]; then
    ia_icon=$(grep -m1 '^Icon=' "$ia_desktop" | sed 's/^Icon=//')
    [ -n "$ia_icon" ] || ia_icon="$PRODUCT"
    install_desktop_entry "$ia_desktop" "$ia_apprun"
    install_icons "$ia_target" "$ia_icon"
  else
    warn "the build has no .desktop file, so $PRODUCT will not appear in your application menu" \
      "It is still installed, and \`$BIN_DIR/$BINARY\` starts it. This is a
mistake in the release rather than on your machine — please report it."
  fi
}

extract_appimage() {
  # extract_appimage <appimage-path> -> prints the extracted AppDir path
  ea_work="$(scratch_dir)/extract"
  mkdir -p "$ea_work"
  chmod +x "$1"
  # --appimage-extract always writes ./squashfs-root, so it is run from a
  # directory of ours rather than from wherever the person happened to be.
  (cd "$ea_work" && "$1" --appimage-extract) >/dev/null 2>&1 ||
    die "could not unpack the downloaded AppImage" \
      "The file downloaded and its checksum matched, so this is not a corrupt
download — the AppImage refused to unpack itself. Run

  $1 --appimage-extract

to see what it says. Nothing was installed."
  [ -d "$ea_work/squashfs-root" ] ||
    die "the AppImage unpacked into something this installer does not recognise" \
      "Expected a squashfs-root directory under $ea_work. Nothing was installed."
  printf '%s' "$ea_work/squashfs-root"
}

extract_tarball() {
  et_work="$(scratch_dir)/tar"
  mkdir -p "$et_work"
  tar -xf "$1" -C "$et_work" 2>/dev/null ||
    die "could not unpack the downloaded tarball" \
      "This needs \`tar\` on PATH. Install it (it is in coreutils or tar on
every distribution) and run this script again. Nothing was installed."
  for et_candidate in "$et_work"/*; do
    [ -d "$et_candidate" ] || continue
    if [ -f "$et_candidate/AppRun" ] || [ -f "$et_candidate/$PRODUCT" ]; then
      printf '%s' "$et_candidate"
      return 0
    fi
  done
  die "the tarball does not contain an app directory this installer recognises" \
    "Expected one directory holding an AppRun or a $PRODUCT program. Nothing
was installed."
}

# ------------------------------------------------------ system packages ----

install_system_package() {
  # install_system_package <file> <format>
  isp_sudo=""
  if [ "$(id -u)" != "0" ]; then
    have sudo || die "installing a $2 package needs root, and sudo is not installed" \
      "Either install sudo, or re-run this script as root, or use the format
that needs no root at all:

  sh install.sh --format appimage"
    isp_sudo="sudo"
  fi
  case "$2" in
    deb)
      if have apt; then
        run $isp_sudo apt install -y "$1"
      elif have dpkg; then
        run $isp_sudo dpkg -i "$1"
      else
        die "this machine has no dpkg, so it cannot install a .deb" \
          "Use the format that needs no package manager:

  sh install.sh --format appimage"
      fi
      ;;
    rpm)
      if have dnf; then
        run $isp_sudo dnf install -y "$1"
      elif have zypper; then
        run $isp_sudo zypper --non-interactive install --allow-unsigned-rpm "$1"
      elif have rpm; then
        run $isp_sudo rpm -Uvh "$1"
      else
        die "this machine has no rpm, so it cannot install an .rpm" \
          "Use the format that needs no package manager:

  sh install.sh --format appimage"
      fi
      ;;
  esac
}

# The mirror of install_system_package, and the reason it exists: `--uninstall`
# used to print `sudo apt remove …` for a person to run and then say the app was
# removed, which was not true — and it deleted the receipt on the way out, so the
# next `--uninstall` could no longer name the package. Putting the app there
# already asked for sudo once; taking it away asks for the same thing.

# The command to run by hand, when this script cannot do it itself. Kept next to
# remove_system_package so the two can never name different package managers.
package_remove_command() {
  # package_remove_command <package>
  if have apt; then
    printf 'sudo apt remove %s' "$1"
  elif have dnf; then
    printf 'sudo dnf remove %s' "$1"
  elif have zypper; then
    printf 'sudo zypper remove %s' "$1"
  elif have dpkg; then
    printf 'sudo dpkg -r %s' "$1"
  elif have rpm; then
    printf 'sudo rpm -e %s' "$1"
  else
    printf 'remove the %s package with this machine%ss package manager' "$1" "'"
  fi
}

# Returns non-zero if the package is still installed afterwards. The caller
# keeps the receipt in that case, so a second run still knows what to remove.
remove_system_package() {
  # remove_system_package <package>
  rsp_sudo=""
  if [ "$(id -u)" != "0" ]; then
    have sudo || return 1
    rsp_sudo="sudo"
  fi
  # `--purge` is the flag that means "leave nothing of mine behind", so it also
  # clears dpkg's own record. Without it `apt remove` leaves the package in
  # `deinstall ok config-files`, which is right for a plain removal and wrong
  # for the one the person asked to be complete.
  if have apt; then
    if [ "$PURGE_DATA" = 1 ]; then run $rsp_sudo apt purge -y "$1"; else run $rsp_sudo apt remove -y "$1"; fi
  elif have dnf; then
    run $rsp_sudo dnf remove -y "$1"
  elif have zypper; then
    run $rsp_sudo zypper --non-interactive remove "$1"
  elif have dpkg; then
    if [ "$PURGE_DATA" = 1 ]; then run $rsp_sudo dpkg -P "$1"; else run $rsp_sudo dpkg -r "$1"; fi
  elif have rpm; then
    run $rsp_sudo rpm -e "$1"
  else
    return 1
  fi
}

# ------------------------------------------------------------- install ----

do_install() {
  detect_platform
  require_gh
  say ""
  check_sandbox_support
  resolve_tag

  previous_version=""
  previous_format=""
  if [ -f "$RECEIPT" ]; then
    previous_version=$(receipt_get version || true)
    previous_format=$(receipt_get format || true)
  fi

  asset=$(select_asset)
  version=$(printf '%s' "$TAG" | sed 's/^v//')
  # With --from there is no tag to read a version out of, and saying "<product>
  # local is installed" is a placeholder in the last line a person reads. Every
  # artifact carries the version in its own name (electron-builder puts it
  # there), so take it from the file that is actually being installed. An
  # upgrade from an offline copy is then detected like any other.
  if [ "$version" = "local" ]; then
    from_name=$(printf '%s' "$asset" |
      sed -n "s/^$BINARY[-_]\\([0-9][0-9A-Za-z.+-]*\\)[-_.]\\(x86_64\\|amd64\\|arm64\\|aarch64\\).*\$/\\1/p")
    [ -n "$from_name" ] && version="$from_name"
  fi

  say ""
  if [ -n "$previous_version" ] && [ "$previous_version" = "$version" ] && [ "$previous_format" = "$FORMAT" ]; then
    say "$PRODUCT $version is already installed; reinstalling it."
  elif [ -n "$previous_version" ]; then
    say "Upgrading $PRODUCT $previous_version -> $version ($ARCH, $FORMAT)."
  else
    say "Installing $PRODUCT $version ($ARCH, $FORMAT)."
  fi
  [ "$DRY_RUN" = 1 ] && say "Dry run: nothing will be downloaded or changed."
  say ""

  work="$(scratch_dir)/download"
  mkdir -p "$work"

  if [ "$DRY_RUN" = 1 ]; then
    step "would: download $asset and SHA256SUMS from $REPO release $TAG"
    step "would: verify $asset against SHA256SUMS and abort on a mismatch"
  else
    step "downloading SHA256SUMS"
    fetch "SHA256SUMS" "$work"
    sig=""
    if fetch_optional "SHA256SUMS.sig" "$work"; then sig="$work/SHA256SUMS.sig"; fi
    check_signature "$work/SHA256SUMS" "$sig"

    step "downloading $asset"
    fetch "$asset" "$work"

    step "verifying $asset"
    verify_file "$work/$asset" "$asset" "$work/SHA256SUMS"
    check_attestation "$work/$asset"
    step "checksum matched"
    step "manifest: ${TRUST_SIGNATURE:-not checked}"
    step "provenance: ${TRUST_PROVENANCE:-not checked}"
  fi

  receipt_add version "$version"
  receipt_add tag "$TAG"
  receipt_add format "$FORMAT"
  receipt_add arch "$ARCH"
  receipt_add asset "$asset"
  receipt_add prefix "$PREFIX"
  receipt_add installed "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo unknown)"

  case "$FORMAT" in
    appimage | tar)
      if [ "$DRY_RUN" = 1 ]; then
        step "would: unpack it into $LIB_DIR/app"
        step "would: link $BIN_DIR/$BINARY at the unpacked launcher"
        step "would: install $APPS_DIR/$DESKTOP_NAME and icons under $ICONS_DIR"
        step "would: refresh the desktop and icon caches if the tools are present"
        step "would: write the install receipt to $RECEIPT"
      else
        step "unpacking"
        if [ "$FORMAT" = "appimage" ]; then
          appdir=$(extract_appimage "$work/$asset")
        else
          appdir=$(extract_tarball "$work/$asset")
        fi
        step "installing into $LIB_DIR"
        install_appdir "$appdir"
        # A copy of this script travels with the app so `--uninstall` is
        # available later, when the downloaded copy is long gone. Only when $0
        # is really this file: piped in on stdin (`sh < install.sh`) $0 is the
        # shell itself, and copying /bin/sh here would record an "uninstaller"
        # that removes nothing.
        if [ -f "$0" ] && head -n 2 "$0" 2>/dev/null | grep -qF "$PROGRAM"; then
          cp "$0" "$LIB_DIR/install.sh" && receipt_add file "$LIB_DIR/install.sh"
        else
          warn "this script was read from a pipe, so no copy of it was kept beside the app" \
            "$PRODUCT is installed. To uninstall it later you will need this script again:

  gh api repos/$REPO/contents/install.sh -H 'Accept: application/vnd.github.raw' > $PRODUCT-install.sh
  sh $PRODUCT-install.sh --uninstall"
        fi
        # Written before the desktop wiring, not after: if installing the menu
        # entry or the icons fails, the app is already on disk and `--uninstall`
        # has to be able to find it.
        receipt_write
        refresh_desktop_caches
        claim_url_scheme
        receipt_write
      fi
      ;;
    deb | rpm)
      if [ "$DRY_RUN" = 1 ]; then
        step "would: install $asset with the system package manager (this asks for sudo)"
      else
        step "installing the system package (this needs sudo)"
        install_system_package "$work/$asset" "$FORMAT"
        mkdir -p "$LIB_DIR"
        receipt_add package "$PRODUCT"
        receipt_write
      fi
      ;;
  esac

  say ""
  post_install_notes
  if [ "$DRY_RUN" = 1 ]; then
    say "Dry run complete. Nothing was downloaded, and nothing on this machine changed."
    return 0
  fi
  case "$FORMAT" in
    deb | rpm) say "$PRODUCT $version is installed. Open it from your application menu." ;;
    *) say "$PRODUCT $version is installed. Open it from your application menu, or run: $BIN_DIR/$BINARY" ;;
  esac
}

# Ubuntu 24.04 and its derivatives restrict unprivileged user namespaces, which
# is the sandbox a per-user install has — there is no root to make the setuid
# helper root-owned. So a home-directory install on such a machine produces an
# app that refuses to start, and the honest thing is to say that *before*
# downloading 200 MB, and to offer the format that actually works: the .deb and
# .rpm ship an AppArmor profile and a setuid helper, which is precisely the fix.
apparmor_restricts_userns() {
  [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] || return 1
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]
}

check_sandbox_support() {
  case "$FORMAT" in
    deb | rpm) return 0 ;;
  esac
  apparmor_restricts_userns || return 0
  # A machine that also allows the app's own profile through is fine.
  say "$PRODUCT would not open on this machine as a $FORMAT install."
  say ""
  say "The reason: this system restricts unprivileged user namespaces (an AppArmor"
  say "setting), and that is how a copy installed into your home directory sandboxes"
  say "itself. Without it the app refuses to start rather than run unsandboxed."
  say ""
  say "The .deb package is the same build and carries the AppArmor profile and the"
  say "sandbox helper that make it work. It asks for your password once."
  say ""
  # Two things this must not do. It must not override a format the person named
  # on the command line — `--format tar` is an instruction, not a preference —
  # and `--yes` must not answer it: `--yes` means "do not stop to ask me", and
  # turning that into "and also install a system package with sudo" widens what
  # was agreed to. Both cases fall through to the instructions below, which say
  # exactly how to get the .deb on purpose.
  if [ "$DRY_RUN" = 0 ] && [ "$FORMAT_CHOSEN" = 0 ] && [ "$ASSUME_YES" = 0 ] && { have dpkg || have apt; }; then
    if ask "Install the .deb instead?"; then
      FORMAT="deb"
      say ""
      return 0
    fi
  fi
  say "Continuing with $FORMAT. If $PRODUCT does not open, either install the .deb —"
  say ""
  say "  sh install.sh --format deb"
  say ""
  say "— or allow unprivileged user namespaces on this machine:"
  say ""
  say "  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0"
  say ""
  say "To make that survive a reboot, put"
  say "\`kernel.apparmor_restrict_unprivileged_userns=0\` in"
  say "/etc/sysctl.d/60-apparmor-namespace.conf."
  say ""
}

# Everything a person needs to hear before the closing line — printed only when
# it is actually true of this machine.
post_install_notes() {
  case "$FORMAT" in
    deb | rpm) return 0 ;;
  esac
  case ":${PATH}:" in
    *":$BIN_DIR:"*) ;;
    *)
      say "Note: $BIN_DIR is not on your PATH, so typing \`$BINARY\` will not find it."
      say "      The application-menu entry works either way. To fix the shell too, add"
      say "      this line to ~/.profile (or ~/.bashrc, or ~/.zshrc) and open a new terminal:"
      say ""
      say "        export PATH=\"$BIN_DIR:\$PATH\""
      say ""
      ;;
  esac
}

# ----------------------------------------------------------- uninstall ----

do_uninstall() {
  if [ ! -f "$RECEIPT" ]; then
    die "there is no record of a $PRODUCT installation under $PREFIX" \
      "This script only removes what it installed, and it keeps that list in
  $RECEIPT
If you installed with a different --prefix, pass the same one here. If you
installed the .deb or .rpm, remove it with your package manager instead."
  fi

  version=$(receipt_get version || echo unknown)
  package=$(receipt_get package || true)
  say ""
  say "Removing $PRODUCT $version."
  [ "$DRY_RUN" = 1 ] && say "Dry run: nothing will be changed."
  say ""

  # Before the data, and before the receipt is touched: if the package manager
  # refuses, nothing else has changed and the receipt is still there to try again.
  if [ -n "$package" ]; then
    step "removing the $package system package (this needs sudo)"
    say ""
    if remove_system_package "$package"; then
      say ""
    else
      die "the package manager did not remove $package" \
        "Nothing else was changed, and the record of this install is still at
  $RECEIPT
so you can run this again once the package is gone. To remove it by hand:

  $(package_remove_command "$package")"
    fi
  fi

  # Data first, while the receipt is still on disk. If this is interrupted, or
  # the answer is no, a re-run still finds an installation to remove.
  removed_data=0
  kept_data=0
  for data_dir in "$HOME/.config/lasercode" "$HOME/.local/share/lasercode" "$HOME/.lasercode"; do
    [ -d "$data_dir" ] || continue
    # `--yes` means "do not stop to ask me", not "delete my data". Settings,
    # the device identity and every pairing are not recoverable, so deleting
    # them is its own flag.
    if [ "$PURGE_DATA" = 1 ]; then
      run rm -rf "$data_dir"
      step "removed $data_dir"
      removed_data=1
      continue
    fi
    say "  $data_dir holds your settings, paired devices and logs."
    if [ "$ASSUME_YES" = 1 ] || [ ! -r /dev/tty ]; then
      step "kept $data_dir (pass --purge to delete it)"
      kept_data=1
    elif ask "  Delete $data_dir as well?"; then
      run rm -rf "$data_dir"
      step "removed $data_dir"
      removed_data=1
    else
      step "kept $data_dir"
      kept_data=1
    fi
  done
  # A plain `A || B && say` would be the last command of the list, and under
  # `set -e` a false one exits the script mid-uninstall.
  if [ "$removed_data" = 1 ] || [ "$kept_data" = 1 ]; then say ""; fi

  # Only paths this script wrote, read back from the receipt. Directories are
  # removed recursively; files are removed one by one. Nothing is guessed.
  while IFS='=' read -r key value; do
    [ -n "$value" ] || continue
    case "$key" in
      file)
        if [ -e "$value" ] || [ -L "$value" ]; then
          if [ "$value" = "$LIB_DIR/install.sh" ]; then continue; fi
          run rm -f "$value"
          step "removed $value"
        fi
        ;;
      dir)
        if [ -d "$value" ]; then
          run rm -rf "$value"
          step "removed $value"
        fi
        ;;
    esac
  done <"$RECEIPT"

  run rm -f "$RECEIPT"
  run rm -f "$LIB_DIR/install.sh"
  # Only if empty: a --prefix of /usr/local must not lose its bin directory.
  if [ "$DRY_RUN" = 0 ]; then
    rmdir "$LIB_DIR" 2>/dev/null || true
  else
    step "would: remove $LIB_DIR if it is empty"
  fi

  refresh_desktop_caches

  say ""
  if [ "$DRY_RUN" = 1 ]; then
    say "Dry run complete. Nothing on this machine changed."
  elif [ "$removed_data" = 1 ] && [ "$kept_data" = 0 ]; then
    say "$PRODUCT is removed, along with its settings, paired devices and logs."
  elif [ "$removed_data" = 1 ]; then
    say "$PRODUCT is removed, along with the data you chose to delete."
  else
    say "$PRODUCT is removed. Your settings are still on disk, so reinstalling picks up where you left off."
  fi
}

# ---------------------------------------------------------------- main ----

TRUST_PROVENANCE=""
TRUST_SIGNATURE=""

if [ "$PURGE_DATA" = 1 ] && [ "$MODE" != "uninstall" ]; then
  die "--purge only means something with --uninstall" \
    "It deletes your settings, paired devices and logs while removing $PRODUCT:

  sh install.sh --uninstall --purge"
fi

case "$MODE" in
  install) do_install ;;
  uninstall) do_uninstall ;;
esac
