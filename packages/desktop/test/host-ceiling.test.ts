import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaserPaths } from "@lasercode/cli";
import { HostProcess, desktopHostArgv, desktopNodeEnvironment } from "../src/host-process.js";
import type { DesktopLog } from "../src/log.js";

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

afterEach(() => vi.useRealTimers());

describe("desktop-owned host generations", () => {
  it("puts the exact flag before the unpacked entry on the first spawn and every restart", () => {
    const expected = ["--max-old-space-size=448", "/bundle/cli.mjs", "__daemon"];
    const first = desktopHostArgv(paths("/scratch"), 4096 * 1024 * 1024, "/bundle/cli.mjs");
    const restarted = desktopHostArgv(paths("/scratch"), 4096 * 1024 * 1024, "/bundle/cli.mjs");
    expect(first.slice(0, 3)).toEqual(expected);
    expect(restarted).toEqual(first);
  });

  it("caps OOM-shaped owned-host restart incidents after 500 ms and 1,000 ms", async () => {
    vi.useFakeTimers();
    const changes: Array<{ state: string; message?: string }> = [];
    const host = new HostProcess({
      paths: paths("/scratch"), packaged: false, resourcesPath: "/bundle",
      log: { line: () => undefined, error: () => undefined } as unknown as DesktopLog,
      onChange: (info) => changes.push({ state: info.state, ...(info.message ? { message: info.message } : {}) }),
    });
    const internal = host as unknown as {
      onChildExit(code: number | null, signal: NodeJS.Signals | null): void;
      spawnDaemon(): Promise<unknown>;
    };
    const spawn = vi.spyOn(internal, "spawnDaemon").mockResolvedValue({});

    internal.onChildExit(null, "SIGABRT");
    await vi.advanceTimersByTimeAsync(499);
    expect(spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    internal.onChildExit(null, "SIGABRT");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawn).toHaveBeenCalledTimes(2);
    internal.onChildExit(null, "SIGABRT");
    await vi.runAllTimersAsync();

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(changes.at(-1)).toMatchObject({ state: "failed", message: expect.stringContaining("stopped 3 times") });
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
