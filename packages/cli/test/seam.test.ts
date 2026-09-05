/**
 * AGENTS.md invariant 1, for this package: the CLI speaks @lasercode/protocol and
 * never imports Pi. It resolves the pinned Pi's *path* (src/pi.ts) and spawns
 * it as a process — that is allowed, and importing it is not.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Real import/require/export-from statements, not the string in a comment. */
const PI_IMPORT = /(?:from|import|require)\s*\(?\s*["'](?:@earendil-works\/|pi-subagents)/;

describe("cli seam", () => {
  it("imports nothing from Pi", () => {
    for (const file of walk(join(import.meta.dirname, "../src"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(PI_IMPORT);
    }
  });

  it("declares no Pi dependency", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(all.filter((name) => name.startsWith("@earendil-works/") || name === "pi-subagents")).toEqual([]);
  });
});
