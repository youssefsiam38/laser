import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FeatureGenerationStore,
  RuntimeGenerationError,
  RuntimeGenerationGuard,
  prepareRuntimeGeneration,
  readRuntimeGenerationPointer,
  runtimeVerificationMetrics,
  selectRuntimeGeneration,
  stageRuntimeGeneration,
  runtimeReferenceFromManifest,
  verifyRuntimeGeneration,
  writeRuntimeGenerationManifest,
} from "../src/runtime-generation.js";

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fixture(name = "one") {
  const root = mkdtempSync(join(tmpdir(), `runtime-generation-${name}-`));
  roots.push(root);
  const cli = join(root, "app", "cli.js");
  const worker = join(root, "app", "worker.js");
  const extension = join(root, "app", "extension.ts");
  const node = join(root, "runtime", "node");
  for (const [path, text] of [[cli, "cli"], [worker, `worker-${name}`], [extension, "export default 1"], [node, "node"]]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  chmodSync(node, 0o755);
  const written = writeRuntimeGenerationManifest({
    installRoot: root,
    files: [extension, worker, cli, node],
    entries: { cli: "app/cli.js", worker: "app/worker.js", node: "runtime/node" },
    productVersion: "1.0.0",
    buildIdentity: "build-one",
  });
  return { root, cli, worker, extension, node, ...written };
}

describe("runtime generation inventory", () => {
  it("derives the id from sorted path/length/digest rows and verifies executable TypeScript", () => {
    const first = fixture("sorted");
    const parsed = JSON.parse(readFileSync(first.path, "utf8")) as { generationId: string; inventory: Array<{ path: string }> };
    expect(parsed.inventory.map((row) => row.path)).toEqual([
      "app/cli.js", "app/extension.ts", "app/worker.js", "runtime/node",
    ]);
    expect(parsed.generationId).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyRuntimeGeneration(runtimeReferenceFromManifest(first.path), true).generationId).toBe(parsed.generationId);

    writeFileSync(first.extension, "export default 2");
    expect(() => verifyRuntimeGeneration(runtimeReferenceFromManifest(first.path))).toThrow(RuntimeGenerationError);
  });

  it("hashes entry files on every verification even when length and mtime are preserved", () => {
    const built = fixture("entry");
    const before = statSync(built.worker);
    writeFileSync(built.worker, "WORKER");
    utimesSync(built.worker, before.atime, before.mtime);
    expect(() => verifyRuntimeGeneration(runtimeReferenceFromManifest(built.path))).toThrowError(
      "The app's runtime files changed after they were installed. Reinstall the app before starting it.",
    );
  });

  it("treats a self-consistent manifest replaced in one fixed root as a staged update", () => {
    const state = mkdtempSync(join(tmpdir(), "runtime-generation-state-"));
    roots.push(state);
    const installed = fixture("active");
    const running = runtimeReferenceFromManifest(installed.path);
    const selected = prepareRuntimeGeneration(state, installed.cli);
    expect(selected.pointer).toMatchObject({
      schemaVersion: 1,
      active: runtimeReferenceFromManifest(installed.path),
    });
    expect(selected.pointer.active.verification).toBeDefined();
    expect(statSync(join(state, "runtime-generation.json")).mode & 0o777).toBe(0o600);

    writeFileSync(installed.worker, "worker-updated");
    const updated = writeRuntimeGenerationManifest({
      installRoot: installed.root,
      files: [installed.extension, installed.worker, installed.cli, installed.node],
      entries: { cli: "app/cli.js", worker: "app/worker.js", node: "runtime/node" },
      productVersion: "1.1.0",
      buildIdentity: "build-updated",
    });
    expect(() => new RuntimeGenerationGuard(running).verify()).toThrowError(
      "An update was installed. Restart the app and its host to use it.",
    );
    const staged = stageRuntimeGeneration(state, installed.cli);
    expect(staged.pointer.active.generationId).toBe(installed.manifest.generationId);
    expect(staged.pointer.pending?.generationId).toBe(updated.manifest.generationId);
    expect(readRuntimeGenerationPointer(state)).toEqual(staged.pointer);
    expect(readFileSync(join(state, "runtime-generation.json"), "utf8")).not.toContain('"inventory"');

    const activated = selectRuntimeGeneration(state, updated.manifest.generationId);
    expect(activated.active.generationId).toBe(updated.manifest.generationId);
    expect(activated.previousGenerationId).toBe(installed.manifest.generationId);
    expect(activated.pending).toBeUndefined();
    expect(() => verifyRuntimeGeneration(runtimeReferenceFromManifest(installed.path))).not.toThrow();
  });

  it("bounds unchanged verification and hashes bundled Node only once per generation", () => {
    const state = mkdtempSync(join(tmpdir(), "runtime-generation-bounded-"));
    roots.push(state);
    const built = fixture("bounded");
    prepareRuntimeGeneration(state, built.cli);
    const cold = runtimeVerificationMetrics();
    expect(cold).toMatchObject({ generationId: built.manifest.generationId, full: true, hashedFiles: 4 });

    prepareRuntimeGeneration(state, built.cli);
    const warm = runtimeVerificationMetrics();
    expect(warm).toMatchObject({ generationId: built.manifest.generationId, full: false, hashedFiles: 2 });
    expect(warm.hashedBytes).toBeLessThan(cold.hashedBytes);
    expect(warm.durationMs).toBeGreaterThanOrEqual(0);

    const before = statSync(built.extension);
    utimesSync(built.extension, before.atime, new Date(before.mtimeMs + 1_000));
    prepareRuntimeGeneration(state, built.cli);
    expect(runtimeVerificationMetrics()).toMatchObject({ full: false, hashedFiles: 3 });
  });

  it("keys immutable feature manifests to Feature prefs and retains only current plus previous", () => {
    const state = mkdtempSync(join(tmpdir(), "feature-generation-state-"));
    roots.push(state);
    const root = join(state, "feature-generations");
    const store = new FeatureGenerationStore(state, "a".repeat(64));
    const first = store.ensure({ cwd: "/private/project", featurePrefsRevision: 7, effectiveFeatures: ["web-access", "goals"], mode: "normal" });
    const pointerPath = join(root, "projects", `${first.cwdDigest}.json`);
    const unchanged = new Date("2001-01-01T00:00:00.000Z");
    utimesSync(pointerPath, unchanged, unchanged);

    // Reordering IDs — and unrelated preference writes, which do not change
    // featurePrefsRevision — cannot mint or rewrite a generation.
    const same = store.ensure({ cwd: "/private/project", featurePrefsRevision: 7, effectiveFeatures: ["goals", "web-access"], mode: "normal" });
    expect(same).toEqual(first);
    expect(statSync(pointerPath).mtimeMs).toBe(unchanged.getTime());

    const second = store.ensure({ cwd: "/private/project", featurePrefsRevision: 8, effectiveFeatures: ["goals", "web-access"], mode: "normal" });
    const third = store.ensure({ cwd: "/private/project", featurePrefsRevision: 8, effectiveFeatures: [], mode: "safe" });
    expect(new Set([first.featureGenerationId, second.featureGenerationId, third.featureGenerationId]).size).toBe(3);
    expect(JSON.parse(readFileSync(pointerPath, "utf8"))).toEqual({
      schemaVersion: 1,
      featureGenerationId: third.featureGenerationId,
      previousFeatureGenerationId: second.featureGenerationId,
    });
    expect(readdirSync(root).filter((name) => name.endsWith(".json")).sort()).toEqual([
      `${second.featureGenerationId}.json`,
      `${third.featureGenerationId}.json`,
    ].sort());

    const text = readFileSync(join(root, `${third.featureGenerationId}.json`), "utf8");
    expect(text).not.toContain("/private/project");
    expect(JSON.parse(text)).toMatchObject({ runtimeGenerationId: "a".repeat(64), desiredPrefsRevision: 8, mode: "safe" });
    expect(statSync(join(root, `${third.featureGenerationId}.json`)).mode & 0o777).toBe(0o600);
  });
});
