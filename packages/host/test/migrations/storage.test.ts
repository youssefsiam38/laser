import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MigrationEngine, MigrationError } from "../../src/migrations/index.js";
import { validateUnit } from "../../src/migrations/storage.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("validateUnit retain exclusions", () => {
  it("rejects retain, lease and store-lock paths the same way as migration state", () => {
    const allowed = { root: "stateDir" as const, path: "data/config.json", type: "file" as const };
    expect(() => validateUnit(allowed)).not.toThrow();
    expect(() => validateUnit({ root: "stateDir", path: "migration-state.json", type: "file" })).toThrow(/unsafe migration path/);
    expect(() => validateUnit({ root: "stateDir", path: "runtime-generations", type: "directory" })).toThrow(/unsafe migration path/);
    expect(() => validateUnit({ root: "stateDir", path: "runtime-generations/abc", type: "directory" })).toThrow(/unsafe migration path/);
    expect(() => validateUnit({ root: "stateDir", path: "runtime-generation-leases", type: "directory" })).toThrow(/unsafe migration path/);
    expect(() => validateUnit({ root: "stateDir", path: "runtime-generation-leases/one.json", type: "file" })).toThrow(/unsafe migration path/);
    expect(() => validateUnit({ root: "stateDir", path: ".store.lock", type: "file" })).toThrow(/unsafe migration path/);
  });

  it("refuses a synthetic step that snapshots retain trees", () => {
    const root = mkdtempSync(join(tmpdir(), "retain-migration-"));
    roots.push(root);
    const paths = { stateDir: join(root, "state"), agentDir: join(root, "agent"), sessionDir: join(root, "sessions") };
    for (const path of Object.values(paths)) mkdirSync(path, { recursive: true, mode: 0o700 });
    expect(() => new MigrationEngine({
      roots: paths,
      registry: {
        targetSchema: 2,
        steps: [{
          id: "snapshot-retain",
          fromSchema: 1,
          toSchema: 2,
          units: [{ root: "stateDir", path: "runtime-generations", type: "directory" }],
          run() {},
        }],
      },
    })).toThrow(MigrationError);
  });
});
