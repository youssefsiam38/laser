import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  MigrationEngine,
  UpdateTransactionStore,
  readMigrationState,
  readRuntimeGenerationPointer,
  type MigrationRegistry,
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
  const install = join(root, "installed");
  const generation = (name: string, version: string) => {
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
  const oldReference = runtimeReferenceFromManifest(old.path);
  const target = generation("target", "1.1.0");
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
  const paths = {
    stateDir, agentDir: join(root, "agent"), sessionDir: join(root, "agent", "sessions"),
    hostFile: join(stateDir, "host.json"), logFile: join(stateDir, "host.log"),
    host: "127.0.0.1", port: 1, portIsExplicit: true,
  };
  const activation = new DesktopUpdateActivation({ stateDir, paths, link, publish: (status) => statuses.push(status) });
  return {
    activation, marker, stateDir, paths, link, statuses,
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
  expect(new UpdateTransactionStore(h.stateDir).read(h.marker.updateId)?.phase).toBe("ready");
  expect(readMigrationState(h.stateDir)).toBeUndefined();
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

it("keeps the fixed-root selection and offers honest recovery when verified launch fails", async () => {
  const h = harness();
  h.activation.discover(h.marker);
  h.setBlockers({});
  await h.activation.prepare();
  await h.activation.activate();
  const selected = readRuntimeGenerationPointer(h.stateDir)!;
  expect(selected.previousGenerationId).toBeDefined();
  h.activation.failLaunch();
  expect(readRuntimeGenerationPointer(h.stateDir)?.active.generationId).toBe(h.marker.generationId);
  expect(new UpdateTransactionStore(h.stateDir).read(h.marker.updateId)?.phase).toBe("failed");
  expect(h.statuses.at(-1)).toMatchObject({
    state: "failed",
    updateId: h.marker.updateId,
    action: "retry",
    actionLabel: "Try again",
  });
  expect((h.statuses.at(-1) as { message: string }).message).toContain("reinstall the app");
  expect((h.statuses.at(-1) as { message: string }).message).toContain("available to restore");
  h.activation.stop();
});

it("offers and completes exact snapshot restore after migration failure", async () => {
  const h = harness();
  const unit = { root: "stateDir" as const, path: "synthetic.txt", type: "file" as const };
  writeFileSync(join(h.stateDir, unit.path), "before\n", { mode: 0o600 });
  const registry: MigrationRegistry = {
    targetSchema: 2,
    steps: [{ id: "synthetic-v2", fromSchema: 1, toSchema: 2, units: [unit], run(context) {
      context.writeFile(unit, "after\n");
      throw new Error("fault");
    } }],
  };
  const transactions = new UpdateTransactionStore(h.stateDir);
  transactions.transition(h.marker.updateId, "parking");
  transactions.transition(h.marker.updateId, "snapshotting");
  transactions.transition(h.marker.updateId, "migrating");
  expect(() => new MigrationEngine({
    roots: { stateDir: h.paths.stateDir, agentDir: h.paths.agentDir, sessionDir: h.paths.sessionDir }, registry,
  }).migrate({ updateId: h.marker.updateId, targetGenerationId: h.marker.generationId })).toThrow(/prepare your data safely/);
  transactions.transition(h.marker.updateId, "failed", { failureCategory: "migration_failed" });

  // Models a package-manager install: the durable transaction/marker exists,
  // but no native-update marker was ever discovered in this Electron process.
  await expect(h.activation.restore(h.marker.updateId)).resolves.toMatchObject({
    state: "restored", title: "Previous data restored. The update was not activated.",
  });
  expect(readFileSync(join(h.stateDir, unit.path), "utf8")).toBe("before\n");
  expect(transactions.read(h.marker.updateId)?.phase).toBe("rolled_back");
  h.activation.stop();
});

it("uses neutral copy when no correlated snapshot exists", async () => {
  const h = harness();
  await expect(h.activation.restore("e".repeat(64))).resolves.toMatchObject({
    state: "no-snapshot",
    message: "There is no earlier data snapshot to restore.",
  });
  expect((h.statuses.at(-1) as { message: string }).message).not.toContain("restored");
  h.activation.stop();
});

it("survives coordinator replacement by update id and matching cancel reopens admission", async () => {
  const h = harness();
  h.activation.discover(h.marker);
  await h.activation.prepare();
  h.activation.stop();
  const resumedStatuses: unknown[] = [];
  const resumed = new DesktopUpdateActivation({ stateDir: h.stateDir, paths: h.paths, link: h.link, publish: (status) => resumedStatuses.push(status) });
  expect(resumed.resume(h.marker)).toMatchObject({ state: "parking", updateId: h.marker.updateId });
  await expect(resumed.cancel()).resolves.toMatchObject({ state: "downloaded", updateId: h.marker.updateId });
  expect(h.link.cancelActivation).toHaveBeenCalledExactlyOnceWith(h.marker.updateId);
  expect(new UpdateTransactionStore(h.stateDir).read(h.marker.updateId)?.phase).toBe("staged");
  resumed.stop();
});
