#!/usr/bin/env bash
# Turn a staging directory of artifacts into a GitHub release.
#
#   scripts/release/publish.sh --tag v0.1.0 --dir release
#   scripts/release/publish.sh --tag v0.1.0 --dir release --draft
#
# Run this once, after every architecture's artifacts are in one directory. It
# rewrites SHA256SUMS over whatever is actually there (so a half-finished set
# cannot ship a manifest that claims otherwise), signs it if a release key is
# configured, and uploads install.sh alongside — the same install.sh that is in
# this commit, so the script and the artifacts it verifies are one release.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO_ROOT/scripts/release"
. "$REPO_ROOT/scripts/identity/identity.sh"

TAG=""
DIR="$REPO_ROOT/release"
REPO="$(printenv "${product_env_prefix}_REPO" || true)"
[ -n "$REPO" ] || REPO="$product_repo"
RELEASE_KEY="$(printenv "${product_env_prefix}_RELEASE_KEY" || true)"
[ -n "$RELEASE_KEY" ] || RELEASE_KEY="$HOME/.config/$product_dir/release-key.pem"
DRAFT=0
NOTES=""
STAGE_ONLY=0

die() {
  printf '\npublish: %s\n' "$1" >&2
  [ $# -gt 1 ] && printf '%s\n' "$2" >&2
  printf '\n' >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)
      shift
      TAG="${1:-}"
      ;;
    --tag=*) TAG="${1#--tag=}" ;;
    --dir)
      shift
      DIR="${1:-}"
      ;;
    --dir=*) DIR="${1#--dir=}" ;;
    --repo)
      shift
      REPO="${1:-}"
      ;;
    --repo=*) REPO="${1#--repo=}" ;;
    --notes)
      shift
      NOTES="${1:-}"
      ;;
    --notes=*) NOTES="${1#--notes=}" ;;
    --draft) DRAFT=1 ;;
    # Assemble the final set of files and stop. The release workflow uses this
    # to attest the exact bytes it is about to upload; running publish.sh again
    # afterwards regenerates a byte-identical manifest (sorted names, and
    # Ed25519 signatures are deterministic), so the digests do not move.
    --stage-only) STAGE_ONLY=1 ;;
    --help | -h)
      sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[ -n "$TAG" ] || die "--tag is required, for example --tag v0.1.0"
[ -d "$DIR" ] || die "$DIR is not a directory" "Run scripts/release/build-linux.sh first."
if [ "$STAGE_ONLY" = 0 ]; then
  command -v gh >/dev/null 2>&1 || die "gh is not installed" "Publishing a GitHub release requires the GitHub CLI."
  gh auth status >/dev/null 2>&1 || die "gh is not signed in" "Run: gh auth login"
fi

# The tag and the version inside the app must agree, or the installed app
# reports a version that no release has, and the updater compares nonsense.
# The path goes in as an argument, not inside the evaluated string: a repository
# checked out under a directory with a quote or a backslash in its name would
# otherwise be JavaScript this script wrote by accident.
read_version() { node -e 'process.stdout.write(String(require(process.argv[1]).version))' "$1"; }
VERSION="$(read_version "$REPO_ROOT/packages/desktop/package.json")"
if [ "$TAG" != "v$VERSION" ]; then
  die "the tag $TAG does not match the app's version $VERSION" \
    "Set the version first, in every packages/*/package.json and the root one,
commit it, then tag:

  scripts/release/set-version.sh ${TAG#v}
  git commit -am 'chore: $TAG' && git tag $TAG && git push origin $TAG

A release whose tag and version disagree cannot be reproduced from the tag."
fi

# …and every package it ships must agree with the app, because the CLI's
# --version` reads the CLI's manifest, the AppStream release entry reads the
# desktop's, and a person comparing the two should not find two answers.
DISAGREE="$(
  for manifest in "$REPO_ROOT"/package.json "$REPO_ROOT"/packages/*/package.json; do
    v="$(read_version "$manifest")"
    [ "$v" = "$VERSION" ] || printf '  %s is %s\n' "${manifest#"$REPO_ROOT"/}" "$v"
  done
)"
if [ -n "$DISAGREE" ]; then
  die "the workspace is not all at $VERSION" \
    "These disagree:

$DISAGREE

Run: scripts/release/set-version.sh $VERSION"
fi

printf '\n==> manifest\n'
"$HERE/manifest.sh" --dir "$DIR"

if [ -f "$RELEASE_KEY" ]; then
  printf '==> signing the manifest\n'
  "$HERE/sign.sh" --dir "$DIR"
else
  printf '==> no release key configured; publishing an unsigned manifest\n'
  printf '    install.sh verifies every file against SHA256SUMS, and *requires*\n'
  printf '    GitHub build provenance unless the person passes --allow-unattested.\n'
  printf '    A release staged by hand therefore has to be installed with that flag.\n'
  printf '    To sign the manifest as well:\n'
  printf '      scripts/release/sign.sh --keygen\n\n'
fi

# install.sh ships with the release so a person can install an *old* version
# with the installer that version was tested against.
cp -f "$REPO_ROOT/install.sh" "$DIR/install.sh"
# …which changes the directory, so the manifest is rewritten over the final set.
"$HERE/manifest.sh" --dir "$DIR" >/dev/null
if [ -f "$RELEASE_KEY" ]; then
  "$HERE/sign.sh" --dir "$DIR" >/dev/null
fi

if [ "$STAGE_ONLY" = 1 ]; then
  printf '\nStaged %s for %s. Nothing was uploaded.\n\n' "$DIR" "$TAG"
  exit 0
fi

printf '==> uploading to %s %s\n\n' "$REPO" "$TAG"
assets=()
while IFS= read -r f; do assets+=("$f"); done < <(find "$DIR" -maxdepth 1 -type f | LC_ALL=C sort)

create_args=(release create "$TAG" --repo "$REPO" --title "$product_display $VERSION")
[ "$DRAFT" = 1 ] && create_args+=(--draft)
if [ -n "$NOTES" ]; then
  create_args+=(--notes "$NOTES")
else
  create_args+=(--generate-notes)
fi

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  printf '    release %s exists; replacing its assets\n' "$TAG"
  gh release upload "$TAG" --repo "$REPO" --clobber "${assets[@]}"
else
  gh "${create_args[@]}" "${assets[@]}"
fi

printf '\nPublished. Install it with:\n\n'
printf '  curl -fsSLo %s-install.sh https://raw.githubusercontent.com/%s/%s/install.sh \\\n' "$product_name" "$REPO" "$TAG"
printf '    && sh %s-install.sh --version %s\n\n' "$product_name" "$TAG"
