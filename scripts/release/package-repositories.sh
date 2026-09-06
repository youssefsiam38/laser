#!/usr/bin/env bash
# Build the signed APT and DNF repositories published by the release workflow.
#
#   scripts/release/package-repositories.sh --dir release --out package-repositories
#
# The RPMs are signed in place before SHA256SUMS and build provenance are made,
# so the downloadable release asset and the copy in the DNF repository are the
# same bytes. The repository metadata is then signed with the same OpenPGP key.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
. "$REPO_ROOT/scripts/identity/identity.sh"

DIR="$REPO_ROOT/release"
OUT="$REPO_ROOT/package-repositories"
KEY_HOME="${GNUPGHOME:-$HOME/.config/$product_dir/package-signing}"

die() {
  printf '\npackage-repositories: %s\n\n' "$1" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) shift; DIR="${1:-}" ;;
    --dir=*) DIR="${1#--dir=}" ;;
    --out) shift; OUT="${1:-}" ;;
    --out=*) OUT="${1#--out=}" ;;
    --key-home) shift; KEY_HOME="${1:-}" ;;
    --key-home=*) KEY_HOME="${1#--key-home=}" ;;
    --help | -h) sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[ -d "$DIR" ] || die "$DIR is not a directory"
for tool in gpg dpkg-deb dpkg-scanpackages apt-ftparchive gzip createrepo_c rpm rpmsign; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required to build the package repositories"
done
[ -d "$KEY_HOME" ] || die "$KEY_HOME is not a GnuPG home"

PUBLIC_KEY="$REPO_ROOT/packages/desktop/build/linux/package-repository-key.asc"
FINGERPRINT="$(gpg --batch --show-keys --with-colons "$PUBLIC_KEY" |
  awk -F: '$1 == "fpr" { print $10; exit }')"
[ -n "$FINGERPRINT" ] || die "$PUBLIC_KEY contains no OpenPGP key"
gpg --homedir "$KEY_HOME" --batch --list-secret-keys "$FINGERPRINT" >/dev/null 2>&1 ||
  die "the secret half of $FINGERPRINT is not in $KEY_HOME"
RPM_DB="$(mktemp -d)"
trap 'rm -rf -- "$RPM_DB"' EXIT
rpmkeys --dbpath "$RPM_DB" --import "$PUBLIC_KEY"

mapfile -t DEBS < <(find "$DIR" -maxdepth 1 -type f -name '*.deb' | LC_ALL=C sort)
mapfile -t RPMS < <(find "$DIR" -maxdepth 1 -type f -name '*.rpm' | LC_ALL=C sort)
[ "${#DEBS[@]}" -gt 0 ] || die "$DIR contains no deb packages"
[ "${#RPMS[@]}" -gt 0 ] || die "$DIR contains no rpm packages"

printf '==> signing rpm packages\n'
for package in "${RPMS[@]}"; do
  GNUPGHOME="$KEY_HOME" rpmsign \
    --define '_signature gpg' \
    --define "_gpg_name $FINGERPRINT" \
    --define "_gpg_path $KEY_HOME" \
    --define '__gpg /usr/bin/gpg' \
    --addsign "$package"
  rpm --dbpath "$RPM_DB" --checksig "$package" | grep -q 'digests signatures OK' ||
    die "the rpm signature did not verify: $(basename "$package")"
done

[ ! -e "$OUT" ] || die "$OUT already exists; choose a fresh --out directory"
mkdir -p "$OUT/apt/pool/main/$product_name" \
  "$OUT/apt/dists/stable/main/binary-amd64" \
  "$OUT/apt/dists/stable/main/binary-arm64" \
  "$OUT/rpm/x86_64" "$OUT/rpm/aarch64"

for package in "${DEBS[@]}"; do
  cp -f "$package" "$OUT/apt/pool/main/$product_name/"
done
for package in "${RPMS[@]}"; do
  case "$(rpm --dbpath "$RPM_DB" -qp --qf '%{ARCH}' "$package")" in
    x86_64) target="$OUT/rpm/x86_64" ;;
    aarch64) target="$OUT/rpm/aarch64" ;;
    *) die "unsupported rpm architecture in $(basename "$package")" ;;
  esac
  cp -f "$package" "$target/"
done

printf '==> apt metadata\n'
(
  cd "$OUT/apt"
  for arch in amd64 arm64; do
    dpkg-scanpackages --arch "$arch" "pool/main/$product_name" /dev/null >"dists/stable/main/binary-$arch/Packages"
    gzip -n -9 -c "dists/stable/main/binary-$arch/Packages" >"dists/stable/main/binary-$arch/Packages.gz"
  done
  {
    printf 'Origin: %s\n' "$product_display"
    printf 'Label: %s\n' "$product_display"
    printf 'Suite: stable\nCodename: stable\nArchitectures: amd64 arm64\nComponents: main\n'
    printf 'Description: %s package repository\n' "$product_display"
    apt-ftparchive release dists/stable
  } >dists/stable/Release
  gpg --homedir "$KEY_HOME" --batch --yes --pinentry-mode loopback --passphrase '' \
    --local-user "$FINGERPRINT" --clearsign --output dists/stable/InRelease dists/stable/Release
  gpg --homedir "$KEY_HOME" --batch --yes --pinentry-mode loopback --passphrase '' \
    --local-user "$FINGERPRINT" --armor --detach-sign --output dists/stable/Release.gpg dists/stable/Release
)

printf '==> dnf metadata\n'
for arch in x86_64 aarch64; do
  createrepo_c --quiet "$OUT/rpm/$arch"
  gpg --homedir "$KEY_HOME" --batch --yes --pinentry-mode loopback --passphrase '' \
    --local-user "$FINGERPRINT" --armor --detach-sign \
    --output "$OUT/rpm/$arch/repodata/repomd.xml.asc" \
    "$OUT/rpm/$arch/repodata/repomd.xml"
done

cp -f "$REPO_ROOT/packages/desktop/build/linux/package-repository-key.asc" "$OUT/apt/"
cp -f "$REPO_ROOT/packages/desktop/build/linux/package-repository-key.asc" "$OUT/rpm/"
touch "$OUT/.nojekyll"

printf '\nSigned package repositories are in %s\n\n' "$OUT"
