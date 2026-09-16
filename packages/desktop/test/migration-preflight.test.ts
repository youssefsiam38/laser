import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { PRODUCT_SLUG } from "@lasercode/protocol";
import { cliEntry, type LaserPaths } from "@lasercode/cli";
import { prepareInstalledRuntimeOffMain } from "../src/migration-preflight.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("keeps runtime verification and migration work off the Electron main thread", async () => {
  const root = mkdtempSync(join(tmpdir(), `${PRODUCT_SLUG}-migration-worker-`));
  roots.push(root);
  const paths: LaserPaths = {
    stateDir: join(root, "state"), agentDir: join(root, "agent"), sessionDir: join(root, "agent", "sessions"),
    hostFile: join(root, "state", "host.json"), logFile: join(root, "state", "host.log"),
    host: "127.0.0.1", port: 1, portIsExplicit: true,
  };
  mkdirSync(paths.sessionDir, { recursive: true });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  const workerUrl = pathToFileURL(join(fileURLToPath(new URL("../dist", import.meta.url)), "migration-preflight.js"));
  try {
    const result = await prepareInstalledRuntimeOffMain(paths, cliEntry(), undefined, workerUrl);
    expect(result.reference.generationId).toMatch(/^[0-9a-f]{64}$/);
    expect(ticks).toBeGreaterThan(0);
  } finally {
    clearInterval(timer);
  }
});
