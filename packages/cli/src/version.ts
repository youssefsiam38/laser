/**
 * The CLI's version, read from its own package.json at runtime so a build never
 * ships a stale string. Falls back rather than throwing: a missing manifest is
 * not worth failing `laser --version` over.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function read(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/version.js → dist → package root
    const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
    return manifest.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const CLI_VERSION = read();
