import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LaserPaths } from "@lasercode/cli";
import { desktopHostArgv, desktopNodeEnvironment } from "../src/host-process.js";

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

describe("desktop-owned host generations", () => {
  it("puts the exact flag before the unpacked entry on the first spawn and every restart", () => {
    const expected = ["--max-old-space-size=448", "/bundle/cli.mjs", "__daemon"];
    const first = desktopHostArgv(paths("/scratch"), 4096 * 1024 * 1024, "/bundle/cli.mjs");
    const restarted = desktopHostArgv(paths("/scratch"), 4096 * 1024 * 1024, "/bundle/cli.mjs");
    expect(first.slice(0, 3)).toEqual(expected);
    expect(restarted).toEqual(first);
  });

  it("removes Node and Electron controls after every overlay", () => {
    expect(desktopNodeEnvironment({
      HOME: "/scratch/home",
      NODE_OPTIONS: "--max-old-space-size=1",
      Node_Options: "--trace-warnings",
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
    })).toEqual({ HOME: "/scratch/home" });
  });
});
