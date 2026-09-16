import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  UpdateTransactionStore,
  runtimeReferenceFromManifest,
  runtimeUpdateId,
  writeRuntimeGenerationPointer,
  writeRuntimeGenerationManifest,
} from "@lasercode/cli";
import { NativeUpdateWatch, installedHostVersion, type NativeUpdateMarker } from "../src/native-update.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "native-update-test-")); roots.push(root); return root;
};

function installedFixture() {
  const install = fixture();
  const resources = join(install, "resources");
  const stateDir = join(install, "state");
  const app = join(install, "app");
  mkdirSync(resources, { recursive: true });
  mkdirSync(app, { recursive: true });
  const cli = join(app, "cli.js");
  const worker = join(app, "worker.js");
  writeFileSync(cli, "old-cli");
  writeFileSync(worker, "old-worker");
  const old = writeRuntimeGenerationManifest({
    installRoot: install,
    files: [cli, worker],
    entries: { cli: "app/cli.js", worker: "app/worker.js" },
    productVersion: "1.0.0",
    buildIdentity: "old-build",
  });
  writeRuntimeGenerationPointer(stateDir, { schemaVersion: 1, active: runtimeReferenceFromManifest(old.path) });

  const publish = (version: string, suffix: string): NativeUpdateMarker => {
    writeFileSync(cli, `new-cli-${suffix}`);
    writeFileSync(worker, `new-worker-${suffix}`);
    const next = writeRuntimeGenerationManifest({
      installRoot: install,
      files: [cli, worker],
      entries: { cli: "app/cli.js", worker: "app/worker.js" },
      productVersion: version,
      buildIdentity: `build-${suffix}`,
    });
    const marker: NativeUpdateMarker = {
      schemaVersion: 1,
      version,
      buildIdentity: next.manifest.buildIdentity,
      generationId: next.manifest.generationId,
      manifestDigest: next.manifestDigest,
      updateId: runtimeUpdateId(next.manifest),
    };
    writeFileSync(join(resources, "native-update.json"), `${JSON.stringify(marker)}\n`);
    return marker;
  };
  return { install, resources, stateDir, cli, publish };
}

it("announces only a verified correlated install, stages it and never decides to restart", () => {
  const f = installedFixture(), ready = vi.fn();
  const watch = new NativeUpdateWatch({ resources: f.resources, stateDir: f.stateDir, currentEntry: f.cli, running: "1.0.0", onReady: ready });
  expect(watch.check()).toBeUndefined();
  writeFileSync(join(f.resources, "native-update.json"), '{"version":"1.0.1"}');
  expect(watch.check()).toBeUndefined();
  const marker = f.publish("1.0.1", "one");
  expect(watch.check()).toEqual(marker);
  expect(watch.check()).toEqual(marker);
  expect(ready).toHaveBeenCalledExactlyOnceWith(marker);
  expect(new UpdateTransactionStore(f.stateDir).read(marker.updateId)).toMatchObject({
    phase: "staged",
    targetGenerationId: marker.generationId,
    targetVersion: marker.version,
  });
});

it("polling stops on exit and a subsequent verified update is announced once", () => {
  vi.useFakeTimers();
  const f = installedFixture(), ready = vi.fn();
  const watch = new NativeUpdateWatch({ resources: f.resources, stateDir: f.stateDir, currentEntry: f.cli, running: "1.0.0", onReady: ready });
  watch.start();
  const first = f.publish("1.0.1", "one");
  vi.advanceTimersByTime(30_000); expect(ready).toHaveBeenCalledExactlyOnceWith(first);
  watch.stop();
  const second = f.publish("1.0.2", "two");
  vi.advanceTimersByTime(60_000); expect(ready).toHaveBeenCalledTimes(1);
  watch.check(); expect(ready).toHaveBeenLastCalledWith(second);
});

it("reads installed host files uncached so an old supervisor cannot spawn a newer daemon", () => {
  const root = fixture(), dir = join(root, "app.asar.unpacked/node_modules/@lasercode/cli");
  mkdirSync(dir, { recursive: true });
  const manifest = join(dir, "package.json");
  writeFileSync(manifest, '{"version":"1.0.0"}'); expect(installedHostVersion(root)).toBe("1.0.0");
  writeFileSync(manifest, '{"version":"1.0.1"}'); expect(installedHostVersion(root)).toBe("1.0.1");
});
