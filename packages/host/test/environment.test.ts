import { type ClientMethod, type ClientRequests, type JsonRpcMessage, type McpCallResult } from "@lasercode/protocol";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { HostServer } from "../src/server.js";
import { WorkerPool } from "../src/worker-pool.js";

class Client {
  private id = 0;
  readonly notifications: unknown[] = [];
  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as JsonRpcMessage;
      if (!("id" in message)) this.notifications.push(message);
    });
  }
  async request<M extends ClientMethod>(method: M, params: ClientRequests[M]["params"]): Promise<ClientRequests[M]["result"]> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.off("message", receive); reject(new Error("request timed out")); }, 30_000);
      const receive = (data: WebSocket.RawData) => {
        const message = JSON.parse(String(data));
        if (message.id !== id) return;
        clearTimeout(timer);
        this.socket.off("message", receive);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      };
      this.socket.on("message", receive);
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
}

let root: string;
let host: HostServer;
let url: string;
let logs: string[];
const clients: Client[] = [];
beforeEach(async () => {
  vi.stubEnv("SYNTHETIC_SHELL_EXPORT", undefined);
  root = mkdtempSync(join(tmpdir(), "host-env-"));
  for (const dir of ["agent", "one", "two"]) mkdirSync(join(root, dir));
  // Match production path pins while all mutable state stays under this test.
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  logs = [];
  host = new HostServer({ agentDir: join(root, "agent"), sessionDir: join(root, "sessions"), stateDir: join(root, "state"), logFile: false, workerIdleMs: 0, log: (line) => logs.push(line) });
  for (const dir of ["one", "two"]) host.projects.setTrust(join(root, dir), false, false);
  url = (await host.listen()).url;
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.socket.close();
  await host.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
async function connect(origin?: string): Promise<Client> {
  const socket = new WebSocket(`${url.replace("http", "ws")}/ws`, origin ? { origin } : {});
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const client = new Client(socket);
  clients.push(client);
  return client;
}
function presence(result: McpCallResult) {
  expect(result.ok).toBe(true);
  const text = result.content.find((part) => part.type === "text");
  return JSON.parse(text?.type === "text" ? text.text : "null") as { present: boolean; shellPresent: boolean };
}

it("updates a real live worker and the base of a later worker without restarting either host or worker", async () => {
  const client = await connect();
  const first = join(root, "one");
  const second = join(root, "two");
  const fixture = fileURLToPath(new URL("../../worker/test/environment-server.mjs", import.meta.url));
  const save = (cwd: string) => client.request("mcp/save", { cwd, scope: "project", server: { name: "environment", transport: { kind: "stdio", command: process.execPath, args: [fixture] } } });
  const call = (cwd: string) => client.request("mcp/call", { cwd, scope: "project", name: "environment", tool: "presence", args: {} }).then(presence);
  await save(first);
  expect((await call(first)).present).toBe(false);
  const pid = host.pool.workerInfo(first)?.pid;
  expect(pid).toBeTypeOf("number");
  expect(await client.request("pi/host/environment", { variables: { SYNTHETIC_SHELL_EXPORT: "private-fixture", PI_CODING_AGENT_DIR: "/refused", NODE_OPTIONS: "--refused" } })).toEqual({ applied: 1 });
  // The host process's own mutable environment is not an environment store.
  expect(Object.hasOwn(process.env, "SYNTHETIC_SHELL_EXPORT")).toBe(false);
  expect((await call(first)).present).toBe(false); // Existing MCP process is untouched.
  await client.request("mcp/disconnect", { cwd: first, scope: "project", name: "environment" });
  expect(await call(first)).toMatchObject({ present: true, ...(process.platform !== "win32" ? { shellPresent: true } : {}) });
  expect(host.pool.workerInfo(first)?.pid).toBe(pid);
  await save(second);
  expect((await call(second)).present).toBe(true);
  expect(host.pool.workerInfo(second)?.pid).not.toBe(pid);
  expect(JSON.stringify(client.notifications).includes("private-fixture")).toBe(false);
  expect(logs.join("\n").includes("private-fixture")).toBe(false);
}, 90_000);

it("queues an update to an already spawned worker before it reports ready", async () => {
  const pool = new WorkerPool({ agentDir: join(root, "agent"), sessionDir: join(root, "early-sessions"), stateDir: join(root, "early-state"), idleMs: 0, onNotification: () => {} });
  const cwd = join(root, "one");
  try {
    const starting = pool.get(cwd);
    expect(pool.liveClients()).toHaveLength(1); // Spawn is synchronous; ready is not.
    expect(pool.workerInfo(cwd)?.status).toBe("starting");
    expect(pool.applyEnvironment({ SYNTHETIC_SHELL_EXPORT: "private-fixture" })).toBe(1);
    const worker = await starting;
    await worker.request("mcp/save", { cwd, scope: "project", server: { name: "environment", transport: { kind: "stdio", command: process.execPath, args: [fileURLToPath(new URL("../../worker/test/environment-server.mjs", import.meta.url))] } } });
    const result = await worker.request<McpCallResult>("mcp/call", { cwd, scope: "project", name: "environment", tool: "presence", args: {} });
    expect(presence(result).present).toBe(true);
  } finally {
    await pool.stopAll();
  }
  expect(() => pool.applyEnvironment({ SYNTHETIC_SHELL_EXPORT: "after-close" })).not.toThrow();
}, 60_000);

it("refuses browser and relay/default callers; malformed input is not applied", async () => {
  const browser = await connect(url);
  const params = { variables: { SYNTHETIC_SHELL_EXPORT: "private-fixture" } };
  await expect(browser.request("pi/host/environment", params)).rejects.toThrow("only accepted from a local app or terminal");
  const relay = await host.router.handle({ jsonrpc: "2.0", id: 1, method: "pi/host/environment", params });
  expect(relay.error?.message).toContain("only accepted from a local app or terminal");
  const local = await connect();
  await expect(local.request("pi/host/environment", { variables: { "BAD=NAME": "private-fixture" } })).rejects.toThrow("invalid params");
  expect(host.pool.workers()).toEqual([]);
});
