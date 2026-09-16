import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FeatureGenerationStore,
  RuntimeGenerationError,
  prepareRuntimeGeneration,
  readRuntimeGenerationPointer,
  selectRuntimeGeneration,
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

  it("selects atomically and retains only active, previous and pending references", () => {
    const state = mkdtempSync(join(tmpdir(), "runtime-generation-state-"));
    roots.push(state);
    const first = fixture("active");
    const selected = prepareRuntimeGeneration(state, first.cli);
    expect(selected.pointer).toEqual({ schemaVersion: 1, active: runtimeReferenceFromManifest(first.path) });
    expect(statSync(join(state, "runtime-generation.json")).mode & 0o777).toBe(0o600);

    const second = fixture("pending");
    const staged = prepareRuntimeGeneration(state, second.cli);
    expect(staged.pointer.active.generationId).toBe(first.manifest.generationId);
    expect(staged.pointer.pending?.generationId).toBe(second.manifest.generationId);
    expect(readRuntimeGenerationPointer(state)).toEqual(staged.pointer);
    expect(readFileSync(join(state, "runtime-generation.json"), "utf8")).not.toContain("inventory");

    const activated = selectRuntimeGeneration(state, second.manifest.generationId);
    expect(activated.active.generationId).toBe(second.manifest.generationId);
    expect(activated.previous?.generationId).toBe(first.manifest.generationId);
    expect(activated.pending).toBeUndefined();
  });

  it("writes immutable feature manifests that reference the runtime without retaining cwd", () => {
    const state = mkdtempSync(join(tmpdir(), "feature-generation-state-"));
    roots.push(state);
    const store = new FeatureGenerationStore(state, "a".repeat(64));
    const first = store.ensure({ cwd: "/private/project", desiredPrefsRevision: 7, effectiveFeatures: ["web-access", "goals"], mode: "normal" });
    const second = store.ensure({ cwd: "/private/project", desiredPrefsRevision: 7, effectiveFeatures: ["goals", "web-access"], mode: "normal" });
    expect(second).toEqual(first);
    const text = readFileSync(join(state, "feature-generations", `${first.featureGenerationId}.json`), "utf8");
    expect(text).not.toContain("/private/project");
    expect(JSON.parse(text)).toMatchObject({ runtimeGenerationId: "a".repeat(64), desiredPrefsRevision: 7, mode: "normal" });
    expect(statSync(join(state, "feature-generations", `${first.featureGenerationId}.json`)).mode & 0o777).toBe(0o600);
  });
});
