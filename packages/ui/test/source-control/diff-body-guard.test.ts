import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const uiRoot = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);

it("puts Pierre in a sibling chunk, not the overlay entry", async () => {
  const esbuild = require("esbuild") as typeof import("esbuild");
  const outdir = mkdtempSync(join(tmpdir(), "changes-chunks-"));
  try {
    const result = await esbuild.build({
      absWorkingDir: uiRoot,
      entryPoints: ["src/source-control/index.ts"],
      bundle: true,
      splitting: true,
      format: "esm",
      outdir,
      write: true,
      jsx: "automatic",
      packages: "external",
      alias: { "@": join(uiRoot, "src") },
      logLevel: "silent",
    });
    expect(result.errors).toEqual([]);
    const files = readdirSync(outdir).filter((name) => name.endsWith(".js"));
    const entryName = files.find((name) => name.startsWith("index")) ?? files[0]!;
    const entry = readFileSync(join(outdir, entryName), "utf8");
    expect(entry).not.toMatch(/@pierre/);
    const siblings = files.filter((name) => name !== entryName).map((name) => readFileSync(join(outdir, name), "utf8"));
    expect(siblings.some((chunk) => chunk.includes("@pierre"))).toBe(true);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
});
