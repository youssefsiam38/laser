import { ENV, PRODUCT_VERSION } from "@lasercode/protocol";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import { resolvePaths } from "../src/config.js";
import { startHost } from "../src/host-control.js";
import { writeHostFile } from "../src/hostfile.js";

it("terminal adoption forwards its environment without starting or stopping the recorded host", async () => {
  const root = mkdtempSync(join(tmpdir(), "cli-env-"));
  const server = createServer((_req, res) => res.end("ok"));
  const sockets = new WebSocketServer({ server, path: "/ws" });
  let received = false;
  sockets.on("connection", (socket) => socket.on("message", (data) => {
    const request = JSON.parse(String(data));
    received = request.method === "pi/host/environment"
      && request.params.variables.SYNTHETIC_SHELL_EXPORT === "private-fixture"
      && !(ENV.agentDir in request.params.variables)
      && !("PI_CODING_AGENT_DIR" in request.params.variables);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { applied: 1 } }));
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const paths = resolvePaths({ flags: {}, positionals: [], rest: [], hasRest: false }, { HOME: root, [ENV.agentDir]: join(root, "agent"), [ENV.stateDir]: join(root, "state"), [ENV.port]: String(port) });
  const record = { pid: process.pid, host: "127.0.0.1", port, url: `http://127.0.0.1:${port}`, agentDir: paths.agentDir, sessionDir: paths.sessionDir, stateDir: paths.stateDir, startedAt: new Date().toISOString(), cliVersion: PRODUCT_VERSION };
  writeHostFile(paths.hostFile, record);
  // Send only a minimal fixture environment; never the runner's credentials.
  const original = process.env;
  process.env = { PATH: original.PATH, HOME: root, SYNTHETIC_SHELL_EXPORT: "private-fixture", [ENV.agentDir]: paths.agentDir, PI_CODING_AGENT_DIR: "/not-ours" };
  const kill = vi.spyOn(process, "kill");
  try {
    expect(await startHost(paths)).toEqual({ record, started: false });
    expect(received).toBe(true);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  } finally {
    process.env = original;
    kill.mockRestore();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
