import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  UpdateTransactionStore,
  readRuntimeGenerationPointer,
  runtimeReferenceFromManifest,
  runtimeUpdateId,
  writeRuntimeGenerationManifest,
  writeRuntimeGenerationPointer,
} from "@lasercode/cli";
import type { RuntimeActivationState } from "@lasercode/protocol";
import type { HostLink } from "../src/host-link.js";
import type { NativeUpdateMarker } from "../src/native-update.js";
import { DesktopUpdateActivation } from "../src/update-activation.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });

function harness() {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "desktop-update-activation-")); roots.push(root);
  const stateDir = join(root, "state");
  const generation = (name: string, version: string) => {
    const install = join(root, name);
    mkdirSync(join(install, "app"), { recursive: true });
    const cli = join(install, "app", "cli.js");
    const worker = join(install, "app", "worker.js");
    writeFileSync(cli, `${name}-cli`); writeFileSync(worker, `${name}-worker`);
    return writeRuntimeGenerationManifest({
      installRoot: install, files: [cli, worker], entries: { cli: "app/cli.js", worker: "app/worker.js" },
      productVersion: version, buildIdentity: `${name}-build`,
    });
  };
  const old = generation("old", "1.0.0");
  const target = generation("target", "1.1.0");
  const oldReference = runtimeReferenceFromManifest(old.path);
  const targetReference = runtimeReferenceFromManifest(target.path);
  writeRuntimeGenerationPointer(stateDir, { schemaVersion: 1, active: oldReference, pending: targetReference });
  const marker: NativeUpdateMarker = {
    schemaVersion: 1,
    version: target.manifest.productVersion,
    buildIdentity: target.manifest.buildIdentity,
    generationId: target.manifest.generationId,
    manifestDigest: target.manifestDigest,
    updateId: runtimeUpdateId(target.manifest),
  };
  new UpdateTransactionStore(stateDir).begin({
    updateId: marker.updateId,
    targetGenerationId: marker.generationId,
    previousGenerationId: old.manifest.generationId,
    targetVersion: marker.version,
    buildIdentity: marker.buildIdentity,
    manifestDigest: marker.manifestDigest,
  });
  const transactions = new UpdateTransactionStore(stateDir);
  transactions.transition(marker.updateId, "staging");
  transactions.transition(marker.updateId, "staged");
  let blockers: RuntimeActivationState["blockers"] = { conversations: 1, agents: 0, questions: 0, approvals: 0, commands: 0, mutations: 0, workers: 0 };
  const gate = (): RuntimeActivationState => ({
    updateId: marker.updateId,
    generationId: marker.generationId,
    phase: Object.values(blockers).every((count) => count === 0) ? "parked" : "parking",
    blockers,
  });
  const link = {
    prepareActivation: vi.fn(async () => gate()),
    activationStatus: vi.fn(async () => gate()),
    cancelActivation: vi.fn(async () => ({ ...gate(), phase: "cancelled" as const })),
  } as unknown as HostLink;
  const statuses: unknown[] = [];
  const activation = new DesktopUpdateActivation({ stateDir, link, publish: (status) => statuses.push(status) });
  return {
    activation, marker, stateDir, link, statuses,
    setBlockers(next: Partial<RuntimeActivationState["blockers"]>) {
      blockers = { conversations: 0, agents: 0, questions: 0, approvals: 0, commands: 0, mutations: 0, workers: 0, ...next };
    },
  };
}

it("correlates download, parking, selection and exact launch success", async () => {
  const h = harness();
  expect(h.activation.discover(h.marker)).toMatchObject({ state: "downloaded", updateId: h.marker.updateId });
  await expect(h.activation.prepare()).resolves.toMatchObject({ state: "parking", blockers: { conversations: 1 } });
  expect(h.link.prepareActivation).toHaveBeenCalledExactlyOnceWith(h.marker.updateId, h.marker.generationId);
  h.setBlockers({});
  await expect(h.activation.prepare()).resolves.toMatchObject({ state: "ready", updateId: h.marker.updateId });
  await expect(h.activation.activate()).resolves.toBe(true);
  expect(readRuntimeGenerationPointer(h.stateDir)?.active.generationId).toBe(h.marker.generationId);
  expect(new UpdateTransactionStore(h.stateDir).read(h.marker.updateId)?.phase).toBe("restarting");

  h.activation.completeLaunch({ launchId: "a".repeat(32), generationId: "f".repeat(64), version: h.marker.version });
  expect(new UpdateTransactionStore(h.stateDir).read(h.marker.updateId)?.phase).toBe("restarting");
  const verified = { launchId: "b".repeat(32), generationId: h.marker.generationId, version: h.marker.version };
  h.activation.completeLaunch(verified);
  h.activation.completeLaunch(verified);
  expect(new UpdateTransactionStore(h.stateDir).read(h.marker.updateId)).toMatchObject({
    phase: "succeeded", selectedLaunchId: "b".repeat(32), selectedVersion: h.marker.version,
  });
  expect(h.statuses.filter((status) => (status as { state?: string }).state === "succeeded")).toHaveLength(1);
  h.activation.stop();
});

it("restores the previous verified generation when the selected host cannot prove launch", async () => {
  const h = harness();
  h.activation.discover(h.marker);
  h.setBlockers({});
  await h.activation.prepare();
  await h.activation.activate();
  const selected = readRuntimeGenerationPointer(h.stateDir)!;
  const previousId = selected.previous!.generationId;
  h.activation.failLaunch();
  expect(readRuntimeGenerationPointer(h.stateDir)?.active.generationId).toBe(previousId);
  expect(new UpdateTransactionStore(h.stateDir).read(h.marker.updateId)?.phase).toBe("rolled_back");
  expect(h.statuses.at(-1)).toMatchObject({ state: "failed", updateId: h.marker.updateId });
  h.activation.stop();
});

it("survives coordinator replacement by update id and matching cancel reopens admission", async () => {
  const h = harness();
  h.activation.discover(h.marker);
  await h.activation.prepare();
  h.activation.stop();
  const resumedStatuses: unknown[] = [];
  const resumed = new DesktopUpdateActivation({ stateDir: h.stateDir, link: h.link, publish: (status) => resumedStatuses.push(status) });
  expect(resumed.resume(h.marker)).toMatchObject({ state: "parking", updateId: h.marker.updateId });
  await expect(resumed.cancel()).resolves.toMatchObject({ state: "downloaded", updateId: h.marker.updateId });
  expect(h.link.cancelActivation).toHaveBeenCalledExactlyOnceWith(h.marker.updateId);
  expect(new UpdateTransactionStore(h.stateDir).read(h.marker.updateId)?.phase).toBe("staged");
  resumed.stop();
});
