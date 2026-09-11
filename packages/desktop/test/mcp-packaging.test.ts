import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const checkerUrl = new URL("../scripts/check-mcp-artifact.mjs", import.meta.url).href;
const { assertAdapterFiles } = await import(checkerUrl) as { assertAdapterFiles(root: string): { assets: number; skills: number } };
const worker = createRequire(new URL("../../worker/package.json", import.meta.url));
const adapter = dirname(dirname(worker.resolve("pi-mcp-adapter/types")));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function copyAdapter(): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-artifact-"));
  roots.push(root);
  cpSync(adapter, root, { recursive: true });
  return root;
}

describe("MCP packaged executable assets", () => {
  it("accepts the real published adapter without its root documentation", () => {
    const root = copyAdapter();
    for (const file of ["README.md", "OAUTH.md", "CHANGELOG.md"]) rmSync(join(root, file), { force: true });
    expect(assertAdapterFiles(root).skills).toBeGreaterThan(0);
  });

  it.each(["index.ts", "server-manager.ts", "app-bridge.bundle.js", "mcp-keyring-helper.cjs", "mcp-script-worker.mjs"])("refuses a build missing %s", (file) => {
    const root = copyAdapter();
    rmSync(join(root, file));
    expect(() => assertAdapterFiles(root)).toThrow(`MCP executable asset missing: ${file}`);
  });

  it("refuses the old broad Markdown exclusion even if the skills directory survives", () => {
    const root = copyAdapter();
    rmSync(join(root, "skills"), { recursive: true });
    mkdirSync(join(root, "skills"));
    expect(() => assertAdapterFiles(root)).toThrow("MCP skill instructions were stripped");
  });
});

// Run the real hook in a synthetic pnpm store: a newly invisible sibling
// must refuse packaging for both scoped and unscoped subjects.
const hook = readFileSync(new URL("../build/before-pack.cjs", import.meta.url), "utf8");
describe("pnpm dependency visibility before packaging", () => {
  it.each(["@vendor/engine", "engine"])("detects an undeclared sibling of %s", async (subject) => {
    const root = mkdtempSync(join(tmpdir(), "mcp-visibility-"));
    roots.push(root);
    const { symlinkSync } = await import("node:fs");
    const { runInNewContext } = await import("node:vm");
    const dir = join(root, "node_modules", ".pnpm", "subject", "node_modules", subject);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: subject }));
    const sibling = join(root, "node_modules", ".pnpm", "subject", "node_modules", "missing-runtime");
    mkdirSync(sibling);
    const owner = join(root, "packages", "worker");
    mkdirSync(join(owner, "node_modules", dirname(subject)), { recursive: true });
    writeFileSync(join(owner, "package.json"), JSON.stringify({ dependencies: { [subject]: "1.0.0" } }));
    symlinkSync(dir, join(owner, "node_modules", subject), "dir");
    // Expose the existing helper from its CJS lexical scope; don't replace its
    // filesystem operations or algorithm. The product name is irrelevant here.
    const check = runInNewContext(`${hook}\nidentity = { name: 'fixture' }; assertTreeIsPackagable;`, {
      require: createRequire(import.meta.url), exports: {}, console,
      __dirname: fileURLToPath(new URL("../build", import.meta.url)),
    }) as (options: object) => void;
    const options = { packagesDir: join(root, "packages"), owner: "worker", subject, label: "fixture", declareIn: "packages/worker/package.json" };
    expect(() => check(options)).toThrow("needs missing-runtime");
    writeFileSync(join(owner, "package.json"), JSON.stringify({ dependencies: { [subject]: "1.0.0", "missing-runtime": "1.0.0" } }));
    expect(() => check(options)).not.toThrow();
  });
});
