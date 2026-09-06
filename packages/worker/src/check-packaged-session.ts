/**
 * Packaged-session acceptance probe.
 *
 * Importing Pi proves its compiled core is present. Opening a real session is
 * the stronger boundary: it makes the resource loader resolve and transpile
 * every bundled feature entry point, including TypeScript-only extensions.
 * The desktop clean-machine test runs this file with the packaged Node and an
 * otherwise empty environment.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StableSdkDriver } from "./drivers/stable-sdk.js";

export type PackagedSessionReport =
  | { ok: true; sessionId: string; modelCount: number }
  | { ok: false; error: string };

export async function checkPackagedSession(): Promise<PackagedSessionReport> {
  const root = mkdtempSync(join(tmpdir(), "laser-packaged-session-"));
  const driver = new StableSdkDriver();
  try {
    for (const name of ["project", "agent", "sessions", "subagents"]) {
      mkdirSync(join(root, name), { recursive: true });
    }
    const state = await driver.open({
      cwd: join(root, "project"),
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      subagentsTempRoot: join(root, "subagents"),
      projectTrusted: false,
      features: ["subagents", "goals"],
    });
    const models = await driver.listModels();
    return { ok: true, sessionId: state.id, modelCount: models.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await driver.dispose().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

const invokedDirectly = (() => {
  const argv = process.argv[1];
  if (!argv) return false;
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(argv) === real(fileURLToPath(import.meta.url));
})();

if (invokedDirectly) {
  const report = await checkPackagedSession();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
