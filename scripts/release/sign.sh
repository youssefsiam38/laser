#!/usr/bin/env bash
# Sign SHA256SUMS with the piorbit release key, or create that key.
#
#   scripts/release/sign.sh --keygen                  make a key (once, ever)
#   scripts/release/sign.sh --show-key                print the line install.sh pins
#   scripts/release/sign.sh --dir release             sign release/SHA256SUMS
#   scripts/release/sign.sh --dir release --verify    check the signature
#
# Why this exists on top of the checksum manifest: the manifest and the
# artifacts travel together, so anyone who can replace one can replace both.
# A signature made with a key that never leaves the maintainer's machine is the
# one link in the chain that a compromised release cannot forge, and its public
# half lives in install.sh, in git — never fetched alongside what it verifies.
#
# Ed25519 through openssl, because openssl is the one crypto tool that is
# already on a release machine. The signature is over the manifest's bytes
# (`-rawin`), not over a hash of them, so there is no second digest to agree on.
#
# The private key belongs in a password manager or a hardware token, and never
# in this repository. .gitignore does not protect you; a habit does.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
KEY="${PIORBIT_RELEASE_KEY:-$HOME/.config/piorbit/release-key.pem}"
DIR="$REPO_ROOT/release"
MODE="sign"

die() {
  printf '\nsign: %s\n' "$1" >&2
  [ $# -gt 1 ] && printf '%s\n' "$2" >&2
  printf '\n' >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --keygen) MODE="keygen" ;;
    --show-key) MODE="show" ;;
    --verify) MODE="verify" ;;
    --dir)
      shift
      DIR="${1:-}"
      ;;
    --dir=*) DIR="${1#--dir=}" ;;
    --key)
      shift
      KEY="${1:-}"
      ;;
    --key=*) KEY="${1#--key=}" ;;
    --help | -h)
      sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

command -v openssl >/dev/null 2>&1 || die "openssl is not installed" \
  "Install openssl; it is what signs and verifies the release manifest."

pubkey_body() {
  openssl pkey -in "$KEY" -pubout 2>/dev/null |
    sed -e '/-----BEGIN PUBLIC KEY-----/d' -e '/-----END PUBLIC KEY-----/d' -e '/^$/d'
}

case "$MODE" in
  keygen)
    if [ -f "$KEY" ]; then
      die "$KEY already exists" \
        "A release key is created once and then kept: replacing it invalidates
every signature already published, and every installed copy of install.sh that
pins the old public half. If you really mean to rotate, move the old file aside
by hand first."
    fi
    mkdir -p "$(dirname "$KEY")"
    ( umask 077 && openssl genpkey -algorithm ed25519 -out "$KEY" )
    chmod 600 "$KEY"
    printf '\nWrote a new Ed25519 release key to %s (mode 600).\n\n' "$KEY"
    printf 'Back it up somewhere you will still have it in five years, then paste\n'
    printf 'this into install.sh as RELEASE_PUBKEY:\n\n'
    printf 'RELEASE_PUBKEY="%s"\n\n' "$(pubkey_body)"
    ;;

  show)
    [ -f "$KEY" ] || die "there is no release key at $KEY" "Create one with: scripts/release/sign.sh --keygen"
    printf 'RELEASE_PUBKEY="%s"\n' "$(pubkey_body)"
    ;;

  sign)
    [ -f "$KEY" ] || die "there is no release key at $KEY" \
      "Create one with:

  scripts/release/sign.sh --keygen

or point at an existing one with --key / PIORBIT_RELEASE_KEY. Releases can go
out unsigned — install.sh still verifies every file against SHA256SUMS and
against GitHub's build provenance — but a signed one is stronger."
    [ -f "$DIR/SHA256SUMS" ] || die "$DIR/SHA256SUMS does not exist" \
      "Run scripts/release/manifest.sh --dir $DIR first."
    openssl pkeyutl -sign -inkey "$KEY" -rawin -in "$DIR/SHA256SUMS" -out "$DIR/SHA256SUMS.sig"
    printf '\nSigned %s -> %s\n\n' "$DIR/SHA256SUMS" "$DIR/SHA256SUMS.sig"
    ;;

  verify)
    [ -f "$DIR/SHA256SUMS.sig" ] || die "$DIR/SHA256SUMS.sig does not exist" "Sign it first."
    [ -f "$KEY" ] || die "there is no release key at $KEY to verify against"
    pub="$(mktemp)"
    trap 'rm -f "$pub"' EXIT
    openssl pkey -in "$KEY" -pubout -out "$pub"
    if openssl pkeyutl -verify -pubin -inkey "$pub" -rawin -in "$DIR/SHA256SUMS" -sigfile "$DIR/SHA256SUMS.sig" >/dev/null 2>&1; then
      printf '\nSHA256SUMS verifies against %s\n\n' "$KEY"
    else
      die "SHA256SUMS does NOT verify against $KEY" \
        "Either the manifest changed after it was signed — re-run sign.sh — or
this is not the key it was signed with."
    fi
    ;;
esac
