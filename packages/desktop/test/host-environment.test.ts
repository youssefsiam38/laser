import { ENV, PRODUCT_VERSION } from "@lasercode/protocol";
import { resolvePaths, writeHostFile } from "@lasercode/cli";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import { HostProcess } from "../src/host-process.js";
import { DesktopLog } from "../src/log.js";

it("same-version adoption sends the desktop environment and normal Quit leaves the host alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-env-"));
  const server = createServer((_req, res) => res.end("ok"));
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
  writeHostFile(paths.hostFile, { pid: process.pid, host: "127.0.0.1", port, url: `http://127.0.0.1:${port}`, agentDir: paths.agentDir, sessionDir: paths.sessionDir, stateDir: paths.stateDir, startedAt: new Date().toISOString(), cliVersion: PRODUCT_VERSION });
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
});
