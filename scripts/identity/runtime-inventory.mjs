#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readIdentity, repoRoot } from "./identity.mjs";

const EXECUTABLE_EXTENSIONS = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".mjs", ".node", ".sh", ".ts", ".tsx", ".wasm",
]);
const OMIT_DIRECTORIES = new Set([".git", "coverage", "test", "tests", "__tests__"]);

function buildIdentity() {
  const fromEnvironment = process.env.GITHUB_SHA ?? process.env.SOURCE_SHA;
  if (fromEnvironment) return fromEnvironment;
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(); }
  catch { return "local-build"; }
}

function collect(root, starts, include = () => true) {
  const installRoot = realpathSync(root);
  const files = new Set();
  const directories = new Set();
  const visit = (candidate) => {
    let path;
    try { path = realpathSync(candidate); } catch { return; }
    const rel = relative(installRoot, path);
    if (rel === ".." || rel.startsWith(`..${sep}`)) return;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      const name = basename(path);
      if (directories.has(path) || OMIT_DIRECTORIES.has(name) || (name.startsWith(".") && name !== ".pnpm")) return;
      directories.add(path);
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }
    if (stat.isFile() && include(path, stat)) files.add(path);
  };
  for (const start of starts) if (existsSync(start)) visit(start);
  return [...files];
}

function executableFile(path, stat) {
  return EXECUTABLE_EXTENSIONS.has(extname(path).toLowerCase())
    || (stat.mode & 0o111) !== 0
    || basename(path) === "app.asar";
}

async function writer() {
  const built = join(repoRoot, "packages", "host", "dist", "runtime-generation.js");
  if (!existsSync(built)) throw new Error("Build @lasercode/host before generating a runtime inventory.");
  return import(pathToFileURL(built).href);
}

export async function generateWorkspaceManifest() {
  const identity = readIdentity();
  const packageNames = ["cli", "crypto", "desktop", "host", "pi-extension", "protocol", "ui", "worker"];
  const starts = packageNames.flatMap((name) => [
    join(repoRoot, "packages", name, "dist"),
    join(repoRoot, "packages", name, "package.json"),
  ]);
  // Follow the installed dependency closure from the processes that execute it.
  for (const name of ["cli", "desktop", "worker"]) starts.push(join(repoRoot, "packages", name, "node_modules"));
  const files = collect(repoRoot, starts, executableFile);
  const { writeRuntimeGenerationManifest } = await writer();
  return writeRuntimeGenerationManifest({
    installRoot: repoRoot,
    files,
    entries: {
      cli: "packages/cli/dist/main.js",
      worker: "packages/worker/dist/main.js",
      app: "packages/desktop/dist/main.js",
    },
    productVersion: JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version,
    buildIdentity: buildIdentity(),
  });
}

export async function generatePackagedManifest({ installRoot, resourcesPath, platform }) {
  const root = realpathSync(installRoot);
  const resources = realpathSync(resourcesPath);
  const nodeName = platform === "win32" ? "node.exe" : "node";
  const cli = join(resources, "app.asar.unpacked", "node_modules", "@lasercode", "cli", "dist", "main.js");
  const worker = join(resources, "app.asar.unpacked", "node_modules", "@lasercode", "worker", "dist", "main.js");
  const node = join(resources, "runtime", nodeName);
  const app = join(resources, "app.asar");
  for (const entry of [cli, worker, node, app]) {
    if (!existsSync(entry)) throw new Error(`packaged runtime entry is missing: ${relative(root, entry)}`);
  }
  const files = collect(root, [root], executableFile);
  const { writeRuntimeGenerationManifest } = await writer();
  const result = writeRuntimeGenerationManifest({
    installRoot: root,
    files,
    entries: {
      cli: relative(root, cli).split(sep).join("/"),
      worker: relative(root, worker).split(sep).join("/"),
      node: relative(root, node).split(sep).join("/"),
      app: relative(root, app).split(sep).join("/"),
    },
    productVersion: JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version,
    buildIdentity: buildIdentity(),
  });
  console.log(`${readIdentity().displayName}: runtime generation ${result.manifest.generationId.slice(0, 12)}… (${result.manifest.inventory.length} files)`);
  return result;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  if (process.argv[2] !== "--workspace") throw new Error("usage: runtime-inventory.mjs --workspace");
  const result = await generateWorkspaceManifest();
  console.log(`${readIdentity().displayName}: workspace runtime generation ${result.manifest.generationId.slice(0, 12)}… (${result.manifest.inventory.length} files)`);
}
