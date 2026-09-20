import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { laserDataDir, RUNTIME_RETAIN_DIR_NAME } from "@lasercode/host";
import { parseArgs } from "../src/args.js";
import { PATH_FLAGS, resolvePaths } from "../src/config.js";
import { GLOBAL_FLAGS } from "../src/flags.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("LaserPaths.runtimeRetainDir", () => {
  it("derives from stateDir and never from the default data directory", () => {
    const state = mkdtempSync(join(tmpdir(), "retain-paths-"));
    dirs.push(state);
    const parsed = parseArgs(["--state-dir", state], PATH_FLAGS);
    const paths = resolvePaths(parsed, { HOME: state });
    expect(paths.runtimeRetainDir).toBe(join(state, RUNTIME_RETAIN_DIR_NAME));
    expect(paths.runtimeRetainDir.startsWith(state)).toBe(true);
    expect(paths.runtimeRetainDir.startsWith(laserDataDir({ HOME: state }))).toBe(false);
  });

  it("uses an explicit retain directory even when stateDir is elsewhere", () => {
    const root = mkdtempSync(join(tmpdir(), "retain-explicit-"));
    dirs.push(root);
    const state = join(root, "state");
    const retain = join(root, "explicit-retain");
    const parsed = parseArgs(["--state-dir", state, "--runtime-retain-dir", retain], GLOBAL_FLAGS);
    const paths = resolvePaths(parsed, { HOME: root });
    expect(paths.stateDir).toBe(state);
    expect(paths.runtimeRetainDir).toBe(retain);
  });

  it("keeps the retain flag hidden from help specs consumers", () => {
    expect(PATH_FLAGS["runtime-retain-dir"]?.hidden).toBe(true);
  });
});
