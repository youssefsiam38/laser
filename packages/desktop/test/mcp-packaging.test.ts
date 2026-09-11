import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
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

  it.each(["config", "metadata-cache", "types"])("refuses an empty compiled export: %s", (name) => {
    const root = copyAdapter();
    rmSync(join(root, "dist", `${name}.js`));
    expect(() => assertAdapterFiles(root)).toThrow();
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
function hookFunction(name: string): (options: object) => void {
  return runInNewContext(`${hook}\nidentity = { name: 'fixture' }; ${name};`, {
    require: createRequire(import.meta.url), exports: {}, console,
    __dirname: fileURLToPath(new URL("../build", import.meta.url)),
  });
}
function link(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  symlinkSync(from, to, process.platform === "win32" ? "junction" : "dir");
}
function manifest(root: string, value: object): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify(value));
}
describe("pnpm dependency visibility before packaging", () => {
  it.each(["@vendor/engine", "engine"])("detects an undeclared sibling of %s", async (subject) => {
    const root = mkdtempSync(join(tmpdir(), "mcp-visibility-"));
    roots.push(root);

    const dir = join(root, "node_modules", ".pnpm", "subject", "node_modules", subject);
    mkdirSync(dir, { recursive: true });
    manifest(dir, { name: subject, peerDependencies: { "missing-runtime": "1.0.0" } });
    const sibling = join(root, "node_modules", ".pnpm", "subject", "node_modules", "missing-runtime");
    manifest(sibling, { name: "missing-runtime" });
    const desktop = join(root, "packages", "desktop");
    manifest(desktop, { dependencies: { "worker-fixture": "1.0.0" } });
    const disconnected = join(root, "packages", "disconnected");
    manifest(disconnected, { dependencies: { "missing-runtime": "1.0.0" } });
    link(sibling, join(disconnected, "node_modules", "missing-runtime"));
    const owner = join(root, "packages", "worker");
    mkdirSync(join(owner, "node_modules", dirname(subject)), { recursive: true });
    writeFileSync(join(owner, "package.json"), JSON.stringify({ dependencies: { [subject]: "1.0.0" } }));
    link(dir, join(owner, "node_modules", subject));
    link(sibling, join(owner, "node_modules", "missing-runtime"));
    link(owner, join(desktop, "node_modules", "worker-fixture"));
    // Expose the existing helper from its CJS lexical scope; don't replace its
    // filesystem operations or algorithm. The product name is irrelevant here.
    const check = hookFunction("assertTreeIsPackagable");
    const options = { packagesDir: join(root, "packages"), owner: "worker", subject, label: "fixture", declareIn: "packages/worker/package.json" };
    expect(() => check(options)).toThrow("needs missing-runtime");
    writeFileSync(join(owner, "package.json"), JSON.stringify({ dependencies: { [subject]: "1.0.0", "missing-runtime": "1.0.0" } }));
    expect(() => check(options)).not.toThrow();
  });
});


describe("MCP target native binding", () => {
  it("requires the adapter version from both the worker and the keyring store for arm64", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-binding-"));
    roots.push(root);
    const ownerRoot = join(root, "packages", "worker");
    const keyringRoot = join(root, "node_modules", ".pnpm", "keyring", "node_modules", "@napi-rs", "keyring");
    const binding = join(root, "node_modules", ".pnpm", "binding", "node_modules", "@napi-rs", "keyring-linux-arm64-gnu");
    const name = "@napi-rs/keyring-linux-arm64-gnu";
    manifest(ownerRoot, {});
    manifest(keyringRoot, { name: "@napi-rs/keyring", version: "1.3.0" });
    const options = { ownerRoot, keyringRoot, declareIn: "packages/worker/package.json", platform: "linux", arch: "arm64" };
    const check = hookFunction("assertNativeBindingIsStaged");
    expect(() => check(options)).toThrow(`must declare the target binding ${name}@1.3.0`);
    manifest(ownerRoot, { optionalDependencies: { [name]: "1.3.0" } });
    expect(() => check(options)).toThrow(`${name}@1.3.0 is not installed for linux-arm64`);
    manifest(binding, { name, version: "2.0.0", main: "binding.node" });
    writeFileSync(join(binding, "binding.node"), "resolve only; not executed");
    link(binding, join(ownerRoot, "node_modules", name));
    expect(() => check(options)).toThrow(`${name}@1.3.0 is not installed`);
    manifest(binding, { name, version: "1.3.0", main: "binding.node" });
    // A direct worker binding alone does not prove the adapter can resolve it.
    expect(() => check(options)).toThrow(`as resolved from ${keyringRoot}`);
    link(binding, join(keyringRoot, "..", "keyring-linux-arm64-gnu"));
    expect(() => check(options)).not.toThrow();
    rmSync(join(binding, "binding.node"));
    expect(() => check(options)).toThrow(`${name}@1.3.0 is not installed`);
  });
});
