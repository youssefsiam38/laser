import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LaserPaths } from "@lasercode/cli";
import { runtimeMigrationCopy } from "@lasercode/protocol";
import type { DesktopLog } from "../src/log.js";

const preflight = vi.hoisted(() => ({ prepareInstalledRuntimeOffMain: vi.fn() }));
vi.mock("../src/migration-preflight.js", () => preflight);

import { HostProcess } from "../src/host-process.js";

function paths(base: string): LaserPaths {
  return {
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    hostFile: join(base, "state", "host.json"),
    logFile: join(base, "state", "host.log"),
    host: "127.0.0.1",
    port: 41415,
    portIsExplicit: false,
  };
}

describe("migration preflight failure copy", () => {
  it("keeps worker exit diagnostics private and renders only curated copy", async () => {
    const diagnostic = "migration worker exited with code 17, signal SIGKILL, at /private/data";
    preflight.prepareInstalledRuntimeOffMain.mockRejectedValueOnce(new Error(diagnostic));
    const privateLog: string[] = [];
    const log = {
      line: (message: string) => privateLog.push(message),
      error: (message: string, cause?: unknown) => {
        privateLog.push(`${message}: ${cause instanceof Error ? cause.message : String(cause)}`);
      },
    } as DesktopLog;
    const host = new HostProcess({
      paths: paths("/fixture"),
      packaged: false,
      resourcesPath: "/bundle",
      log,
      onChange: () => undefined,
    });

    const result = await host.start();
    expect(result).toMatchObject({
      state: "failed",
      message: runtimeMigrationCopy("prepare-failed"),
    });
    expect(result.message).not.toMatch(/17|SIGKILL|\/private\/data/);
    expect(privateLog.join("\n")).toContain(diagnostic);
  });
});
