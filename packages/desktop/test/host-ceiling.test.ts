import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaserPaths } from "@lasercode/cli";
import { ENV } from "@lasercode/protocol";
import { HostProcess, desktopNodeEnvironment } from "../src/host-process.js";
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

function log(): DesktopLog {
  return { line: () => undefined, error: () => undefined } as unknown as DesktopLog;
}

afterEach(() => vi.useRealTimers());

describe("desktop-owned host generations", () => {
  it("passes the exact ceiling argv to the initial spawn and the supervised restart", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "desktop-host-ceiling-"));
    const children: EventEmitter[] = [];
    const spawnProcess = vi.fn(() => {
      const child = Object.assign(new EventEmitter(), { exitCode: null, pid: 42, kill: vi.fn() });
      children.push(child);
      queueMicrotask(() => child.emit("error", new Error("fixture stop")));
      return child;
    });
    try {
      const host = new HostProcess({
        paths: paths(root), packaged: false, resourcesPath: "/bundle", log: log(),
        spawnProcess: spawnProcess as never,
        onChange: () => undefined,
      });
      const internal = host as unknown as {
        runtime: { binary: string; version: string; execPath: string };
        spawnDaemon(): Promise<unknown>;
        onChildExit(code: number | null, signal: NodeJS.Signals | null): void;
      };
      internal.runtime = { binary: process.execPath, version: process.version, execPath: process.execPath };
      await internal.spawnDaemon();
      internal.onChildExit(null, "SIGABRT");
      await vi.advanceTimersByTimeAsync(500);

      expect(spawnProcess).toHaveBeenCalledTimes(2);
      const first = spawnProcess.mock.calls[0]![1] as string[];
      const restarted = spawnProcess.mock.calls[1]![1] as string[];
      expect(first[0]).toBe("--max-old-space-size=448");
      expect(first[1]).toMatch(/cli[/\\]dist[/\\]main\.js$/);
      expect(first[2]).toBe("__daemon");
      expect(restarted).toEqual(first);
      const firstEnv = (spawnProcess.mock.calls[0]![2] as { env: NodeJS.ProcessEnv }).env;
      const restartedEnv = (spawnProcess.mock.calls[1]![2] as { env: NodeJS.ProcessEnv }).env;
      expect(firstEnv[ENV.hostLaunchId]).toMatch(/^[0-9a-f]{32}$/);
      expect(restartedEnv[ENV.hostLaunchId]).toMatch(/^[0-9a-f]{32}$/);
      expect(restartedEnv[ENV.hostLaunchId]).not.toBe(firstEnv[ENV.hostLaunchId]);
    } finally {
      for (const child of children) child.removeAllListeners();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("caps OOM-shaped owned-host restart incidents after 500 ms and 1,000 ms", async () => {
    vi.useFakeTimers();
    const changes: Array<{ state: string; message?: string }> = [];
    const host = new HostProcess({
      paths: paths("/scratch"), packaged: false, resourcesPath: "/bundle",
      log: log(),
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

  it("starts a fresh restart incident after one healthy minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:02:00.000Z"));
    const host = new HostProcess({
      paths: paths("/scratch"), packaged: false, resourcesPath: "/bundle", log: log(), onChange: () => undefined,
    });
    const internal = host as unknown as {
      restarts: number;
      readyAt: number;
      onChildExit(code: number | null, signal: NodeJS.Signals | null): void;
      spawnDaemon(): Promise<unknown>;
    };
    internal.restarts = 2;
    internal.readyAt = Date.now() - 60_000;
    const spawn = vi.spyOn(internal, "spawnDaemon").mockResolvedValue({});

    internal.onChildExit(null, "SIGABRT");
    await vi.advanceTimersByTimeAsync(500);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(internal.restarts).toBe(1);
  });

  it("publishes a host-floor refusal without spawning", async () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-host-small-"));
    const constrained = vi.spyOn(process, "constrainedMemory").mockReturnValue(256 * 1024 * 1024);
    const spawnProcess = vi.fn();
    try {
      const host = new HostProcess({
        paths: paths(root), packaged: false, resourcesPath: "/bundle", log: log(),
        spawnProcess: spawnProcess as never,
        onChange: () => undefined,
      });
      const internal = host as unknown as {
        runtime: { binary: string; version: string; execPath: string };
        spawnDaemon(): Promise<unknown>;
      };
      internal.runtime = { binary: process.execPath, version: process.version, execPath: process.execPath };
      await internal.spawnDaemon();
      expect(host.current()).toMatchObject({ state: "failed", message: expect.stringContaining("needs at least 448 MiB") });
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally {
      constrained.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
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
