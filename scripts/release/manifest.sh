#!/usr/bin/env bash
# Write SHA256SUMS over a directory of release artifacts.
#
#   scripts/release/manifest.sh --dir release
#
# The format is exactly `sha256sum`'s, so `sha256sum -c SHA256SUMS` works for
# anyone who wants to check it by hand, and install.sh can parse it with awk on
# a machine that has nothing else installed.
#
# Names are relative and sorted, so two builds of the same set of files produce
# byte-identical manifests and a diff means something.
set -euo pipefail

DIR="release"

die() {
  printf '\nmanifest: %s\n' "$1" >&2
  [ $# -gt 1 ] && printf '%s\n' "$2" >&2
  printf '\n' >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      shift
      DIR="${1:-}"
      ;;
    --dir=*) DIR="${1#--dir=}" ;;
    --help | -h)
      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[ -d "$DIR" ] || die "$DIR is not a directory" "Run scripts/release/build-linux.sh first."

cd "$DIR"

# The manifest never lists itself or its own signature.
mapfile -t files < <(
  find . -maxdepth 1 -type f \
    ! -name 'SHA256SUMS' ! -name 'SHA256SUMS.sig' \
    -printf '%P\n' | LC_ALL=C sort
)

[ "${#files[@]}" -gt 0 ] || die "$DIR contains no files to hash" \
  "Run scripts/release/build-linux.sh first."

sha256sum "${files[@]}" >SHA256SUMS.new
mv SHA256SUMS.new SHA256SUMS

printf '\nSHA256SUMS covers %d file(s) in %s:\n\n' "${#files[@]}" "$DIR"
sed 's/^/  /' SHA256SUMS
printf '\n'
