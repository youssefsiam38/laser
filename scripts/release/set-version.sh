#!/usr/bin/env bash
# Set one version across the whole workspace.
#
# Every package.json in this repository carries the same version, because they
# are one product shipped as one artifact: the CLI's `--version` reads the CLI's
# manifest, the AppStream release entry reads the desktop's, and the tag names
# the release. Three answers to one question is how a bug report becomes
# unreproducible, so there is one number and this is what sets it.
#
#   scripts/release/set-version.sh 0.2.0
#
# It changes nothing else — not the pinned Node (packages/desktop/runtime.json),
# not the pinned agent (packages/worker/package.json's dependency). Those are
# pinned on their own schedule and each has its own task.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
. "$REPO_ROOT/scripts/identity/identity.sh"

VERSION="${1-}"
case "$VERSION" in
  "" | -h | --help)
    sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  printf '%s: "%s" is not a version.\n' "$product_name" "$VERSION" >&2
  printf 'Use MAJOR.MINOR.PATCH, for example 0.2.0 — the leading "v" belongs on the tag, not here.\n' >&2
  exit 2
fi

node - "$REPO_ROOT" "$VERSION" "$product_name" <<'NODE'
const { readFileSync, writeFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const [root, version, product] = process.argv.slice(2);

const manifests = [join(root, "package.json")];
for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
  if (entry.isDirectory()) manifests.push(join(root, "packages", entry.name, "package.json"));
}

for (const path of manifests) {
  const before = readFileSync(path, "utf8");
  // A textual edit on the first `"version"` key, so the file keeps its own key
  // order, indentation and comment blocks. JSON.stringify would reformat all of
  // them and bury the one line that changed in a hundred that did not.
  if (!/("version":\s*)"[^"]*"/.test(before)) {
    console.error(`${product}: ${path} has no "version" field to set.`);
    process.exit(1);
  }
  const after = before.replace(/("version":\s*)"[^"]*"/, `$1"${version}"`);
  if (after !== before) writeFileSync(path, after);
  console.log(`  ${path.slice(root.length + 1)} → ${version}${after === before ? " (unchanged)" : ""}`);
}
NODE

node "$REPO_ROOT/scripts/identity/generate.mjs"

printf '\nEverything is at %s. This command only synchronized local metadata.\n\n' "$VERSION"
printf 'Review and commit the metadata, then use scripts/release/release.mjs with the reviewed full source SHA.\n'
printf 'That entrypoint requires exact-source CI to pass before it creates an immutable tag.\n'
printf 'Never combine versioning, tagging and pushing into one shortcut.\n\n'
