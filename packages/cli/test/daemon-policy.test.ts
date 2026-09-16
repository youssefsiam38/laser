/**
 * What the launcher does with an environment policy it cannot honour (RP-13).
 *
 * The host refuses to construct when a policy it was given is unusable, which
 * is before it listens and before a socket could exist. This test is about the
 * *launcher*: the daemon the CLI supervises must fail with that sentence
 * rather than come up wide open, and the sentence must be the one a person can
 * act on rather than a stack trace's first line.
 *
 * Only the optional local narrowing file is exercised, because it is the only
 * producer that ships today: no launcher passes `HostServerOptions.policy`
 * (see `docs/environment-policy.md` §3).
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV, PRODUCT_NAME } from "@lasercode/protocol";
import { MigrationEngine, type MigrationRegistry } from "@lasercode/host";
import { runDaemon } from "../src/daemon.js";
import { prepareInstalledRuntime } from "../src/host-control.js";
import type { LaserPaths } from "../src/config.js";

function paths(base: string): LaserPaths {
  return {
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    hostFile: join(base, "state", "host.json"),
    logFile: join(base, "state", "host.log"),
    host: "127.0.0.1",
    port: 0,
    portIsExplicit: false,
  };
}

describe("the daemon and an unusable policy", () => {
  it("fails to start, says what to do, and never binds a port", async () => {
    const base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-daemon-policy-`));
    const previousLaunchId = process.env[ENV.hostLaunchId];
    try {
      process.env[ENV.hostLaunchId] = "00112233445566778899aabbccddeeff";
      mkdirSync(join(base, "state"), { recursive: true });
      writeFileSync(join(base, "state", "policy.json"), JSON.stringify({ remote: { scopes: ["everything"] } }));
      const lines: string[] = [];
      const runtimeGeneration = prepareInstalledRuntime(paths(base)).reference;
      await expect(runDaemon({ paths: paths(base), runtimeGeneration, log: (line) => lines.push(line) })).rejects.toThrow(
        /cannot be used/,
      );
      // Construction failed before this launch could publish even `starting`.
      expect(lines.some((line) => line.includes("host ready"))).toBe(false);
      expect(existsSync(paths(base).hostFile)).toBe(false);
    } finally {
      if (previousLaunchId === undefined) delete process.env[ENV.hostLaunchId];
      else process.env[ENV.hostLaunchId] = previousLaunchId;
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("never binds while a durable migration marker still owns startup", async () => {
    const base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-daemon-migration-`));
    const previousLaunchId = process.env[ENV.hostLaunchId];
    try {
      process.env[ENV.hostLaunchId] = "00112233445566778899aabbccddeeff";
      const resolved = paths(base);
      mkdirSync(resolved.stateDir, { recursive: true });
      writeFileSync(join(resolved.stateDir, "fixture.txt"), "before\n");
      const runtimeGeneration = prepareInstalledRuntime(resolved).reference;
      const unit = { root: "stateDir" as const, path: "fixture.txt", type: "file" as const };
      const registry: MigrationRegistry = {
        targetSchema: 2,
        steps: [{ id: "synthetic-v2", fromSchema: 1, toSchema: 2, units: [unit], run(context) {
          context.writeFile(unit, "after\n");
        } }],
      };
      const engine = new MigrationEngine({
        roots: { stateDir: resolved.stateDir, agentDir: resolved.agentDir, sessionDir: resolved.sessionDir }, registry,
      });
      engine.migrate({ updateId: "d".repeat(64), targetGenerationId: runtimeGeneration.generationId });

      await expect(runDaemon({ paths: resolved, runtimeGeneration, log: () => {} })).rejects.toThrow(
        /data preparation is incomplete/,
      );
      expect(existsSync(resolved.hostFile)).toBe(false);

      engine.markLaunchAttempt("d".repeat(64), process.env[ENV.hostLaunchId]!);
      writeFileSync(join(resolved.stateDir, "policy.json"), JSON.stringify({ remote: { scopes: ["everything"] } }));
      await expect(runDaemon({ paths: resolved, runtimeGeneration, log: () => {} })).rejects.toThrow(/cannot be used/);
      expect(existsSync(resolved.hostFile)).toBe(false);
    } finally {
      if (previousLaunchId === undefined) delete process.env[ENV.hostLaunchId];
      else process.env[ENV.hostLaunchId] = previousLaunchId;
      rmSync(base, { recursive: true, force: true });
    }
  });
});
