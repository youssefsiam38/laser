import { ENV, PRODUCT_VERSION } from "@lasercode/protocol";
import { resolvePaths } from "@lasercode/cli";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import { HostProcess } from "../src/host-process.js";
import { DesktopLog } from "../src/log.js";

it("adopts a same-version legacy host, refreshes its environment, and leaves it alive on Quit", async () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-env-"));
  const server = createServer((req, res) => res.end(req.url === "/healthz" ? "ok" : ""));
  const sockets = new WebSocketServer({ server, path: "/ws" });
  let received: { method: string; keys: string[]; hasSyntheticValue: boolean } | undefined;
  sockets.on("connection", (socket) => socket.on("message", (data) => {
    const request = JSON.parse(String(data));
    received = { method: request.method, keys: Object.keys(request.params.variables).sort(),
      hasSyntheticValue: request.params.variables.SYNTHETIC_SHELL_EXPORT === "private-fixture" };
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { applied: 1 } }));
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const paths = resolvePaths({ flags: {}, positionals: [], rest: [], hasRest: false }, { HOME: root, [ENV.agentDir]: join(root, "agent"), [ENV.stateDir]: join(root, "state"), [ENV.port]: String(port) });
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.hostFile, JSON.stringify({ pid: process.pid, host: "127.0.0.1", port, url: `http://127.0.0.1:${port}`, agentDir: paths.agentDir, sessionDir: paths.sessionDir, stateDir: paths.stateDir, startedAt: new Date().toISOString(), cliVersion: PRODUCT_VERSION }));
  const log = new DesktopLog(join(root, "desktop.log"));
  const lines: string[] = [];
  vi.spyOn(log, "line").mockImplementation((line) => { lines.push(line); });
  const host = new HostProcess({ paths, packaged: false, resourcesPath: root, log, baseEnv: { HOME: root, SYNTHETIC_SHELL_EXPORT: "private-fixture", [ENV.agentDir]: paths.agentDir }, onChange: () => {} });
  const kill = vi.spyOn(process, "kill");
  try {
    expect(await host.start()).toMatchObject({ state: "ready", startedByUs: false });
    expect(received?.method).toBe("pi/host/environment");
    expect(received?.keys).toEqual(["HOME", "SYNTHETIC_SHELL_EXPORT"]);
    expect(received?.hasSyntheticValue).toBe(true);
    await host.stop();
    expect(server.listening).toBe(true);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(lines.join("\n").includes("private-fixture")).toBe(false);
  } finally {
    kill.mockRestore();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
// A real host is spawned here: alone it takes a couple of seconds, and the
// workspace runs three packages at once, so the cost is declared rather than
// left to the 5s default (M21 integration gate).
}, 30_000);

it("refuses a ready responder whose launch identity differs from the desktop spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-launch-mismatch-"));
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const paths = resolvePaths(
    { flags: {}, positionals: [], rest: [], hasRest: false },
    { HOME: root, [ENV.agentDir]: join(root, "agent"), [ENV.stateDir]: join(root, "state"), [ENV.port]: String(port) },
  );
  const mismatch = "fedcba9876543210fedcba9876543210";
  const responder = createServer((_req, res) => res.end(JSON.stringify({ status: "ok", launchId: mismatch })));
  const child = Object.assign(new EventEmitter(), { exitCode: null, pid: 42, kill: vi.fn() });
  const spawnProcess = vi.fn(() => {
    responder.listen(port, "127.0.0.1", () => {
      mkdirSync(paths.stateDir, { recursive: true });
      writeFileSync(paths.hostFile, JSON.stringify({
        pid: process.pid,
        state: "ready",
        launchId: mismatch,
        host: paths.host,
        port,
        url: `http://${paths.host}:${port}`,
        agentDir: paths.agentDir,
        sessionDir: paths.sessionDir,
        stateDir: paths.stateDir,
        startedAt: new Date().toISOString(),
        cliVersion: PRODUCT_VERSION,
      }));
    });
    return child;
  });
  const host = new HostProcess({
    paths,
    packaged: false,
    resourcesPath: root,
    log: new DesktopLog(join(root, "desktop.log")),
    spawnProcess: spawnProcess as never,
    onChange: () => {},
  });
  (host as unknown as { runtime: { binary: string; version: string; execPath: string } }).runtime = {
    binary: process.execPath,
    version: process.version,
    execPath: process.execPath,
  };
  try {
    await expect((host as unknown as { spawnDaemon(): Promise<unknown> }).spawnDaemon()).resolves.toMatchObject({
      state: "failed",
      message: expect.stringContaining("not the process"),
    });
  } finally {
    child.removeAllListeners();
    await new Promise<void>((resolve) => responder.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

it("routes a different-version legacy host through the replacement confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-legacy-refresh-"));
  const server = createServer((req, res) => res.end(req.url === "/healthz" ? "ok" : ""));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const paths = resolvePaths(
    { flags: {}, positionals: [], rest: [], hasRest: false },
    { HOME: root, [ENV.agentDir]: join(root, "agent"), [ENV.stateDir]: join(root, "state"), [ENV.port]: String(port) },
  );
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.hostFile, JSON.stringify({
    pid: process.pid,
    host: "127.0.0.1",
    port,
    url: `http://127.0.0.1:${port}`,
    agentDir: paths.agentDir,
    sessionDir: paths.sessionDir,
    stateDir: paths.stateDir,
    startedAt: new Date().toISOString(),
    cliVersion: "0.1.0",
  }));
  const log = new DesktopLog(join(root, "desktop.log"));
  const confirm = vi.fn(async () => false);
  const host = new HostProcess({
    paths,
    packaged: false,
    resourcesPath: root,
    log,
    confirmHostRefresh: confirm,
    onChange: () => {},
  });
  try {
    await expect(host.start()).resolves.toMatchObject({ state: "failed", message: expect.stringContaining("different version") });
    expect(confirm).toHaveBeenCalledWith("0.1.0");
    expect(server.listening).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
// A real host is spawned here: alone it takes a couple of seconds, and the
// workspace runs three packages at once, so the cost is declared rather than
// left to the 5s default (M21 integration gate).
}, 30_000);
