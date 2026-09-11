#!/usr/bin/env bash
# Turn a staging directory of artifacts into a GitHub release.
#
#   scripts/release/publish.sh --tag v0.1.0 --dir release --provenance /path/provenance.jsonl
#   scripts/release/publish.sh --tag v0.1.0 --dir release --stage-only
#
# Run this once, after every architecture's artifacts are in one directory. It
# rewrites SHA256SUMS over whatever is actually there (so a half-finished set
# cannot ship a manifest that claims otherwise), signs it if a release key is
# configured, and uploads install.sh alongside — the same install.sh that is in
# this commit, so the script and the artifacts it verifies are one release.
# Publication requires both Linux architectures and offline provenance. Uploads
# stay in a draft until every remote size and SHA-256 digest matches. A manually
# staged build without provenance can be tested locally, but cannot be published.
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
PROVENANCE=""

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
    --provenance) shift; PROVENANCE="${1:-}" ;;
    --provenance=*) PROVENANCE="${1#--provenance=}" ;;
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
    "Use the reviewed release orchestrator from the authorized source checkout:

  node scripts/release/release.mjs ${TAG#v} --source FULL_REVIEWED_SHA
  node scripts/release/release.mjs ${TAG#v} --publish --source FULL_REVIEWED_SHA

It synchronizes versions and requires exact-source CI before an annotated tag.
See scripts/release/README.md; do not create or move release tags manually."
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

# The release orchestrator writes the release notes into the annotated tag's
# body; that text is the release page. A tag without a body (a manual tag)
# falls back to GitHub's generated notes inside publish-github.mjs.
if [ -z "$NOTES" ]; then
  NOTES="$(git tag -l --format='%(contents:body)' "$TAG" 2>/dev/null || true)"
fi

node "$HERE/publish-github.mjs" "$TAG" "$VERSION" "$REPO" "$DIR" "$PROVENANCE" "$DRAFT" "$NOTES"

if [ "$DRAFT" = 1 ]; then
  printf '\nDraft verified. No public release was published.\n'
  exit 0
fi

printf '\nPublished. Install it with:\n\n'
printf '  curl -fsSLo %s-install.sh https://raw.githubusercontent.com/%s/%s/install.sh \\\n' "$product_name" "$REPO" "$TAG"
printf '    && sh %s-install.sh --version %s\n\n' "$product_name" "$TAG"
