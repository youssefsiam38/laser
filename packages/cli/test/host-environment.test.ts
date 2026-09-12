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
import { run } from "../src/cli.js";
import { writeHostFile } from "../src/hostfile.js";

it.each(["success", "unsupported", "failed", "disconnect", "timeout"])("terminal adoption is advisory on refresh %s", async (reply) => {
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
    if (reply === "timeout") return;
    if (reply === "disconnect") return socket.close();
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id,
      ...(reply === "success" ? { result: { applied: 1 } } : { error: { code: reply === "unsupported" ? -32601 : -32603, message: "private-fixture" } }),
    }));
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
  const notes: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { notes.push(String(chunk)); return true; });
  const output: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
  try {
    expect(await startHost(paths)).toEqual({ record, started: false });
    expect(received).toBe(true);
    expect(notes).toHaveLength(reply === "success" ? 0 : 1);
    expect(notes.join("").includes("private-fixture")).toBe(false);
    if (reply === "unsupported") {
      // Both bare invocation and `up` still return success and print the URL.
      for (const command of [[], ["up"]]) {
        notes.length = 0;
        output.length = 0;
        expect(await run([...command, "--json", "--no-open", "--agent-dir", paths.agentDir, "--state-dir", paths.stateDir, "--port", String(port)])).toBe(0);
        expect(JSON.parse(output.join(""))).toMatchObject({ url: record.url, attached: true });
        expect(notes).toHaveLength(1);
      }
    }
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  } finally {
    process.env = original;
    kill.mockRestore();
    stderr.mockRestore();
    stdout.mockRestore();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
