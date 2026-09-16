import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MigrationEngine,
  MigrationError,
  type MigrationBoundary,
  type MigrationRegistry,
  type MigrationRoots,
} from "../../src/migrations/index.js";

const UPDATE = "a".repeat(64);
const GENERATION = "b".repeat(64);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const configUnit = { root: "stateDir", path: "data/config.json", type: "file" } as const;
const cacheUnit = { root: "agentDir", path: "cache", type: "directory" } as const;

const registry: MigrationRegistry = {
  targetSchema: 3,
  steps: [
    {
      id: "add-layout",
      fromSchema: 1,
      toSchema: 2,
      units: [configUnit],
      run(context) {
        const value = JSON.parse(context.readFile(configUnit).toString("utf8")) as Record<string, unknown>;
        context.writeFile(configUnit, `${JSON.stringify({ ...value, layout: 2 })}\n`, 0o640);
      },
    },
    {
      id: "rewrite-cache",
      fromSchema: 2,
      toSchema: 3,
      units: [cacheUnit],
      run(context) {
        const files = new Map(context.readDirectory(cacheUnit));
        files.set("version.txt", "3\n");
        context.replaceDirectory(cacheUnit, files, 0o750);
      },
    },
  ],
};

function fixture(options: { boundary?: (boundary: MigrationBoundary, detail: string) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), "migration-engine-")); roots.push(root);
  const paths: MigrationRoots = {
    stateDir: join(root, "state"),
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
  };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const config = join(paths.stateDir, configUnit.path);
  const cache = join(paths.agentDir, cacheUnit.path);
  mkdirSync(join(cache, "nested"), { recursive: true, mode: 0o750 });
  mkdirSync(join(paths.stateDir, "data"), { recursive: true });
  writeFileSync(config, '{"name":"before"}\n', { mode: 0o640 });
  writeFileSync(join(cache, "version.txt"), "1\n", { mode: 0o640 });
  writeFileSync(join(cache, "nested", "value.bin"), Buffer.from([1, 2, 3]), { mode: 0o600 });
  chmodSync(cache, 0o750); chmodSync(join(cache, "nested"), 0o710);
  const engine = new MigrationEngine({ roots: paths, registry, ...options });
  return { root, paths, config, cache, engine };
}

function assertPrior(f: ReturnType<typeof fixture>): void {
  expect(readFileSync(f.config, "utf8")).toBe('{"name":"before"}\n');
  expect(readFileSync(join(f.cache, "version.txt"), "utf8")).toBe("1\n");
  expect([...readFileSync(join(f.cache, "nested", "value.bin"))]).toEqual([1, 2, 3]);
  expect(lstatSync(f.config).mode & 0o777).toBe(0o640);
  expect(lstatSync(f.cache).mode & 0o777).toBe(0o750);
  expect(lstatSync(join(f.cache, "nested")).mode & 0o777).toBe(0o710);
}

function assertMigrated(f: ReturnType<typeof fixture>): void {
  expect(JSON.parse(readFileSync(f.config, "utf8"))).toEqual({ name: "before", layout: 2 });
  expect(readFileSync(join(f.cache, "version.txt"), "utf8")).toBe("3\n");
  expect(f.engine.currentSchema()).toBe(3);
}

function completeAfterFault(f: ReturnType<typeof fixture>): void {
  const restarted = new MigrationEngine({ roots: f.paths, registry });
  const state = restarted.currentState();
  if (state) {
    const result = restarted.recover({ targetVerified: true });
    if (result.status === "restored") restarted.migrate({ updateId: UPDATE, targetGenerationId: GENERATION });
  } else restarted.migrate({ updateId: UPDATE, targetGenerationId: GENERATION });
  assertMigrated({ ...f, engine: restarted });
}

describe("migration snapshot and restore", () => {
  it("snapshots whole declared units, verifies before mutation, and restores exact bytes and modes", () => {
    const f = fixture();
    const migrated = f.engine.migrate({ updateId: UPDATE, targetGenerationId: GENERATION });
    expect(migrated).toMatchObject({ phase: "migrated", stepIndex: 2, snapshotDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    assertMigrated(f);
    const manifestPath = join(f.paths.stateDir, "migration-snapshots", UPDATE, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { units: Array<Record<string, unknown>> };
    expect(manifest.units).toEqual(expect.arrayContaining([
      expect.objectContaining({ root: "stateDir", path: configUnit.path, type: "file", mode: 0o640, length: 18, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      expect.objectContaining({ root: "agentDir", path: cacheUnit.path, type: "directory", mode: 0o750, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    ]));
    expect(lstatSync(dirname(manifestPath)).mode & 0o777).toBe(0o700);

    f.engine.restore(UPDATE);
    expect(f.engine.currentState()).toBeUndefined();
    expect(f.engine.currentSchema()).toBe(1);
    assertPrior(f);
    expect(existsSync(join(f.paths.stateDir, "migration-snapshots", UPDATE))).toBe(true);
  });

  it("keeps the verified snapshot through selection and deletes it only after healthy success", () => {
    const f = fixture();
    f.engine.migrate({ updateId: UPDATE, targetGenerationId: GENERATION });
    f.engine.markLaunchAttempt(UPDATE, "c".repeat(32));
    f.engine.acknowledgeSelection(UPDATE, "c".repeat(32));
    expect(f.engine.currentState()).toBeUndefined();
    expect(existsSync(join(f.paths.stateDir, "migration-snapshots", UPDATE))).toBe(true);
    f.engine.markSucceeded(UPDATE);
    expect(existsSync(join(f.paths.stateDir, "migration-snapshots", UPDATE))).toBe(false);
  });

  it("refuses corrupt snapshots without changing the migrated units", () => {
    const f = fixture();
    f.engine.migrate({ updateId: UPDATE, targetGenerationId: GENERATION });
    writeFileSync(join(f.paths.stateDir, "migration-snapshots", UPDATE, "data", "stateDir", "data", "config.json"), "corrupt");
    expect(() => f.engine.restore(UPDATE)).toThrowError("The previous data snapshot is damaged.");
    assertMigrated(f);
    expect(f.engine.currentState()).toMatchObject({ phase: "restoring", failureCategory: "restore" });
  });

  it("refuses traversal, symlink units and newer schemas", () => {
    const f = fixture();
    expect(() => new MigrationEngine({ roots: f.paths, registry: {
      targetSchema: 2,
      steps: [{ id: "escape", fromSchema: 1, toSchema: 2, units: [{ root: "stateDir", path: "../outside", type: "file" }], run() {} }],
    } })).toThrow(MigrationError);

    const link = join(f.paths.stateDir, "linked");
    const target = join(f.root, "outside");
    writeFileSync(target, "private");
    symlinkSync(target, link);
    const linkedRegistry: MigrationRegistry = {
      targetSchema: 2,
      steps: [{ id: "linked", fromSchema: 1, toSchema: 2, units: [{ root: "stateDir", path: "linked", type: "file" }], run() {} }],
    };
    expect(() => new MigrationEngine({ roots: f.paths, registry: linkedRegistry }).migrate({ updateId: UPDATE, targetGenerationId: GENERATION }))
      .toThrowError("The update could not prepare your data safely.");

    writeFileSync(join(f.paths.stateDir, "migration-schema.json"), '{"schemaVersion":99}\n');
    expect(() => f.engine.needsMigration()).toThrowError("This data was written by a newer app version.");
  });

  it("re-applies an interrupted idempotent step from its durable step index", () => {
    const f = fixture();
    let calls = 0;
    const retryRegistry: MigrationRegistry = {
      targetSchema: 2,
      steps: [{
        id: "retry-layout", fromSchema: 1, toSchema: 2, units: [configUnit],
        run(context) {
          calls += 1;
          context.writeFile(configUnit, '{"name":"after"}\n', 0o640);
          if (calls === 1) throw new Error("interrupted after apply");
        },
      }],
    };
    const engine = new MigrationEngine({ roots: f.paths, registry: retryRegistry });
    expect(() => engine.migrate({ updateId: UPDATE, targetGenerationId: GENERATION })).toThrow();
    expect(engine.currentState()).toMatchObject({ phase: "migrating", stepIndex: 0 });
    expect(engine.migrate({ updateId: UPDATE, targetGenerationId: GENERATION })).toMatchObject({ phase: "migrated", stepIndex: 1 });
    expect(calls).toBe(2);
    expect(readFileSync(f.config, "utf8")).toBe('{"name":"after"}\n');
  });

  it("leaves a durable pre-mutation marker on ENOSPC", () => {
    const noSpace = Object.assign(new Error("full"), { code: "ENOSPC" });
    const f = fixture({ boundary(boundary) { if (boundary === "copy") throw noSpace; } });
    expect(() => f.engine.migrate({ updateId: UPDATE, targetGenerationId: GENERATION }))
      .toThrowError("There is not enough free space to prepare this update safely.");
    expect(f.engine.currentState()).toMatchObject({ phase: "snapshotting", failureCategory: "snapshot" });
    assertPrior(f);
  });
});

describe("fault recovery at durable boundaries", () => {
  it.each(["copy", "hash", "marker", "step", "rename"] as const)("recovers every %s boundary before target launch", (kind) => {
    const trace: MigrationBoundary[] = [];
    const measured = fixture({ boundary(boundary) { trace.push(boundary); } });
    measured.engine.migrate({ updateId: UPDATE, targetGenerationId: GENERATION });
    const count = trace.filter((boundary) => boundary === kind).length;
    expect(count).toBeGreaterThan(0);

    for (let failAt = 1; failAt <= count; failAt += 1) {
      let seen = 0;
      const f = fixture({ boundary(boundary) {
        if (boundary === kind && ++seen === failAt) throw new Error(`fault ${kind} ${failAt}`);
      } });
      expect(() => f.engine.migrate({ updateId: UPDATE, targetGenerationId: GENERATION })).toThrow();
      completeAfterFault(f);
    }
  });

  it.each(["copy", "hash", "marker", "rename"] as const)("resumes every %s boundary while restoring", (kind) => {
    const measured = fixture();
    measured.engine.migrate({ updateId: UPDATE, targetGenerationId: GENERATION });
    const trace: MigrationBoundary[] = [];
    const tracing = new MigrationEngine({ roots: measured.paths, registry, boundary(boundary) { trace.push(boundary); } });
    tracing.restore(UPDATE);
    const count = trace.filter((boundary) => boundary === kind).length;
    expect(count).toBeGreaterThan(0);

    for (let failAt = 1; failAt <= count; failAt += 1) {
      let seen = 0;
      const f = fixture();
      f.engine.migrate({ updateId: UPDATE, targetGenerationId: GENERATION });
      const failing = new MigrationEngine({ roots: f.paths, registry, boundary(boundary) {
        if (boundary === kind && ++seen === failAt) throw new Error(`restore fault ${kind} ${failAt}`);
      } });
      expect(() => failing.restore(UPDATE)).toThrow();
      const restarted = new MigrationEngine({ roots: f.paths, registry });
      const result = restarted.recover({ targetVerified: true });
      if (result.status === "migrated") restarted.restore(UPDATE);
      else expect(result.status).toBe("restored");
      assertPrior({ ...f, engine: restarted });
    }
  });
});
