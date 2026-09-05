#!/usr/bin/env node
/**
 * Write every file that carries the product's name, from product.json (MX-T7).
 *
 *   pnpm identity:generate
 *
 * Renaming the product is one edit to product.json and one run of this. If a
 * rename ever needs a second edit somewhere, that somewhere belongs in
 * `artifacts.mjs` or in the check.
 */
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { artifacts } from "./artifacts.mjs";
import { identity, repoRoot } from "./identity.mjs";

const changed = [];
for (const artifact of artifacts()) {
  const path = join(repoRoot, artifact.path);
  writeFileSync(path, artifact.contents);
  if (artifact.mode !== undefined) chmodSync(path, artifact.mode);
  changed.push(artifact.path);
}

// The Linux packaging owns three more files, in a directory git ignores, and
// knows how to name and validate them. Importing rather than re-implementing.
const { writeLinuxAssets } = await import("../../packages/desktop/scripts/make-linux-assets.mjs");
for (const asset of writeLinuxAssets({ quiet: true })) {
  changed.push(`packages/desktop/build/linux/generated/${asset.name}`);
}

process.stdout.write(
  `${identity.name} identity — ${identity.appId}, ${identity.schemePrefix}, ~/.local/share/${identity.dirName}\n` +
    changed.map((path) => `  ${path}\n`).join(""),
);
