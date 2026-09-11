#!/usr/bin/env node
/** Structural backstop beside the real-session gate: lazily used OAuth and
 * script-mode assets must ship even when the offline stdio probe doesn't use them.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function assertAdapterFiles(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  // Only the root Markdown documentation is disposable. In particular,
  // skills/**/*.md is executable instruction source and must not be stripped.
  const required = manifest.files.filter((file) => !/\.(md|markdown)$/.test(file));
  for (const file of required) {
    if (!existsSync(join(root, file))) throw new Error(`MCP executable asset missing: ${file}`);
  }
  const adapter = createRequire(join(root, "package.json"));
  for (const key of Object.keys(manifest.exports)) {
    const specifier = key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`;
    if (!existsSync(adapter.resolve(specifier))) throw new Error(`MCP export missing: ${specifier}`);
  }
  const skills = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "SKILL.md") skills.push(path);
    }
  }
  walk(join(root, "skills"));
  if (skills.length === 0) throw new Error("MCP skill instructions were stripped.");
  return { assets: required.length, skills: skills.length };
}

export function checkMcpArtifact(workerManifest, modules) {
  const worker = createRequire(workerManifest);
  const root = dirname(dirname(worker.resolve("pi-mcp-adapter/types")));
  const adapter = createRequire(join(root, "package.json"));
  const assets = assertAdapterFiles(root);
  const dependencies = {};
  function dependency(loader, name) {
    const path = realpathSync(loader.resolve(name));
    if (!path.startsWith(`${realpathSync(modules)}${sep}`)) throw new Error(`${name} resolves outside the packaged dependency tree: ${path}`);
    dependencies[name] = path;
    return path;
  }
  dependency(worker, "jiti");
  dependency(worker, "smol-toml");
  dependency(adapter, "@modelcontextprotocol/client");
  dependency(adapter, "@modelcontextprotocol/core");
  const keyringPath = dependency(adapter, "@napi-rs/keyring");
  const keyringVersion = JSON.parse(readFileSync(join(dirname(keyringPath), "package.json"), "utf8")).version;
  if (!keyringPath.startsWith(`${realpathSync(root)}${sep}`)) throw new Error(`MCP resolved the desktop's keyring instead of its own: ${keyringPath}`);
  const suffix = { linux: `linux-${process.arch}-gnu`, darwin: `darwin-${process.arch}`, win32: `win32-${process.arch}-msvc` }[process.platform];
  const keyring = createRequire(keyringPath);
  const bindingPath = dependency(keyring, `@napi-rs/keyring-${suffix}`);
  const bindingVersion = JSON.parse(readFileSync(join(dirname(bindingPath), "package.json"), "utf8")).version;
  if (bindingVersion !== keyringVersion) throw new Error(`MCP keyring binding ${bindingVersion} does not match ${keyringVersion}.`);
  // Load the binding, but never create an Entry or access the person's keyring.
  if (typeof keyring("@napi-rs/keyring").Entry !== "function") throw new Error("MCP keyring native binding did not load.");
  const fsPath = dependency(adapter, "fs-native-extensions");
  const prebuild = join(dirname(fsPath), "prebuilds", `${process.platform}-${process.arch}`, "fs-native-extensions.node");
  if (!existsSync(prebuild)) throw new Error(`MCP filesystem native prebuild missing: ${prebuild}`);
  adapter("fs-native-extensions");
  return { ...assets, keyringVersion, dependencies, prebuild };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify({ ok: true, ...checkMcpArtifact(process.argv[2], process.argv[3]) })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}
