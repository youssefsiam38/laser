import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCT_SLUG } from "@lasercode/protocol";
import { UpdateTransactionStore, type MigrationRegistry } from "@lasercode/host";
import {
  MigrationActivationError,
  completeInstalledMigration,
  migrationEventLine,
  prepareUpdateData,
  restoreUpdateData,
  type InstalledRuntimeLaunch,
  type LaserPaths,
  type MigrationLaunchEvent,
} from "../src/index.js";

function fixture(): { root: string; paths: LaserPaths; store: UpdateTransactionStore; updateId: string } {
  const root = mkdtempSync(join(tmpdir(), `${PRODUCT_SLUG}-migration-launch-`));
  const stateDir = join(root, "state");
  const agentDir = join(root, "agent");
  const sessionDir = join(agentDir, "sessions");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(stateDir, "fixture.txt"), "before\n", { mode: 0o600 });
  const paths: LaserPaths = {
    stateDir, agentDir, sessionDir,
    hostFile: join(stateDir, "host.json"), logFile: join(stateDir, "host.log"),
    host: "127.0.0.1", port: 1, portIsExplicit: true,
  };
  const store = new UpdateTransactionStore(stateDir);
  const updateId = "d".repeat(64);
  store.begin({
    updateId, targetGenerationId: "b".repeat(64), previousGenerationId: "a".repeat(64),
    targetVersion: "2.0.0", buildIdentity: "fixture", manifestDigest: "c".repeat(64),
  });
  store.transition(updateId, "staging");
  store.transition(updateId, "staged");
  store.transition(updateId, "parking");
  return { root, paths, store, updateId };
}

const registry = (fail = false): MigrationRegistry => {
  const unit = { root: "stateDir" as const, path: "fixture.txt", type: "file" as const };
  return {
    targetSchema: 2,
    steps: [{ id: "synthetic-v2", fromSchema: 1, toSchema: 2, units: [unit], run(context) {
      context.writeFile(unit, "after\n", 0o640);
      if (fail) throw new Error("synthetic failure");
    } }],
  };
};

describe("pre-host migration activation", () => {
  it("snapshots and runs a staged synthetic migration before marking the transaction ready", () => {
    const { paths, store, updateId } = fixture();
    const events: MigrationLaunchEvent[] = [];
    prepareUpdateData(paths, { updateId, targetGenerationId: "b".repeat(64) }, (event) => events.push(event), { registry: registry() });

    expect(readFileSync(join(paths.stateDir, "fixture.txt"), "utf8")).toBe("after\n");
    expect(store.read(updateId)?.phase).toBe("ready");
    expect(events.map(({ phase }) => phase)).toEqual(["preparing", "migrating", "ready"]);
    const line = migrationEventLine(events[1]!);
    expect(JSON.parse(line)).toMatchObject({ schemaVersion: 1, type: "migration", updateId, phase: "migrating" });
    expect(line).not.toContain(paths.stateDir);
    expect(line).not.toContain("before");

    store.transition(updateId, "selected");
    store.transition(updateId, "restarting");
    const installed = {
      migrationUpdateId: updateId,
      reference: { generationId: "b".repeat(64) },
      manifest: { productVersion: "2.0.0" },
    } as unknown as InstalledRuntimeLaunch;
    expect(completeInstalledMigration(paths, installed, {
      launchId: "a".repeat(32), generationId: "e".repeat(64), cliVersion: "2.0.0",
    })).toBe(false);
    expect(completeInstalledMigration(paths, installed, {
      launchId: "a".repeat(32), generationId: "b".repeat(64), cliVersion: "2.0.0",
    })).toBe(true);
    expect(store.read(updateId)?.phase).toBe("succeeded");
    expect(existsSync(join(paths.stateDir, "migration-snapshots", updateId))).toBe(false);
    expect(completeInstalledMigration(paths, installed, {
      launchId: "a".repeat(32), generationId: "b".repeat(64), cliVersion: "2.0.0",
    })).toBe(true);
  });

  it("keeps the snapshot on failure and restores exact bytes for the correlated update only", () => {
    const { paths, store, updateId } = fixture();
    expect(() => prepareUpdateData(paths, { updateId, targetGenerationId: "b".repeat(64) }, undefined, { registry: registry(true) }))
      .toThrow(MigrationActivationError);
    expect(store.read(updateId)?.phase).toBe("failed");
    expect(readFileSync(join(paths.stateDir, "fixture.txt"), "utf8")).toBe("after\n");

    expect(() => restoreUpdateData(paths, "e".repeat(64))).toThrow(MigrationActivationError);
    restoreUpdateData(paths, updateId);
    expect(readFileSync(join(paths.stateDir, "fixture.txt"), "utf8")).toBe("before\n");
    expect(store.read(updateId)?.phase).toBe("rolled_back");

    prepareUpdateData(paths, { updateId, targetGenerationId: "b".repeat(64) }, undefined, { registry: registry() });
    expect(readFileSync(join(paths.stateDir, "fixture.txt"), "utf8")).toBe("after\n");
    expect(store.read(updateId)?.phase).toBe("ready");
  });
});
