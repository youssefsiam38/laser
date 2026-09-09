import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Includes every emitted module/asset, not only the layer's entry file. */
export function artifactTreeSha256(directory) {
  const digest = createHash("sha256");
  function visit(relative = "") {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, entry.name);
      // This report describes the tree and cannot include its own bytes.
      if (path === "review-build.json") continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) digest.update(path).update("\0").update(readFileSync(join(directory, path))).update("\0");
      else throw new Error(`Unexpected artifact type: ${path}`);
    }
  }
  visit();
  return digest.digest("hex");
}
