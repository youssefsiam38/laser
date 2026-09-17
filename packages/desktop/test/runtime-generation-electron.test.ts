import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { PRODUCT_SLUG } from "@lasercode/protocol";
import { runtimeReferenceFromManifest, writeRuntimeGenerationManifest } from "@lasercode/cli";

const electron = createRequire(import.meta.url)("electron") as unknown as string;
// The workspace link resolves to the built CLI, the module the packaged preflight imports.
const cliModule = pathToFileURL(join(import.meta.dirname, "..", "node_modules", "@lasercode", "cli", "dist", "index.js")).href;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A minimal valid asar archive holding one file, so Electron's fs mounts it. */
function asarArchive(): Buffer {
  const data = Buffer.from("a");
  const json = JSON.stringify({ files: { "a.txt": { size: data.length, offset: "0" } } });
  const padded = Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(8 + padded);
  header.writeUInt32LE(4 + padded, 0);
  header.writeUInt32LE(json.length, 4);
  header.write(json, 8, "utf8");
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  return Buffer.concat([size, header, data]);
}

// 0.7.0 refused every launch: the desktop preflight verifies the inventory
// inside Electron, whose fs presents `app.asar` as a directory. Vitest runs
// plain Node, so this proves the verifier in the real Electron binary.
it("verifies an inventory that lists app.asar from inside Electron", () => {
  const root = mkdtempSync(join(tmpdir(), `${PRODUCT_SLUG}-electron-generation-`));
  roots.push(root);
  const resources = join(root, "resources");
  const cli = join(resources, "app.asar.unpacked", "cli", "main.js");
  const worker = join(resources, "app.asar.unpacked", "worker", "main.js");
  const app = join(resources, "app.asar");
  mkdirSync(join(resources, "app.asar.unpacked", "cli"), { recursive: true });
  mkdirSync(join(resources, "app.asar.unpacked", "worker"), { recursive: true });
  writeFileSync(cli, "export {};\n");
  writeFileSync(worker, "export {};\n");
  writeFileSync(app, asarArchive());
  const { path } = writeRuntimeGenerationManifest({
    installRoot: root,
    files: [cli, worker, app],
    entries: { cli: "resources/app.asar.unpacked/cli/main.js", worker: "resources/app.asar.unpacked/worker/main.js", app: "resources/app.asar" },
    productVersion: "0.0.0",
    buildIdentity: "test",
  });
  const reference = runtimeReferenceFromManifest(path);

  const probe = join(root, "probe.mjs");
  writeFileSync(probe, `
import { lstatSync } from "node:fs";
const [cliUrl, referenceJson, app] = process.argv.slice(2);
const { verifyRuntimeGeneration } = await import(cliUrl);
const asarIsDirectory = lstatSync(app).isDirectory();
try {
  verifyRuntimeGeneration(JSON.parse(referenceJson), true);
  console.log(JSON.stringify({ ok: true, asarIsDirectory, electron: process.versions.electron }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, asarIsDirectory, electron: process.versions.electron, error: String(error) }));
}
`);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete env.NODE_OPTIONS;
  const stdout = execFileSync(electron, [probe, cliModule, JSON.stringify(reference), app], {
    env, encoding: "utf8", timeout: 60_000,
  });
  const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as { ok: boolean; asarIsDirectory: boolean; electron?: string; error?: string };
  // The fixture is only meaningful if Electron really mounts the archive.
  expect(result.electron).toBeTruthy();
  expect(result.asarIsDirectory).toBe(true);
  expect(result).toMatchObject({ ok: true });
}, 60_000);
